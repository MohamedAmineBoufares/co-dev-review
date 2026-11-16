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
  async all() {
    let names;
    try { names = await fs.readdir(this.root); } catch { return []; }
    const runs = await Promise.all(names.filter(x => x.endsWith('.json')).map(async name => { try { return JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8')); } catch { return null; } }));
    return runs.filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  // The newest pass of this kind on this review at this commit, so a draft need not carry run ids around.
  async latest(kind, target, head) {
    return (await this.all()).find(run => run.kind === kind && run.head === head && run.target?.provider === target.provider && run.target?.number === target.number
      && (!run.target.project || !target.project || String(run.target.project) === String(target.project))) ?? null;
  }
  async read(id) {
    // The 8-character prefix is what the server prints everywhere else.
    if (/^[0-9a-f]{8,35}$/i.test(String(id))) id = (await this.all()).find(run => run.id.startsWith(String(id).toLowerCase()))?.id ?? id;
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
// The server recorded every run, so it finds them itself: a pass that ran on this head against this base is
// evidence, and one that did not is shown to the approver as not run. A runId or a skip reason may still be given.
export async function verifyDeterministic(runs, evidence, snapshot, target) {
  const verified = {};
  const bases = [snapshot.refs?.base_sha, snapshot.refs?.start_sha].filter(Boolean);
  for (const [field, kind] of [...Object.entries(PASSES), ...Object.entries(OPTIONAL)]) {
    const claim = evidence?.[field];
    if (claim?.skipped) { verified[field] = { skipped: claim.skipped }; continue; }
    if (!claim) {
      const run = target ? await runs.latest(kind, target, snapshot.head) : null;
      if (run && run.mode === 'branch' && bases.includes(run.base) && run.changedFileCount) verified[field] = { runId: run.id, at: run.at, summary: run.summary };
      else if (field in PASSES) verified[field] = { skipped: `step=${kind} was not run on this head` };
      continue;
    }
    const run = await runs.read(claim.runId);
    const label = `Run ${run.id.slice(0, 8)}`;
    if (run.kind !== kind) throw new Error(`${label} is a ${run.kind} run, not ${kind}.`);
    if (run.head !== snapshot.head) throw new Error(`${label} analysed ${String(run.head).slice(0, 8)}, not the review head ${String(snapshot.head).slice(0, 8)}. Run step=verify with this target, or leave deterministic out.`);
    if (run.mode !== 'branch' || !bases.includes(run.base)) throw new Error(`${label} did not compare against this review's base. Run step=${kind} with the target so the base is set for you.`);
    if (!run.changedFileCount) throw new Error(`${label} found no changed files, so it is not evidence about this change.`);
    verified[field] = { runId: run.id, at: run.at, summary: run.summary };
  }
  return verified;
}
