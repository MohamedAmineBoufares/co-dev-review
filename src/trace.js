import fs from 'node:fs';
import path from 'node:path';
import { localDir } from './config.js';

// An append-only record of what the server offered, what was fetched through it, and what the
// model declared it applied. Skills a client loads natively never pass through here, so the
// trace is evidence of protocol compliance, not a complete list of everything the model read.
// Names, counts and identifiers only: never comment bodies, source text, or tokens.
const FILE = path.join(localDir, 'trace.jsonl');
const ROTATE_AT = 5_000_000;

const targetOf = (args, result) => {
  const target = args?.request?.target ?? args?.target ?? result?.review?.target ?? result?.draft?.target;
  if (target) return `${target.provider} ${target.project ?? ''} #${target.number}`.replace(/\s+/g, ' ');
  if (args?.request?.ticketId) return `ticket ${args.request.ticketId}`;
  if (result?.mode) return `local ${result.mode}${result.base ? ` vs ${String(result.base).slice(0, 12)}` : ''}`;
  return 'local';
};

export function summarize(tool, args, result, error) {
  const step = args?.request?.step ?? (tool === 'review_sonar' ? 'read' : undefined);
  const entry = { at: new Date().toISOString(), tool, step, target: targetOf(args, result) };
  if (error) return { ...entry, error: String(error).slice(0, 300) };
  switch (step) {
    case 'read':
      if (tool === 'plan_ticket_tasks') return { ...entry, ticket: result?.ticket?.id, type: result?.ticket?.fields?.['System.WorkItemType'] };
      return { ...entry,
        files: result?.changes?.data?.length ?? (result?.hunks ? new Set(result.hunks.map(h => h.path)).size : undefined),
        hunks: result?.hunks?.length, page: result?.page, incomplete: result?.incomplete,
        rubricsOffered: [...new Set(result?.rubrics?.rubrics?.map(r => r.skill ?? `${r.id} (no packaged skill)`) ?? [])],
        repoSkillsOffered: result?.repoSkills?.skills?.map(s => s.name),
        gate: result?.sonar?.gate?.data?.projectStatus?.status,
        checkout: result?.localCheckout ? (result.localCheckout.worktree?.matchesReview ? 'review worktree at head' : result.localCheckout.matchesReview ? 'matches review head' : `MISMATCH: local is on ${result.localCheckout.branch}`) : undefined };
    case 'checkout':
      return { ...entry, head: result?.head?.slice(0, 12), reused: result?.reused, install: result?.install?.status };
    case 'rubric':
      return { ...entry, fetched: result?.rubrics?.map(r => `${r.source}:${r.name}`), missing: result?.missing };
    case 'checks':
      return { ...entry, run: result?.runId, worktree: Boolean(result?.worktree), scope: `${result?.mode} vs ${String(result?.base).slice(0, 12)}`, changedFiles: result?.changedFileCount, runners: Object.fromEntries(Object.entries(result?.runners ?? {}).map(([name, r]) => [name, r.status === 'ran' ? `${r.onChangedLines?.length ?? 0} on changed lines` : r.status])) };
    case 'blast_radius':
      return { ...entry, run: result?.runId, worktree: Boolean(result?.worktree), scope: `${result?.mode} vs ${String(result?.base).slice(0, 12)}`, symbols: result?.symbolsInspected, callers: result?.symbols?.reduce((n, s) => n + s.callerCount, 0) };
    case 'read_file':
      return { ...entry, path: args.request.path };
    case 'prepare_comments':
      return { ...entry, draft: result?.draft?.id, items: result?.draft?.items?.length,
        severities: Object.fromEntries(['blocker', 'major', 'minor', 'suggestion'].map(s => [s, result?.draft?.items?.filter(i => i.severity === s).length ?? 0]).filter(([, n]) => n)),
        coverage: result?.draft?.coverage ? `${result.draft.coverage.claims.length} claim(s) over ${result.draft.coverage.hunkCount} hunks` : undefined,
        declared: result?.draft?.rubricsApplied,
        approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined,
        deterministic: result?.draft?.deterministic && Object.fromEntries(Object.entries(result.draft.deterministic).map(([pass, x]) => [pass, x.runId ? 'run' : 'skipped'])) };
    case 'prepare':
      return { ...entry, draft: result?.draft?.id, tasks: result?.draft?.items?.length, totalHours: result?.totalEstimatedHours, approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined };
    case 'request_approval':
      return { ...entry, draft: args.request.draftId, approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined };
    case 'view_draft':
      return { ...entry, draft: args.request.draftId };
    case 'publish':
      return { ...entry, draft: args.request.draftId, posted: Object.values(result?.journal ?? {}).filter(x => x.state === 'posted').length };
    default:
      return entry;
  }
}

export function record(entry) {
  if (process.env.CO_DEV_TRACE === 'off') return;
  try {
    fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
    try { if (fs.statSync(FILE).size > ROTATE_AT) fs.renameSync(FILE, FILE + '.1'); } catch { /* first write */ }
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* tracing must never break a review */ }
}

export function readTrace(limit = 60) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
