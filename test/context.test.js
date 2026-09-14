import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewContext, ticketContext, sonarReport } from '../src/review-context.js';

test('review bundles context and signals pagination and missing patches', async () => {
  const p = { review: async () => ({ head: 'a', raw: {} }), diffs: async () => Array(100).fill({ patch: '+x' }), discussions: async () => [] };
  const result = await reviewContext(p, {}, 2);
  assert.equal(result.nextPage, 3);
  assert.equal(result.incomplete, false);
  assert.equal(result.review.raw, undefined);
  p.diffs = async () => [{ collapsed: true }];
  assert.equal((await reviewContext(p, {})).incomplete, true);
});
test('discussion errors preserve available changes and flag incomplete review', async () => {
  const p = { review: async () => ({ head: 'a' }), diffs: async () => [{ patch: '+x' }], discussions: async () => { throw new Error('Unavailable'); } };
  const result = await reviewContext(p, {});
  assert.equal(result.changes.data.length, 1);
  assert.equal(result.discussions.error, 'Unavailable');
  assert.equal(result.incomplete, true);
});
test('review refuses mixed head snapshots', async () => {
  let calls = 0;
  const p = { review: async () => ({ head: ++calls }), diffs: async () => [], discussions: async () => [] };
  await assert.rejects(reviewContext(p, {}), /changed while reading/);
});
test('ticket includes discussion and forwards its continuation token', async () => {
  const result = await ticketContext({ ticket: async id => ({ id }), ticketComments: async (id, token) => ({ id, token }) }, 42, 'next');
  assert.equal(result.ticket.id, 42);
  assert.equal(result.discussion.data.token, 'next');
});
test('Sonar report retains successful sections when one fails and can include a rule', async () => {
  const result = await sonarReport({ sonar: async kind => { if (kind === 'hotspots') throw new Error('Denied'); return kind; }, sonarRule: async key => ({ key }) }, {}, 'rule-1');
  assert.equal(result.gate.data, 'gate');
  assert.equal(result.hotspots.error, 'Denied');
  assert.equal(result.rule.data.key, 'rule-1');
});
