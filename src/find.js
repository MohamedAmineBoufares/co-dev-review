import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clip } from './compact.js';
const run = promisify(execFile);
const git = async (cwd, args) => (await run('git', ['--no-pager', ...args], { cwd, windowsHide: true, timeout: 20000, maxBuffer: 24_000_000 })).stdout;

// Paths that read like the one asked for. Import aliases and wrong roots are the usual cause of a miss:
// "@/utils/date" or "componentslibrary/src/utils/date.ts" for applications/componentsLibrary/src/utils/date.ts.
export function matchPaths(paths, wanted) {
  const want = String(wanted).replaceAll('\\', '/').replace(/^(\.{0,2}\/|@\/|~\/)+/, '').toLowerCase();
  const lower = paths.map(path => [path, path.toLowerCase()]);
  const extensionless = !/\.\w+$/.test(want);
  const parts = want.split('/');
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i).join('/');
    const hits = lower.filter(([, have]) => {
      if (have === tail || have.endsWith('/' + tail)) return true;
      if (!extensionless) return false;
      const bare = have.replace(/\.\w+$/, '');
      return bare === tail || bare.endsWith('/' + tail) || bare.endsWith('/' + tail + '/index');
    });
    if (hits.length) return hits.map(([path]) => path);
  }
  return [];
}

// Finds files and text at the review head: in the review worktree or the user's checkout when there is one,
// otherwise through the provider's API.
export class Finder {
  constructor(config, providers, worktrees) { this.config = config; this.providers = providers; this.worktrees = worktrees; this.cache = new Map(); }
  async paths(target, ref) {
    const key = `${target.provider}:${target.project ?? ''}:${ref}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let paths = null;
    const worktree = await this.worktrees.status(target);
    const local = worktree?.head === ref ? worktree.path : this.config.REVIEW_REPO_ROOT;
    // shortcut: the configured checkout is assumed to be this project, and a wrong guess only costs one more 404; verify the remote if that assumption stops holding.
    if (local) {
      try { paths = (await git(local, ['ls-tree', '-r', '--name-only', ref])).split('\n').filter(Boolean); }
      catch { try { paths = (await git(local, ['ls-files'])).split('\n').filter(Boolean); } catch { /* fall through to the API */ } }
    }
    paths ??= await this.providers.tree(target, ref);
    if (this.cache.size > 20) this.cache.clear();
    this.cache.set(key, paths);
    return paths;
  }
  async resolve(target, ref, wanted) { return matchPaths(await this.paths(target, ref), wanted); }
  async find(target, review, { query, path }) {
    const result = { head: review.head };
    if (path) {
      const all = await this.resolve(target, review.head, path);
      result.paths = all.slice(0, 40);
      if (all.length > 40) result.morePaths = all.length - 40;
    }
    if (query) {
      const worktree = await this.worktrees.status(target);
      if (worktree?.head === review.head) {
        let out = '';
        // git grep exits 1 when nothing matches.
        try { out = await git(worktree.path, ['grep', '-n', '-I', '-F', '-e', query, '--', '.']); } catch (error) { if (error.code !== 1) throw new Error('git grep failed in the review worktree'); }
        const lines = out.split('\n').filter(Boolean);
        result.matches = lines.slice(0, 60).map(line => { const [, file, n, text] = /^(.+?):(\d+):(.*)$/.exec(line) ?? []; return { path: file, line: Number(n), text: clip(text?.trim(), 200) }; });
        result.source = 'worktree';
        if (lines.length > 60) result.moreMatches = lines.length - 60;
      } else {
        result.matches = await this.providers.search(target, query, review.sourceBranch);
        result.source = target.provider === 'github' ? 'GitHub code search: default branch only, so code added by this PR is not indexed' : `GitLab search on ${review.sourceBranch}`;
      }
    }
    return result;
  }
}
