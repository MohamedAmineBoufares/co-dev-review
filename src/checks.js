import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { required } from './config.js';
import { fileHunks, splitUnifiedDiff } from './hunks.js';

const exec = promisify(execFile);
// Compilers and linters have perfect recall on the mistakes they know about. Running them first
// keeps the reviewer's attention for the judgement calls a tool cannot make.
const SAFE_PATH = /^[\w.@/+-]+$/;
const TIMEOUT = 240000;
const MAX_GROUPS = 6;
const TS_CONFIG = ['tsconfig.json'];
const ESLINT_CONFIG = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml'];

const within = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
// Monorepos keep their real configuration next to each application, not at the repository root.
function nearestDir(root, from, names) {
  let current = path.resolve(from);
  while (within(root, current)) {
    if (names.some(name => fs.existsSync(path.join(current, name)))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
// pnpm hoists to the workspace root, npm workspaces may not; look upward either way.
function resolveBin(root, from, ...parts) {
  let current = path.resolve(from);
  while (within(root, current)) {
    const file = path.join(current, 'node_modules', ...parts);
    if (fs.existsSync(file)) return file;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// Changed files grouped by the configuration that actually governs them.
function groupByConfig(root, files, names, pattern) {
  const groups = new Map();
  for (const file of files.filter(x => pattern.test(x) && SAFE_PATH.test(x))) {
    const dir = nearestDir(root, path.dirname(path.resolve(root, file)), names);
    if (!dir) continue;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  return [...groups].map(([dir, members]) => ({ dir, files: members }));
}

function dotnetTarget(config, cwd) {
  if (config.REVIEW_DOTNET_PROJECT) return path.resolve(cwd, config.REVIEW_DOTNET_PROJECT);
  const roots = [cwd, ...fs.readdirSync(cwd, { withFileTypes: true }).filter(x => x.isDirectory() && !x.name.startsWith('.') && x.name !== 'node_modules').slice(0, 40).map(x => path.join(cwd, x.name))];
  for (const extension of ['.sln', '.slnx', '.csproj']) {
    for (const root of roots) {
      const hit = fs.readdirSync(root).find(name => name.endsWith(extension));
      if (hit) return path.join(root, hit);
    }
  }
  return null;
}

const relativeTo = (root, base, file) => path.relative(root, path.resolve(base, file)).replaceAll('\\', '/');
async function capture(command, args, cwd) {
  // Every runner here exits non-zero precisely when it has something to report.
  try { const { stdout } = await exec(command, args, { cwd, windowsHide: true, timeout: TIMEOUT, maxBuffer: 24_000_000 }); return stdout; }
  catch (error) {
    if (error.killed || error.signal) throw new Error(`Timed out after ${TIMEOUT / 1000}s`);
    if (typeof error.stdout === 'string' && (error.stdout || typeof error.code === 'number')) return error.stdout;
    throw new Error('Runner could not be started. Check that it is installed in the reviewed repository.');
  }
}

const TS_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const MSBUILD_LINE = /^\s*(.+?)\((\d+),(\d+)\): (error|warning) ([A-Z]+\d+): (.*?)(?: \[[^\]]*\])?\s*$/;
function parseLines(output, pattern, root, base) {
  const found = [];
  for (const line of output.split('\n')) {
    const match = pattern.exec(line.trimEnd());
    if (match) found.push({ path: relativeTo(root, base, match[1]), line: Number(match[2]), column: Number(match[3]), severity: match[4], rule: match[5], message: match[6].trim() });
  }
  return found;
}

const RUNNERS = {
  tsc: {
    reason: 'no tsconfig.json governs the changed files, or typescript is not installed in the reviewed repository',
    plan: (root, files) => groupByConfig(root, files, TS_CONFIG, /\.(m|c)?tsx?$/).filter(group => resolveBin(root, group.dir, 'typescript', 'bin', 'tsc')),
    run: async (root, group) => parseLines(await capture(process.execPath, [resolveBin(root, group.dir, 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false'], group.dir), TS_LINE, root, group.dir),
  },
  eslint: {
    reason: 'no ESLint configuration governs the changed files, or eslint is not installed in the reviewed repository',
    plan: (root, files) => groupByConfig(root, files, ESLINT_CONFIG, /\.(m|c)?[jt]sx?$/).filter(group => resolveBin(root, group.dir, 'eslint', 'bin', 'eslint.js')),
    run: async (root, group) => {
      const targets = group.files.map(file => path.relative(group.dir, path.resolve(root, file)).replaceAll('\\', '/'));
      const output = await capture(process.execPath, [resolveBin(root, group.dir, 'eslint', 'bin', 'eslint.js'), '--format', 'json', '--no-error-on-unmatched-pattern', ...targets], group.dir);
      const start = output.indexOf('[');
      if (start < 0) throw new Error('ESLint produced no JSON report');
      return JSON.parse(output.slice(start)).flatMap(result => result.messages.map(message => ({
        path: relativeTo(root, group.dir, result.filePath), line: message.line ?? 0, column: message.column ?? 0,
        severity: message.severity === 2 ? 'error' : 'warning', rule: message.ruleId || 'parse', message: message.message,
      })));
    },
  },
  dotnet: {
    reason: 'no .sln/.csproj found under REVIEW_REPO_ROOT; set REVIEW_DOTNET_PROJECT to point at one',
    plan: (root, files, config) => {
      if (!files.some(file => /\.(cs|razor|cshtml)$/.test(file))) return [];
      const target = dotnetTarget(config, root);
      return target ? [{ dir: path.dirname(target), target }] : [];
    },
    run: async (root, group) => {
      if (!SAFE_PATH.test(path.relative(root, group.target).replaceAll('\\', '/'))) throw new Error('Unsupported characters in the .NET project path');
      return parseLines(await capture('dotnet', ['build', group.target, '--nologo', '-v', 'q', '-clp:NoSummary'], root), MSBUILD_LINE, root, root);
    },
  },
};
export const runnerNames = Object.keys(RUNNERS);

// New line numbers introduced by this change, so a pre-existing warning is never billed to it.
function addedLines(file) {
  const lines = new Set();
  for (const hunk of fileHunks(file.path, file.patch)) {
    let line = hunk.newStart;
    for (const text of hunk.lines) {
      if (text.startsWith('-')) continue;
      if (text.startsWith('+')) lines.add(line);
      line++;
    }
  }
  return lines;
}

export async function runChecks(config, { mode = 'working', base = 'HEAD', only } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./~^@{}-]*$/.test(base)) throw new Error('Invalid base ref');
  if (!['working', 'staged', 'branch'].includes(mode)) throw new Error('Invalid diff mode');
  const root = path.resolve(required(config, 'REVIEW_REPO_ROOT'));
  const git = async args => (await exec('git', ['--no-pager', ...args], { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 24_000_000 })).stdout;
  const range = mode === 'staged' ? ['--cached'] : mode === 'branch' ? [`${base}...HEAD`] : ['HEAD'];
  let diff;
  try { diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--unified=0', ...range, '--']); }
  catch { throw new Error('Git read failed. Check REVIEW_REPO_ROOT and the base ref.'); }

  const touched = splitUnifiedDiff(diff);
  const files = touched.map(file => file.path);
  if (!files.length) return { mode, base, changedFileCount: 0, runners: {}, note: 'No changed files in this range, so nothing was checked. If a change was expected, the checkout is on the wrong branch or the base is wrong; nothing here proves the change under review is clean.' };
  const added = new Map(touched.map(file => [file.path, addedLines(file)]));
  const allowed = only?.length ? only : runnerNames;
  const runners = {};

  await Promise.all(Object.entries(RUNNERS).map(async ([name, runner]) => {
    if (!allowed.includes(name)) return;
    let groups;
    try { groups = runner.plan(root, files, config); } catch { groups = []; }
    if (!groups.length) { runners[name] = { status: 'unavailable', reason: runner.reason }; return; }
    const started = Date.now();
    const projects = groups.slice(0, MAX_GROUPS);
    const all = [];
    const failures = [];
    await Promise.all(projects.map(async group => {
      try { all.push(...await runner.run(root, group)); }
      catch (error) { failures.push({ project: path.relative(root, group.dir).replaceAll('\\', '/') || '.', error: error.message }); }
    }));
    const scoped = all.filter(item => files.includes(item.path));
    runners[name] = {
      status: failures.length === projects.length ? 'failed' : 'ran',
      durationMs: Date.now() - started,
      projects: projects.map(group => path.relative(root, group.dir).replaceAll('\\', '/') || '.'),
      skippedProjects: groups.length > MAX_GROUPS ? groups.length - MAX_GROUPS : undefined,
      failures: failures.length ? failures : undefined,
      onChangedLines: scoped.filter(item => added.get(item.path)?.has(item.line)).slice(0, 200),
      elsewhereInChangedFiles: scoped.filter(item => !added.get(item.path)?.has(item.line)).slice(0, 100),
      outsideChangedFilesCount: all.length - scoped.length,
    };
  }));

  return {
    mode, base, changedFileCount: files.length, runners,
    note: 'Findings on changed lines belong to this change and must be triaged, not rediscovered by reading. Findings elsewhere in the same files are pre-existing context. A runner that is unavailable, failed, or skipped projects proves nothing about the code it did not see; disclose it in the review.',
  };
}
