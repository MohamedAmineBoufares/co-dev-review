import { Http, ApiError } from './http.js';
import { required } from './config.js';

const e = encodeURIComponent;
export class Providers {
  constructor(config, fetchImpl) { this.config = config; this.fetch = fetchImpl; }
  destination(target) { return target ? this.client(target.provider).base + this.repo(target) : this.client('azure').base + '/' + this.azureProject(); }
  client(provider) {
    const c = this.config;
    if (provider === 'gitlab') return new Http((c.GITLAB_URL || 'https://gitlab.com').replace(/\/$/, '') + '/api/v4', { 'PRIVATE-TOKEN': required(c, 'GITLAB_TOKEN') }, this.fetch);
    if (provider === 'github') return new Http(c.GITHUB_API_URL || 'https://api.github.com', { Authorization: `Bearer ${required(c, 'GITHUB_TOKEN')}`, 'X-GitHub-Api-Version': '2022-11-28' }, this.fetch);
    if (provider === 'azure') return new Http(required(c, 'AZURE_DEVOPS_ORG_URL'), { Authorization: `Basic ${Buffer.from(':' + required(c, 'AZURE_DEVOPS_TOKEN')).toString('base64')}` }, this.fetch);
    // Jira Cloud authenticates with email + API token (Basic); Server/Data Center with a personal access token (Bearer).
    if (provider === 'jira') return new Http(required(c, 'JIRA_URL').replace(/\/$/, ''), { Authorization: c.JIRA_EMAIL ? `Basic ${Buffer.from(`${c.JIRA_EMAIL}:${required(c, 'JIRA_TOKEN')}`).toString('base64')}` : `Bearer ${required(c, 'JIRA_TOKEN')}` }, this.fetch);
    if (provider === 'sonar') return new Http(c.SONAR_URL || 'https://sonarcloud.io', { Authorization: `Bearer ${required(c, 'SONAR_TOKEN')}` }, this.fetch);
    throw new Error('Unsupported provider');
  }
  repo(target) {
    const project = target.project || this.config.GITLAB_PROJECT_ID;
    if (!project) throw new Error('A repository/project identifier is required');
    if (target.provider === 'gitlab') return `/projects/${e(project)}`;
    if (!/^[\w.-]+\/[\w.-]+$/.test(project)) throw new Error('GitHub project must be owner/repository');
    return `/repos/${project.split('/').map(e).join('/')}`;
  }
  async listReviews(target, page = 1) {
    const gl = target.provider === 'gitlab';
    return this.client(target.provider).request(this.repo(target) + (gl ? '/merge_requests' : '/pulls'), { query: { state: gl ? 'opened' : 'open', per_page: 50, page } });
  }
  async review(target) {
    const gl = target.provider === 'gitlab';
    const raw = await this.client(target.provider).request(`${this.repo(target)}/${gl ? 'merge_requests' : 'pulls'}/${target.number}`);
    return { target, title: raw.title, description: raw.description ?? raw.body, url: raw.web_url ?? raw.html_url, head: gl ? raw.sha : raw.head.sha, sourceBranch: gl ? raw.source_branch : raw.head?.ref, targetBranch: gl ? raw.target_branch : raw.base?.ref, refs: gl ? raw.diff_refs : { base_sha: raw.base.sha, head_sha: raw.head.sha }, state: raw.state, raw };
  }
  async diffs(target, page = 1) {
    const gl = target.provider === 'gitlab';
    return this.client(target.provider).request(`${this.repo(target)}/${gl ? 'merge_requests' : 'pulls'}/${target.number}/${gl ? 'diffs' : 'files'}`, { query: { per_page: 100, page } });
  }
  async discussions(target, page = 1) {
    const gl = target.provider === 'gitlab';
    return this.client(target.provider).request(`${this.repo(target)}/${gl ? 'merge_requests' : 'pulls'}/${target.number}/${gl ? 'discussions' : 'comments'}`, { query: { per_page: 100, page } });
  }
  async source(target, file, ref) {
    if (file.split('/').some(x => x === '..' || x === '.') || file.startsWith('/')) throw new Error('File path must be repository-relative without traversal');
    const gl = target.provider === 'gitlab';
    let raw;
    try { raw = await this.client(target.provider).request(`${this.repo(target)}/${gl ? `repository/files/${e(file)}` : `contents/${file.split('/').map(e).join('/')}`}`, { query: { ref } }); }
    catch (error) {
      // One call in eight asked for a file the API did not have; the generic message blamed access and configuration.
      // One call in eight asked for a file the API did not have; notFound lets the caller look the name up in the tree.
      if (error instanceof ApiError && error.status === 404) throw Object.assign(new Error(`No file ${file} at ${String(ref).slice(0, 12)}. Deleted files have none at the head; step=find with path lists the paths that exist.`), { notFound: true });
      throw error;
    }
    if (raw.encoding !== 'base64' || typeof raw.content !== 'string') throw new Error('File is too large, a directory, or not available as base64');
    return { file, ref, content: Buffer.from(raw.content, 'base64').toString('utf8') };
  }
  // What changed between two commits of a review: the diff of a re-review.
  async compare(target, from, to) {
    const gl = target.provider === 'gitlab';
    const raw = await this.client(target.provider).request(gl ? `${this.repo(target)}/repository/compare` : `${this.repo(target)}/compare/${e(from)}...${e(to)}`, gl ? { query: { from, to } } : {});
    return (gl ? raw.diffs : raw.files) ?? [];
  }
  // Every file path at a commit. GitLab pages its tree, so a very large repository is cut at 3000 files.
  async tree(target, ref) {
    const api = this.client(target.provider);
    if (target.provider === 'github') return ((await api.request(`${this.repo(target)}/git/trees/${e(ref)}`, { query: { recursive: 1 } })).tree ?? []).filter(x => x.type === 'blob').map(x => x.path);
    const paths = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await api.request(`${this.repo(target)}/repository/tree`, { query: { ref, recursive: true, per_page: 100, page } });
      paths.push(...batch.filter(x => x.type === 'blob').map(x => x.path));
      if (batch.length < 100) break;
    }
    return paths;
  }
  async search(target, query, ref) {
    const api = this.client(target.provider);
    if (target.provider === 'gitlab') return (await api.request(`${this.repo(target)}/search`, { query: { scope: 'blobs', search: query, ref, per_page: 30 } })).map(x => ({ path: x.path, line: x.startline, text: String(x.data ?? '').trim().slice(0, 300) }));
    return ((await api.request('/search/code', { query: { q: `${query} repo:${target.project}`, per_page: 30 } })).items ?? []).map(x => ({ path: x.path }));
  }
  async postFinding(target, snapshot, finding) {
    const api = this.client(target.provider);
    if (finding.replyTo) {
      if (target.provider !== 'gitlab') return api.request(`${this.repo(target)}/pulls/${target.number}/comments/${e(finding.replyTo)}/replies`, { method: 'POST', body: { body: finding.body } });
      const thread = `${this.repo(target)}/merge_requests/${target.number}/discussions/${e(finding.replyTo)}`;
      const note = await api.request(`${thread}/notes`, { method: 'POST', body: { body: finding.body } });
      // The reply is posted either way; a failed resolve is reported, not retried, so the reply is never doubled.
      if (finding.resolve) { try { await api.request(thread, { method: 'PUT', body: { resolved: true } }); } catch { note.warning = 'Reply posted, but the thread could not be resolved'; } }
      return note;
    }
    if (target.provider === 'gitlab') {
      // GitLab wants both line numbers for an unchanged line and exactly one for a changed line.
      const lines = finding.unchanged ? { old_line: finding.oldLine, new_line: finding.line } : { [finding.side === 'LEFT' ? 'old_line' : 'new_line']: finding.line };
      const position = finding.path ? { position_type: 'text', base_sha: snapshot.refs.base_sha, start_sha: snapshot.refs.start_sha, head_sha: snapshot.head, old_path: finding.oldPath || finding.path, new_path: finding.path, ...lines } : undefined;
      return api.request(`${this.repo(target)}/merge_requests/${target.number}/discussions`, { method: 'POST', body: { body: finding.body, ...(position ? { position } : {}) } });
    }
    if (!finding.path) return api.request(`${this.repo(target)}/issues/${target.number}/comments`, { method: 'POST', body: { body: finding.body } });
    return api.request(`${this.repo(target)}/pulls/${target.number}/comments`, { method: 'POST', body: { body: finding.body, commit_id: snapshot.head, path: finding.path, line: finding.line, side: finding.side } });
  }
  azureProject() { return e(required(this.config, 'AZURE_DEVOPS_PROJECT')); }
  async ticket(id) {
    return this.client('azure').request(`/${this.azureProject()}/_apis/wit/workitems/${id}`, { query: { '$expand': 'all', 'api-version': '7.1' } });
  }
  async ticketComments(id, continuationToken) {
    return this.client('azure').request(`/${this.azureProject()}/_apis/wit/workItems/${id}/comments`, { query: { 'api-version': '7.1-preview.4', '$top': 100, continuationToken } });
  }
  async queryTickets(wiql) {
    return this.client('azure').request(`/${this.azureProject()}/_apis/wit/wiql`, { method: 'POST', query: { 'api-version': '7.1' }, body: { query: wiql } });
  }
  async runSavedQuery(queryId) {
    return this.client('azure').request(`/${this.azureProject()}/_apis/wit/wiql/${e(queryId)}`, { query: { 'api-version': '7.1' } });
  }
  async ticketsByIds(ids) {
    if (!ids.length) return { value: [] };
    const fields = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo', 'System.Tags', 'System.AreaPath', 'System.IterationPath', 'System.ChangedDate'];
    return this.client('azure').request(`/${this.azureProject()}/_apis/wit/workitems`, { query: { ids: ids.join(','), fields: fields.join(','), 'api-version': '7.1' } });
  }
  async createTask(parent, task) {
    const body = [
      { op: 'add', path: '/fields/System.Title', value: task.title },
      { op: 'add', path: '/fields/System.Description', value: task.description },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${this.config.AZURE_DEVOPS_ORG_URL.replace(/\/$/, '')}/_apis/wit/workItems/${parent.id}` } },
    ];
    for (const key of ['System.AreaPath', 'System.IterationPath']) if (parent.fields[key]) body.push({ op: 'add', path: `/fields/${key}`, value: parent.fields[key] });
    if (task.estimatedHours !== undefined) {
      body.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: task.estimatedHours });
      body.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: task.estimatedHours });
    }
    const assignedTo = task.assignedTo || this.config.AZURE_DEVOPS_ASSIGNEE;
    if (assignedTo) body.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignedTo });
    return this.client('azure').request(`/${this.azureProject()}/_apis/wit/workitems/$Task`, { method: 'POST', contentType: 'application/json-patch+json', query: { 'api-version': '7.1' }, body });
  }
  async sonar(kind, { project, pullRequest, branch, page = 1 }) {
    if (pullRequest && branch) throw new Error('Choose pullRequest or branch, not both');
    const key = project || required(this.config, 'SONAR_PROJECT_KEY');
    const scope = { pullRequest, branch };
    const routes = {
      metrics: ['/api/measures/component', { component: key, metricKeys: 'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,new_coverage,new_duplicated_lines_density,security_hotspots', ...scope }],
      gate: ['/api/qualitygates/project_status', { projectKey: key, ...scope }],
      issues: ['/api/issues/search', { componentKeys: key, resolved: false, p: page, ps: 100, ...scope }],
      hotspots: ['/api/hotspots/search', { projectKey: key, p: page, ps: 100, ...scope }],
    };
    return this.client('sonar').request(routes[kind][0], { query: routes[kind][1] });
  }
  async sonarRule(key) { return this.client('sonar').request('/api/rules/show', { query: { key } }); }
}
