import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const legacyDir = path.join(projectRoot, '.local');
// State lives per user, outside the package, so a global or npx install works from any client.
// An existing in-repository .local keeps working; CO_DEV_HOME overrides both.
export const localDir = process.env.CO_DEV_HOME ? path.resolve(process.env.CO_DEV_HOME)
  : fs.existsSync(legacyDir) ? legacyDir
  : path.join(os.homedir(), '.co-dev-review');
export const configFile = path.join(localDir, 'config.json');
export const configKeys = ['GITLAB_URL', 'GITLAB_TOKEN', 'GITLAB_PROJECT_ID', 'GITHUB_API_URL', 'GITHUB_TOKEN', 'AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN', 'AZURE_DEVOPS_ASSIGNEE', 'JIRA_URL', 'JIRA_EMAIL', 'JIRA_TOKEN', 'JIRA_ASSIGNEE', 'JIRA_SUBTASK_TYPE', 'JIRA_ACCEPTANCE_FIELD', 'GITHUB_REPO', 'GITHUB_ASSIGNEE', 'TICKET_TRACKER', 'SONAR_URL', 'SONAR_TOKEN', 'SONAR_PROJECT_KEY', 'REVIEW_REPO_ROOT', 'REVIEW_REMOTE', 'REVIEW_WORKTREE_DIR', 'REVIEW_DOTNET_PROJECT', 'REVIEW_APPROVAL', 'REVIEW_CHECKOUT', 'EXTRA_CA_CERTS'];
export function savedConfig() {
  if (!fs.existsSync(configFile)) return {};
  const text = fs.readFileSync(configFile, 'utf8').replace(/^﻿/, '');
  return text.trim() ? JSON.parse(text) : {};
}
export function loadConfig() {
  const saved = savedConfig();
  return Object.fromEntries(configKeys.map(k => [k, process.env[k] ?? saved[k] ?? '']));
}
export function required(config, key) {
  if (!config[key]) throw new Error(`Missing configuration: ${key}`);
  return config[key];
}
