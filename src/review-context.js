import { ledger, changedPaths } from './hunks.js';
import { suggestRubrics } from './rubrics.js';
import { repoSkills } from './repo-skills.js';
import { localHead } from './local.js';

// Combine related reads without hiding partial failures or pagination.
export async function sections(tasks) {
  const entries = Object.entries(tasks);
  const results = await Promise.allSettled(entries.map(([, run]) => Promise.resolve().then(run)));
  return Object.fromEntries(results.map((result, i) => [entries[i][0], result.status === 'fulfilled'
    ? { data: result.value }
    : { error: result.reason instanceof Error ? result.reason.message : 'Read failed' }]));
}

export async function reviewContext(providers, target, page = 1) {
  const review = await providers.review(target);
  const result = await sections({ changes: () => providers.diffs(target, page), discussions: () => providers.discussions(target, page) });
  const current = await providers.review(target);
  if (current.head !== review.head) throw new Error('PR/MR changed while reading. Restart the review at page 1.');
  const { raw, ...metadata } = review;
  const files = result.changes.data ?? [];
  // checks and blast_radius only mean something if the checkout is on this change.
  const local = await localHead(providers.config);
  const localCheckout = local && { ...local, matchesReview: local.head === review.head,
    note: local.head === review.head ? 'Local checkout is at the head of this review; step=checks and step=blast_radius will reflect it.'
      : `Local checkout is on ${local.branch} (${local.head.slice(0, 8)}), not the head of this review (${String(review.head).slice(0, 8)}, branch ${review.sourceBranch ?? 'unknown'}). step=checks and step=blast_radius would analyse the wrong code: check out the review branch first, or state that the deterministic pass was not run.` };
  return { review: metadata, ...result, page,
    hunks: ledger(files, (page - 1) * 100), rubrics: suggestRubrics(changedPaths(files)),
    localCheckout,
    repoSkills: repoSkills(providers.config, { origin: 'REVIEW_REPO_ROOT, which is assumed to be a checkout of this same project — verify that before relying on it' }),
    nextPage: Object.values(result).some(x => x.data?.length === 100) ? page + 1 : null,
    incomplete: Object.values(result).some(x => x.error) || Boolean(files.some(x => x.too_large || x.collapsed || !(x.diff ?? x.patch))),
    note: 'Continue nextPage until null. Errors and omitted patches mean incomplete evidence. Read full files at review.head for context. Load the skills named in rubrics (or fetch their text with step=rubric if this client cannot load skill files), read the repoSkills files that match this change, and account for every hunk id: prepare_comments requires a verdict for each one.' };
}

export async function ticketContext(providers, id, continuationToken) {
  const ticket = await providers.ticket(id);
  return { ticket, ...await sections({ discussion: () => providers.ticketComments(id, continuationToken) }),
    note: 'Use discussion.data.continuationToken for more comments. Child work item IDs are in ticket.relations; read relevant children with this same tool.' };
}

export async function sonarReport(providers, scope, ruleKey) {
  const report = await sections(Object.fromEntries(['gate', 'metrics', 'issues', 'hotspots'].map(kind => [kind, () => providers.sonar(kind, scope)])));
  if (ruleKey) Object.assign(report, await sections({ rule: () => providers.sonarRule(ruleKey) }));
  return { ...report, note: 'Missing/failed sections are unknown, not zero. For issues/hotspots, continue page while paging.pageIndex * paging.pageSize < paging.total. Use ruleKey for remediation details.' };
}
