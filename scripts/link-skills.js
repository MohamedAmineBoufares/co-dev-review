import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { projectRoot } from '../src/config.js';

// Claude Code loads this repository's skills as a plugin. Codex reads ~/.codex/skills instead,
// and uses the identical SKILL.md format — so a link, not a copy, keeps one source of truth.
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const source = path.join(projectRoot, 'skills');
const target = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'skills') : path.join(os.homedir(), '.codex', 'skills');

const skills = fs.readdirSync(source, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(source, entry.name, 'SKILL.md')))
  .map(entry => entry.name);
if (!skills.length) { console.error(`No skills found in ${source}`); process.exit(1); }

if (!fs.existsSync(target)) {
  if (dryRun) console.log(`would create ${target}`);
  else fs.mkdirSync(target, { recursive: true });
}

let linked = 0, skipped = 0;
for (const name of skills) {
  const from = path.join(target, name);
  const to = path.join(source, name);
  let existing = null;
  try { existing = fs.lstatSync(from); } catch { /* not present */ }
  if (existing) {
    const current = existing.isSymbolicLink() ? path.resolve(path.dirname(from), fs.readlinkSync(from)) : null;
    if (current === path.resolve(to)) { console.log(`= ${name} already linked`); skipped++; continue; }
    if (!force) { console.log(`! ${name} exists and is not our link — leaving it alone (use --force to replace)`); skipped++; continue; }
    if (dryRun) console.log(`would replace ${from}`);
    else fs.rmSync(from, { recursive: true, force: true });
  }
  if (dryRun) { console.log(`would link ${name} -> ${to}`); linked++; continue; }
  try {
    // "junction" is the only directory link Windows grants without elevation.
    fs.symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir');
    console.log(`+ ${name} linked`);
    linked++;
  } catch (error) { console.error(`x ${name}: ${error.message}`); process.exitCode = 1; }
}

console.log(`\n${dryRun ? 'Dry run. ' : ''}${linked} linked, ${skipped} unchanged, in ${target}`);
if (!dryRun && linked) console.log('Restart Codex to pick them up. Remove a link with: rm (or rmdir) the entry in that directory — the originals are untouched.');
