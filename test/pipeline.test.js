import test from 'node:test';
import assert from 'node:assert/strict';
import { Providers } from '../src/providers.js';
import { Http } from '../src/http.js';
import { cleanLog, failureCause, findLocations, relativize, pipelineReport } from '../src/pipeline.js';

const LOG = [
  '\u001b[0Ksection_start:1700000000:build_script\r\u001b[0K$ pnpm lint',
  '/builds/acme/front/applications/etudes/src/b.tsx',
  '  4:10  error  Unexpected any  @typescript-eslint/no-explicit-any',
  '',
  'src/a.ts(12,5): error TS2322: Type string is not assignable to number.',
  ' FAIL  src/c.test.ts > sum > empty',
  'AssertionError: expected 0 to be NaN',
  ' ❯ src/c.test.ts:21:7',
  'Uploading artifacts for failed job',
  'ERROR: Job failed: exit code 1',
].join('\n');

test('CI logs are cleaned and reduced to the lines that explain the failure', () => {
  const lines = cleanLog(LOG);
  assert.equal(lines.some(line => /\u001b|section_start/.test(line)), false);
  const cause = failureCause(lines);
  assert.ok(cause.includes('AssertionError: expected 0 to be NaN'));
  assert.ok(cause.includes('ERROR: Job failed: exit code 1'));
  assert.equal(cause.some(line => /Uploading artifacts/.test(line)), false, 'runner housekeeping is not a cause');
  assert.deepEqual(cleanLog('2026-10-08T10:00:00.1234567Z ##[error]Process completed with exit code 2.'), ['Process completed with exit code 2.'], 'GitHub timestamps and markers go');
});

test('file:line references are found in ESLint, tsc and test-runner output and made repository-relative', () => {
  const found = findLocations(cleanLog(LOG));
  assert.deepEqual(found.map(l => [l.path, l.line]), [['/builds/acme/front/applications/etudes/src/b.tsx', 4], ['src/a.ts', 12], ['src/c.test.ts', 21]]);
  assert.equal(found[0].message, 'Unexpected any (@typescript-eslint/no-explicit-any)');
  assert.equal(relativize('/builds/acme/front/applications/etudes/src/b.tsx', ['applications/etudes/src/b.tsx'], 'front'), 'applications/etudes/src/b.tsx');
  assert.equal(relativize('/home/runner/work/app/app/src/x.ts', [], 'app'), 'src/x.ts');
});

function gitlabFixture(routes) {
  const config = { GITLAB_URL: 'https://git.example', GITLAB_TOKEN: 't', GITLAB_PROJECT_ID: 'acme/front' };
  const fetch = async url => {
    const u = new URL(url);
    const hit = Object.entries(routes).find(([path]) => u.pathname === path);
    if (!hit) return new Response('[]', { status: 404 });
    const body = hit[1];
    return typeof body === 'string' ? new Response(body, { status: 200 }) : new Response(JSON.stringify(body), { status: 200 });
  };
  return new Providers(config, fetch);
}

test('GitLab: failing stages of the head pipeline and its child pipelines, with locations on changed lines', async () => {
  const base = '/api/v4/projects/acme%2Ffront';
  const providers = gitlabFixture({
    [`${base}/merge_requests/7`]: { sha: 'head', state: 'opened', web_url: 'https://git.example/acme/front/-/merge_requests/7', diff_refs: {} },
    [`${base}/merge_requests/7/diffs`]: [{ new_path: 'src/a.ts', diff: '@@ -10,2 +10,3 @@\n a\n b\n+c' }],
    [`${base}/merge_requests/7/pipelines`]: [{ id: 2, sha: 'head', status: 'failed', project_id: 1, web_url: 'p2' }, { id: 1, sha: 'old', status: 'success' }],
    [`${base}/pipelines/2/jobs`]: [{ id: 20, name: 'tsc', stage: 'verify', status: 'failed', allow_failure: false, web_url: 'j20' }, { id: 21, name: 'audit', stage: 'verify', status: 'failed', allow_failure: true }, { id: 22, name: 'build', stage: 'build', status: 'success' }],
    [`${base}/pipelines/2/bridges`]: [{ name: 'etudes', status: 'failed', downstream_pipeline: { id: 3, project_id: 1 } }],
    [`${base}/pipelines/3/jobs`]: [{ id: 30, name: 'vitest', stage: 'test', status: 'failed', allow_failure: false }],
    [`${base}/jobs/20/trace`]: 'src/a.ts(12,5): error TS2322: Type string is not assignable to number.\nERROR: Job failed: exit code 2',
    [`${base}/jobs/30/trace`]: 'AssertionError: boom\n ❯ src/other.test.ts:3:1\nERROR: Job failed: exit code 1',
  });
  const { pipeline } = await pipelineReport(providers, { provider: 'gitlab', number: 7 });
  assert.equal(pipeline.status, 'failed');
  assert.equal(pipeline.matchesHead, true, 'the pipeline of the review head is chosen, not the newest older one');
  assert.deepEqual(pipeline.failedStages.map(s => s.stage), ['verify', 'etudes › test']);
  const tsc = pipeline.failedStages[0].jobs[0];
  assert.deepEqual(tsc.locations[0], { path: 'src/a.ts', line: 12, column: 5, message: 'error TS2322: Type string is not assignable to number.', inDiff: true, onChangedLine: true });
  assert.deepEqual(pipeline.allowedFailures, ['verify/audit']);
  assert.equal(pipeline.failedStages[1].jobs[0].locations[0].inDiff, false);
});

test('GitHub: failing check runs bring their annotations as file:line', async () => {
  const fetch = async url => {
    const path = new URL(url).pathname;
    const routes = {
      '/repos/acme/app/pulls/5': { head: { sha: 'h', ref: 'f' }, base: { sha: 'b', ref: 'main' }, state: 'open', html_url: 'u' },
      '/repos/acme/app/pulls/5/files': [{ filename: 'src/x.ts', patch: '@@ -1 +1,2 @@\n a\n+b' }],
      '/repos/acme/app/commits/h/check-runs': { check_runs: [{ id: 9, name: 'lint', status: 'completed', conclusion: 'failure', app: { slug: 'other-ci', name: 'Other CI' }, output: { title: '1 error' } }, { id: 10, name: 'build', status: 'completed', conclusion: 'success' }] },
      '/repos/acme/app/check-runs/9/annotations': [{ path: 'src/x.ts', start_line: 2, annotation_level: 'failure', title: 'no-unused-vars', message: 'b is unused' }],
    };
    return routes[path] ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response('[]', { status: 404 });
  };
  const providers = new Providers({ GITHUB_TOKEN: 'g' }, fetch);
  const { pipeline } = await pipelineReport(providers, { provider: 'github', project: 'acme/app', number: 5 });
  assert.equal(pipeline.status, 'failed');
  const job = pipeline.failedStages[0].jobs[0];
  assert.equal(job.job, 'lint');
  assert.deepEqual(job.cause, ['1 error']);
  assert.deepEqual(job.locations[0], { path: 'src/x.ts', line: 2, message: 'no-unused-vars: b is unused', inDiff: true, onChangedLine: true });
});

test('a log redirect is followed once, over HTTPS, without sending the credentials along', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://logs.example/job.txt?sig=1' } });
    return new Response('line\n'.repeat(10), { status: 200 });
  };
  const http = new Http('https://api.example', { Authorization: 'Bearer secret' }, fetch);
  assert.equal(await http.text('/logs', { tail: 10 }), 'line\nline\n');
  assert.equal(calls[1].url, 'https://logs.example/job.txt?sig=1');
  assert.equal(calls[1].headers, undefined, 'no Authorization header to the storage host');
  const insecure = new Http('https://api.example', {}, async () => new Response(null, { status: 302, headers: { location: 'http://logs.example/x' } }));
  await assert.rejects(insecure.text('/logs'), /non-HTTPS/);
});
