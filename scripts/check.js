import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Static checks that need no network and no credentials: every module parses, every skill is
// well formed, and every skill the server routes to actually ships with the package.
const root = fileURLToPath(new URL('../', import.meta.url));
const problems = [];

const sources = ['src', 'scripts', 'test'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)));
for (const file of sources) {
  try { execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }); }
  catch (error) { problems.push(`${file}: ${String(error.stderr).trim().split('\n').slice(0, 4).join(' ')}`); }
}

const skillsDir = path.join(root, 'skills');
const skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
for (const name of skills) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!fs.existsSync(file)) { problems.push(`skills/${name}: no SKILL.md`); continue; }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
  const declared = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (declared !== name) problems.push(`skills/${name}/SKILL.md: name is "${declared ?? 'missing'}", expected "${name}"`);
  if (!/^description:\s*\S/m.test(front)) problems.push(`skills/${name}/SKILL.md: missing description`);
}

const routed = [...fs.readFileSync(path.join(root, 'src', 'rubrics.js'), 'utf8').matchAll(/skill: '([\w-]+)'/g)].map(m => m[1]);
for (const name of new Set(routed)) if (!skills.includes(name)) problems.push(`src/rubrics.js routes to "${name}", which is not in skills/`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
if (pkg.version !== plugin.version) problems.push(`package.json ${pkg.version} and .claude-plugin/plugin.json ${plugin.version} disagree`);

if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`ok: ${sources.length} modules, ${skills.length} skills, ${new Set(routed).size} routed rubrics, version ${pkg.version}`);
