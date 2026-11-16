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
      if (tool === 'plan_ticket_tasks') return { ...entry, ticket: result?.ticket?.id ?? result?.ticket?.key, type: result?.ticket?.type ?? result?.ticket?.fields?.['System.WorkItemType'], tracker: result?.tracker };
      return { ...entry,
        files: result?.changes?.data?.length ?? (Array.isArray(result?.changes) ? result.fileCount ?? result.changes.length : undefined),
        hunks: result?.hunkCount, since: result?.since?.slice(0, 12), page: result?.page, incomplete: result?.incomplete,
        rubricsOffered: result?.rubrics?.requiredSkills ?? [],
        repoSkillsOffered: result?.repoSkills?.skills?.map(s => s.name),
        gate: result?.sonar?.gate?.data?.status ?? result?.sonar?.gate?.data?.projectStatus?.status,
        checkout: result?.localCheckout ? (result.localCheckout.worktree?.matchesReview ? 'review worktree at head' : result.localCheckout.matchesReview ? 'matches review head' : `MISMATCH: local is on ${result.localCheckout.branch}`) : undefined };
    case 'checkout':
      return { ...entry, head: result?.head?.slice(0, 12), reused: result?.reused, install: result?.install?.status, manager: args?.request?.packageManager };
    case 'rubric':
      return { ...entry, fetched: result?.rubrics?.map(r => `${r.source}:${r.name}`), missing: result?.missing };
    case 'checks':
      return { ...entry, run: result?.runId, worktree: Boolean(result?.worktree), scope: `${result?.mode} vs ${String(result?.base).slice(0, 12)}`, changedFiles: result?.changedFileCount, runners: Object.fromEntries(Object.entries(result?.runners ?? {}).map(([name, r]) => [name, r.status === 'ran' ? `${r.onChangedLines?.length ?? 0} on changed lines` : r.status])) };
    case 'blast_radius':
      return { ...entry, run: result?.runId, worktree: Boolean(result?.worktree), scope: `${result?.mode} vs ${String(result?.base).slice(0, 12)}`, symbols: result?.symbolsInspected, callers: result?.symbols?.reduce((n, s) => n + s.callerCount, 0) };
    case 'pipeline': {
      const p = result?.pipeline;
      const jobs = (p?.failedStages ?? []).flatMap(s => s.jobs);
      return { ...entry, status: p?.status, matchesHead: p?.matchesHead, failed: jobs.map(j => j.job), onChangedLines: jobs.reduce((n, j) => n + (j.locations ?? []).filter(l => l.onChangedLine).length, 0) };
    }
    case 'verify':
      // Statuses only: a checkout error can quote the remote URL, which may embed a credential.
      return { ...entry, pipeline: result?.pipeline?.data?.pipeline?.status ?? (result?.pipeline?.error && 'error'), install: result?.checkout?.data?.install?.status ?? (result?.checkout?.error && 'error'),
        runs: Object.fromEntries(Object.entries(result?.deterministic ?? {}).map(([pass, x]) => [pass, x.runId ? 'run' : 'skipped'])) };
    case 'tests':
      return { ...entry, run: result?.runId, worktree: Boolean(result?.worktree), scope: `${result?.mode} vs ${String(result?.base).slice(0, 12)}`, projects: Object.fromEntries((result?.projects ?? []).map(p => [p.project, p.total !== undefined ? `${p.passed}/${p.total} passed` : p.status])) };
    case 'read_file':
      return { ...entry, path: args.request.path ?? args.request.paths?.join(', ') ?? (args.request.hunks && `hunks ${args.request.hunks}`), lines: args.request.lines, resolved: [result, ...(result?.files ?? [])].filter(x => x?.resolvedFrom).length || undefined };
    case 'batch':
      return { ...entry, items: result?.items?.length, efforts: result?.efforts, failed: result?.items?.filter(x => x.error).length || undefined };
    case 'find':
      return { ...entry, paths: result?.paths?.length, matches: result?.matches?.length, source: result?.source?.split(' ')[0] };
    case 'prepare_replies':
      return { ...entry, draft: result?.draft?.id, items: result?.draft?.items?.length, approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined };
    case 'prepare_comments':
      return { ...entry, draft: result?.draft?.id, items: result?.draft?.items?.length,
        severities: Object.fromEntries(['blocker', 'major', 'minor', 'suggestion'].map(s => [s, result?.draft?.items?.filter(i => i.severity === s).length ?? 0]).filter(([, n]) => n)),
        coverage: result?.draft?.coverage ? `${result.draft.coverage.claimCount ?? result.draft.coverage.claims?.length} claim(s) over ${result.draft.coverage.hunkCount} hunks` : undefined,
        declared: result?.draft?.rubricsApplied,
        approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined,
        deterministic: result?.draft?.deterministic && Object.fromEntries(Object.entries(result.draft.deterministic).map(([pass, x]) => [pass, x.runId ? 'run' : 'skipped'])) };
    case 'prepare':
      return { ...entry, draft: result?.draft?.id, tasks: result?.draft?.items?.length, totalHours: result?.totalEstimatedHours, approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined };
    case 'approve':
      return { ...entry, draft: args.request.draftId, approval: result?.approval ? `${result.approval.via} ${result.approval.status}` : undefined, selected: args.request.selectedIds?.length };
    case 'revise':
      return { ...entry, draft: args.request.draftId, item: args.request.itemId };
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

// Where calls fail and retries go, from the trace: the numbers that say what to fix in the server or the prompts.
export function traceStats(events) {
  const steps = {}, messages = {}, reviews = {};
  for (const e of events) {
    const key = `${e.tool === 'review_work' ? '' : `${e.tool}/`}${e.step ?? '?'}`;
    const row = steps[key] ??= { calls: 0, errors: 0 };
    row.calls++;
    if (e.error) {
      row.errors++;
      const message = `${key}: ${e.error.replace(/[0-9a-f]{8,}/g, '#').replace(/\d+/g, 'N').slice(0, 90)}`;
      messages[message] = (messages[message] ?? 0) + 1;
    }
    if (e.step === 'prepare_comments') {
      const review = reviews[`${e.target} ${e.at.slice(0, 10)}`] ??= { failed: 0, ran: false, saved: false };
      if (e.error) review.failed++;
      else { review.saved = true; review.ran ||= Object.values(e.deterministic ?? {}).some(x => x === 'run'); }
    }
  }
  const saved = Object.values(reviews).filter(r => r.saved);
  return {
    calls: events.length, from: events[0]?.at?.slice(0, 10), to: events.at(-1)?.at?.slice(0, 10),
    steps: Object.entries(steps).sort((a, b) => b[1].calls - a[1].calls).map(([step, x]) => ({ step, ...x, rate: `${Math.round(100 * x.errors / x.calls)}%` })),
    topErrors: Object.entries(messages).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([message, count]) => ({ count, message })),
    reviews: { drafts: saved.length, firstTry: saved.filter(r => !r.failed).length, withChecksRun: saved.filter(r => r.ran).length },
  };
}

export function readTrace(limit = 60) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
