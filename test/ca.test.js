import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraCaFile } from '../src/ca.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// Tokens blanked so doctor never touches the network; env wins over .local/config.json.
const offline = { GITLAB_TOKEN: '', GITHUB_TOKEN: '', AZURE_DEVOPS_TOKEN: '', SONAR_TOKEN: '' };

test('EXTRA_CA_CERTS is ignored when Node already has NODE_EXTRA_CA_CERTS, and must exist otherwise', () => {
  const saved = process.env.NODE_EXTRA_CA_CERTS;
  try {
    process.env.NODE_EXTRA_CA_CERTS = 'x.pem';
    assert.equal(extraCaFile({ EXTRA_CA_CERTS: 'anything.pem' }), null);
    delete process.env.NODE_EXTRA_CA_CERTS;
    assert.equal(extraCaFile({ EXTRA_CA_CERTS: '' }), null);
    assert.throws(() => extraCaFile({ EXTRA_CA_CERTS: path.join(tmpdir(), 'does-not-exist.pem') }), /missing file/);
  } finally { if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = saved; }
});

test('the CLI relaunches itself with the configured CA when the launcher did not set it', () => {
  const pem = path.join(mkdtempSync(path.join(tmpdir(), 'ca-')), 'ca.pem');
  writeFileSync(pem, '');
  const env = { ...process.env, ...offline, EXTRA_CA_CERTS: pem, CO_DEV_TRACE: 'off' };
  delete env.NODE_EXTRA_CA_CERTS;
  const run = spawnSync(process.execPath, [cli, 'doctor'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith(`Node v${process.versions.node} (extra CA certs: ${pem})`), `the child that answers must carry the CA: ${run.stdout.slice(0, 120)}`);
  const plain = spawnSync(process.execPath, [cli, 'doctor'], { env: { ...env, EXTRA_CA_CERTS: '' }, encoding: 'utf8' });
  assert.match(plain.stdout, /^Node v\d+\.\d+\.\d+\n/, 'no relaunch without configuration');
});
