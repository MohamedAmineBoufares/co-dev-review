// A stable identifier per changed hunk, so a review can be required to account for every change
// instead of stopping wherever the model's attention ran out.
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const MAX_LINES = 400;
// Lockfiles, snapshots and generated code: nobody reviews them line by line, and a lockfile alone can be most of a diff.
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$|\.(snap|map)$|\.min\.(js|css)$|(^|\/)__snapshots__\/|\.(Designer|g)\.cs$|ModelSnapshot\.cs$/i;
export const isGenerated = path => GENERATED.test(path ?? '');

export function fileHunks(path, patch = '') {
  const hunks = [];
  let current = null;
  for (const line of String(patch).split('\n')) {
    const match = HEADER.exec(line);
    if (match) {
      current = { path, header: line.slice(0, 200), oldStart: Number(match[1]), newStart: Number(match[3]), added: 0, removed: 0, oldLines: 0, newLines: 0, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) { current.added++; current.newLines++; }
    else if (line.startsWith('-')) { current.removed++; current.oldLines++; }
    else if (!line.startsWith(' ') && line !== '') continue;
    else { current.oldLines++; current.newLines++; }
    if (current.lines.length < MAX_LINES) current.lines.push(line);
  }
  return hunks;
}

// Local `git diff` returns every file in one string; remote providers return one patch per file.
export function splitUnifiedDiff(diff = '') {
  const files = [];
  let current = null;
  for (const line of String(diff).split('\n')) {
    // A Windows checkout can carry CRLF through git output; an untrimmed CR corrupts the path.
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trimEnd());
    if (match) { current = { path: match[2], patch: '' }; files.push(current); continue; }
    if (current) current.patch += line + '\n';
  }
  return files;
}

export const changedPaths = files => files.map(f => f.new_path || f.filename || f.path).filter(Boolean);

// Identifiers are "<changed file index>.<hunk index>" so they stay stable no matter which page
// of a paginated diff they were read from, and so a whole file can be answered for with "7.*".
export function ledger(files, startIndex = 0) {
  const entries = [];
  files.forEach((file, offset) => {
    const index = startIndex + offset + 1;
    const path = file.new_path || file.filename || file.path;
    const patch = file.diff ?? file.patch ?? '';
    if (file.too_large || file.collapsed || !patch) {
      entries.push({ id: `${index}.1`, path, unavailable: true, reason: file.too_large ? 'too large' : file.collapsed ? 'collapsed by provider' : 'no patch returned' });
      return;
    }
    fileHunks(path, patch).forEach((hunk, position) => {
      const { lines, ...rest } = hunk;
      entries.push({ id: `${index}.${position + 1}`, ...rest, ...(isGenerated(path) ? { generated: true } : {}) });
    });
  });
  return entries;
}

// The few lines a human needs to judge a comment, captured when the draft is saved so the
// approval step can show code next to the proposed text.
export function anchorContext(files, path, line, side = 'RIGHT', radius = 5) {
  const file = files.find(f => (f.new_path || f.filename || f.path) === path);
  if (!file) return undefined;
  for (const hunk of fileHunks(path, file.diff ?? file.patch ?? '')) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart, index = 0;
    for (const text of hunk.lines) {
      const at = side === 'LEFT' ? oldLine : newLine;
      const counts = side === 'LEFT' ? !text.startsWith('+') : !text.startsWith('-');
      if (counts && at === line) {
        const from = Math.max(0, index - radius);
        return { path, line, side, header: hunk.header, snippet: hunk.lines.slice(from, index + radius + 1).join('\n'), markerIndex: index - from };
      }
      if (!text.startsWith('+')) oldLine++;
      if (!text.startsWith('-')) newLine++;
      index++;
    }
  }
  return undefined;
}

// Every line of a patch with its old and new line number.
export function diffLines(patch) {
  const rows = [];
  for (const hunk of fileHunks('', patch)) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const type = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ';
      rows.push({ type, old: type === '+' ? undefined : oldLine, new: type === '-' ? undefined : newLine, text: line.slice(1) });
      if (type !== '+') oldLine++;
      if (type !== '-') newLine++;
    }
  }
  return rows;
}

const squash = text => String(text).replace(/\s+/g, ' ').trim();
const words = text => new Set(text.toLowerCase().split(/\W+/).filter(word => word.length > 2));

// Line numbers counted by hand drift by one; the text of the line does not. Finds the line of a patch that
// reads like the given text: an added (RIGHT) or removed (LEFT) line first, then an unchanged line of a hunk.
// Whitespace is ignored, and a quote of part of a line is accepted when only one line contains it.
export function findChangedLine(patch, side, text, near) {
  const rows = diffLines(patch);
  const changed = rows.filter(row => row.type === (side === 'RIGHT' ? '+' : '-'));
  const context = rows.filter(row => row.type === ' ');
  const quoted = squash(text);
  // Models sometimes copy the diff marker along with the line.
  const attempts = /^[+-]/.test(quoted) ? [quoted, squash(quoted.slice(1))] : [quoted];
  let found = [];
  for (const wanted of attempts) {
    found = changed.filter(row => squash(row.text) === wanted);
    if (!found.length) found = context.filter(row => squash(row.text) === wanted);
    if (!found.length && wanted.length >= 12) found = changed.filter(row => { const have = squash(row.text); return have.includes(wanted) || (have.length >= 12 && wanted.includes(have)); });
    if (found.length) break;
  }
  const lineOf = row => (row.type === ' ' || side === 'RIGHT' ? row.new : row.old);
  if (!found.length) {
    const target = words(quoted);
    const closest = changed.map(row => ({ row, score: [...words(row.text)].filter(word => target.has(word)).length }))
      .filter(x => x.score).sort((a, b) => b.score - a.score).slice(0, 3)
      .map(x => `${lineOf(x.row)}: "${squash(x.row.text).slice(0, 80)}"`);
    return { error: `no ${side === 'RIGHT' ? 'added' : 'removed'} line reads "${quoted.slice(0, 80)}"${closest.length ? `. Closest: ${closest.join(' | ')}` : ''}. Copy lineText from a line of the patch` };
  }
  let row = found[0];
  if (found.length > 1) {
    if (!near) return { error: `"${quoted.slice(0, 80)}" appears on lines ${found.map(lineOf).join(', ')}; pass line as well to choose one` };
    row = found.reduce((best, x) => (Math.abs(lineOf(x) - near) < Math.abs(lineOf(best) - near) ? x : best));
  }
  return row.type === ' ' ? { line: row.new, unchanged: true, oldLine: row.old } : { line: lineOf(row) };
}

// The ledger entry an anchor falls in, so a comment answers for its own hunk.
export const hunkAt = (entries, path, side, line) => entries.find(x => x.path === path && !x.unavailable
  && (side === 'LEFT' ? line >= x.oldStart && line < x.oldStart + Math.max(1, x.oldLines) : line >= x.newStart && line < x.newStart + Math.max(1, x.newLines)))?.id;

// Accepts "7.2", a whole file as "7" or "7.*", a range as "7.2-7.5" or "7.2-9.1", and any comma-separated mix.
export function expandIds(spec, entries = []) {
  const ids = [];
  for (const part of String(spec).split(',').map(x => x.trim()).filter(Boolean)) {
    const wildcard = /^(\d+)(?:\.\*)?$/.exec(part);
    if (wildcard) { ids.push(...entries.filter(x => x.id.startsWith(`${wildcard[1]}.`)).map(x => x.id)); continue; }
    const range = /^(\d+)\.(\d+)\s*-\s*(?:(\d+)\.)?(\d+)$/.exec(part);
    if (range) {
      const file = range[1];
      if (range[3] && range[3] !== file) {
        const from = entries.findIndex(x => x.id === `${file}.${range[2]}`), to = entries.findIndex(x => x.id === `${range[3]}.${range[4]}`);
        if (from < 0 || to < from) throw new Error(`Invalid hunk range: ${part}`);
        ids.push(...entries.slice(from, to + 1).map(x => x.id));
        continue;
      }
      const [from, to] = [Number(range[2]), Number(range[4])];
      if (to < from || to - from > 5000) throw new Error(`Invalid hunk range: ${part}`);
      for (let i = from; i <= to; i++) ids.push(`${file}.${i}`);
      continue;
    }
    if (!/^\d+\.\d+$/.test(part)) throw new Error(`Invalid hunk identifier: ${part}. Use "7.2", "7.*", "7.2-7.5" or "rest".`);
    ids.push(part);
  }
  return ids;
}

// Every hunk gets a verdict. A hunk a comment is anchored in is a finding without being claimed, a generated
// file is not-applicable, and one { hunks: "rest" } claim answers for everything not named. Problems are
// returned together rather than thrown one at a time: each retry resends every comment body.
export function resolveCoverage(entries, coverage = [], findingIds = []) {
  const problems = [];
  const verdicts = new Map(findingIds.filter(Boolean).map(id => [id, 'finding']));
  for (const entry of entries) if (entry.generated && !verdicts.has(entry.id)) verdicts.set(entry.id, 'not-applicable');
  const known = new Set(entries.map(x => x.id));
  const unknown = [];
  let rest = null;
  for (const claim of coverage) {
    if (/^(rest|\*|all)$/i.test(claim.hunks.trim())) { rest ??= claim.verdict === 'finding' ? 'reviewed-clean' : claim.verdict; continue; }
    let ids;
    try { ids = expandIds(claim.hunks, entries); } catch (error) { problems.push(error.message); continue; }
    for (const id of ids) {
      if (!known.has(id)) unknown.push(id);
      else if (!verdicts.has(id)) verdicts.set(id, claim.verdict);
    }
  }
  if (unknown.length) problems.push(`Unknown hunk ids: ${unknown.slice(0, 10).join(', ')}. Id n.k is the k-th @@ of the file numbered n in step=read; this diff has ${new Set(entries.map(x => x.id.split('.')[0])).size} file(s).`);
  const gaps = entries.filter(x => !verdicts.has(x.id)).map(x => x.id);
  if (rest) for (const id of gaps) verdicts.set(id, rest);
  else if (gaps.length) problems.push(`No verdict for ${gaps.length} of ${entries.length} hunks: ${gaps.slice(0, 25).join(', ')}${gaps.length > 25 ? ', …' : ''}. Read them, then give each a verdict in coverage, or add { hunks: "rest", verdict: "reviewed-clean" } for everything you read and found clean.`);
  const summary = {};
  for (const verdict of verdicts.values()) summary[verdict] = (summary[verdict] ?? 0) + 1;
  return { problems, summary, bulk: rest ? gaps.length : 0 };
}
