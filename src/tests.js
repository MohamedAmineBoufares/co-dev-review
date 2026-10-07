import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { required } from './config.js';
import { splitUnifiedDiff } from './hunks.js';
import { resolveBin } from './checks.js';

const exec = promisify(execFile);
// Running the reviewed project's tests turns "this looks wrong" into "this test fails". Only the
// tests related to the changed files run, and only counts and failures come back, never the log.
const SOURCE = /\.(m|c)?[jt]sx?$/;
const SAFE_PATH = /^[\w.@/+-]+$/;
const TIMEOUT = 600000;
const MAX_PROJECTS = 4;
const MAX_FAILURES = 20;
const ANSI = /\u001b\[[0-9;]*m/g;

const within = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// The nearest package that declares a test runner governs a file; monorepos keep it per application.
function runnerFor(root, file) {
  let dir = path.dirname(path.resolve(root, file));
  while (within(root, dir)) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const hasVitestConfig = fs.readdirSync(dir).some(name => /^vitest\.config\./.test(name) || /^vite\.config\./.test(name) && deps.vitest);
      if (deps.vitest || hasVitestConfig) return { dir, runner: 'vitest' };
      if (deps.jest) return { dir, runner: 'jest' };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function command(root, group, outputFile) {
  const files = group.files.map(file => path.relative(group.dir, path.resolve(root, file)).replaceAll('\\', '/'));
  if (group.runner === 'vitest') {
    const bin = resolveBin(root, group.dir, 'vitest', 'vitest.mjs');
    return bin && [bin, 'related', '--run', '--passWithNoTests', '--reporter=json', `--outputFile=${outputFile}`, ...files];
  }
  const bin = resolveBin(root, group.dir, 'jest', 'bin', 'jest.js');
  return bin && [bin, '--ci', '--passWithNoTests', '--findRelatedTests', ...files, '--json', `--outputFile=${outputFile}`];
}

const firstLines = (text, lines = 4) => String(text ?? '').replace(ANSI, '').split('\n').map(x => x.trimEnd()).filter(Boolean).slice(0, lines).join('\n').slice(0, 500);

// Vitest's JSON reporter follows Jest's format, so one reader serves both.
export function summarizeTestReport(report, root) {
  const failures = [], suiteErrors = [];
  for (const suite of report.testResults ?? []) {
    const file = path.relative(root, suite.name ?? '').replaceAll('\\', '/');
    for (const test of suite.assertionResults ?? []) {
      if (test.status === 'failed') failures.push({ file, test: test.fullName ?? test.title, message: firstLines((test.failureMessages ?? []).join('\n')) });
    }
    if (suite.status === 'failed' && !(suite.assertionResults ?? []).some(t => t.status === 'failed')) suiteErrors.push({ file, message: firstLines(suite.message ?? suite.failureMessage) });
  }
  return {
    total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0), failedSuites: report.numFailedTestSuites ?? suiteErrors.length,
    failures: failures.slice(0, MAX_FAILURES), moreFailures: Math.max(0, failures.length - MAX_FAILURES) || undefined,
    suiteErrors: suiteErrors.slice(0, 5),
  };
}

export async function runTests(config, { mode = 'working', base = 'HEAD' } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./~^@{}-]*$/.test(base)) throw new Error('Invalid base ref');
  if (!['working', 'staged', 'branch'].includes(mode)) throw new Error('Invalid diff mode');
  const root = path.resolve(required(config, 'REVIEW_REPO_ROOT'));
  const range = mode === 'staged' ? ['--cached'] : mode === 'branch' ? [`${base}...HEAD`] : ['HEAD'];
  let diff;
  try { diff = (await exec('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--unified=0', ...range, '--'], { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 24_000_000 })).stdout; }
  catch { throw new Error('Git read failed. Check REVIEW_REPO_ROOT and the base ref.'); }

  const changed = splitUnifiedDiff(diff).map(file => file.path);
  const files = changed.filter(file => SOURCE.test(file) && SAFE_PATH.test(file) && fs.existsSync(path.resolve(root, file)));
  if (!changed.length) return { mode, base, changedFileCount: 0, projects: [], note: 'No changed files in this range, so no tests ran. If a change was expected, the checkout is on the wrong branch or the base is wrong.' };

  const groups = new Map();
  const unsupported = [];
  for (const file of files) {
    const found = runnerFor(root, file);
    if (!found) { unsupported.push(file); continue; }
    const key = `${found.runner}:${found.dir}`;
    if (!groups.has(key)) groups.set(key, { ...found, files: [] });
    groups.get(key).files.push(file);
  }

  const projects = [];
  for (const group of [...groups.values()].slice(0, MAX_PROJECTS)) {
    const project = path.relative(root, group.dir).replaceAll('\\', '/') || '.';
    const outputFile = path.join(os.tmpdir(), `co-dev-tests-${randomUUID()}.json`);
    const args = command(root, group, outputFile);
    if (!args) { projects.push({ project, runner: group.runner, status: 'unavailable', reason: `${group.runner} is not installed for this project; run step=checkout to install dependencies` }); continue; }
    const started = Date.now();
    let output = '';
    try { await exec(process.execPath, args, { cwd: group.dir, windowsHide: true, timeout: TIMEOUT, maxBuffer: 24_000_000, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' } }); }
    catch (error) {
      // Failing tests exit non-zero; that is a result, not an error. A timeout or a crash without a report is.
      if (error.killed || error.signal) { projects.push({ project, runner: group.runner, status: 'timed-out', durationMs: Date.now() - started }); continue; }
      output = String(error.stderr || error.stdout || error.message);
    }
    const report = readJson(outputFile);
    fs.rmSync(outputFile, { force: true });
    if (!report) { projects.push({ project, runner: group.runner, status: 'failed-to-run', error: firstLines(output, 8) }); continue; }
    const summary = summarizeTestReport(report, root);
    projects.push({ project, runner: group.runner, status: summary.failed || summary.failedSuites ? 'failing' : 'passing', durationMs: Date.now() - started, files: group.files.length, ...summary });
  }

  return {
    mode, base, changedFileCount: changed.length, projects,
    skippedProjects: groups.size > MAX_PROJECTS ? groups.size - MAX_PROJECTS : undefined,
    filesWithoutRunner: unsupported.length ? unsupported.slice(0, 20) : undefined,
    note: 'Only tests related to the changed files ran (vitest related / jest --findRelatedTests). A failing test on this change is strong evidence for a finding; quote its name and message. A project that did not run proves nothing; disclose it. Test code from the reviewed change was executed.',
  };
}
