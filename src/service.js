import { Store, digest } from './store.js';
import { Providers } from './providers.js';
import { ledger, resolveCoverage, anchorContext, changedPaths, findChangedLine, hunkAt } from './hunks.js';
import { suggestRubrics } from './rubrics.js';
import { Runs, verifyDeterministic } from './runs.js';
import { makeTrackers, resolveTicket, snapshotChanged } from './trackers.js';
import { compactDiscussions } from './compact.js';

// Lines a comment can land on: added (RIGHT) and deleted (LEFT) ones, plus the unchanged lines shown in a hunk
// (CONTEXT, new line number to old), which providers accept as long as they are inside the diff.
export function anchors(patch = '') {
  let oldLine = 0, newLine = 0;
  let active = false;
  const left = new Set(), right = new Set(), context = new Map();
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { active = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (!active) continue;
    if (line.startsWith('+')) right.add(newLine++);
    else if (line.startsWith('-')) left.add(oldLine++);
    else if (line.startsWith(' ')) context.set(newLine++, oldLine++);
  }
  return { LEFT: left, RIGHT: right, CONTEXT: context };
}
const pathOf = file => file.new_path || file.filename;
const isOpen = review => ['opened', 'open'].includes(review.state);
// One error naming everything wrong: a draft that fails three checks should cost one retry, not three.
function failWith(problems) {
  if (problems.length === 1) throw new Error(problems[0]);
  if (problems.length) throw new Error(`${problems.length} problems; fix them all in one call:\n${problems.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
}

export class Service {
  constructor(config, { providers = new Providers(config), store = new Store(), runs = new Runs(), trackers = makeTrackers(providers), routeRubrics = paths => suggestRubrics(paths).rubrics } = {}) { this.providers = providers; this.store = store; this.runs = runs; this.trackers = trackers; this.routeRubrics = routeRubrics; }
  // Tasks belong to whichever tracker holds the parent ticket; drafts saved before trackers existed are Azure.
  tracker(draft) { return this.trackers[draft.tracker ?? 'azure']; }
  destinationOf(draft) { return draft.kind === 'review' ? this.providers.destination(draft.target) : this.tracker(draft).destination(draft.parent); }
  withProject(target) { return { ...target, project: target.project || this.providers.config.GITLAB_PROJECT_ID }; }
  async allDiffs(target) {
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.providers.diffs(target, page);
      files.push(...batch);
      if (batch.length < 100) return files;
    }
    throw new Error('Diff exceeds 3000-file limit; review a smaller change');
  }
  async openReview(target) {
    const snapshot = await this.providers.review(target);
    if (!isOpen(snapshot)) throw new Error('Review is not open');
    if (!snapshot.head) throw new Error('Review has no head commit');
    return snapshot;
  }
  async reviewDraft({ target, language, items, coverage = [], rubricsApplied = [], rubricsSkipped = [], deterministic }) {
    target = this.withProject(target);
    const snapshot = await this.openReview(target);
    const problems = [];
    let evidence;
    try { evidence = await verifyDeterministic(this.runs, deterministic, snapshot, target); } catch (error) { problems.push(error.message); }
    const files = await this.allDiffs(target);
    const entries = ledger(files);
    // The skill says to load every routed rubric; a declared list that leaves some out is how a review
    // quietly loses its correctness or complexity pass. Each one is applied, or skipped with a reason the approver sees.
    const routed = [...new Set(this.routeRubrics(changedPaths(files)).map(r => r.skill).filter(Boolean))];
    const accounted = new Set([...rubricsApplied, ...rubricsSkipped.map(x => x.name)]);
    const missing = routed.filter(skill => !accounted.has(skill));
    if (missing.length) problems.push(`Rubrics routed for this change but neither applied nor skipped: ${missing.join(', ')}. Load each skill (or fetch it with step=rubric), review the change against it, and list it in rubricsApplied; or declare it in rubricsSkipped with a reason.`);
    const gitlab = target.provider === 'gitlab';
    if (gitlab && items.some(x => x.path) && (!snapshot.refs?.base_sha || !snapshot.refs?.start_sha || snapshot.refs.head_sha !== snapshot.head)) problems.push('GitLab diff refs are unavailable or still being calculated; retry in a moment');
    const findingIds = [];
    for (const item of items) {
      if (!item.path) {
        if (item.suggestion !== undefined) problems.push('A suggestion replaces a line, so it needs an inline comment: give path and lineText');
        continue;
      }
      let file = files.find(f => pathOf(f) === item.path);
      if (!file) {
        // A path typed from memory: same file name, wrong root or case.
        const wanted = item.path.toLowerCase();
        const close = files.filter(f => { const have = String(pathOf(f)).toLowerCase(); return have === wanted || have.endsWith('/' + wanted) || wanted.endsWith('/' + have); });
        if (close.length === 1) { file = close[0]; item.path = pathOf(file); }
      }
      const patch = file?.diff ?? file?.patch;
      if (!file || file.too_large || file.collapsed || !patch) { problems.push(`No diff available for ${item.path}: comment on a file of this change, or make it a general comment (no path) naming the file`); continue; }
      if (item.lineText) {
        const found = findChangedLine(patch, item.side, item.lineText, item.line);
        if (found.error) { problems.push(`Cannot anchor on ${item.path}: ${found.error}`); continue; }
        if (item.line && item.line !== found.line) item.lineCorrectedFrom = item.line;
        item.line = found.line;
        if (found.unchanged) Object.assign(item, { unchanged: true, oldLine: found.oldLine, side: 'RIGHT' });
      } else {
        const valid = anchors(patch);
        if (item.side === 'RIGHT' && !valid.RIGHT.has(item.line) && valid.CONTEXT.has(item.line)) Object.assign(item, { unchanged: true, oldLine: valid.CONTEXT.get(item.line) });
        else if (!valid[item.side].has(item.line)) { problems.push(`Invalid or unavailable changed-line anchor: ${item.path}:${item.line} is not a line of the diff. Anchor with lineText, the exact text of a line shown in the patch.`); continue; }
      }
      if (item.suggestion !== undefined) {
        if (item.side !== 'RIGHT') { problems.push(`A suggestion replaces a line of the new file; ${item.path}:${item.line} is anchored on a removed line`); continue; }
        // The block the author applies with one click; -0+0 is GitLab's "this line only".
        item.body += `\n\n\`\`\`suggestion${gitlab ? ':-0+0' : ''}\n${item.suggestion}\n\`\`\``;
      }
      if (gitlab) item.oldPath = file.old_path;
      findingIds.push(hunkAt(entries, item.path, item.side, item.line));
    }
    // A review that never looked at part of the diff is the most common way findings are missed.
    const covered = resolveCoverage(entries, coverage, findingIds);
    problems.push(...covered.problems);
    failWith(problems);
    // A second reviewer repeating an open thread is noise the approver should see before posting.
    try {
      const open = compactDiscussions(await this.providers.discussions(target, 1)).filter(d => d.resolved !== true).map(d => d.notes?.[0] ?? d).filter(n => n.path && n.line);
      for (const item of items.filter(x => x.path)) {
        const near = open.find(n => n.path === item.path && Math.abs(n.line - item.line) <= 3);
        if (near) item.nearExisting = `${near.author ?? 'someone'} at line ${near.line}: ${String(near.body).replace(/\s+/g, ' ').slice(0, 120)}`;
      }
    } catch { /* the duplicate check is a courtesy; the draft does not depend on it */ }
    const current = await this.providers.review(target);
    if (current.head !== snapshot.head) throw new Error('Review changed while loading diffs; retry');
    return this.store.create({ kind: 'review', language, target, destination: this.providers.destination(target),
      snapshot: { head: snapshot.head, refs: snapshot.refs, title: snapshot.title, url: snapshot.url },
      coverage: { hunkCount: entries.length, claims: coverage, summary: covered.summary, bulk: covered.bulk }, rubricsApplied, rubricsSkipped, deterministic: evidence,
      // Captured now so approval can show the code a comment lands on, without a second fetch.
      items: items.map(({ lineText, suggestion, ...x }, i) => ({ ...x, id: `R${i + 1}`, context: x.path ? anchorContext(files, x.path, x.line, x.side) : undefined })) });
  }
  // Replies to existing threads, for the author answering a review. Same draft, approval and journal as comments.
  async replyDraft({ target, language, replies }) {
    target = this.withProject(target);
    const snapshot = await this.openReview(target);
    const gitlab = target.provider === 'gitlab';
    const threads = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.providers.discussions(target, page);
      threads.push(...batch);
      if (batch.length < 100) break;
    }
    const problems = [];
    const items = replies.map((reply, i) => {
      const thread = threads.find(t => String(t.id) === String(reply.threadId));
      if (!thread) { problems.push(`Unknown thread ${reply.threadId}: use the id of a discussion returned by step=read`); return null; }
      if (reply.resolve && !gitlab) { problems.push(`Thread ${reply.threadId}: GitHub threads cannot be resolved through this API; reply, and resolve it in the browser`); return null; }
      const first = gitlab ? thread.notes?.find(note => !note.system) : thread;
      return { id: `R${i + 1}`, severity: 'reply', body: reply.body, replyTo: String(gitlab ? thread.id : thread.in_reply_to_id ?? thread.id), resolve: reply.resolve || undefined,
        thread: { author: first?.author?.username ?? first?.user?.login, path: first?.position?.new_path ?? first?.path, line: first?.position?.new_line ?? first?.line, said: String(first?.body ?? '').replace(/\s+/g, ' ').slice(0, 200) } };
    });
    failWith(problems);
    return this.store.create({ kind: 'review', language, target, destination: this.providers.destination(target), snapshot: { head: snapshot.head, refs: snapshot.refs, title: snapshot.title, url: snapshot.url }, items });
  }
  async taskDraft({ parentId, tracker, language, items }) {
    const ref = resolveTicket(this.providers.config ?? {}, parentId, tracker);
    const parent = await this.trackers[ref.tracker].loadParent(ref);
    return this.store.create({ kind: 'tasks', tracker: ref.tracker, language, destination: this.trackers[ref.tracker].destination(parent), parent, items: items.map((x, i) => ({ ...x, id: `T${i + 1}` })) });
  }
  async publish(id) {
    return this.store.withLock(id, async () => {
      const draft = await this.store.read(id);
      const approval = await this.store.approved(draft);
      if (draft.destination !== this.destinationOf(draft)) throw new Error('Destination configuration changed. Create and approve a fresh draft.');
      const journal = await this.store.journal(id);
      for (const item of draft.items.filter(x => approval.selectedIds.includes(x.id))) {
        if (journal[item.id]?.state === 'posted') continue;
        if (journal[item.id]) throw new Error(`Item ${item.id} has an uncertain previous attempt. Inspect the provider and reconcile using the local CLI before retrying.`);
        if (draft.kind === 'review') {
          const current = await this.providers.review(draft.target);
          if (current.head !== draft.snapshot.head || !['opened', 'open'].includes(current.state)) throw new Error('PR/MR changed or closed since draft creation. Create and approve a fresh draft.');
        } else {
          const ref = resolveTicket(this.providers.config ?? {}, draft.parent.id, draft.tracker ?? 'azure');
          const current = await this.tracker(draft).loadParent(ref);
          if (snapshotChanged(draft.parent, current)) throw new Error('Parent ticket changed. Create and approve a fresh task draft.');
        }
        journal[item.id] = { state: 'attempting', at: new Date().toISOString() };
        await this.store.saveJournal(id, journal);
        try {
          const result = draft.kind === 'review' ? await this.providers.postFinding(draft.target, draft.snapshot, item) : await this.tracker(draft).createTask(draft.parent, item);
          journal[item.id] = { state: 'posted', remoteId: result.id, url: result.web_url || result.html_url || result.url, at: new Date().toISOString(), ...(result.warning ? { warning: result.warning } : {}) };
          await this.store.saveJournal(id, journal);
        } catch (error) {
          journal[item.id] = { state: 'uncertain', at: new Date().toISOString() };
          await this.store.saveJournal(id, journal);
          throw error;
        }
      }
      return { draftId: id, journal };
    });
  }
}
