import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Providers } from '../src/providers.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { makeTrackers, resolveTicket } from '../src/trackers.js';

const config = { JIRA_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'me@acme.io', JIRA_TOKEN: 'jt', GITHUB_TOKEN: 'gh', GITHUB_REPO: 'acme/app', AZURE_DEVOPS_TOKEN: 'pat', AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/org', AZURE_DEVOPS_PROJECT: 'P' };

// Routes are "METHOD /path"; a handler returns [status, body] or a body for 200.
function mock(routes, extra = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    const u = new URL(url);
    const call = { method: options.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: options.headers, body: options.body && JSON.parse(options.body) };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response('{}', { status: 404 });
    const out = await handler(call);
    const [status, body] = Array.isArray(out) && typeof out[0] === 'number' ? out : [200, out];
    return new Response(JSON.stringify(body), { status });
  };
  const providers = new Providers({ ...config, ...extra }, fetch);
  return { providers, trackers: makeTrackers(providers), calls };
}

test('the tracker is inferred from the ticket id', () => {
  assert.deepEqual(resolveTicket(config, 'proj-12'), { tracker: 'jira', id: 'PROJ-12' });
  assert.deepEqual(resolveTicket(config, 'acme/web#5'), { tracker: 'github', id: 'acme/web#5', repo: 'acme/web', number: 5 });
  assert.deepEqual(resolveTicket(config, '#5'), { tracker: 'github', id: 'acme/app#5', repo: 'acme/app', number: 5 });
  assert.equal(resolveTicket(config, 42).tracker, 'azure', 'bare numbers go to the default tracker');
  assert.equal(resolveTicket({ ...config, TICKET_TRACKER: 'github' }, 42).id, 'acme/app#42');
  assert.throws(() => resolveTicket(config, 42, 'jira'), /not a Jira issue key/);
  assert.throws(() => resolveTicket({}, '#5'), /GITHUB_REPO/);
});

test('Jira search uses /search/jql, falls back to /search, and runs saved filters', async () => {
  const { trackers, calls } = mock({
    'GET /rest/api/2/search': ({ query }) => ({ total: 1, issues: [{ key: 'PROJ-1', fields: { summary: 'Export', status: { name: 'To Do' }, issuetype: { name: 'Story' }, assignee: { displayName: 'Ana' }, labels: ['csv'], updated: '2026-10-01T10:00:00.000+0000' } }] }),
    'GET /rest/api/2/filter/10042': () => ({ jql: 'project = PROJ' }),
  });
  const result = await trackers.jira.search({ queryId: '10042' });
  assert.equal(calls[1].path, '/rest/api/2/search/jql', 'Cloud endpoint first');
  assert.equal(calls[2].query.jql, 'project = PROJ', 'Server endpoint on 404, with the filter JQL');
  assert.deepEqual(result.tickets[0], { id: 'PROJ-1', title: 'Export', type: 'Story', state: 'To Do', assignedTo: 'Ana', tags: 'csv', changedDate: '2026-10-01' });
  assert.match(calls[0].headers.Authorization, /^Basic /, 'Cloud uses email + API token');
});

test('Jira read returns reviewer fields, sub-tasks, links and paged comments', async () => {
  const { trackers } = mock({
    'GET /rest/api/2/issue/PROJ-1': () => ({ key: 'PROJ-1', fields: { summary: 'Export', description: 'h2. Goal\nExport lines', issuetype: { name: 'Story' }, status: { name: 'In Progress' },
      subtasks: [{ key: 'PROJ-2', fields: { summary: 'API', status: { name: 'Done' } } }], issuelinks: [{ type: { outward: 'blocks' }, outwardIssue: { key: 'PROJ-9' } }], timetracking: { originalEstimate: '1d' } } }),
    'GET /rest/api/2/issue/PROJ-1/comment': () => ({ total: 101, startAt: 0, comments: Array.from({ length: 100 }, (_, i) => ({ id: String(i), author: { displayName: 'Bo' }, body: 'ok', created: '2026-10-01T10:00:00.000+0000' })) }),
  }, { JIRA_ACCEPTANCE_FIELD: 'customfield_10100' });
  const { ticket, discussion } = await trackers.jira.read({ id: 'PROJ-1' });
  assert.equal(ticket.url, 'https://acme.atlassian.net/browse/PROJ-1');
  assert.deepEqual(ticket.children, [{ id: 'PROJ-2', title: 'API', state: 'Done' }]);
  assert.deepEqual(ticket.related, [{ rel: 'blocks', id: 'PROJ-9' }]);
  assert.equal(discussion.data.continuationToken, '100');
});

test('Jira sub-tasks carry the estimate, and creation retries without time tracking when the screen refuses it', async () => {
  let attempts = 0;
  const { trackers, calls } = mock({
    'GET /rest/api/2/issue/PROJ-1': () => ({ key: 'PROJ-1', fields: { summary: 'Export', issuetype: { name: 'Story', subtask: false }, project: { key: 'PROJ' }, status: { name: 'To Do' } } }),
    'POST /rest/api/2/issue': ({ body }) => (++attempts === 1 && body.fields.timetracking ? [400, {}] : { key: 'PROJ-3' }),
  });
  const parent = await trackers.jira.loadParent({ id: 'PROJ-1' });
  const created = await trackers.jira.createTask(parent, { title: 'Write tests', description: 'Cover it', estimatedHours: 3, assignedTo: 'acc-1' });
  const posts = calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts[0].body.fields.timetracking, { originalEstimate: '3h' });
  assert.equal(posts[0].body.fields.issuetype.name, 'Sub-task');
  assert.deepEqual(posts[0].body.fields.parent, { key: 'PROJ-1' });
  assert.deepEqual(posts[0].body.fields.assignee, { accountId: 'acc-1' }, 'Cloud assigns by accountId');
  assert.equal(posts[1].body.fields.timetracking, undefined);
  assert.deepEqual(created, { id: 'PROJ-3', web_url: 'https://acme.atlassian.net/browse/PROJ-3' });
  const { trackers: subtaskTrackers } = mock({ 'GET /rest/api/2/issue/PROJ-2': () => ({ key: 'PROJ-2', fields: { issuetype: { subtask: true } } }) });
  await assert.rejects(subtaskTrackers.jira.loadParent({ id: 'PROJ-2' }), /sub-task/);
});

test('GitHub search scopes to issues in the default repository', async () => {
  const { trackers, calls } = mock({ 'GET /search/issues': () => ({ total_count: 1, items: [{ number: 7, title: 'Bug', state: 'open', repository_url: 'https://api.github.com/repos/acme/app', labels: [{ name: 'bug' }], assignees: [{ login: 'ana' }] }] }) });
  const result = await trackers.github.search({ query: 'is:open label:bug' });
  assert.equal(calls[0].query.q, 'is:open label:bug is:issue repo:acme/app');
  assert.deepEqual(result.tickets[0], { id: 'acme/app#7', title: 'Bug', type: 'issue', state: 'open', assignedTo: 'ana', tags: 'bug' });
  await assert.rejects(trackers.github.search({ queryId: 'x' }), /no saved queries/);
});

test('GitHub tasks become sub-issues; a failed link never turns a created issue into a retry', async () => {
  const { trackers, calls } = mock({
    'GET /repos/acme/app/issues/7': () => ({ id: 700, number: 7, title: 'Bug', state: 'open', body: 'b' }),
    'POST /repos/acme/app/issues': () => ({ id: 801, number: 8, html_url: 'https://github.com/acme/app/issues/8' }),
    'POST /repos/acme/app/issues/7/sub_issues': () => [404, {}],
  });
  const parent = await trackers.github.loadParent(resolveTicket(config, 'acme/app#7'));
  const created = await trackers.github.createTask(parent, { title: 'Fix', description: 'Do it', estimatedHours: 2 });
  assert.match(calls.find(c => c.path === '/repos/acme/app/issues').body.body, /Part of #7$/);
  assert.equal(calls.find(c => c.path.endsWith('/sub_issues')).body.sub_issue_id, 801, 'linked by issue id, not number');
  assert.equal(created.id, 8);
  assert.match(created.warning, /not linked/);
  const { trackers: prTrackers } = mock({ 'GET /repos/acme/app/issues/9': () => ({ number: 9, state: 'open', pull_request: {} }) });
  await assert.rejects(prTrackers.github.loadParent(resolveTicket(config, 'acme/app#9')), /not a pull request/);
});

test('a Jira task draft publishes only while the parent is unchanged', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-dev-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let summary = 'Export';
  const { providers, calls } = mock({
    'GET /rest/api/2/issue/PROJ-1': () => ({ key: 'PROJ-1', fields: { summary, issuetype: { name: 'Story' }, project: { key: 'PROJ' }, status: { name: 'To Do' } } }),
    'POST /rest/api/2/issue': () => ({ key: `PROJ-${10 + calls.filter(c => c.method === 'POST').length}` }),
  });
  const store = new Store(root);
  const service = new Service(config, { providers, store });
  const draft = await service.taskDraft({ parentId: 'PROJ-1', language: 'en', items: [{ title: 'A', description: 'a', estimatedHours: 1 }, { title: 'B', description: 'b', estimatedHours: 2 }] });
  assert.equal(draft.tracker, 'jira');
  assert.equal(draft.destination, 'https://acme.atlassian.net/projects/PROJ');
  await store.approve(draft.id, ['T1']);
  const { journal } = await service.publish(draft.id);
  assert.equal(journal.T1.url, 'https://acme.atlassian.net/browse/PROJ-11');
  assert.equal(journal.T2, undefined, 'unapproved tasks are not created');
  const second = await service.taskDraft({ parentId: 'PROJ-1', language: 'en', items: [{ title: 'C', description: 'c', estimatedHours: 1 }] });
  await store.approve(second.id, ['T1']);
  summary = 'Export v2';
  await assert.rejects(service.publish(second.id), /Parent ticket changed/);
});
