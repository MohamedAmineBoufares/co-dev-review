import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, digest } from '../src/store.js';
import { Service, anchors } from '../src/service.js';
import { Runs } from '../src/runs.js';

const skippedPasses = { checks: { skipped: 'No local checkout of this repository.' }, blastRadius: { skipped: 'No local checkout of this repository.' } };
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
  const runs = new Runs(path.join(root, 'runs'));
  const service = new Service({}, { store, providers, runs, routeRubrics: () => [] });
  const draft = () => service.reviewDraft({ target: { provider: 'gitlab', number: 1 }, language: 'fr', items: [{ body: 'Corriger ce défaut.', severity: 'blocker', path: 'new.js', line: 1, side: 'RIGHT' }, { body: 'Suggestion facultative.', severity: 'minor' }], coverage: [{ hunks: '1.1', verdict: 'finding' }], deterministic: skippedPasses });
  return { store, state, providers, service, draft, runs };
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
  await assert.rejects(service.reviewDraft({ target: { provider: 'gitlab', number: 1 }, language: 'en', items: [{ body: 'x', path: 'new.js', line: 2, side: 'RIGHT' }], coverage: [{ hunks: '1.1', verdict: 'finding' }], deterministic: skippedPasses }), /Invalid or unavailable/);
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
  await assert.rejects(service.reviewDraft({ target: { provider: 'gitlab', number: 1 }, language: 'en', coverage: [], deterministic: skippedPasses,
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

test('a draft must carry deterministic evidence or an explicit skip', async t => {
  const { service } = await fixture(t);
  const request = { target: { provider: 'gitlab', number: 1 }, language: 'en', items: [{ body: 'x', severity: 'minor' }], coverage: [{ hunks: '1.1', verdict: 'reviewed-clean' }] };
  await assert.rejects(service.reviewDraft(request), /deterministic.checks is required/);
  const d = await service.reviewDraft({ ...request, deterministic: skippedPasses });
  assert.equal(d.deterministic.checks.skipped, skippedPasses.checks.skipped, 'a skip reason reaches the approver');
});
test('only runs on the review head and base count as deterministic evidence', async t => {
  const { service, runs, state } = await fixture(t);
  const request = { target: { provider: 'gitlab', number: 1 }, language: 'en', items: [{ body: 'x', severity: 'minor' }], coverage: [{ hunks: '1.1', verdict: 'reviewed-clean' }] };
  const run = (kind, extra = {}) => runs.record({ kind, mode: 'branch', head: state.head, base: 'base', changedFileCount: 1, summary: { tsc: '0 on changed lines' }, ...extra });
  const good = { checks: { runId: (await run('checks')).id }, blastRadius: { runId: (await run('blast_radius')).id } };
  const d = await service.reviewDraft({ ...request, deterministic: good });
  assert.equal(d.deterministic.checks.runId, good.checks.runId);
  assert.deepEqual(d.deterministic.checks.summary, { tsc: '0 on changed lines' });
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { ...good, checks: { runId: (await run('checks', { head: 'other' })).id } } }), /not the review head/);
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { ...good, checks: { runId: (await run('checks', { base: 'develop' })).id } } }), /review's base/);
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { ...good, checks: { runId: (await run('checks', { mode: 'working' })).id } } }), /review's base/);
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { ...good, checks: { runId: (await run('checks', { changedFileCount: 0 })).id } } }), /no changed files/);
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { checks: good.blastRadius, blastRadius: good.blastRadius } }), /not checks/);
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { ...good, checks: { runId: '11111111-1111-1111-1111-111111111111' } } }), /Unknown run/);
});

test('in-chat approval posts exactly the ticked items', async t => {
  const { draft, service, state } = await fixture(t);
  const { approveInChat } = await import('../src/approval.js');
  const d = await draft();
  let form;
  const mcp = { server: { elicitInput: async params => { form = params; return { action: 'accept', content: { R1: false, R2: true, then: 'publish' } }; } } };
  const outcome = await approveInChat(mcp, service, d);
  assert.equal(outcome.status, 'published');
  assert.deepEqual(outcome.selectedIds, ['R2']);
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].id, 'R2');
  assert.ok(form.requestedSchema.properties.R1.title.includes('BLOCKER'), 'the form names severity and location');
  assert.match(form.requestedSchema.properties.R1.description, /Corriger/);
});
test('a declined in-chat form approves nothing', async t => {
  const { draft, service, store, state } = await fixture(t);
  const { approveInChat } = await import('../src/approval.js');
  const d = await draft();
  const outcome = await approveInChat({ server: { elicitInput: async () => ({ action: 'decline' }) } }, service, d);
  assert.equal(outcome.status, 'declined');
  assert.equal(await store.maybe(d.id, 'approval.json'), null);
  assert.equal(state.posts.length, 0);
});
test('the browser approval page applies edits, posts the selection, and refuses foreign hosts and reuse', async t => {
  const { draft, service, store, state } = await fixture(t);
  const { approveInBrowser } = await import('../src/approval.js');
  const d = await draft();
  const page = await approveInBrowser(service, d, { open: async () => true });
  t.after(() => page.close());
  const { port, pathname } = new URL(page.url);
  const html = await (await fetch(page.url)).text();
  assert.match(html, /Corriger ce défaut/);
  const foreign = await fetch(`http://localhost:${port}${pathname}`);
  assert.equal(foreign.status, 403, 'a Host other than 127.0.0.1:port is refused (DNS rebinding)');
  const post = body => fetch(`${page.url}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const done = await (await post({ then: 'publish', selected: ['R1'], edits: { R1: { field: 'body', text: 'Texte corrigé.' } } })).json();
  assert.match(done.message, /1 posted/);
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].body, 'Texte corrigé.');
  assert.equal((await store.maybe(d.id, 'approval.json')).via, 'browser');
  const reuse = await post({ then: 'publish', selected: ['R2'] }).then(response => response.status, () => 'closed');
  assert.notEqual(reuse, 200, 'the page is single-use');
  assert.equal(state.posts.length, 1);
});

test('test-run evidence is optional, but checked like the others when given', async t => {
  const { service, runs, state } = await fixture(t);
  const request = { target: { provider: 'gitlab', number: 1 }, language: 'en', items: [{ body: 'x', severity: 'minor' }], coverage: [{ hunks: '1.1', verdict: 'reviewed-clean' }] };
  const run = (kind, extra = {}) => runs.record({ kind, mode: 'branch', head: state.head, base: 'base', changedFileCount: 1, summary: {}, ...extra });
  const passes = { checks: { runId: (await run('checks')).id }, blastRadius: { runId: (await run('blast_radius')).id } };
  assert.equal((await service.reviewDraft({ ...request, deterministic: passes })).deterministic.tests, undefined);
  const withTests = await service.reviewDraft({ ...request, deterministic: { ...passes, tests: { runId: (await run('tests')).id } } });
  assert.ok(withTests.deterministic.tests.runId);
  await assert.rejects(service.reviewDraft({ ...request, deterministic: { ...passes, tests: { runId: (await run('tests', { head: 'old' })).id } } }), /not the review head/);
});

test('conversation approval posts only the named items of a draft that was shown and is unchanged', async t => {
  const { draft, service, store, state } = await fixture(t);
  const { renderPreview, approveFromConversation } = await import('../src/approval.js');
  const d = await draft();
  await assert.rejects(approveFromConversation(service, d.id, { selectedIds: ['R1'], userWords: 'approve R1' }), /never shown/, 'a draft never displayed cannot be approved from the chat');
  const preview = renderPreview(d);
  assert.match(preview, /### R1 · .*BLOCKER/);
  assert.match(preview, /```diff[\s\S]*\+new/);
  assert.match(preview, /approve all except/);
  await store.markPreviewed(d);
  await assert.rejects(approveFromConversation(service, d.id, { selectedIds: ['R9'], userWords: 'approve R9' }), /Unknown item id/);
  const outcome = await approveFromConversation(service, d.id, { selectedIds: ['R2'], userWords: 'approve all except R1' });
  assert.equal(outcome.status, 'published');
  assert.deepEqual(state.posts.map(post => post.id), ['R2']);
  const record = await store.maybe(d.id, 'approval.json');
  assert.equal(record.via, 'conversation');
  assert.equal(record.userWords, 'approve all except R1', "the user's words are kept with the approval");
});
test('a draft edited after it was shown must be shown again; revise does that', async t => {
  const { draft, service, store, state } = await fixture(t);
  const { approveFromConversation, reviseItem } = await import('../src/approval.js');
  const d = await draft();
  await store.markPreviewed(d);
  await store.updateItem(d.id, 'R2', { body: 'Changed behind the user.' });
  await assert.rejects(approveFromConversation(service, d.id, { selectedIds: ['R2'], userWords: 'approve' }), /changed after it was shown/);
  const revised = await reviseItem(service, d.id, 'R2', 'Reformulé.');
  assert.match(revised.preview, /> Reformulé\./);
  const outcome = await approveFromConversation(service, d.id, { selectedIds: ['R2'], userWords: 'ok approve R2', publish: false });
  assert.equal(outcome.status, 'approved', '"later" approves without posting');
  assert.equal(state.posts.length, 0);
});

test('every routed rubric must be applied or skipped with a reason', async t => {
  const { store, providers, runs } = await fixture(t);
  const service = new Service({}, { store, providers, runs });
  const request = { target: { provider: 'gitlab', number: 1 }, language: 'en', items: [{ body: 'x', severity: 'minor' }], coverage: [{ hunks: '1.1', verdict: 'reviewed-clean' }], deterministic: skippedPasses };
  await assert.rejects(service.reviewDraft({ ...request, rubricsApplied: ['review-mr'] }), /neither applied nor skipped: review-correctness, review-complexity, review-design/);
  const d = await service.reviewDraft({ ...request, rubricsApplied: ['review-correctness', 'review-complexity', 'review-react-ts'], rubricsSkipped: [{ name: 'review-design', reason: 'One-line config change' }, { name: 'review-tests', reason: 'No behaviour changed here' }] });
  assert.equal(d.rubricsSkipped[1].name, 'review-tests', 'skips are stored for the approver');
});

test('inline comments anchor on the text of the changed line, not a counted number', async t => {
  const { service, providers } = await fixture(t);
  providers.diffs = async () => [{ new_path: 'new.js', old_path: 'new.js', diff: '@@ -1,3 +1,5 @@\n a\n+const x = 1;\n b\n+return x;\n+const x = 1;' }];
  const request = { target: { provider: 'gitlab', number: 1 }, language: 'en', coverage: [{ hunks: '1.1', verdict: 'finding' }], deterministic: skippedPasses };
  const d = await service.reviewDraft({ ...request, items: [{ body: 'r', severity: 'minor', path: 'new.js', lineText: '  return x;', side: 'RIGHT' }, { body: 'c', severity: 'minor', path: 'new.js', lineText: 'const x = 1;', line: 4, side: 'RIGHT' }] });
  assert.equal(d.items[0].line, 4, 'found by text');
  assert.equal(d.items[0].lineText, undefined, 'the text is only used to resolve the anchor');
  assert.equal(d.items[1].line, 5, 'between identical lines, the one nearest the hint');
  assert.equal(d.items[1].lineCorrectedFrom, 4);
  await assert.rejects(service.reviewDraft({ ...request, items: [{ body: 'r', severity: 'minor', path: 'new.js', lineText: 'const x = 1;', side: 'RIGHT' }] }), /appears on lines 2, 5/);
  await assert.rejects(service.reviewDraft({ ...request, items: [{ body: 'r', severity: 'minor', path: 'new.js', lineText: 'nowhere', side: 'RIGHT' }] }), /no added line reads "nowhere"/);
});
