import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTemplate, loadTemplates, renderTemplate, lintTemplate } from '../src/templates.js';

const packaged = fileURLToPath(new URL('../templates', import.meta.url));

test('front matter gives a title, a description and typed arguments', () => {
  const t = parseTemplate('---\ntitle: Do it\ndescription: Does it\narg target (required): The MR\narg language: fr or en\n---\nBody {{target}}', 'x');
  assert.equal(t.title, 'Do it');
  assert.deepEqual(t.args, [{ name: 'target', required: true, description: 'The MR' }, { name: 'language', required: false, description: 'fr or en' }]);
  assert.equal(t.body, 'Body {{target}}');
  assert.throws(() => parseTemplate('no front matter', 'x'), /no front matter/);
});

test('rendering includes the persona, fills values, falls back, and requires required arguments', () => {
  const templates = loadTemplates([packaged]);
  const text = renderTemplate(templates, 'review-mr', { target: '306', language: 'fr' });
  assert.ok(text.startsWith('# Who you are'), 'the persona comes first');
  assert.match(text, /review merge request 306/);
  assert.match(text, /look for the work item id in the branch name/, 'an omitted optional argument shows its fallback');
  assert.equal(/\{\{/.test(text), false, 'no placeholder survives');
  assert.throws(() => renderTemplate(templates, 'review-mr', {}), /needs: target/);
  assert.throws(() => renderTemplate(templates, '_persona', {}), /Unknown template/);
});

test('every packaged template is well formed', () => {
  const templates = loadTemplates([packaged]);
  const names = [...templates.values()].filter(t => !t.partial).map(t => t.name).sort();
  assert.deepEqual(names, ['address-threads', 'explain-ticket', 'fix-pipeline', 'fix-sonar', 'plan-ticket', 'qa-ticket', 'review-local', 'review-mr', 'work-ticket']);
  for (const t of templates.values()) assert.deepEqual(lintTemplate(templates, t), [], t.name);
});

test("a user's template overrides the packaged one with the same name and can add new ones", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co-dev-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'review-mr.md'), '---\ntitle: House review\ndescription: Ours\narg target (required): MR\n---\n{{> _persona}}\nOur way for {{target}}.');
  await fs.writeFile(path.join(dir, 'standup.md'), '---\ntitle: Standup\ndescription: Daily\n---\nWhat did I merge yesterday?');
  const templates = loadTemplates([packaged, dir]);
  assert.match(renderTemplate(templates, 'review-mr', { target: '7' }), /Our way for 7\./);
  assert.equal(renderTemplate(templates, 'standup'), 'What did I merge yesterday?');
});
