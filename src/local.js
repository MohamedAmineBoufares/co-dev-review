import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { required } from './config.js';
import { ledger, splitUnifiedDiff } from './hunks.js';
import { suggestRubrics } from './rubrics.js';
import { repoSkills } from './repo-skills.js';
const exec = promisify(execFile);
const PAGE_FILES = 100;
const PAGE_BYTES = 200_000;
// git's per-file header (index, ---/+++, modes) carries nothing a reviewer reads beyond the status.
function compactLocalFile(file) {
  const start = file.patch.search(/^@@ /m);
  const header = start < 0 ? file.patch : file.patch.slice(0, start);
  const status = /^new file mode/m.test(header) ? 'added' : /^deleted file mode/m.test(header) ? 'deleted' : /^rename from/m.test(header) ? 'renamed' : 'modified';
  const oldPath = /^rename from (.+)$/m.exec(header)?.[1]?.trim();
  if (start < 0) return { path: file.path, status, unavailable: /^Binary files/m.test(header) ? 'binary' : 'no textual change' };
  return { path: file.path, ...(oldPath ? { oldPath } : {}), status, patch: file.patch.slice(start) };
}
// Pages hold up to 100 files and about 200 KB of patch, so one huge diff never lands in a single response.
function pages(files) {
  const result = [];
  let current = [], size = 0;
  for (const file of files) {
    if (current.length && (current.length >= PAGE_FILES || size + file.patch.length > PAGE_BYTES)) { result.push(current); current = []; size = 0; }
    current.push(file);
    size += file.patch.length;
  }
  if (current.length) result.push(current);
  return result;
}

export async function localDiff(config, { mode = 'working', base = 'HEAD', page = 1 } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./~^@{}-]*$/.test(base)) throw new Error('Invalid base ref');
  if (!['working', 'staged', 'branch'].includes(mode)) throw new Error('Invalid diff mode');
  const cwd = required(config, 'REVIEW_REPO_ROOT');
  const git = async args => {
    try { return (await exec('git', ['--no-pager', ...args], { cwd, windowsHide: true, timeout: 30000, maxBuffer: 12_000_000 })).stdout; }
    catch { throw new Error('Git read failed. Check REVIEW_REPO_ROOT, the base ref, and diff size.'); }
  };
  const head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
  const resolved = (await git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--unified=5'];
  if (mode === 'staged') args.push('--cached');
  if (mode === 'branch') args.push(`${resolved}...${head}`);
  else if (mode === 'working') args.push(head);
  args.push('--');
  const [diff, status] = await Promise.all([git(args), git(['status', '--short'])]);
  const files = splitUnifiedDiff(diff);
  const split = pages(files);
  const current = split[page - 1] ?? [];
  const startIndex = split.slice(0, page - 1).reduce((n, group) => n + group.length, 0);
  const result = { head, base: resolved, mode, page, fileCount: files.length,
    changes: current.map(compactLocalFile), hunks: ledger(current, startIndex),
    nextPage: page < split.length ? page + 1 : null };
  if (page > 1) return { ...result, note: 'Rubrics, repoSkills and status were returned with page 1.' };
  return { ...result, status,
    rubrics: suggestRubrics(files.map(file => file.path)), repoSkills: repoSkills(config),
    note: 'Read-only snapshot. Continue nextPage until null. Untracked file contents are not in git diff; inspect them separately. Load the skills named in rubrics (or fetch their text with step=rubric) and read the repoSkills that match this change before judging the code, and account for every hunk id. Run step=checks, step=blast_radius and step=tests before concluding: they surface what reading a diff cannot.' };
}

// Where the local checkout actually is, so a remote review can say whether checks and blast
// radius will reflect the change under review or some other branch entirely.
export async function localHead(config) {
  const cwd = config?.REVIEW_REPO_ROOT;
  if (!cwd) return null;
  const git = async args => (await exec('git', ['--no-pager', ...args], { cwd, windowsHide: true, timeout: 10000 })).stdout.trim();
  try { return { branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']), head: await git(['rev-parse', 'HEAD']) }; }
  catch { return null; }
}
