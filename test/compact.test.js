import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, compactFile, compactDiscussions, compactTicket, compactComments, compactSonar, compactRule, draftSummary, sliceLines } from '../src/compact.js';
import { summarizeTestReport } from '../src/tests.js';

test('HTML becomes readable text: lists, breaks, entities, no markup', () => {
  assert.equal(htmlToText('<div style="x"><p>Given&nbsp;a <b>user</b></p><ul><li>one</li><li>two &amp; three</li></ul></div>'), 'Given a user\n\n- one\n- two & three');
  assert.equal(htmlToText(undefined), undefined);
  assert.equal(htmlToText('&#233;t&#xe9;'), 'été');
});

test('diff files keep path, status and patch only', () => {
  const gitlab = compactFile({ new_path: 'a.ts', old_path: 'b.ts', renamed_file: true, a_mode: '100644', b_mode: '100644', diff: '@@ -1 +1 @@\n-x\n+y', generated_file: false });
  assert.deepEqual(gitlab, { path: 'a.ts', oldPath: 'b.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-x\n+y' });
  const github = compactFile({ filename: 'c.ts', status: 'added', sha: 'abc', blob_url: 'u', raw_url: 'u', contents_url: 'u', patch: '@@ -0,0 +1 @@\n+z' });
  assert.deepEqual(Object.keys(github).sort(), ['patch', 'path', 'status']);
  assert.equal(compactFile({ new_path: 'big.ts', too_large: true }).unavailable, 'too large');
});

test('discussions drop system notes and profile noise but keep position and resolution', () => {
  const [thread, ...rest] = compactDiscussions([
    { id: 'd1', notes: [{ body: 'Rename this', author: { username: 'ana', avatar_url: 'x', web_url: 'y' }, created_at: '2026-10-01T10:20:30Z', resolvable: true, resolved: true, position: { new_path: 'a.ts', new_line: 4, base_sha: 'q' } }] },
    { id: 'd2', notes: [{ system: true, body: 'added 1 commit' }] },
  ]);
  assert.equal(rest.length, 0, 'a thread made only of system notes disappears');
  assert.deepEqual(thread, { id: 'd1', resolved: true, notes: [{ author: 'ana', at: '2026-10-01T10:20', body: 'Rename this', path: 'a.ts', line: 4 }] });
  const [comment] = compactDiscussions([{ id: 9, user: { login: 'bo', avatar_url: 'x' }, body: 'Why?', path: 'b.ts', line: 7, created_at: '2026-10-01T10:20:30Z', diff_hunk: '@@ huge' }]);
  assert.deepEqual(comment, { id: 9, author: 'bo', at: '2026-10-01T10:20', body: 'Why?', path: 'b.ts', line: 7 });
});

test('a work item keeps reviewer fields, converts HTML and resolves its links', () => {
  const ticket = compactTicket({
    id: 42, rev: 7, _links: { html: { href: 'https://dev/42' } },
    fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': 'Export', 'System.State': 'Active', 'System.Watermark': 99, 'System.AssignedTo': { displayName: 'Ana', imageUrl: 'x' },
      'System.Description': '<p>Export <b>all</b> lines</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>CSV</li></ul>', 'System.CreatedDate': '2026-09-01T08:00:00Z' },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev/_apis/wit/workItems/40' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev/_apis/wit/workItems/43' },
      { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/1', attributes: { name: 'Pull Request' } },
    ],
  });
  assert.equal(ticket.description, 'Export all lines');
  assert.equal(ticket.acceptanceCriteria, '- CSV');
  assert.equal(ticket.assignedTo, 'Ana');
  assert.equal(ticket.parent, 40);
  assert.deepEqual(ticket.children, [43]);
  assert.equal(ticket.artifacts[0].name, 'Pull Request');
  assert.equal(ticket.created, '2026-09-01');
  assert.equal(JSON.stringify(ticket).includes('Watermark'), false);
  assert.deepEqual(compactComments({ totalCount: 1, continuationToken: 't', comments: [{ id: 1, text: '<div>ok</div>', createdBy: { displayName: 'Bo', imageUrl: 'x' }, createdDate: '2026-09-02T09:00:00Z', url: 'u' }] }),
    { totalCount: 1, continuationToken: 't', comments: [{ id: 1, author: 'Bo', at: '2026-09-02T09:00', text: 'ok' }] });
});

test('Sonar responses are reduced to status, values and located issues', () => {
  assert.deepEqual(compactSonar('gate', { projectStatus: { status: 'ERROR', conditions: [{ metricKey: 'new_coverage', status: 'ERROR', actualValue: '61', errorThreshold: '80', comparator: 'LT', periodIndex: 1 }] } }),
    { status: 'ERROR', conditions: [{ metric: 'new_coverage', status: 'ERROR', actual: '61', threshold: '80', comparator: 'LT' }] });
  assert.deepEqual(compactSonar('metrics', { component: { key: 'k', measures: [{ metric: 'bugs', value: '2' }, { metric: 'new_coverage', periods: [{ index: 1, value: '61.0' }] }] } }), { bugs: '2', new_coverage: '61.0' });
  const issues = compactSonar('issues', { paging: { pageIndex: 1, pageSize: 100, total: 1 }, components: [{}], issues: [{ key: 'i', rule: 'ts:S1', severity: 'MAJOR', component: 'proj:src/a.ts', line: 3, message: 'm', hash: 'h', flows: [], textRange: {} }] });
  assert.deepEqual(issues.issues[0], { key: 'i', rule: 'ts:S1', severity: 'MAJOR', path: 'src/a.ts', line: 3, message: 'm' });
  assert.equal(compactRule({ rule: { key: 'ts:S1', name: 'N', descriptionSections: [{ key: 'how_to_fix', content: '<p>Do <code>x</code></p>' }] } }).description, 'how_to_fix:\nDo x');
});

test('a draft summary confirms ids and anchors without echoing bodies', () => {
  const summary = draftSummary({ id: 'd', kind: 'review', language: 'fr', destination: 'x', snapshot: { head: 'h' }, coverage: { hunkCount: 3, claims: [{}, {}] }, rubricsApplied: [],
    items: [{ id: 'R1', severity: 'major', confidence: 'likely', path: 'a.ts', line: 2, body: 'LONG BODY', context: { snippet: 'code' } }] });
  assert.deepEqual(summary.items, [{ id: 'R1', severity: 'major', confidence: 'likely', path: 'a.ts', line: 2 }]);
  assert.deepEqual(summary.coverage, { hunkCount: 3, claimCount: 2 });
  assert.equal(JSON.stringify(summary).includes('LONG BODY'), false);
});

test('source files can be read by line range, and long ones are cut with a hint', () => {
  const source = { file: 'a.ts', ref: 'h', content: Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n') };
  const range = sliceLines(source, '10-12');
  assert.equal(range.content, 'line 10\nline 11\nline 12');
  assert.equal(range.totalLines, 2000);
  assert.equal(sliceLines(source, '1999-').content, 'line 1999\nline 2000');
  const cut = sliceLines(source);
  assert.equal(cut.endLine, 1500);
  assert.match(cut.note, /"1501-"/);
  assert.equal(sliceLines({ file: 'b', content: 'x\ny' }).note, undefined, 'short files come back whole');
  assert.throws(() => sliceLines(source, '50-10'), /Empty line range/);
});

test('a Jest/Vitest JSON report becomes counts and the first lines of each failure', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const file = process.platform === 'win32' ? 'C:\\repo\\src\\a.test.ts' : '/repo/src/a.test.ts';
  const summary = summarizeTestReport({
    numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0, numFailedTestSuites: 1,
    testResults: [{ name: file, status: 'failed', assertionResults: [
      { fullName: 'sum adds', status: 'passed' },
      { fullName: 'sum handles empty', status: 'failed', failureMessages: ['\u001b[31mAssertionError: expected 0 to be NaN\u001b[39m\n    at a.test.ts:12:5\n    at x\n    at y\n    at z'] },
    ] }],
  }, root);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failures[0], { file: 'src/a.test.ts', test: 'sum handles empty', message: 'AssertionError: expected 0 to be NaN\n    at a.test.ts:12:5\n    at x\n    at y' });
});
