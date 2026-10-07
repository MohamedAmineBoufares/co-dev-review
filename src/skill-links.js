import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.js';

// Clients that read SKILL.md get links, not copies, so editing a rubric here updates every client.
export const skillsSource = path.join(projectRoot, 'skills');
export const packagedSkills = () => fs.readdirSync(skillsSource, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsSource, entry.name, 'SKILL.md')))
  .map(entry => entry.name);

const linkTarget = file => {
  try {
    const stats = fs.lstatSync(file);
    return stats.isSymbolicLink() ? path.resolve(path.dirname(file), fs.readlinkSync(file)) : 'not-a-link';
  } catch { return null; }
};

export function linkSkills(targetDir, { dryRun = false, force = false } = {}) {
  const report = { linked: [], unchanged: [], conflicts: [], failed: [] };
  if (!fs.existsSync(targetDir) && !dryRun) fs.mkdirSync(targetDir, { recursive: true });
  for (const name of packagedSkills()) {
    const from = path.join(targetDir, name), to = path.join(skillsSource, name);
    const current = linkTarget(from);
    if (current && path.resolve(current) === path.resolve(to)) { report.unchanged.push(name); continue; }
    if (current && !force) { report.conflicts.push(name); continue; }
    if (dryRun) { report.linked.push(name); continue; }
    try {
      if (current) fs.rmSync(from, { recursive: true, force: true });
      // "junction" is the only directory link Windows grants without elevation.
      fs.symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir');
      report.linked.push(name);
    } catch (error) { report.failed.push(`${name}: ${error.message}`); }
  }
  return report;
}

// Removes only links that point into this package; a folder the user made is never touched.
export function unlinkSkills(targetDir) {
  const removed = [];
  for (const name of packagedSkills()) {
    const from = path.join(targetDir, name);
    const current = linkTarget(from);
    if (current && current !== 'not-a-link' && path.resolve(current) === path.resolve(skillsSource, name)) {
      fs.rmSync(from, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
