import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { localDir } from './config.js';

// A deterministic pass is only evidence if it ran on the code under review. Each run is recorded
// with the commit and base it analysed, so prepare_comments can tell a real pass from a claimed one.
export class Runs {
  constructor(root = path.join(localDir, 'runs')) { this.root = root; }
  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error('Invalid run identifier');
    return path.join(this.root, `${id}.json`);
  }
  async record(run) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const entry = { id: randomUUID(), at: new Date().toISOString(), ...run };
    await fs.writeFile(this.file(entry.id), JSON.stringify(entry, null, 2), { flag: 'wx', mode: 0o600 });
    return entry;
  }
  async read(id) {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Unknown run ${id}. Use the runId returned by step=checks or step=blast_radius.`);
      throw error;
    }
  }
}

const PASSES = { checks: 'checks', blastRadius: 'blast_radius' };
const OPTIONAL = { tests: 'tests' };

// Instructions alone did not get these passes run: the trace showed them in about one review in six.
// A draft now carries either a run that analysed exactly this review, or an explicit, visible skip.
export async function verifyDeterministic(runs, evidence, snapshot) {
  const verified = {};
  const wanted = [...Object.entries(PASSES), ...Object.entries(OPTIONAL).filter(([field]) => evidence?.[field])];
  for (const [field, kind] of wanted) {
    const claim = evidence?.[field];
    if (!claim) throw new Error(`deterministic.${field} is required: pass the runId returned by step=${kind}, or { "skipped": "<reason>" } to declare it was not run.`);
    if (claim.skipped) { verified[field] = { skipped: claim.skipped }; continue; }
    const run = await runs.read(claim.runId);
    const label = `Run ${run.id.slice(0, 8)}`;
    if (run.kind !== kind) throw new Error(`${label} is a ${run.kind} run, not ${kind}.`);
    if (run.head !== snapshot.head) throw new Error(`${label} analysed ${String(run.head).slice(0, 8)}, not the review head ${String(snapshot.head).slice(0, 8)}. Run step=checkout, then step=${kind} with this target.`);
    const bases = [snapshot.refs?.base_sha, snapshot.refs?.start_sha].filter(Boolean);
    if (run.mode !== 'branch' || !bases.includes(run.base)) throw new Error(`${label} did not compare against this review's base. Run step=${kind} with the target so the base is set for you.`);
    if (!run.changedFileCount) throw new Error(`${label} found no changed files, so it is not evidence about this change.`);
    verified[field] = { runId: run.id, at: run.at, summary: run.summary };
  }
  return verified;
}
