import { Store, digest } from './store.js';
import { Providers } from './providers.js';
import { ledger, coverageGaps, anchorContext } from './hunks.js';

// Added/deleted line anchors only; ambiguous context lines are deliberately rejected.
export function anchors(patch = '') {
  let oldLine = 0, newLine = 0;
  let active = false;
  const left = new Set(), right = new Set();
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { active = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (!active) continue;
    if (line.startsWith('+')) right.add(newLine++);
    else if (line.startsWith('-')) left.add(oldLine++);
    else if (line.startsWith(' ')) { oldLine++; newLine++; }
  }
  return { LEFT: left, RIGHT: right };
}
export class Service {
  constructor(config, { providers = new Providers(config), store = new Store() } = {}) { this.providers = providers; this.store = store; }
  async reviewDraft({ target, language, items, coverage = [], rubricsApplied = [] }) {
    target = { ...target, project: target.project || this.providers.config.GITLAB_PROJECT_ID };
    const snapshot = await this.providers.review(target);
    if (!['opened', 'open'].includes(snapshot.state)) throw new Error('Review is not open');
    if (!snapshot.head) throw new Error('Review has no head commit');
    const files = [];
    let complete = false;
    for (let page = 1; page <= 30; page++) {
      const batch = await this.providers.diffs(target, page);
      files.push(...batch);
      if (batch.length < 100) { complete = true; break; }
    }
    if (!complete) throw new Error('Diff exceeds 3000-file limit; review a smaller change');
    // A review that never looked at part of the diff is the most common way findings are missed.
    const entries = ledger(files);
    const gaps = coverageGaps(entries, coverage);
    if (gaps.length) throw new Error(`No verdict for ${gaps.length} of ${entries.length} hunks: ${gaps.slice(0, 25).join(', ')}${gaps.length > 25 ? ', …' : ''}. Read them, then give each a verdict in coverage.`);
    for (const item of items) {
      if (!item.path) continue;
      const file = files.find(f => (f.new_path || f.filename) === item.path);
      if (!file || file.too_large || file.collapsed || !anchors(file.diff ?? file.patch)[item.side].has(item.line)) throw new Error(`Invalid or unavailable changed-line anchor: ${item.path}:${item.line}`);
      if (target.provider === 'gitlab') {
        if (!snapshot.refs?.base_sha || !snapshot.refs?.start_sha || snapshot.refs.head_sha !== snapshot.head) throw new Error('GitLab diff refs are unavailable or still being calculated');
        item.oldPath = file.old_path;
      }
    }
    const current = await this.providers.review(target);
    if (current.head !== snapshot.head) throw new Error('Review changed while loading diffs; retry');
    return this.store.create({ kind: 'review', language, target, destination: this.providers.destination(target),
      snapshot: { head: snapshot.head, refs: snapshot.refs, title: snapshot.title, url: snapshot.url },
      coverage: { hunkCount: entries.length, claims: coverage }, rubricsApplied,
      // Captured now so approval can show the code a comment lands on, without a second fetch.
      items: items.map((x, i) => ({ ...x, id: `R${i + 1}`, context: x.path ? anchorContext(files, x.path, x.line, x.side) : undefined })) });
  }
  async taskDraft({ parentId, language, items }) {
    const parent = await this.providers.ticket(parentId);
    if (!['Bug', 'Product Backlog Item'].includes(parent.fields['System.WorkItemType'])) throw new Error('Parent must be a Bug or Product Backlog Item');
    return this.store.create({ kind: 'tasks', language, destination: this.providers.destination(), parent: { id: parent.id, rev: parent.rev, fields: parent.fields }, items: items.map((x, i) => ({ ...x, id: `T${i + 1}` })) });
  }
  async publish(id) {
    return this.store.withLock(id, async () => {
      const draft = await this.store.read(id);
      const approval = await this.store.approved(draft);
      if (draft.destination !== this.providers.destination(draft.target)) throw new Error('Destination configuration changed. Create and approve a fresh draft.');
      const journal = await this.store.journal(id);
      for (const item of draft.items.filter(x => approval.selectedIds.includes(x.id))) {
        if (journal[item.id]?.state === 'posted') continue;
        if (journal[item.id]) throw new Error(`Item ${item.id} has an uncertain previous attempt. Inspect the provider and reconcile using the local CLI before retrying.`);
        if (draft.kind === 'review') {
          const current = await this.providers.review(draft.target);
          if (current.head !== draft.snapshot.head || !['opened', 'open'].includes(current.state)) throw new Error('PR/MR changed or closed since draft creation. Create and approve a fresh draft.');
        } else {
          const parent = await this.providers.ticket(draft.parent.id);
          const relevant = fields => Object.fromEntries(['System.WorkItemType', 'System.Title', 'System.Description', 'System.State', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Common.AcceptanceCriteria'].map(key => [key, fields[key]]));
          if (digest(relevant(parent.fields)) !== digest(relevant(draft.parent.fields))) throw new Error('Parent ticket changed. Create and approve a fresh task draft.');
        }
        journal[item.id] = { state: 'attempting', at: new Date().toISOString() };
        await this.store.saveJournal(id, journal);
        try {
          const result = draft.kind === 'review' ? await this.providers.postFinding(draft.target, draft.snapshot, item) : await this.providers.createTask(draft.parent, item);
          journal[item.id] = { state: 'posted', remoteId: result.id, url: result.web_url || result.html_url || result.url, at: new Date().toISOString() };
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
