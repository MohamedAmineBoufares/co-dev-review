import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const localDir = path.join(projectRoot, '.local');
export const configKeys = ['GITLAB_URL', 'GITLAB_TOKEN', 'GITLAB_PROJECT_ID', 'GITHUB_API_URL', 'GITHUB_TOKEN', 'AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN', 'SONAR_URL', 'SONAR_TOKEN', 'SONAR_PROJECT_KEY', 'REVIEW_REPO_ROOT', 'REVIEW_DOTNET_PROJECT'];
export function loadConfig() {
  const file = path.join(localDir, 'config.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return Object.fromEntries(configKeys.map(k => [k, process.env[k] ?? saved[k] ?? '']));
}
export function required(config, key) {
  if (!config[key]) throw new Error(`Missing configuration: ${key}`);
  return config[key];
}
