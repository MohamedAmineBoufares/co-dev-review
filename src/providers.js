import { Http } from './http.js';
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
    return { target, title: raw.title, description: raw.description ?? raw.body, url: raw.web_url ?? raw.html_url, head: gl ? raw.sha : raw.head.sha, sourceBranch: gl ? raw.source_branch : raw.head?.ref, refs: gl ? raw.diff_refs : { base_sha: raw.base.sha, head_sha: raw.head.sha }, state: raw.state, raw };
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
    const raw = await this.client(target.provider).request(`${this.repo(target)}/${gl ? `repository/files/${e(file)}` : `contents/${file.split('/').map(e).join('/')}`}`, { query: { ref } });
    if (raw.encoding !== 'base64' || typeof raw.content !== 'string') throw new Error('File is too large, a directory, or not available as base64');
    return { file, ref, content: Buffer.from(raw.content, 'base64').toString('utf8') };
  }
  async postFinding(target, snapshot, finding) {
    const api = this.client(target.provider);
    if (target.provider === 'gitlab') {
      const position = finding.path ? { position_type: 'text', base_sha: snapshot.refs.base_sha, start_sha: snapshot.refs.start_sha, head_sha: snapshot.head, old_path: finding.oldPath || finding.path, new_path: finding.path, [finding.side === 'LEFT' ? 'old_line' : 'new_line']: finding.line } : undefined;
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
  async createTask(parent, task) {
    const body = [
      { op: 'add', path: '/fields/System.Title', value: task.title },
      { op: 'add', path: '/fields/System.Description', value: task.description },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${this.config.AZURE_DEVOPS_ORG_URL.replace(/\/$/, '')}/_apis/wit/workItems/${parent.id}` } },
    ];
    for (const key of ['System.AreaPath', 'System.IterationPath']) if (parent.fields[key]) body.push({ op: 'add', path: `/fields/${key}`, value: parent.fields[key] });
    if (task.remainingWork !== undefined) body.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: task.remainingWork });
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
