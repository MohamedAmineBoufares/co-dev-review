import { anchors } from './service.js';

// What CI already knows about this change: which stages failed, why, and where. A failing stage
// is a finding the reviewer must report, anchored to the file and line the log points at.

const MAX_JOBS = 8;
const MAX_LOCATIONS = 40;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const EXTENSIONS = '[cm]?[jt]sx?|vue|svelte|cs|razor|cshtml|s?css|less|json|ya?ml|py|go|java|kt|rb|php|sql|html';
const PATH = `(?:[A-Za-z]:)?[\\w./\\\\@+-]+\\.(?:${EXTENSIONS})`;
const TSC = new RegExp(`^(${PATH})\\((\\d+),(\\d+)\\):\\s*(.+)$`, 'i');
const ESLINT_FILE = new RegExp(`^\\s*(${PATH})\\s*$`, 'i');
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@/-]+))?\s*$/;
const GENERIC = new RegExp(`(${PATH})[:(](\\d+)(?:[:,](\\d+))?`, 'i');
const CAUSE = /\b(error|errors|failed|failure|fail|exception|panic|fatal|cannot|not found|exit code|exit status|denied|timed? ?out|TS\d{4})\b|[A-Za-z]+(Error|Exception):|ERR!|✗|×|✖/i;
const NOISE = /^(Uploading artifacts|Cleaning up|Saving cache|Running after_script|Skipping|section_|Job succeeded|\$ )/i;

export function cleanLog(text) {
  return String(text ?? '')
    .replace(ANSI, '')
    .split('\n')
    .map(line => line
      .replace(/^.*\r(?=.)/, '') // progress bars rewrite the line with \r: keep what was shown last
      .replace(/\r$/, '')
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '') // GitHub Actions timestamps
      .replace(/section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?/g, '') // GitLab collapsible sections
      .replace(/^##\[(?:error|warning)\]/, '')
      .trimEnd())
    .filter(line => line.trim() && !/^##\[(?:group|endgroup)\]/.test(line));
}

// The lines that explain the failure, in order: errors near the end of the log, then its last words.
export function failureCause(lines, limit = 12) {
  const tail = lines.slice(-400);
  const hits = tail.filter(line => CAUSE.test(line) && !NOISE.test(line.trim()));
  const chosen = hits.length ? hits.slice(-limit) : tail.slice(-8);
  return [...new Set(chosen.map(line => (line.length > 300 ? `${line.slice(0, 299)}…` : line.trim())))];
}

// file:line references in tsc, ESLint (stylish), test-runner and generic "path:line:col" formats.
export function findLocations(lines) {
  const found = [];
  let eslintFile = null;
  for (const line of lines) {
    const header = ESLINT_FILE.exec(line);
    if (header) { eslintFile = header[1]; continue; }
    const row = eslintFile && ESLINT_ROW.exec(line);
    if (row) { found.push({ path: eslintFile, line: Number(row[1]), column: Number(row[2]), message: `${row[4]}${row[5] ? ` (${row[5]})` : ''}` }); continue; }
    if (!/^\s/.test(line)) eslintFile = null;
    const tsc = TSC.exec(line.trim());
    if (tsc) { found.push({ path: tsc[1], line: Number(tsc[2]), column: Number(tsc[3]), message: tsc[4] }); continue; }
    const generic = GENERIC.exec(line);
    if (generic && !/node_modules/.test(generic[1])) found.push({ path: generic[1], line: Number(generic[2]), column: generic[3] ? Number(generic[3]) : undefined, message: line.trim().slice(0, 300) });
  }
  const unique = new Map(found.map(item => [`${item.path}:${item.line}:${item.message}`, item]));
  return [...unique.values()];
}

// CI runs in /builds/group/project/ or /home/runner/work/repo/repo/; reviews speak repository-relative paths.
export function relativize(file, changedPaths, repoName) {
  const p = String(file).replaceAll('\\', '/').replace(/^\.\//, '');
  const changed = changedPaths.find(c => p === c || p.endsWith(`/${c}`));
  if (changed) return changed;
  const marker = repoName ? p.lastIndexOf(`/${repoName}/`) : -1;
  return marker >= 0 ? p.slice(marker + repoName.length + 2) : p.replace(/^\/+/, '');
}

function locate(rawLocations, diff, repoName) {
  const changedPaths = [...diff.keys()];
  return rawLocations.map(item => {
    const path = relativize(item.path, changedPaths, repoName);
    const added = diff.get(path);
    return { ...item, path, inDiff: Boolean(added), onChangedLine: Boolean(added?.has(item.line)) };
  }).sort((a, b) => Number(b.onChangedLine) - Number(a.onChangedLine) || Number(b.inDiff) - Number(a.inDiff)).slice(0, MAX_LOCATIONS);
}

async function changedLines(providers, target) {
  const diff = new Map();
  for (let page = 1; page <= 30; page++) {
    const batch = await providers.diffs(target, page);
    for (const file of batch) diff.set(file.new_path || file.filename, anchors(file.diff ?? file.patch).RIGHT);
    if (batch.length < 100) break;
  }
  return diff;
}

function group(jobs) {
  const stages = new Map();
  for (const job of jobs) {
    if (!stages.has(job.stage)) stages.set(job.stage, []);
    stages.get(job.stage).push(job);
  }
  return [...stages].map(([stage, items]) => ({ stage, jobs: items.map(({ stage: _, ...job }) => job) }));
}

async function gitlab(providers, target, review, diff) {
  const api = providers.client('gitlab');
  const repo = providers.repo(target);
  const pipelines = await api.request(`${repo}/merge_requests/${target.number}/pipelines`, { query: { per_page: 20 } });
  const pick = pipelines.find(p => p.sha === review.head) ?? pipelines[0];
  if (!pick) return { status: 'none', note: 'No pipeline has run for this merge request.' };
  const repoName = /\/([^/]+)\/-\/merge_requests\//.exec(review.url ?? '')?.[1];
  const jobsOf = async id => api.request(`${repo}/pipelines/${id}/jobs`, { query: { per_page: 100 } });
  let jobs = await jobsOf(pick.id);
  // Child pipelines (trigger jobs) are where monorepos usually run their per-application stages.
  try {
    for (const bridge of await api.request(`${repo}/pipelines/${pick.id}/bridges`, { query: { per_page: 100 } })) {
      const child = bridge.downstream_pipeline;
      // Only child pipelines of this project: a multi-project trigger lives in a repository this review is not about.
      if (bridge.status !== 'failed' || !child?.id || (child.project_id && pick.project_id && child.project_id !== pick.project_id)) continue;
      jobs = jobs.concat((await jobsOf(child.id)).map(job => ({ ...job, stage: `${bridge.name} › ${job.stage}` })));
    }
  } catch { /* no bridges endpoint or no access: the parent pipeline still reports */ }
  const failed = jobs.filter(job => job.status === 'failed');
  const required = failed.filter(job => !job.allow_failure);
  const reported = [];
  for (const job of required.slice(0, MAX_JOBS)) {
    let lines = [];
    try { lines = cleanLog(await api.text(`${repo}/jobs/${job.id}/trace`)); } catch { /* the job header still says which stage failed */ }
    reported.push({ stage: job.stage, job: job.name, status: job.status, failureReason: job.failure_reason, url: job.web_url, durationS: job.duration ? Math.round(job.duration) : undefined,
      cause: lines.length ? failureCause(lines) : [`${job.failure_reason ?? 'failed'} (log unavailable)`], locations: locate(findLocations(lines), diff, repoName) });
  }
  return {
    status: pick.status, id: pick.id, sha: pick.sha, matchesHead: pick.sha === review.head, url: pick.web_url, ref: pick.ref,
    failedStages: group(reported), moreFailedJobs: Math.max(0, required.length - MAX_JOBS) || undefined,
    allowedFailures: failed.filter(job => job.allow_failure).map(job => `${job.stage}/${job.name}`),
    running: jobs.filter(job => ['running', 'pending', 'created'].includes(job.status)).map(job => `${job.stage}/${job.name}`),
  };
}

async function github(providers, target, review, diff) {
  const api = providers.client('github');
  const repo = providers.repo(target);
  const { check_runs: runs = [] } = await api.request(`${repo}/commits/${review.head}/check-runs`, { query: { per_page: 100 } });
  if (!runs.length) return { status: 'none', sha: review.head, matchesHead: true, note: 'No checks have run on the head commit.' };
  const failed = runs.filter(run => ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion));
  const running = runs.filter(run => run.status !== 'completed');
  const repoName = target.project.split('/')[1];
  const reported = [];
  for (const run of failed.slice(0, MAX_JOBS)) {
    let raw = [];
    // Annotations carry the exact file and line; the log fills in when a tool printed none.
    try {
      raw = (await api.request(`${repo}/check-runs/${run.id}/annotations`, { query: { per_page: 50 } }))
        .filter(a => a.annotation_level === 'failure' && a.path && a.path !== '.github')
        .map(a => ({ path: a.path, line: a.start_line, message: [a.title, a.message].filter(Boolean).join(': ').slice(0, 300) }));
    } catch { /* no annotations */ }
    let lines = [];
    if (run.app?.slug === 'github-actions') { try { lines = cleanLog(await api.text(`${repo}/actions/jobs/${run.id}/logs`)); } catch { /* logs expire or need Actions: read */ } }
    const summary = [run.output?.title, run.output?.summary].filter(Boolean).join(' — ');
    reported.push({ stage: run.app?.name ?? 'checks', job: run.name, status: run.conclusion, url: run.html_url,
      cause: lines.length ? failureCause(lines) : summary ? [summary.slice(0, 600)] : ['failed (no log available)'],
      locations: locate([...raw, ...findLocations(lines)], diff, repoName) });
  }
  return {
    status: failed.length ? 'failed' : running.length ? 'running' : 'success', sha: review.head, matchesHead: true,
    failedStages: group(reported), moreFailedJobs: Math.max(0, failed.length - MAX_JOBS) || undefined,
    running: running.map(run => run.name),
  };
}

export async function pipelineReport(providers, target) {
  const review = await providers.review(target);
  const diff = await changedLines(providers, target);
  const report = target.provider === 'gitlab' ? await gitlab(providers, target, review, diff) : await github(providers, target, review, diff);
  return {
    pipeline: report,
    note: report.status === 'none' ? report.note
      : `${report.matchesHead === false ? 'This pipeline ran on an older commit than the review head; say so before relying on it. ' : ''}Report every failing stage in the review: when a location is onChangedLine, comment inline at that path and line with the stage, job and cause; otherwise write a general comment naming the stage, job, file:line and cause. A required stage failing because of this change is a confirmed blocker. allowedFailures do not block the merge.`,
  };
}
