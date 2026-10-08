// A stable identifier per changed hunk, so a review can be required to account for every change
// instead of stopping wherever the model's attention ran out.
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const MAX_LINES = 400;

export function fileHunks(path, patch = '') {
  const hunks = [];
  let current = null;
  for (const line of String(patch).split('\n')) {
    const match = HEADER.exec(line);
    if (match) {
      current = { path, header: line.slice(0, 200), oldStart: Number(match[1]), newStart: Number(match[3]), added: 0, removed: 0, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
    else if (!line.startsWith(' ') && line !== '') continue;
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
      entries.push({ id: `${index}.${position + 1}`, ...rest });
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

// Line numbers counted by hand drift by one; the text of the line does not. Finds the added (RIGHT) or
// removed (LEFT) line of a patch whose content equals the given text, preferring the one nearest a hint.
export function findChangedLine(patch, side, text, near) {
  const wanted = String(text).trim();
  const candidates = [];
  for (const hunk of fileHunks('', patch)) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (side === 'RIGHT' && line.startsWith('+') && line.slice(1).trim() === wanted) candidates.push(newLine);
      if (side === 'LEFT' && line.startsWith('-') && line.slice(1).trim() === wanted) candidates.push(oldLine);
      if (!line.startsWith('+')) oldLine++;
      if (!line.startsWith('-')) newLine++;
    }
  }
  if (!candidates.length) return { error: `no ${side === 'RIGHT' ? 'added' : 'removed'} line reads "${wanted.slice(0, 80)}"` };
  if (candidates.length === 1) return { line: candidates[0] };
  if (near) return { line: candidates.reduce((best, line) => (Math.abs(line - near) < Math.abs(best - near) ? line : best)) };
  return { error: `"${wanted.slice(0, 80)}" appears on lines ${candidates.join(', ')}; pass line as well to choose one` };
}

// Accepts "7.2", a whole file as "7.*", a range as "7.2-7.5", and any comma-separated mix.
export function expandIds(spec, entries = []) {
  const ids = [];
  for (const part of String(spec).split(',').map(x => x.trim()).filter(Boolean)) {
    const wildcard = /^(\d+)\.\*$/.exec(part);
    if (wildcard) { ids.push(...entries.filter(x => x.id.startsWith(`${wildcard[1]}.`)).map(x => x.id)); continue; }
    const range = /^(\d+)\.(\d+)\s*-\s*(?:(\d+)\.)?(\d+)$/.exec(part);
    if (range) {
      const file = range[1];
      if (range[3] && range[3] !== file) throw new Error(`A hunk range cannot span files: ${part}`);
      const [from, to] = [Number(range[2]), Number(range[4])];
      if (to < from || to - from > 5000) throw new Error(`Invalid hunk range: ${part}`);
      for (let i = from; i <= to; i++) ids.push(`${file}.${i}`);
      continue;
    }
    if (!/^\d+\.\d+$/.test(part)) throw new Error(`Invalid hunk identifier: ${part}. Use "7.2", "7.*" or "7.2-7.5".`);
    ids.push(part);
  }
  return ids;
}

// Rejects a draft whose author skipped part of the diff, and says exactly what is missing.
export function coverageGaps(entries, coverage = []) {
  const seen = new Map();
  for (const claim of coverage) {
    for (const id of expandIds(claim.hunks, entries)) {
      if (seen.has(id)) throw new Error(`Hunk ${id} is claimed twice; each hunk needs exactly one verdict`);
      seen.set(id, claim.verdict);
    }
  }
  const known = new Set(entries.map(x => x.id));
  const unknown = [...seen.keys()].filter(id => !known.has(id));
  if (unknown.length) throw new Error(`Unknown hunk identifiers: ${unknown.slice(0, 10).join(', ')}. Re-read the ledger from step=read.`);
  return entries.filter(x => !seen.has(x.id)).map(x => x.id);
}
