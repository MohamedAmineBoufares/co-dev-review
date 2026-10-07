import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, exec as execShell } from 'node:child_process';
import { promisify } from 'node:util';
import { localDir, required } from './config.js';

const run = promisify(execFile);
const shell = promisify(execShell);
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[\w][\w./-]*$/;
const MAX_FILE = 2_000_000;
// Lifecycle scripts are skipped: the reviewed change controls them, and tsc and eslint do not need them.
const INSTALL = {
  pnpm: { lockfile: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile --prefer-offline --ignore-scripts' },
  npm: { lockfile: 'package-lock.json', command: 'npm ci --prefer-offline --ignore-scripts --no-audit --no-fund' },
  yarn: { lockfile: 'yarn.lock', command: 'yarn install --frozen-lockfile --ignore-scripts' },
};
export const packageManagers = ['auto', 'link', ...Object.keys(INSTALL), 'none'];
// The manager a repository uses, from its lockfile, so the assistant can propose it when asking.
export function detectPackageManager(dir) {
  return Object.entries(INSTALL).find(([, x]) => dir && fs.existsSync(path.join(dir, x.lockfile)))?.[0] ?? null;
}
const hashFile = file => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

// Every node_modules folder of the user's checkout, to depth 3 (root, apps/*, packages/*/sub).
function moduleDirs(root, depth = 3, relative = '') {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.name === 'node_modules') { found.push(relative); continue; }
    if (depth > 1) found.push(...moduleDirs(root, depth - 1, child));
  }
  return found;
}
function removeLink(target) {
  try { fs.unlinkSync(target); } catch { try { fs.rmdirSync(target); } catch { /* already gone */ } }
}

async function git(cwd, args, timeout = 60000) {
  try { return (await run('git', ['--no-pager', ...args], { cwd, windowsHide: true, timeout, maxBuffer: 24_000_000 })).stdout; }
  catch (error) {
    if (error.killed || error.signal) throw new Error(`git ${args[0]} timed out`);
    throw new Error(`git ${args[0]} failed: ${String(error.stderr || error.message).trim().slice(0, 300)}`);
  }
}
const committed = async (cwd, sha) => { try { await git(cwd, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };

// Only worktrees this server created are ever moved; a colleague's or the user's own are left alone.
export class Worktrees {
  constructor(config, registry = path.join(localDir, 'worktrees.json')) { this.config = config; this.registry = registry; }
  key(target) { return `${target.provider}:${target.project || this.config.GITLAB_PROJECT_ID}:${target.number}`; }
  load() { try { return JSON.parse(fs.readFileSync(this.registry, 'utf8')); } catch { return {}; } }
  save(entries) {
    fs.mkdirSync(path.dirname(this.registry), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.registry, JSON.stringify(entries, null, 2), { mode: 0o600 });
  }

  // A fetched MR ref from the wrong repository would make every later pass analyse unrelated code.
  async assertSameProject(root, remote, review) {
    const projectPath = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/merge_requests|pull)\/\d+/.exec(review.url ?? '')?.[1]?.toLowerCase();
    if (!projectPath) return;
    const url = (await git(root, ['remote', 'get-url', remote])).trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
    if (!url.replace(/^[^@]+@([^:]+):/, '$1/').endsWith('/' + projectPath)) throw new Error(`Remote "${remote}" of REVIEW_REPO_ROOT is ${url}, not ${projectPath}. Point REVIEW_REPO_ROOT or REVIEW_REMOTE at a checkout of this project.`);
  }

  async prepare(providers, target, { install = true, packageManager = 'auto' } = {}) {
    const root = path.resolve(required(this.config, 'REVIEW_REPO_ROOT'));
    const remote = this.config.REVIEW_REMOTE || 'origin';
    if (!BRANCH.test(remote)) throw new Error('Invalid REVIEW_REMOTE');
    const review = await providers.review(target);
    if (!['opened', 'open'].includes(review.state)) throw new Error('Review is not open');
    if (!SHA.test(String(review.head))) throw new Error('Review has no head commit');
    await this.assertSameProject(root, remote, review);

    const number = target.number;
    const localRef = `refs/co-dev/${target.provider}-${number}`;
    const headRef = target.provider === 'gitlab' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`;
    await git(root, ['fetch', '--no-tags', remote, `+${headRef}:${localRef}`], 180000);
    if (review.targetBranch && BRANCH.test(review.targetBranch)) await git(root, ['fetch', '--no-tags', remote, review.targetBranch], 180000);
    const fetched = (await git(root, ['rev-parse', `${localRef}^{commit}`])).trim();
    if (fetched !== review.head) throw new Error(`Fetched ${fetched.slice(0, 8)} but the review head is ${review.head.slice(0, 8)}; it moved during the fetch. Retry.`);
    const base = review.refs?.base_sha;
    if (!SHA.test(String(base)) || !await committed(root, base)) throw new Error('The review base commit is not available locally after fetching the target branch.');

    const parent = this.config.REVIEW_WORKTREE_DIR ? path.resolve(this.config.REVIEW_WORKTREE_DIR) : path.dirname(root);
    const dir = path.join(parent, `${path.basename(root)}-review-${target.provider === 'gitlab' ? 'mr' : 'pr'}${number}`);
    const entries = this.load();
    const previous = entries[this.key(target)];
    const reused = fs.existsSync(dir);
    if (reused) {
      if (previous?.path !== dir) throw new Error(`${dir} already exists and was not created by this server. Remove it, or set REVIEW_WORKTREE_DIR.`);
      if ((await git(dir, ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error(`${dir} has local modifications. Commit, stash or discard them before the review worktree is moved.`);
      await git(dir, ['checkout', '--detach', '--quiet', review.head]);
    } else {
      fs.mkdirSync(parent, { recursive: true });
      await git(root, ['worktree', 'add', '--detach', dir, review.head], 180000);
    }

    const dependencies = await this.install({ root, dir, base, head: review.head, previous, packageManager: install ? packageManager : 'none' });
    entries[this.key(target)] = { path: dir, head: review.head, base, targetBranch: review.targetBranch, lockHash: dependencies.lockHash ?? undefined, linked: dependencies.linked, preparedAt: new Date().toISOString() };
    this.save(entries);
    const { lockHash, linked, ...installReport } = dependencies;
    return {
      worktree: dir, head: review.head, base, targetBranch: review.targetBranch, reused, install: installReport,
      note: 'Your own checkout was not touched. step=checks and step=blast_radius with this same target now run in this worktree against the review base, and read_file at this head is served from disk. Their runIds are what prepare_comments requires as deterministic evidence.',
    };
  }

  // Dependencies for the worktree, cheapest correct option first:
  // - link: when the change touches neither the lockfile nor any package.json, the user's own
  //   node_modules already hold exactly these dependencies; junctions make that take seconds;
  // - install with the chosen manager otherwise, or when asked;
  // - none: the caller only wants the source (checks may then be unavailable).
  async install({ root, dir, base, head, previous, packageManager = 'auto' }) {
    const manager = ['auto', 'link', 'none'].includes(packageManager) ? detectPackageManager(dir) : packageManager;
    const lockfile = manager && INSTALL[manager]?.lockfile;
    const lockHash = lockfile ? hashFile(path.join(dir, lockfile)) : null;
    // Links from a previous run point into the user's checkout: an install through them would modify it.
    const unlinkPrevious = () => { for (const relative of previous?.linked ?? []) removeLink(path.join(dir, relative, 'node_modules')); };
    if (packageManager === 'none') return { status: 'skipped', reason: 'the user chose no dependency install; tsc, eslint and tests may be unavailable', linked: previous?.linked, lockHash: previous?.lockHash ?? null };
    if (!manager) return { status: 'not-needed', reason: 'no lockfile at the worktree root' };

    if (packageManager === 'auto' || packageManager === 'link') {
      const changed = (await git(dir, ['diff', '--name-only', `${base}...${head}`])).split('\n').map(x => x.trim()).filter(Boolean);
      const dependencyChange = changed.find(file => file === lockfile || /(^|\/)package\.json$/.test(file));
      const sameLock = lockHash && lockHash === hashFile(path.join(root, lockfile));
      const sources = sameLock && !dependencyChange ? moduleDirs(root) : [];
      if (sources.length && (previous?.linked?.length || !fs.existsSync(path.join(dir, 'node_modules')))) {
        const linked = [];
        for (const relative of sources) {
          const target = path.join(dir, relative, 'node_modules');
          if (!fs.existsSync(path.join(dir, relative))) continue;
          if (previous?.linked?.includes(relative)) { linked.push(relative); continue; }
          if (fs.existsSync(target)) continue;
          // "junction" is the only directory link Windows grants without elevation.
          fs.symlinkSync(path.join(root, relative, 'node_modules'), target, process.platform === 'win32' ? 'junction' : 'dir');
          linked.push(relative);
        }
        return { status: 'linked', manager, folders: linked.length, linked, lockHash,
          note: 'Dependencies are linked from your own checkout because this change touches neither the lockfile nor a package.json. Workspace packages resolve to your checkout\'s versions; use packageManager "pnpm"/"npm"/"yarn" for a fully separate install.' };
      }
      if (packageManager === 'link') return { status: 'skipped', reason: dependencyChange ? `linking refused: the change modifies ${dependencyChange}` : 'linking refused: your checkout has a different lockfile or no node_modules', lockHash: null };
    }

    unlinkPrevious();
    if (fs.existsSync(path.join(dir, 'node_modules')) && previous?.lockHash === lockHash && !previous?.linked?.length) return { status: 'up-to-date', manager, lockHash };
    const command = INSTALL[manager].command;
    const started = Date.now();
    try {
      await shell(command, { cwd: dir, windowsHide: true, timeout: 600000, maxBuffer: 24_000_000 });
      return { status: 'installed', manager, command, durationMs: Date.now() - started, lockHash };
    } catch (error) {
      return { status: 'failed', manager, command, error: String(error.stderr || error.stdout || error.message).trim().slice(-1000), lockHash: null };
    }
  }

  // The worktree a deterministic pass runs in, refused if anything moved it off the prepared commit.
  async at(target) {
    const entry = this.load()[this.key(target)];
    if (!entry || !fs.existsSync(entry.path)) throw new Error('No review worktree for this target. Run step=checkout with the target first.');
    const head = (await git(entry.path, ['rev-parse', 'HEAD'])).trim();
    if (head !== entry.head) throw new Error('The review worktree is no longer at the prepared commit. Run step=checkout again.');
    return entry;
  }

  async status(target) {
    try { return await this.at(target); } catch { return null; }
  }

  // Served from disk when the worktree is exactly at the requested commit; otherwise the caller asks the provider.
  async source(target, file, ref) {
    const entry = await this.status(target);
    if (!entry || entry.head !== ref) return null;
    const absolute = path.resolve(entry.path, file);
    if (!absolute.startsWith(path.resolve(entry.path) + path.sep)) throw new Error('File path must be repository-relative without traversal');
    let stats;
    try { stats = fs.statSync(absolute); } catch { throw new Error(`${file} does not exist at ${ref.slice(0, 8)}`); }
    if (!stats.isFile() || stats.size > MAX_FILE) throw new Error('File is too large or a directory');
    return { file, ref, content: fs.readFileSync(absolute, 'utf8'), source: 'worktree' };
  }
}

export async function gitRefs(cwd, base) {
  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
  const resolved = (await git(cwd, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  return { head, base: resolved };
}

// Review worktrees this server created, and a removal that unlinks borrowed node_modules first:
// a plain `git worktree remove --force` could otherwise delete through the links into the user's checkout.
export async function listWorktrees(config) {
  return Object.entries(new Worktrees(config).load()).map(([key, entry]) => ({ key, ...entry, exists: fs.existsSync(entry.path) }));
}
export async function removeWorktree(config, key) {
  const worktrees = new Worktrees(config);
  const entries = worktrees.load();
  const entry = entries[key];
  if (!entry) throw new Error(`No review worktree ${key}`);
  for (const relative of entry.linked ?? []) removeLink(path.join(entry.path, relative, 'node_modules'));
  if (fs.existsSync(entry.path)) await git(path.resolve(required(config, 'REVIEW_REPO_ROOT')), ['worktree', 'remove', '--force', entry.path], 180000);
  delete entries[key];
  worktrees.save(entries);
  return entry.path;
}
