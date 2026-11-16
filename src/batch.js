import { suggestRubrics } from './rubrics.js';
import { isGenerated, changedPaths } from './hunks.js';
import { resolveTicket } from './trackers.js';

// Bulk work: size each review or ticket so the host can give it to a subagent on a model that fits the effort.
// The server cannot start a model; it says how big each job is and hands back the brief to give the subagent.
// Approval never moves: subagents report findings or plans, the main conversation drafts and the user approves.
const MODEL = { low: 'smallest, fastest model available', medium: 'default model', high: 'most capable model available' };
const BULK_NOTE = 'If this host can start subagents, start one per item (at most 4 at a time) on the model its effort names, each with its brief; otherwise work through the items here, lowest effort first. Subagents never draft, approve or publish: collect their reports, show the user one summary table, and prepare drafts in this conversation for what the user keeps.';

export function reviewEffort({ files, lines, sensitive, more }) {
  if (more || sensitive || lines > 400 || files > 15) return 'high';
  return lines <= 60 && files <= 3 ? 'low' : 'medium';
}
export function ticketEffort({ chars, criteria }) {
  if (chars > 3000 || criteria > 8) return 'high';
  return chars < 600 && criteria <= 3 ? 'low' : 'medium';
}
const settle = async (inputs, run) => (await Promise.allSettled(inputs.map(run))).map((x, i) => (x.status === 'fulfilled' ? x.value : { id: inputs[i], error: x.reason?.message ?? 'failed' }));
const tally = items => items.reduce((n, item) => (item.effort ? { ...n, [item.effort]: (n[item.effort] ?? 0) + 1 } : n), {});

export async function reviewBatch(service, targets) {
  const { providers, store } = service;
  const items = await settle(targets, async given => {
    const target = service.withProject(given);
    const review = await providers.review(target);
    const page = await providers.diffs(target, 1);
    const files = page.filter(file => !isGenerated(file.new_path || file.filename));
    const lines = files.reduce((n, file) => n + String(file.diff ?? file.patch ?? '').split('\n').filter(line => /^[+-](?![+-]{2})/.test(line)).length, 0);
    const flags = suggestRubrics(changedPaths(files)).rubrics.map(r => r.id).filter(id => ['security', 'data', 'pipeline', 'build'].includes(id));
    const last = (await store.reviewHistory(providers.destination(target), target.number))[0]?.draft.snapshot?.head;
    const state = !last ? 'not reviewed here yet' : last === review.head ? 'already reviewed at this head' : 'changed since your last draft';
    const effort = reviewEffort({ files: files.length, lines, sensitive: flags.includes('security') || flags.includes('data'), more: page.length === 100 });
    return { id: target.number, target, title: review.title, author: review.raw?.author?.username ?? review.raw?.user?.login, url: review.url, state: review.state,
      files: files.length, changedLines: lines, flags: flags.length ? flags : undefined, pipeline: review.raw?.head_pipeline?.status,
      reviewed: state, skip: state === 'already reviewed at this head' || undefined, effort, model: MODEL[effort],
      read: { step: 'read', target, ...(state === 'changed since your last draft' ? { since: 'last' } : {}) } };
  });
  return { items, efforts: tally(items),
    brief: 'Review this merge/pull request with the co-dev-review server. Call review_work with the item\'s "read" arguments, then follow the "next" field of each result: load the routed skills, verify when a worktree is allowed, and try to refute each finding. Do not call prepare_comments, prepare_replies, approve or publish, and do not edit files. Reply in at most 40 lines: one table of findings (severity, confidence, path, lineText, problem, fix), blockers first, then what you could not verify.',
    note: `${BULK_NOTE} Items marked skip were already reviewed at their current head.` };
}

export async function ticketBatch(service, config, ticketIds, tracker) {
  const items = await settle(ticketIds, async ticketId => {
    const ref = resolveTicket(config, ticketId, tracker);
    const { ticket = {} } = await service.trackers[ref.tracker].read(ref, undefined, {});
    const text = `${ticket.description ?? ''}\n${ticket.acceptanceCriteria ?? ''}`;
    const criteria = String(ticket.acceptanceCriteria ?? '').split('\n').filter(line => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
    const children = ticket.children?.length ?? 0;
    const effort = ticketEffort({ chars: text.length, criteria });
    return { id: ticketId, tracker: ref.tracker, title: ticket.title, type: ticket.type, state: ticket.state, descriptionChars: text.length, criteria, children: children || undefined,
      skip: children ? true : undefined, effort, model: MODEL[effort], read: { step: 'read', ticketId, tracker: ref.tracker } };
  });
  return { items, efforts: tally(items),
    brief: 'Decompose this ticket with the co-dev-review server. Call plan_ticket_tasks with the item\'s "read" arguments, read its discussion and children, then propose implementation and testing tasks. Do not call prepare, approve or publish. Reply in at most 30 lines: one table (title, scope, completion criteria, estimatedHours, assumptions), the total hours, and the open questions.',
    note: `${BULK_NOTE} Items marked skip already have child tasks: read them before proposing duplicates.` };
}
