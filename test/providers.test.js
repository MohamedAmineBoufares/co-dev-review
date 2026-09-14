import test from 'node:test';
import assert from 'node:assert/strict';
import { Providers } from '../src/providers.js';
import { Http } from '../src/http.js';

function fixture() {
  const calls = [];
  const config = { GITLAB_URL: 'https://git.example', GITLAB_TOKEN: 'secret', AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/org', AZURE_DEVOPS_PROJECT: 'My Project', AZURE_DEVOPS_TOKEN: 'pat', GITHUB_TOKEN: 'gh', SONAR_TOKEN: 'sonar', SONAR_PROJECT_KEY: 'key' };
  const fetch = async (url, options) => { calls.push({ url: new URL(url), ...options, body: options.body && JSON.parse(options.body) }); return new Response(JSON.stringify({ id: 7 }), { status: 200 }); };
  return { providers: new Providers(config, fetch), calls };
}
test('GitLab renamed deletion uses complete diff refs and old-line anchor', async () => {
  const { providers, calls } = fixture();
  await providers.postFinding({ provider: 'gitlab', project: 'group/repo', number: 5 }, { head: 'h', refs: { base_sha: 'b', start_sha: 's' } }, { body: 'Bonjour', path: 'new.js', oldPath: 'old.js', line: 9, side: 'LEFT' });
  assert.equal(calls[0].url.pathname, '/api/v4/projects/group%2Frepo/merge_requests/5/discussions');
  assert.deepEqual(calls[0].body.position, { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', old_path: 'old.js', new_path: 'new.js', old_line: 9 });
});
test('GitHub inline comments pin commit and side', async () => {
  const { providers, calls } = fixture();
  await providers.postFinding({ provider: 'github', project: 'owner/repo', number: 5 }, { head: 'sha' }, { body: 'Fix', path: 'x.js', line: 4, side: 'RIGHT' });
  assert.equal(calls[0].url.pathname, '/repos/owner/repo/pulls/5/comments');
  assert.equal(calls[0].body.commit_id, 'sha'); assert.equal(calls[0].body.side, 'RIGHT');
});
test('Azure task uses JSON Patch and parent hierarchy relation', async () => {
  const { providers, calls } = fixture();
  await providers.createTask({ id: 42, fields: { 'System.AreaPath': 'Area', 'System.IterationPath': 'Iteration' } }, { title: 'Test', description: '<p>Test</p>', remainingWork: 2 });
  assert.equal(calls[0].url.pathname, '/org/My%20Project/_apis/wit/workitems/$Task');
  assert.equal(calls[0].headers['Content-Type'], 'application/json-patch+json');
  assert.equal(calls[0].body[2].value.rel, 'System.LinkTypes.Hierarchy-Reverse');
  assert.equal(calls[0].body[2].value.url, 'https://dev.azure.com/org/_apis/wit/workItems/42');
  assert.equal(calls[0].body.at(-1).value, 2);
});
test('Sonar preserves PR scope and rejects conflicting branch', async () => {
  const { providers, calls } = fixture(); await providers.sonar('metrics', { pullRequest: '22' });
  assert.equal(calls[0].url.searchParams.get('pullRequest'), '22');
  await assert.rejects(providers.sonar('gate', { pullRequest: '22', branch: 'main' }), /Choose/);
});
test('HTTP errors do not leak raw provider bodies or follow redirects', async () => {
  const api = new Http('https://api.example', {}, async (_url, options) => {
    assert.equal(options.redirect, 'error'); return new Response('secret-token', { status: 403 });
  });
  await assert.rejects(api.request('/x'), error => !error.message.includes('secret-token') && error.status === 403);
  assert.throws(() => new Http('http://api.example'), /HTTPS/);
  assert.throws(() => new Http('https://user:password@api.example'), /HTTPS/);
});
test('read pagination is passed through', async () => {
  const { providers, calls } = fixture(); await providers.diffs({ provider: 'github', project: 'a/b', number: 1 }, 3);
  assert.equal(calls[0].url.searchParams.get('page'), '3'); assert.equal(calls[0].url.searchParams.get('per_page'), '100');
});
