import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { localDir } from './config.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Store {
  constructor(root = path.join(localDir, 'drafts')) { this.root = root; }
  file(id, suffix = 'json') {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid draft identifier');
    return path.join(this.root, `${id}.${suffix}`);
  }
  async create(payload) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const draft = { id: randomUUID(), createdAt: new Date().toISOString(), ...payload };
    await fs.writeFile(this.file(draft.id), JSON.stringify(draft, null, 2), { flag: 'wx', mode: 0o600 });
    return draft;
  }
  async read(id) { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
  async maybe(id, suffix) {
    try { return JSON.parse(await fs.readFile(this.file(id, suffix), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  // Lets the approval command find drafts on its own instead of the user copying a UUID out of chat.
  async list() {
    let names;
    try { names = await fs.readdir(this.root); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const drafts = [];
    for (const name of names.filter(x => /^[0-9a-f-]{36}\.json$/.test(x))) {
      const id = name.slice(0, 36);
      try {
        const draft = await this.read(id);
        const [approval, journal] = await Promise.all([this.maybe(id, 'approval.json'), this.journal(id)]);
        const posted = Object.values(journal).filter(x => x.state === 'posted').length;
        drafts.push({ id, kind: draft.kind, language: draft.language, createdAt: draft.createdAt, items: draft.items.length, posted,
          approved: Boolean(approval) && approval.hash === digest(draft) && Date.parse(approval.expiresAt) > Date.now(),
          label: draft.snapshot?.title || draft.parent?.title || draft.parent?.fields?.['System.Title'] || draft.destination });
      } catch { /* a half-written or hand-edited draft must not hide the others */ }
    }
    return drafts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async resolve(reference) {
    if (!reference || reference === 'latest') {
      const pending = (await this.list()).filter(x => x.posted < x.items);
      if (!pending.length) throw new Error('No pending drafts. Ask your assistant to prepare comments or tasks first.');
      return pending[0].id;
    }
    if (/^[0-9a-f-]{36}$/.test(reference)) return reference;
    const matches = (await this.list()).filter(x => x.id.startsWith(reference.toLowerCase()));
    if (!matches.length) throw new Error(`No draft starts with "${reference}"`);
    if (matches.length > 1) throw new Error(`"${reference}" matches ${matches.length} drafts; use more characters`);
    return matches[0].id;
  }
  async updateItem(id, itemId, patch) {
    return this.withLock(id, async () => {
      const draft = await this.read(id);
      const item = draft.items.find(x => x.id === itemId);
      if (!item) throw new Error('Unknown item');
      Object.assign(item, patch);
      await fs.writeFile(this.file(id), JSON.stringify(draft, null, 2), { mode: 0o600 });
      return draft;
    });
  }
  async withLock(id, fn) {
    let handle;
    try { handle = await fs.open(this.file(id, 'lock'), 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Draft is locked by another operation. If a process crashed, reconcile its journal before manually removing the lock.'); throw error; }
    try { return await fn(); } finally { await handle.close(); await fs.unlink(this.file(id, 'lock')); }
  }
  async approve(id, selectedIds, expectedHash, { via = 'terminal', userWords } = {}) {
    return this.withLock(id, async () => {
      const draft = await this.read(id);
      if (expectedHash && expectedHash !== digest(draft)) throw new Error('Draft changed during approval; inspect it again');
      const ids = draft.items.map(x => x.id);
      if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(x => !ids.includes(x))) throw new Error('Select at least one valid, unique item');
      const approval = { hash: digest(draft), selectedIds, via, ...(userWords ? { userWords } : {}), approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
      await fs.writeFile(this.file(id, 'approval.json'), JSON.stringify(approval, null, 2), { mode: 0o600 });
      return approval;
    });
  }
  // What was shown in the conversation, so only an unchanged, displayed draft can be approved there.
  async markPreviewed(draft) {
    await fs.writeFile(this.file(draft.id, 'preview.json'), JSON.stringify({ hash: digest(draft), at: new Date().toISOString() }), { mode: 0o600 });
  }
  async previewed(id) { return this.maybe(id, 'preview.json'); }
  async approved(draft) {
    let approval;
    try { approval = JSON.parse(await fs.readFile(this.file(draft.id, 'approval.json'), 'utf8')); }
    catch { throw new Error('Not approved. Ask the user to run the local approval command and inspect every item.'); }
    if (approval.hash !== digest(draft) || Date.parse(approval.expiresAt) < Date.now()) throw new Error('Approval is stale or content changed. Approve again.');
    return approval;
  }
  async journal(id) {
    try { return JSON.parse(await fs.readFile(this.file(id, 'journal.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async saveJournal(id, journal) {
    const temp = this.file(id, 'journal.tmp');
    await fs.writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.file(id, 'journal.json'));
  }
}
