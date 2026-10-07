// Provider APIs return everything they know: avatars, links, watermarks, hashes, styling markup.
// The model needs a fraction of it, and every extra field costs context in every review.
// These shapers keep what a reviewer or planner uses and drop the rest; `full` views stay available.

const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" };
export function htmlToText(html, limit = 20000) {
  if (html === undefined || html === null) return undefined;
  const text = String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*(br|\/p|\/div|\/h\d|\/tr|\/ul|\/ol)[^>]*>/gi, '\n')
    .replace(/<\s*\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, code) => {
      if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(text, limit);
}
export const clip = (text, limit) => (typeof text === 'string' && text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const compactObject = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)));

// --- Merge/pull request diffs and discussions -------------------------------------------------

export function compactFile(file) {
  const path = file.new_path || file.filename || file.path;
  const oldPath = file.old_path || file.previous_filename;
  const status = file.status
    || (file.new_file ? 'added' : file.deleted_file ? 'deleted' : file.renamed_file ? 'renamed' : 'modified');
  return compactObject({
    path, oldPath: oldPath && oldPath !== path ? oldPath : undefined, status,
    patch: file.diff ?? file.patch,
    unavailable: file.too_large ? 'too large' : file.collapsed ? 'collapsed by provider' : (file.diff ?? file.patch) ? undefined : 'no patch returned',
  });
}

const NOTE_LIMIT = 2000;
export function compactDiscussions(items) {
  if (!Array.isArray(items)) return items;
  return items.map(item => {
    // GitLab: a discussion holding notes. GitHub: a flat review comment.
    if (Array.isArray(item.notes)) {
      const notes = item.notes.filter(note => !note.system).map(note => compactObject({
        author: note.author?.username, at: note.created_at?.slice(0, 16), body: clip(note.body, NOTE_LIMIT),
        path: note.position?.new_path ?? note.position?.old_path, line: note.position?.new_line ?? note.position?.old_line,
      }));
      if (!notes.length) return null;
      const resolvable = item.notes.filter(note => note.resolvable);
      return compactObject({ id: item.id, resolved: resolvable.length ? resolvable.every(note => note.resolved) : undefined, notes });
    }
    return compactObject({
      id: item.id, author: item.user?.login, at: item.created_at?.slice(0, 16), body: clip(item.body, NOTE_LIMIT),
      path: item.path, line: item.line ?? item.original_line, replyTo: item.in_reply_to_id,
    });
  }).filter(Boolean);
}

// --- Azure DevOps work items -------------------------------------------------------------------

const idFromUrl = url => Number(/\/workItems\/(\d+)$/i.exec(url ?? '')?.[1]) || undefined;
export function compactTicket(ticket) {
  if (!ticket?.fields) return ticket;
  const f = ticket.fields;
  const relations = ticket.relations ?? [];
  const linked = rel => relations.filter(r => r.rel === rel).map(r => idFromUrl(r.url)).filter(Boolean);
  return compactObject({
    id: ticket.id, rev: ticket.rev, url: ticket._links?.html?.href,
    type: f['System.WorkItemType'], title: f['System.Title'], state: f['System.State'], reason: f['System.Reason'],
    assignedTo: f['System.AssignedTo']?.displayName, area: f['System.AreaPath'], iteration: f['System.IterationPath'],
    tags: f['System.Tags'], priority: f['Microsoft.VSTS.Common.Priority'], severity: f['Microsoft.VSTS.Common.Severity'],
    effort: f['Microsoft.VSTS.Scheduling.Effort'] ?? f['Microsoft.VSTS.Scheduling.StoryPoints'],
    originalEstimate: f['Microsoft.VSTS.Scheduling.OriginalEstimate'], remainingWork: f['Microsoft.VSTS.Scheduling.RemainingWork'],
    created: f['System.CreatedDate']?.slice(0, 10), changed: f['System.ChangedDate']?.slice(0, 10),
    description: htmlToText(f['System.Description']),
    acceptanceCriteria: htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    reproSteps: htmlToText(f['Microsoft.VSTS.TCM.ReproSteps']),
    systemInfo: htmlToText(f['Microsoft.VSTS.TCM.SystemInfo'], 4000),
    parent: linked('System.LinkTypes.Hierarchy-Reverse')[0],
    children: linked('System.LinkTypes.Hierarchy-Forward'),
    related: relations.filter(r => /Related|Dependency|Duplicate/.test(r.rel)).map(r => compactObject({ rel: r.attributes?.name ?? r.rel, id: idFromUrl(r.url) })),
    // Linked branches, commits and pull requests: how a ticket leads to its code.
    artifacts: relations.filter(r => r.rel === 'ArtifactLink' || r.rel === 'Hyperlink').map(r => compactObject({ name: r.attributes?.name, url: r.url })),
    attachments: relations.filter(r => r.rel === 'AttachedFile').map(r => compactObject({ name: r.attributes?.name, url: r.url })),
  });
}

export function compactComments(response) {
  if (!response || !Array.isArray(response.comments)) return response;
  return compactObject({
    totalCount: response.totalCount, continuationToken: response.continuationToken,
    comments: response.comments.map(c => compactObject({ id: c.id, author: c.createdBy?.displayName, at: c.createdDate?.slice(0, 16), text: htmlToText(c.text, NOTE_LIMIT) })),
  });
}

// --- SonarQube / SonarCloud ----------------------------------------------------------------------

const sonarPath = component => (typeof component === 'string' && component.includes(':') ? component.slice(component.indexOf(':') + 1) : component);
export function compactSonar(kind, data) {
  if (!data || typeof data !== 'object') return data;
  if (kind === 'gate') {
    const status = data.projectStatus ?? data;
    return compactObject({ status: status.status, conditions: (status.conditions ?? []).map(c => compactObject({ metric: c.metricKey, status: c.status, actual: c.actualValue, threshold: c.errorThreshold, comparator: c.comparator })) });
  }
  if (kind === 'metrics') {
    const measures = data.component?.measures ?? [];
    return Object.fromEntries(measures.map(m => [m.metric, m.value ?? m.period?.value ?? m.periods?.[0]?.value]));
  }
  if (kind === 'issues') {
    return compactObject({
      paging: data.paging,
      issues: (data.issues ?? []).map(i => compactObject({
        key: i.key, rule: i.rule, severity: i.impacts?.map(x => `${x.softwareQuality}:${x.severity}`).join(',') || i.severity, type: i.type,
        path: sonarPath(i.component), line: i.line, message: i.message, effort: i.effort,
      })),
    });
  }
  if (kind === 'hotspots') {
    return compactObject({
      paging: data.paging,
      hotspots: (data.hotspots ?? []).map(h => compactObject({ key: h.key, path: sonarPath(h.component), line: h.line, message: h.message, probability: h.vulnerabilityProbability, category: h.securityCategory, status: h.status })),
    });
  }
  return data;
}
export function compactRule(data) {
  const rule = data?.rule ?? data;
  if (!rule || typeof rule !== 'object') return data;
  const sections = (rule.descriptionSections ?? []).map(s => `${s.key}:\n${htmlToText(s.content, 4000)}`).join('\n\n');
  return compactObject({ key: rule.key, name: rule.name, type: rule.type, severity: rule.severity, description: clip(sections || htmlToText(rule.htmlDesc ?? rule.mdDesc, 8000), 8000) });
}

// --- Drafts --------------------------------------------------------------------------------------

// The model just wrote every body; echoing them back doubles the cost of every prepare call.
export function draftSummary(draft) {
  return compactObject({
    id: draft.id, kind: draft.kind, language: draft.language, destination: draft.destination, target: draft.target,
    head: draft.snapshot?.head, parent: draft.parent?.id,
    items: draft.items.map(item => compactObject({ id: item.id, severity: item.severity, confidence: item.confidence, path: item.path, line: item.line, title: item.title, estimatedHours: item.estimatedHours })),
    coverage: draft.coverage && { hunkCount: draft.coverage.hunkCount, claimCount: draft.coverage.claims?.length },
    rubricsApplied: draft.rubricsApplied, deterministic: draft.deterministic,
  });
}

// --- Source files ----------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 1500;
// "120-220", "120-" or "-80"; without a range, long files are cut with an explicit continuation hint.
export function sliceLines(source, range) {
  const lines = String(source.content).split('\n');
  const total = lines.length;
  let from = 1, to = total;
  if (range) {
    const match = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(range) ?? /^\s*(\d+)\s*$/.exec(range);
    if (!match) throw new Error('lines must look like "120-220", "120-" or "-80"');
    from = Math.max(1, Number(match[1]) || 1);
    to = Math.min(total, match[2] === undefined ? from : Number(match[2]) || total);
    if (to < from) throw new Error(`Empty line range: the file has ${total} lines`);
  } else if (total > DEFAULT_MAX_LINES) to = DEFAULT_MAX_LINES;
  return compactObject({
    ...source, content: lines.slice(from - 1, to).join('\n'), totalLines: total,
    startLine: from === 1 && to === total ? undefined : from, endLine: from === 1 && to === total ? undefined : to,
    note: to < total && !range ? `Showing lines 1-${to} of ${total}. Ask for lines "${to + 1}-" to continue.` : undefined,
  });
}
