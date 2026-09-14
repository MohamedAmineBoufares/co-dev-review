import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { required } from './config.js';
import { ledger, splitUnifiedDiff } from './hunks.js';
import { suggestRubrics } from './rubrics.js';
import { repoSkills } from './repo-skills.js';
const exec = promisify(execFile);
export async function localDiff(config, { mode = 'working', base = 'HEAD' } = {}) {
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
  return { head, base: resolved, mode, diff, status,
    hunks: ledger(files), rubrics: suggestRubrics(files.map(file => file.path)), repoSkills: repoSkills(config),
    note: 'Read-only snapshot. Untracked file contents are not in git diff; inspect them separately. No commit or push is performed. Load the skills named in rubrics (or fetch their text with step=rubric if this client cannot load skill files) and read the repoSkills files that match this change before judging the code, and account for every hunk id. Run step=checks and step=blast_radius before concluding: they surface what reading a diff cannot.' };
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
