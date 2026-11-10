import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { suggestRubrics } from '../src/rubrics.js';

// Schema rejections happen in the SDK before the handler runs, so they never reach the trace. The
// message is the only thing the agent gets: each one must say how to fix the call.
test('schema errors tell the agent how to fix the call', { timeout: 20000 }, async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))], env: { ...process.env, CO_DEV_TRACE: 'off' }, stderr: 'pipe' });
  const client = new Client({ name: 'schema-errors-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args) => {
    try { return (await client.callTool({ name, arguments: args })).content[0].text; }
    catch (error) { return error.message; }
  };
  assert.match(await call('review_work', { step: 'read' }), /Wrap the arguments as \{ "request": \{ "step"/);
  assert.match(await call('review_work', { request: { step: 'diff' } }), /step must be one of read, read_file, .*verify.*\. Start with step=read/);
  const approve = await call('review_work', { request: { step: 'approve', draftId: '1a2b3c4d', selectedIds: ['all'], userWords: 'approve all' } });
  assert.match(approve, /full 36-character id/);
  assert.match(approve, /"all" is not an id/);
  assert.match(await call('review_sonar', { target: { provider: 'gitlab', number: 1 }, lines: 'L40-90' }), /lines must look like "120-220"/);
  assert.match(await call('plan_ticket_tasks', { request: { step: 'read', ticketId: 'ticket 42' } }), /Ticket ids look like 42 \(Azure\), PROJ-123/);
  assert.match(await call('review_work', { request: { step: 'read_file', target: { provider: 'gitlab', number: 1 }, ref: 'abc' } }), /Give path for one file or paths for up to 20/);
  const { tools } = await client.listTools();
  const steps = tools.find(x => x.name === 'review_work').inputSchema.properties.request.anyOf.map(v => v.properties.step.const);
  assert.ok(steps.includes('verify'), 'verify is published as a step');
});

test('read offers the flat skill list prepare_comments wants back', () => {
  const { requiredSkills, rubrics } = suggestRubrics(['src/App.tsx', 'src/util.ts', 'src/auth/login.ts']);
  assert.deepEqual(requiredSkills, [...new Set(rubrics.map(r => r.skill))]);
  assert.equal(new Set(requiredSkills).size, requiredSkills.length, 'no duplicates even though react-ts and typescript route to the same skill');
  assert.ok(requiredSkills.includes('review-security'));
});
