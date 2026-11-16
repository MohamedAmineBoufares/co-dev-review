import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTarget } from '../src/target.js';
import { matchPaths } from '../src/find.js';
import { findChangedLine, isGenerated } from '../src/hunks.js';
import { numberedFile, compactRubrics } from '../src/compact.js';
import { suggestRubrics } from '../src/rubrics.js';
import { traceStats } from '../src/trace.js';
import { renderPreview } from '../src/approval.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Runs } from '../src/runs.js';
import { Providers } from '../src/providers.js';
import { reviewContext } from '../src/review-context.js';

test('a target is whatever the user pasted', () => {
  const gitlab = { GITLAB_TOKEN: 'x' };
  assert.deepEqual(parseTarget('https://gitlab.example.com/group/sub/app/-/merge_requests/1585/diffs', gitlab), { provider: 'gitlab', project: 'group/sub/app', number: 1585 });
  assert.deepEqual(parseTarget('https://github.com/acme/web/pull/12', gitlab), { provider: 'github', project: 'acme/web', number: 12 });
  assert.deepEqual(parseTarget('1585', gitlab), { provider: 'gitlab', number: 1585 });
  assert.deepEqual(parseTarget('!306', gitlab), { provider: 'gitlab', number: 306 });
  assert.deepEqual(parseTarget(12, { GITHUB_TOKEN: 'x', GITHUB_REPO: 'acme/web' }), { provider: 'github', project: 'acme/web', number: 12 });
  assert.deepEqual(parseTarget('acme/web#12', gitlab), { provider: 'github', project: 'acme/web', number: 12 });
  assert.deepEqual(parseTarget({ provider: 'GitLab', number: '7' }, gitlab), { provider: 'gitlab', number: 7 });
  assert.deepEqual(parseTarget('{"provider":"gitlab","number":7}', gitlab), { provider: 'gitlab', number: 7 });
  assert.equal(parseTarget('the big one', gitlab), 'the big one', 'what cannot be read is left for validation to report');
});

test('a guessed path resolves to the file that exists', () => {
  const paths = ['applications/componantsLibrary/src/utils/excelOutline.ts', 'applications/etudes/src/hooks/useColumnsDef.tsx', 'applications/etudes/src/hooks/index.ts', 'applications/tbc/src/hooks/index.ts'];
  assert.deepEqual(matchPaths(paths, 'componantslibrary/src/utils/excelOutline.ts'), [paths[0]], 'wrong root and wrong case');
  assert.deepEqual(matchPaths(paths, '@/hooks/useColumnsDef'), [paths[1]], 'an import alias without extension');
  assert.deepEqual(matchPaths(paths, 'etudes/src/hooks'), [paths[2]], 'a folder import means its index');
  assert.equal(matchPaths(paths, 'hooks/index.ts').length, 2, 'an ambiguous name returns every candidate');
  assert.deepEqual(matchPaths(paths, 'nothing/like/this.ts'), []);
});

test('comments anchor on the text of a line, however it was quoted', () => {
  const patch = '@@ -10,4 +10,5 @@\n const a = 1;\n-const total = items.length;\n+const total = items.filter(Boolean).length;\n+if (!total) return null;\n return total;';
  assert.deepEqual(findChangedLine(patch, 'RIGHT', '  const total  =  items.filter(Boolean).length;'), { line: 11 }, 'whitespace does not matter');
  assert.deepEqual(findChangedLine(patch, 'RIGHT', '+if (!total) return null;'), { line: 12 }, 'a copied diff marker is ignored');
  assert.deepEqual(findChangedLine(patch, 'RIGHT', 'items.filter(Boolean)'), { line: 11 }, 'part of a line is enough when only one line has it');
  assert.deepEqual(findChangedLine(patch, 'LEFT', 'const total = items.length;'), { line: 11 });
  assert.deepEqual(findChangedLine(patch, 'RIGHT', 'return total;'), { line: 13, unchanged: true, oldLine: 12 }, 'an unchanged line of the hunk can carry a comment');
  assert.match(findChangedLine(patch, 'RIGHT', 'const total = items.size;').error, /Closest: 11: "const total = items\.filter/);
});

test('generated files are collapsed and rubrics are named, not explained', () => {
  assert.ok(isGenerated('apps/web/pnpm-lock.yaml') && isGenerated('src/__snapshots__/a.test.tsx.snap') && isGenerated('Migrations/AppModelSnapshot.cs'));
  assert.equal(isGenerated('src/lock.ts'), false);
  const lock = numberedFile({ path: 'package-lock.json', status: 'modified', patch: '@@ -1 +1,2 @@\n-a\n+b\n+c' }, 3);
  assert.equal(lock.patch, undefined);
  assert.match(lock.collapsed, /\+2 -1/);
  assert.deepEqual(numberedFile({ path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d' }, 4), { n: 4, path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d', hunks: 2 });
  const rubrics = compactRubrics(suggestRubrics(['src/App.tsx', 'src/util.ts']));
  assert.deepEqual(rubrics.requiredSkills, ['review-correctness', 'review-complexity', 'review-design', 'review-react-ts', 'review-tests']);
  assert.match(rubrics.testsMissing, /no test file changed/);
  assert.ok(JSON.stringify(rubrics).length < JSON.stringify(suggestRubrics(['src/App.tsx', 'src/util.ts'])).length / 2, 'at most half the size of the full routing');
});

test('stats turn the trace into failure rates', () => {
  const stats = traceStats([
    { at: '2026-11-01T10:00:00Z', tool: 'review_work', step: 'read_file', target: 'gitlab #1' },
    { at: '2026-11-01T10:01:00Z', tool: 'review_work', step: 'read_file', target: 'gitlab #1', error: 'No file a/b.ts at 51f63c793b01' },
    { at: '2026-11-01T10:02:00Z', tool: 'review_work', step: 'prepare_comments', target: 'gitlab #1', error: 'No verdict for 3 of 9 hunks' },
    { at: '2026-11-01T10:03:00Z', tool: 'review_work', step: 'prepare_comments', target: 'gitlab #1', deterministic: { checks: 'run', blastRadius: 'skipped' } },
    { at: '2026-11-02T10:03:00Z', tool: 'review_work', step: 'prepare_comments', target: 'gitlab #2', deterministic: { checks: 'skipped' } },
  ]);
  assert.deepEqual(stats.steps[0], { step: 'prepare_comments', calls: 3, errors: 1, rate: '33%' });
  assert.deepEqual(stats.reviews, { drafts: 2, firstTry: 1, withChecksRun: 1 });
  assert.equal(stats.topErrors[0].message, 'read_file: No file a/b.ts at #');
});

async function fixture(t, { provider = 'gitlab' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-dev-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const calls = [];
  const patch = '@@ -1,3 +1,3 @@\n context\n-old\n+const value = compute(input);\n tail';
  const threads = provider === 'gitlab'
    ? [{ id: 'abc123', notes: [{ author: { username: 'lea' }, body: 'Rename this, please.', resolvable: true, resolved: false, position: { new_path: 'src/a.ts', new_line: 3 } }] }]
    : [{ id: 77, user: { login: 'lea' }, body: 'Rename this, please.', path: 'src/a.ts', line: 3 }];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: decodeURIComponent(u.pathname), body: init.body && JSON.parse(init.body) });
    const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST' || init.method === 'PUT') return json({ id: 900 + calls.length });
    if (/\/(diffs|files)$/.test(u.pathname)) return json(provider === 'gitlab' ? [{ new_path: 'src/a.ts', old_path: 'src/a.ts', diff: patch }, { new_path: 'pnpm-lock.yaml', old_path: 'pnpm-lock.yaml', diff: '@@ -1 +1 @@\n-x\n+y' }] : [{ filename: 'src/a.ts', patch }]);
    if (/\/(discussions|comments)$/.test(u.pathname)) return json(threads);
    if (/\/compare/.test(u.pathname)) return json({ diffs: [{ new_path: 'src/a.ts', old_path: 'src/a.ts', diff: '@@ -5 +5 @@\n-before\n+after' }] });
    return json(provider === 'gitlab'
      ? { title: 'MR', state: 'opened', sha: 'head2', web_url: 'https://gitlab.example.com/g/app/-/merge_requests/5', source_branch: 'feat', target_branch: 'main', diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'head2' }, head_pipeline: { status: 'failed', sha: 'head2' } }
      : { title: 'PR', state: 'open', html_url: 'https://github.com/o/r/pull/5', head: { sha: 'head2', ref: 'feat' }, base: { sha: 'base', ref: 'main' } });
  };
  const config = { GITLAB_URL: 'https://gitlab.example.com', GITLAB_TOKEN: 't', GITLAB_PROJECT_ID: 'g/app', GITHUB_TOKEN: 't' };
  const providers = new Providers(config, fetchImpl);
  const store = new Store(path.join(root, 'drafts'));
  const service = new Service(config, { providers, store, runs: new Runs(path.join(root, 'runs')), routeRubrics: () => [] });
  const target = provider === 'gitlab' ? { provider, number: 5 } : { provider, project: 'o/r', number: 5 };
  return { service, store, providers, calls, target };
}

test('one failed draft names everything wrong with it', async t => {
  const { service, target } = await fixture(t);
  const error = await service.reviewDraft({ target, language: 'en', coverage: [{ hunks: '9.1', verdict: 'reviewed-clean' }],
    items: [{ body: 'a', severity: 'minor', confidence: 'likely', path: 'src/a.ts', lineText: 'nothing like this', side: 'RIGHT' }, { body: 'b', severity: 'minor', confidence: 'likely', path: 'src/zzz.ts', line: 1, side: 'RIGHT' }] }).catch(e => e);
  assert.match(error.message, /^4 problems; fix them all in one call:/);
  assert.match(error.message, /Cannot anchor on src\/a\.ts/);
  assert.match(error.message, /No diff available for src\/zzz\.ts/);
  assert.match(error.message, /Unknown hunk ids: 9\.1/);
  assert.match(error.message, /No verdict for 1 of 2 hunks: 1\.1/, 'the lockfile hunk needs no verdict');
});

test('suggestions, unchanged lines, near-duplicates and the evidence reach the approver', async t => {
  const { service, store, target, calls } = await fixture(t);
  const draft = await service.reviewDraft({ target, language: 'en', coverage: [],
    items: [{ body: 'Name the unit.', severity: 'minor', confidence: 'confirmed', path: 'a.ts', lineText: 'const value = compute(input);', side: 'RIGHT', suggestion: 'const valueMs = compute(input);' },
      { body: 'Why is this kept?', severity: 'suggestion', confidence: 'question', path: 'src/a.ts', lineText: 'tail', side: 'LEFT' }] });
  assert.equal(draft.items[0].path, 'src/a.ts', 'a path missing its root is matched to the changed file');
  assert.match(draft.items[0].body, /```suggestion:-0\+0\nconst valueMs = compute\(input\);\n```$/);
  assert.match(draft.items[1].nearExisting, /^lea at line 3: Rename this/);
  assert.deepEqual([draft.items[1].unchanged, draft.items[1].side, draft.items[1].line, draft.items[1].oldLine], [true, 'RIGHT', 3, 3]);
  assert.deepEqual(draft.coverage.summary, { finding: 1, 'not-applicable': 1 });
  const preview = renderPreview(draft);
  assert.match(preview, /Evidence: checks not run \(step=checks was not run on this head\)/);
  assert.match(preview, /Near an open thread by lea/);
  assert.match(preview, /\(unchanged line\)/);
  await store.approve(draft.id, ['R2']);
  await service.publish(draft.id);
  assert.deepEqual(calls.at(-1).body.position.old_line, 3);
  assert.deepEqual(calls.at(-1).body.position.new_line, 3, 'GitLab needs both numbers for an unchanged line');
  // What the approver left out is remembered for the next review of this project.
  assert.deepEqual(await store.rejected(draft.destination), [{ severity: 'minor', path: 'src/a.ts', said: draft.items[0].body.replace(/\s+/g, ' ').slice(0, 160) }]);
});

test('replies to review threads go through the same approval', async t => {
  const { service, store, target, calls } = await fixture(t);
  await assert.rejects(service.replyDraft({ target, language: 'en', replies: [{ threadId: 'nope', body: 'x' }] }), /Unknown thread nope/);
  const draft = await service.replyDraft({ target, language: 'en', replies: [{ threadId: 'abc123', body: 'Renamed in the last commit.', resolve: true }] });
  assert.match(renderPreview(draft), /REPLY · reply to lea on `src\/a\.ts:3` · resolves the thread\n\*They wrote: Rename this, please\.\*/);
  await assert.rejects(service.publish(draft.id), /Not approved/);
  await store.approve(draft.id, ['R1']);
  await service.publish(draft.id);
  assert.deepEqual(calls.slice(-2).map(c => `${c.method} ${c.path.split('/merge_requests/')[1]}`), ['POST 5/discussions/abc123/notes', 'PUT 5/discussions/abc123']);
  const github = await fixture(t, { provider: 'github' });
  await assert.rejects(github.service.replyDraft({ target: github.target, language: 'en', replies: [{ threadId: 77, body: 'x', resolve: true }] }), /cannot be resolved through this API/);
  const reply = await github.service.replyDraft({ target: github.target, language: 'en', replies: [{ threadId: 77, body: 'Done.' }] });
  await github.store.approve(reply.id, ['R1']);
  await github.service.publish(reply.id);
  assert.equal(github.calls.at(-1).path, '/repos/o/r/pulls/5/comments/77/replies');
});

test('read numbers files, collapses the lockfile, says what to do next and remembers the last draft', async t => {
  const { service, store, providers, target } = await fixture(t);
  const read = await reviewContext(providers, service.withProject(target), 1, undefined, { store });
  assert.deepEqual(read.changes.data.map(f => [f.n, f.hunks, Boolean(f.patch)]), [[1, 1, true], [2, 1, false]]);
  assert.equal(read.hunks, undefined, 'no separate ledger repeating every hunk header');
  assert.deepEqual(read.pipeline, { status: 'failed', matchesHead: true });
  assert.ok(read.next.some(x => /Pipeline is failed: step=pipeline/.test(x)));
  await assert.rejects(reviewContext(providers, service.withProject(target), 1, undefined, { store, since: 'last' }), /No earlier draft/);
  const draft = await service.reviewDraft({ target, language: 'en', coverage: [{ hunks: 'rest', verdict: 'reviewed-clean' }], items: [{ body: 'General remark.', severity: 'minor', confidence: 'likely' }] });
  assert.equal(draft.coverage.bulk, 1);
  const again = await reviewContext(providers, service.withProject(target), 1, undefined, { store, since: 'abcdef1' });
  assert.equal(again.changes[0].patch, '@@ -5 +5 @@\n-before\n+after');
  assert.equal(again.previous.items[0].said, 'General remark.');
  const same = await reviewContext(providers, service.withProject(target), 1, undefined, { store, since: 'last' });
  assert.equal(same.unchanged, true, 'nothing moved since the last draft');
});

test('bulk mode sizes each job so the host can pick a model for it', async t => {
  const { reviewEffort, ticketEffort, reviewBatch, ticketBatch } = await import('../src/batch.js');
  assert.equal(reviewEffort({ files: 2, lines: 40 }), 'low');
  assert.equal(reviewEffort({ files: 6, lines: 180 }), 'medium');
  assert.equal(reviewEffort({ files: 2, lines: 40, sensitive: true }), 'high', 'a small change to auth or a migration still gets the capable model');
  assert.equal(reviewEffort({ files: 30, lines: 90 }), 'high');
  assert.deepEqual([ticketEffort({ chars: 300, criteria: 2 }), ticketEffort({ chars: 1500, criteria: 5 }), ticketEffort({ chars: 900, criteria: 12 })], ['low', 'medium', 'high']);
  const { service, target } = await fixture(t);
  const first = await reviewBatch(service, [target]);
  assert.deepEqual([first.items[0].files, first.items[0].changedLines, first.items[0].effort, first.items[0].reviewed], [1, 2, 'low', 'not reviewed here yet'], 'the lockfile does not count');
  assert.deepEqual(first.items[0].read, { step: 'read', target: { provider: 'gitlab', number: 5, project: 'g/app' } });
  assert.match(first.brief, /Do not call prepare_comments/);
  await service.reviewDraft({ target, language: 'en', coverage: [{ hunks: 'rest', verdict: 'reviewed-clean' }], items: [{ body: 'ok', severity: 'minor', confidence: 'likely' }] });
  assert.equal((await reviewBatch(service, [target])).items[0].skip, true, 'reviewed at this head already');
  const trackers = { azure: { read: async ref => (ref.id === 2 ? Promise.reject(new Error('HTTP 404')) : { ticket: { title: 'Export', description: 'x'.repeat(700), acceptanceCriteria: '- a\n- b\n1. c\n4) d', children: [{ id: 9 }] } }) } };
  const tickets = await ticketBatch({ trackers }, { TICKET_TRACKER: 'azure' }, ['1', '2'], 'azure');
  assert.deepEqual([tickets.items[0].criteria, tickets.items[0].effort, tickets.items[0].skip], [4, 'medium', true]);
  assert.deepEqual(tickets.items[1], { id: '2', error: 'HTTP 404' }, 'one unreadable ticket does not fail the batch');
  assert.deepEqual(tickets.efforts, { medium: 1 });
});
