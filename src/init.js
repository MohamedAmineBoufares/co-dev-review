import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { parse } from 'jsonc-parser';
import { stdin, stdout } from 'node:process';
import { configFile, configKeys, localDir, loadConfig, savedConfig, projectRoot } from './config.js';
import { clients, selectClients } from './clients.js';
import { linkSkills, unlinkSkills } from './skill-links.js';
import { doctor } from './doctor.js';
import { style, safe } from './review-ui.js';

const run = promisify(execFile);
const SECRET = /TOKEN/;
const QUESTIONS = [
  ['GITLAB_URL', 'GitLab URL', 'https://gitlab.com'],
  ['GITLAB_TOKEN', 'GitLab personal access token (api scope)'],
  ['GITLAB_PROJECT_ID', 'Default GitLab project id or path'],
  ['AZURE_DEVOPS_ORG_URL', 'Azure DevOps organization URL, e.g. https://dev.azure.com/org'],
  ['AZURE_DEVOPS_PROJECT', 'Azure DevOps project'],
  ['AZURE_DEVOPS_TOKEN', 'Azure DevOps PAT (Work Items read & write)'],
  ['AZURE_DEVOPS_ASSIGNEE', 'Assignee for created tasks (email), optional'],
  ['JIRA_URL', 'Jira URL, e.g. https://your-site.atlassian.net, optional'],
  ['JIRA_EMAIL', 'Jira account email (Jira Cloud only; leave empty for Server/Data Center)'],
  ['JIRA_TOKEN', 'Jira API token (Cloud) or personal access token (Server/Data Center)'],
  ['SONAR_URL', 'Sonar URL', 'https://sonarcloud.io'],
  ['SONAR_TOKEN', 'Sonar token, optional'],
  ['SONAR_PROJECT_KEY', 'Sonar project key, optional'],
  ['GITHUB_TOKEN', 'GitHub token, optional'],
  ['GITHUB_REPO', 'Default GitHub repository for issues (owner/repo), optional'],
  ['TICKET_TRACKER', 'Tracker for bare ticket numbers: azure, jira or github, optional'],
  ['REVIEW_REPO_ROOT', 'Absolute path of the local checkout to review'],
  ['EXTRA_CA_CERTS', 'Extra CA certificates .pem, only behind a TLS-intercepting proxy'],
];

const shown = (key, value) => !value ? style.dim('empty') : SECRET.test(key) ? style.dim(`…${String(value).slice(-4)}`) : safe(String(value));
const flag = (argv, name) => argv.includes(`--${name}`);
const option = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const yes = async (rl, question, fallback = true) => {
  if (!rl) return fallback;
  const answer = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return answer ? answer.startsWith('y') : fallback;
};

function writeConfig(values) {
  fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, JSON.stringify(Object.fromEntries(Object.entries(values).filter(([key, value]) => configKeys.includes(key) && value !== '')), null, 2), { mode: 0o600 });
}

// Only allowlisted keys from another client's MCP configuration; its commands are never imported.
export function importConfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  const data = parse(text, [], { allowTrailingComma: true }) ?? {};
  const imported = {};
  for (const server of Object.values(data.servers || data.mcpServers || {})) {
    for (const [key, value] of Object.entries(server?.env || {})) {
      if (!configKeys.includes(key) || typeof value !== 'string' || !value || value.includes('${')) continue;
      if (imported[key] && imported[key] !== value) throw new Error(`Conflicting values for ${key}; configure it manually`);
      imported[key] = value;
    }
  }
  writeConfig({ ...savedConfig(), ...imported });
  return Object.keys(imported);
}

async function askConfig(rl) {
  const current = savedConfig();
  const next = { ...current };
  console.log(style.dim('Press Enter to keep the value in brackets, type "-" to clear it.\n'));
  for (const [key, label, fallback] of QUESTIONS) {
    const value = current[key] ?? fallback ?? '';
    const answer = (await rl.question(`${label} [${shown(key, value)}]: `)).trim();
    next[key] = answer === '-' ? '' : answer || value;
  }
  if (next.REVIEW_REPO_ROOT && !fs.existsSync(path.join(next.REVIEW_REPO_ROOT, '.git'))) console.log(style.yellow(`  ${next.REVIEW_REPO_ROOT} does not look like a git checkout.`));
  writeConfig(next);
  console.log(style.green(`Saved ${configFile}`) + style.dim(' (readable by your user only)\n'));
}

async function onPath(command) {
  try { await run(process.platform === 'win32' ? 'where' : 'which', [command], { windowsHide: true }); return true; } catch { return false; }
}

export async function init(argv) {
  const interactive = stdin.isTTY && stdout.isTTY && !flag(argv, 'yes');
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    console.log(`${style.bold('co-dev-review setup')}\n${style.dim(`package: ${projectRoot}\nstate:   ${localDir}`)}\n`);

    // 1. Credentials
    if (option(argv, 'import')) console.log(`Imported: ${importConfig(option(argv, 'import')).join(', ') || 'nothing'}\n`);
    const hasConfig = Object.keys(savedConfig()).length > 0;
    if (rl && !flag(argv, 'no-config') && await yes(rl, hasConfig ? 'Review the saved configuration?' : 'Configure credentials now?', !hasConfig)) await askConfig(rl);

    // 2. Connectivity
    if (!flag(argv, 'no-doctor')) { console.log(style.bold('Checking connections')); await doctor(loadConfig()); console.log(); }

    // 3. Clients
    const candidates = selectClients(option(argv, 'clients'));
    const chosen = [];
    console.log(style.bold('Assistants'));
    for (const client of candidates) {
      const detected = option(argv, 'clients') ? true : client.detected();
      let registered = false;
      try { registered = await client.registered(); } catch { /* unreadable config is reported at install */ }
      console.log(`  ${detected ? style.green('found  ') : style.dim('absent ')} ${client.name}${registered ? style.dim('  (already registered, will refresh)') : ''}`);
      if (detected) chosen.push(client);
    }
    if (!chosen.length) { console.log(style.yellow('\nNo supported assistant found. Pass --clients <id,...> to register anyway.')); return; }
    const register = !rl || await yes(rl, `\nRegister co-dev-review in these ${chosen.length} assistant(s)?`);
    if (register) {
      for (const client of chosen) {
        try { console.log(`  ${style.green('✓')} ${client.name} → ${safe(await client.install())}`); }
        catch (error) { console.log(`  ${style.red('✗')} ${client.name}: ${safe(error.message)}`); process.exitCode = 1; }
      }
    }

    // 4. Skills, where the assistant reads SKILL.md natively; the others get them over MCP.
    const skillDirs = [...new Set(chosen.map(client => client.skills).filter(Boolean))];
    if (skillDirs.length && !flag(argv, 'no-skills') && (!rl || await yes(rl, '\nLink the review skills into these assistants\' skill folders?'))) {
      for (const dir of skillDirs) {
        const report = linkSkills(dir, { force: flag(argv, 'force') });
        console.log(`  ${dir}: ${report.linked.length} linked, ${report.unchanged.length} unchanged${report.conflicts.length ? style.yellow(`, ${report.conflicts.length} left alone (not our link: ${report.conflicts.join(', ')}; --force replaces)`) : ''}${report.failed.length ? style.red(`, failed: ${report.failed.join('; ')}`) : ''}`);
      }
    }

    // 5. The approval command must work from any terminal, not only from this folder.
    if (!await onPath('co-dev-review')) {
      console.log(style.yellow('\nThe co-dev-review command is not on PATH, so approval only works with "npm run approve" in this folder.'));
      if (rl && await yes(rl, 'Install it globally now (npm install -g)?')) {
        try { await run('npm', ['install', '-g', projectRoot], { windowsHide: true, timeout: 300000, shell: process.platform === 'win32' }); console.log(style.green('Installed: co-dev-review is now available in any terminal.')); }
        catch (error) { console.log(style.red(`npm install -g failed: ${String(error.stderr || error.message).trim().slice(0, 300)}`)); }
      } else console.log(style.dim(`  Later: npm install -g "${projectRoot}"`));
    }

    console.log(`\n${style.bold('Done.')} Restart or reload each assistant so it starts the server, then ask it: "List the tools from co-dev-review".`);
    console.log(style.dim('Approve drafts with: co-dev-review approve   ·   Check connections: co-dev-review doctor   ·   Undo: co-dev-review uninstall'));
  } finally { rl?.close(); }
}

export async function uninstall(argv) {
  for (const client of selectClients(option(argv, 'clients'))) {
    try {
      const where = await client.uninstall();
      if (where) console.log(`  removed from ${client.name} (${safe(where)})`);
    } catch (error) { console.log(`  ${client.name}: ${safe(error.message)}`); }
    if (client.skills && fs.existsSync(client.skills)) {
      const removed = unlinkSkills(client.skills);
      if (removed.length) console.log(`  unlinked ${removed.length} skill(s) from ${client.skills}`);
    }
  }
  console.log(style.dim(`\nYour configuration, drafts and trace stay in ${localDir}. Delete that folder yourself to remove them. A .co-dev-review.bak copy of each edited client file was kept beside it.`));
}
