import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, digest } from '../src/store.js';
import { Service, anchors } from '../src/service.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-dev-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('co-dev-test-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const store = new Store(root);
  const state = { head: 'abc', posts: [], destination: 'https://git.example/api/v4/projects/1' };
  const providers = {
    config: { GITLAB_PROJECT_ID: '1' }, destination: () => state.destination,
    review: async () => ({ head: state.head, state: 'opened', refs: { base_sha: 'base', start_sha: 'start', head_sha: state.head } }),
    diffs: async () => [{ new_path: 'new.js', old_path: 'old.js', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n context' }],
    postFinding: async (_target, _snapshot, item) => { state.posts.push(item); return { id: state.posts.length }; },
    ticket: async () => ({ id: 3, rev: 1 + state.posts.length, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'Bug' } }),
    createTask: async (_parent, item) => { state.posts.push(item); return { id: state.posts.length }; },
  };
  const service = new Service({}, { store, providers });
  const draft = () => service.reviewDraft({ target: { provider: 'gitlab', number: 1 }, language: 'fr', items: [{ body: 'Corriger ce défaut.', severity: 'blocker', path: 'new.js', line: 1, side: 'RIGHT' }, { body: 'Suggestion facultative.', severity: 'minor' }], coverage: [{ hunks: '1.1', verdict: 'finding' }] });
  return { store, state, providers, service, draft };
}
test('unapproved drafts cannot publish', async t => {
  const { service, draft, state } = await fixture(t);
  await assert.rejects(service.publish((await draft()).id), /Not approved/);
  assert.equal(state.posts.length, 0);
});
test('only selected findings publish and retries do not duplicate', async t => {
  const { service, draft, store, state } = await fixture(t);
  const d = await draft();
  assert.equal(d.target.project, '1'); assert.equal(d.items[0].oldPath, 'old.js');
  await store.approve(d.id, ['R1']);
  await service.publish(d.id); await service.publish(d.id);
  assert.equal(state.posts.length, 1); assert.equal(state.posts[0].body, 'Corriger ce défaut.');
});
test('changed head prevents publication', async t => {
  const { service, draft, store, state } = await fixture(t);
  const d = await draft(); await store.approve(d.id, ['R1']); state.head = 'changed';
  await assert.rejects(service.publish(d.id), /changed or closed/); assert.equal(state.posts.length, 0);
});
test('changed destination prevents publication', async t => {
  const { service, draft, store, state } = await fixture(t);
  const d = await draft(); await store.approve(d.id, ['R1']); state.destination = 'https://other.example';
  await assert.rejects(service.publish(d.id), /Destination/); assert.equal(state.posts.length, 0);
});
test('changed content invalidates approval', async t => {
  const { service, draft, store } = await fixture(t);
  const d = await draft(); await store.approve(d.id, ['R1']);
  d.items[0].body = 'changed'; await fs.writeFile(store.file(d.id), JSON.stringify(d));
  await assert.rejects(service.publish(d.id), /stale or content changed/);
});
test('approval rejects concurrent content changes and expires', async t => {
  const { draft, store } = await fixture(t); const d = await draft();
  await assert.rejects(store.approve(d.id, ['R1'], digest({})), /changed during approval/);
  await store.approve(d.id, ['R1']);
  const approval = JSON.parse(await fs.readFile(store.file(d.id, 'approval.json')));
  approval.expiresAt = '2000-01-01'; await fs.writeFile(store.file(d.id, 'approval.json'), JSON.stringify(approval));
  await assert.rejects(store.approved(d), /stale/);
});
test('uncertain remote writes are never retried automatically', async t => {
  const { service, draft, store, providers, state } = await fixture(t);
  providers.postFinding = async () => { state.posts.push('sent'); throw new Error('timeout'); };
  const d = await draft(); await store.approve(d.id, ['R1']);
  await assert.rejects(service.publish(d.id), /timeout/);
  await assert.rejects(service.publish(d.id), /uncertain previous attempt/);
  assert.equal(state.posts.length, 1); assert.equal((await store.journal(d.id)).R1.state, 'uncertain');
});
test('invalid diff lines are rejected before saving', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.reviewDraft({ target: { provider: 'gitlab', number: 1 }, language: 'en', items: [{ body: 'x', path: 'new.js', line: 2, side: 'RIGHT' }], coverage: [{ hunks: '1.1', verdict: 'finding' }] }), /Invalid or unavailable/);
});
test('diff parser handles content starting with plus/minus characters', () => {
  const a = anchors('--- a/x\n+++ b/x\n@@ -4,2 +9,2 @@\n---old\n+++new\n same');
  assert.deepEqual([...a.LEFT], [4]); assert.deepEqual([...a.RIGHT], [9]);
});
test('multiple child tasks tolerate own parent revision changes', async t => {
  const { service, store, state } = await fixture(t);
  const d = await service.taskDraft({ parentId: 3, language: 'en', items: [{ title: 'Fix', description: 'Fix defect' }, { title: 'Test', description: 'Regression test' }] });
  await store.approve(d.id, ['T1', 'T2']); await service.publish(d.id); assert.equal(state.posts.length, 2);
});
test('changed ticket criteria block task publication', async t => {
  const { service, store, providers } = await fixture(t);
  const d = await service.taskDraft({ parentId: 3, language: 'en', items: [{ title: 'Fix', description: 'Fix defect' }] });
  await store.approve(d.id, ['T1']);
  providers.ticket = async () => ({ fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'Changed' } });
  await assert.rejects(service.publish(d.id), /Parent ticket changed/);
});
test('concurrent operations are excluded', async t => {
  const { store, draft } = await fixture(t); const d = await draft();
  await store.withLock(d.id, async () => { await assert.rejects(store.withLock(d.id, async () => {}), /locked/); });
});
test('draft paths cannot escape the store', async t => {
  const { store } = await fixture(t); await assert.rejects(store.read('../../config'), /Invalid draft/);
});
test('a draft that leaves part of the diff unaccounted for is rejected', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.reviewDraft({ target: { provider: 'gitlab', number: 1 }, language: 'en', coverage: [],
    items: [{ body: 'x', severity: 'minor', path: 'new.js', line: 1, side: 'RIGHT' }] }), /No verdict for 1 of 1 hunks/);
});
test('approved review comments keep the diff context shown at approval time', async t => {
  const { draft } = await fixture(t);
  const d = await draft();
  assert.equal(d.items[0].context.markerIndex, 1);
  assert.match(d.items[0].context.snippet, /\+new/);
  assert.equal(d.coverage.hunkCount, 1);
  assert.deepEqual(d.rubricsApplied, [], 'an undeclared rubric list is stored as empty, never omitted, so approval can show it');
});
