import { Providers } from './providers.js';
import { TLS_HINT } from './http.js';
import { style } from './review-ui.js';
import { configFile } from './config.js';

// Read-only authentication checks, shared by `doctor` and `init`. Returns false when a configured integration fails.
export async function doctor(config) {
  const providers = new Providers(config);
  const checks = [
    ['GitLab', config.GITLAB_TOKEN, () => providers.client('gitlab').request('/user')],
    ['GitHub', config.GITHUB_TOKEN, () => providers.client('github').request('/user')],
    ['Azure DevOps', config.AZURE_DEVOPS_TOKEN, () => providers.client('azure').request(`/_apis/projects/${encodeURIComponent(config.AZURE_DEVOPS_PROJECT)}`, { query: { 'api-version': '7.1' } })],
    ['Jira', config.JIRA_TOKEN, () => providers.client('jira').request('/rest/api/2/myself')],
    ['SonarQube', config.SONAR_TOKEN, async () => { const result = await providers.client('sonar').request('/api/authentication/validate'); if (!result.valid) throw new Error('Authentication rejected'); }],
  ];
  console.log(`Node ${process.version}${process.env.NODE_EXTRA_CA_CERTS ? ` (extra CA certs: ${process.env.NODE_EXTRA_CA_CERTS})` : ''}`);
  console.log(`Configuration: ${configFile}`);
  let healthy = true, tlsFailure = false;
  for (const [name, enabled, check] of checks) {
    if (!enabled) { console.log(`${name}: not configured`); continue; }
    try { await check(); console.log(`${name}: connected`); }
    catch (error) {
      // The hint is long and identical for every provider; print it once below.
      tlsFailure ||= error.message.includes(TLS_HINT);
      console.log(`${name}: ${error.message.replace(` ${TLS_HINT}`, '')}`);
      healthy = false;
    }
  }
  if (tlsFailure) console.log(style.yellow(`\n${TLS_HINT}\nOn Windows: run the export in README "Behind a corporate proxy", then set EXTRA_CA_CERTS in the configuration, and restart your assistant.\n`));
  console.log(config.REVIEW_REPO_ROOT ? `Local checkout: ${config.REVIEW_REPO_ROOT}` : 'Local checkout: not configured (checkout, checks and blast_radius are unavailable)');
  const trackers = [config.AZURE_DEVOPS_TOKEN && 'azure', config.JIRA_TOKEN && 'jira', config.GITHUB_TOKEN && config.GITHUB_REPO && 'github'].filter(Boolean);
  if (trackers.length) console.log(`Ticket trackers: ${trackers.join(', ')} · default for bare ids: ${config.TICKET_TRACKER || trackers[0]}`);
  if (config.AZURE_DEVOPS_TOKEN) console.log(config.AZURE_DEVOPS_ASSIGNEE ? `Task assignee: ${config.AZURE_DEVOPS_ASSIGNEE} (unless a task names its own)` : 'Task assignee: not configured — created tasks are left unassigned unless each names one. Set AZURE_DEVOPS_ASSIGNEE to your UPN.');
  return healthy;
}
