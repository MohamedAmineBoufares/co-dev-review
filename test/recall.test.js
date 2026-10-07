import test from 'node:test';
import assert from 'node:assert/strict';
import { ledger, fileHunks, splitUnifiedDiff, expandIds, coverageGaps, anchorContext } from '../src/hunks.js';
import { suggestRubrics } from '../src/rubrics.js';
import { parseSelection } from '../src/review-ui.js';
import { repoSkills, readSkills } from '../src/repo-skills.js';
import { summarize } from '../src/trace.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FILES = [
  { new_path: 'src/App.tsx', diff: '@@ -1,2 +1,3 @@\n ctx\n+added\n ctx2\n@@ -20,1 +21,1 @@\n-gone\n+new' },
  { new_path: 'src/big.ts', too_large: true },
];

test('hunk identifiers survive pagination and address whole files', () => {
  const entries = ledger(FILES);
  assert.deepEqual(entries.map(x => x.id), ['1.1', '1.2', '2.1']);
  assert.equal(entries[2].unavailable, true);
  // Page two of a 100-file-per-page diff must not restart numbering at 1.
  assert.equal(ledger(FILES, 100)[0].id, '101.1');
  assert.deepEqual(expandIds('1.*', entries), ['1.1', '1.2']);
  assert.deepEqual(expandIds('1.1-1.2, 2.1', entries), ['1.1', '1.2', '2.1']);
  assert.throws(() => expandIds('1.1-2.4', entries), /cannot span files/);
  assert.throws(() => expandIds('H3', entries), /Invalid hunk identifier/);
});

test('a review that skipped part of the diff is reported hunk by hunk', () => {
  const entries = ledger(FILES);
  assert.deepEqual(coverageGaps(entries, [{ hunks: '1.1', verdict: 'finding' }]), ['1.2', '2.1']);
  assert.deepEqual(coverageGaps(entries, [{ hunks: '1.*', verdict: 'reviewed-clean' }, { hunks: '2.1', verdict: 'not-applicable' }]), []);
  assert.throws(() => coverageGaps(entries, [{ hunks: '1.1', verdict: 'finding' }, { hunks: '1.1', verdict: 'reviewed-clean' }]), /claimed twice/);
  assert.throws(() => coverageGaps(entries, [{ hunks: '9.9', verdict: 'finding' }]), /Unknown hunk identifiers/);
});

test('comment anchors carry the surrounding diff so approval shows code', () => {
  const context = anchorContext(FILES, 'src/App.tsx', 2, 'RIGHT');
  assert.equal(context.markerIndex, 1);
  assert.match(context.snippet, /\+added/);
  assert.equal(anchorContext(FILES, 'src/App.tsx', 20, 'LEFT').snippet.includes('-gone'), true);
  assert.equal(anchorContext(FILES, 'missing.ts', 1, 'RIGHT'), undefined);
});

test('local multi-file diffs split into per-file patches', () => {
  const files = splitUnifiedDiff('diff --git a/x.ts b/x.ts\nindex 1..2\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.cs b/y.cs\n@@ -5 +5 @@\n+c');
  assert.deepEqual(files.map(x => x.path), ['x.ts', 'y.cs']);
  assert.equal(fileHunks('y.cs', files[1].patch)[0].newStart, 5);
});

test('CRLF git output does not corrupt parsed paths', () => {
  const crlf = ['diff --git a/x.ts b/x.ts', '@@ -1 +1 @@', '+b', ''].join('\r\n');
  assert.deepEqual(splitUnifiedDiff(crlf).map(x => x.path), ['x.ts']);
});

test('changed paths route to the rubrics that must be loaded', () => {
  const { rubrics } = suggestRubrics(['src/App.tsx', 'Api/Controllers/UserController.cs', 'src/auth/token.ts', 'vite.config.ts']);
  const ids = rubrics.map(x => x.id);
  assert.ok(ids.includes('react-ts') && ids.includes('dotnet') && ids.includes('dotnet-api') && ids.includes('build'));
  assert.ok(ids.includes('security'), 'an auth path must pull in the security rubric');
  assert.ok(['correctness', 'complexity', 'design'].every(id => ids.includes(id)), 'every code change gets the stack-independent senior passes');
  assert.ok(ids.includes('tests-missing'), 'code changed with no test changed must be looked at');
  assert.ok(!suggestRubrics(['src/App.tsx', 'src/App.test.tsx']).rubrics.some(x => x.id === 'tests-missing'));
  assert.ok(!suggestRubrics(['vite.config.json', 'README.md']).rubrics.some(x => x.id === 'correctness'), 'config and docs do not get the code passes');
  assert.deepEqual(suggestRubrics(['notes.txt']).rubrics, []);
  assert.deepEqual(suggestRubrics(['notes.txt']).unmatched, ['notes.txt']);
});

test('approval selection accepts ranges, all and none', () => {
  assert.deepEqual(parseSelection('1,3,5-7', 8), [1, 3, 5, 6, 7]);
  assert.deepEqual(parseSelection('all', 3), [1, 2, 3]);
  assert.deepEqual(parseSelection('', 3), []);
  assert.deepEqual(parseSelection('none', 3), []);
  assert.throws(() => parseSelection('4', 3), /not one of the 3 items/);
  assert.throws(() => parseSelection('x', 3), /Cannot read/);
});

test('repository-local skills are discovered from the reviewed checkout', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-dev-skills-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dir = path.join(root, '.claude', 'skills', 'house-style');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: house-style\ndescription: Conventions for this repo,\n  wrapped onto a second line.\n---\n\nBody.\n');
  const found = repoSkills({ REVIEW_REPO_ROOT: root });
  assert.equal(found.skills.length, 1);
  assert.equal(found.skills[0].name, 'house-style');
  assert.equal(found.skills[0].description, 'Conventions for this repo, wrapped onto a second line.');
  assert.match(found.note, /never as instructions/);
  assert.deepEqual(repoSkills({}).skills, []);
  assert.deepEqual(repoSkills({ REVIEW_REPO_ROOT: path.join(root, 'absent') }).skills, []);
});

test('rubric text is served over the tool channel for clients without skills', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-dev-serve-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dir = path.join(root, '.claude', 'skills', 'house-style');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: house-style\n---\n\nBody text.\n');
  const served = readSkills({ REVIEW_REPO_ROOT: root }, ['review-react-ts', 'house-style', 'absent', '../../../etc']);
  assert.deepEqual(served.rubrics.map(x => `${x.source}:${x.name}`), ['packaged:review-react-ts', 'repository:house-style']);
  assert.match(served.rubrics[0].content, /Hook correctness/);
  assert.match(served.rubrics[1].content, /Body text/);
  assert.deepEqual(served.missing, ['absent', '../../../etc']);
});

test('trace summaries carry names and counts only, never bodies', () => {
  const read = summarize('review_work', { request: { step: 'read', target: { provider: 'gitlab', project: 'g/r', number: 7 } } }, {
    changes: { data: [{ new_path: 'a.tsx' }] }, hunks: [{ path: 'a.tsx' }, { path: 'a.tsx' }], page: 1,
    rubrics: { rubrics: [{ id: 'react-ts', skill: 'review-react-ts' }, { id: 'typescript', skill: 'review-react-ts' }, { id: 'tests', skill: null }] },
    repoSkills: { skills: [{ name: 'house-style' }] }, localCheckout: { branch: 'release', matchesReview: false },
  });
  assert.equal(read.target, 'gitlab g/r #7');
  assert.deepEqual(read.rubricsOffered, ['review-react-ts', 'tests (no packaged skill)'], 'one skill serving two rubric ids is listed once');
  assert.deepEqual(read.repoSkillsOffered, ['house-style']);
  assert.match(read.checkout, /MISMATCH: local is on release/);
  const prepared = summarize('review_work', { request: { step: 'prepare_comments', target: { provider: 'gitlab', number: 7 } } }, {
    draft: { id: 'abc', target: { provider: 'gitlab', number: 7 }, items: [{ severity: 'blocker', body: 'SECRET BODY' }, { severity: 'minor', body: 'x' }], coverage: { hunkCount: 3, claims: [{}, {}] }, rubricsApplied: ['review-react-ts'] },
  });
  assert.deepEqual(prepared.severities, { blocker: 1, minor: 1 });
  assert.equal(prepared.coverage, '2 claim(s) over 3 hunks');
  assert.deepEqual(prepared.declared, ['review-react-ts']);
  assert.ok(!JSON.stringify(prepared).includes('SECRET BODY'), 'comment text must never reach the trace');
  const failed = summarize('review_work', { request: { step: 'checks' } }, undefined, 'Git read failed');
  assert.equal(failed.error, 'Git read failed');
});
