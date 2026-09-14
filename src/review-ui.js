import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localDir } from './config.js';

// Strip terminal control characters from all untrusted review/ticket content before styling it.
export const safe = value => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
const plain = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = code => text => (plain ? String(text) : `\u001b[${code}m${text}\u001b[0m`);
export const style = {
  bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), grey: paint(90),
};
const SEVERITY = { blocker: style.red, major: style.yellow, minor: style.blue, suggestion: style.grey };

// "1,3,5-7", "all" or "none" — one answer instead of one prompt per item.
export function parseSelection(input, count) {
  const text = String(input).trim().toLowerCase();
  if (!text || text === 'none' || text === 'n') return [];
  if (text === 'all' || text === 'a') return Array.from({ length: count }, (_, i) => i + 1);
  const chosen = new Set();
  for (const part of text.split(',').map(x => x.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const numbers = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)];
    if (!Number.isInteger(numbers[0]) || !Number.isInteger(numbers[1]) || numbers[1] < numbers[0]) throw new Error(`Cannot read "${part}". Use numbers, ranges like 2-5, "all" or "none".`);
    for (let i = numbers[0]; i <= numbers[1]; i++) {
      if (i < 1 || i > count) throw new Error(`${i} is not one of the ${count} items.`);
      chosen.add(i);
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

const indent = (text, prefix = '   ') => safe(text).split('\n').map(line => prefix + line).join('\n');
function renderContext(context) {
  if (!context?.snippet) return style.grey('   (no captured diff context)');
  return safe(context.snippet).split('\n').map((line, index) => {
    const marker = index === context.markerIndex ? style.bold(' > ') : '   ';
    const body = line.startsWith('+') ? style.green(line) : line.startsWith('-') ? style.red(line) : style.grey(line);
    return marker + body;
  }).join('\n');
}

export function renderItem(item, position) {
  const head = item.severity
    ? `${(SEVERITY[item.severity] || style.grey)(item.severity.toUpperCase())} ${item.path ? style.bold(`${safe(item.path)}:${item.line}`) : style.dim('general comment')}`
    : style.bold(safe(item.title));
  const lines = [`${style.bold(`[${position}]`)} ${style.dim(item.id)}  ${head}`];
  if (item.path) lines.push(renderContext(item.context), style.grey('   ─────'));
  if (item.estimatedHours !== undefined) lines.push(style.dim(`   estimate: ${item.estimatedHours} h`));
  lines.push(indent(item.body ?? item.description));
  return lines.join('\n');
}

export function renderHeader(draft) {
  const title = draft.snapshot?.title || draft.parent?.fields?.['System.Title'] || '';
  const where = draft.target ? `${draft.target.provider} ${draft.target.project ?? ''} #${draft.target.number}` : `work item ${draft.parent?.id}`;
  const facts = [`${draft.items.length} item${draft.items.length === 1 ? '' : 's'}`, draft.language];
  if (draft.snapshot?.head) facts.push(`head ${draft.snapshot.head.slice(0, 8)}`);
  if (draft.coverage?.hunkCount) facts.push(`${draft.coverage.hunkCount} hunks accounted for`);
  // What the assistant says it applied. Self-reported, but visible to the human before approval,
  // which is the point: an empty list on a React change is a review worth questioning.
  const applied = draft.kind === 'review' && Array.isArray(draft.rubricsApplied)
    ? (draft.rubricsApplied.length ? style.grey(`  rubrics applied: ${draft.rubricsApplied.map(safe).join(', ')}`) : style.yellow('  rubrics applied: none declared'))
    : '';
  return [
    `${style.bold(draft.kind === 'review' ? 'Review comments' : 'Tasks')} ${style.dim(draft.id.slice(0, 8))}  ${safe(where)}`,
    title ? style.dim(`  ${safe(title)}`) : '',
    style.grey(`  ${facts.join(' · ')}`),
    applied,
    draft.snapshot?.url ? style.grey(`  ${safe(draft.snapshot.url)}`) : '',
  ].filter(Boolean).join('\n');
}

// The proposed text is a starting point; the human publishing it should be able to fix a word
// without asking the assistant to regenerate the whole draft.
export async function editInEditor(initial, suffix = '.md') {
  const command = (process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano')).split(/\s+/).filter(Boolean);
  const file = path.join(localDir, `edit-${process.pid}${suffix}`);
  await fs.writeFile(file, initial, { mode: 0o600 });
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command[0], [...command.slice(1), file], { stdio: 'inherit', windowsHide: false });
      child.on('error', () => reject(new Error(`Could not start "${command[0]}". Set the EDITOR environment variable.`)));
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error('Editor exited without saving.');
    const edited = (await fs.readFile(file, 'utf8')).trim();
    if (!edited) throw new Error('Empty text; keeping the previous version.');
    if (edited.length > 30000) throw new Error('Text exceeds the 30000 character limit.');
    return edited;
  } finally { await fs.rm(file, { force: true }); }
}
