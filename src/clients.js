import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { projectRoot } from './config.js';

const run = promisify(execFile);
export const SERVER_NAME = 'co-dev-review';
const TOML_TABLE = 'mcp_servers.co_dev_review';
// checkout installs dependencies and checks type-checks a workspace: minutes, not the 60 s some clients allow by default.
const TOOL_TIMEOUT_SECONDS = 900;

const home = os.homedir();
const userConfigDir = process.platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
  : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
  : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');

// An absolute node and server path: no PATH lookup, no .cmd shim, which some clients cannot spawn on Windows.
export const launch = () => ({ command: process.execPath, args: [path.join(projectRoot, 'src', 'server.js')] });

function readJson(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '';
  if (!text.trim()) return { text: '{}', data: {} };
  const errors = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || typeof data !== 'object' || data === null) throw new Error(`${file} is not valid JSON; fix it, or add the server by hand`);
  return { text, data };
}
function backupOnce(file) {
  const copy = `${file}.co-dev-review.bak`;
  if (fs.existsSync(file) && !fs.existsSync(copy)) fs.copyFileSync(file, copy);
}
// jsonc-parser edits in place, so the user's comments, ordering and other servers survive.
function setJson(file, keyPath, value) {
  const { text } = readJson(file);
  backupOnce(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, applyEdits(text, modify(text, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })));
}
const getJson = (file, keyPath) => keyPath.reduce((node, key) => node?.[key], readJson(file).data);

function stripTomlTable(text, name) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let skipping = false;
  const kept = text.split(/\r?\n/).filter(line => {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) skipping = header[1] === name || header[1].startsWith(`${name}.`);
    return !skipping;
  });
  return kept.join(eol).replace(new RegExp(`(${eol}){3,}`, 'g'), eol + eol);
}

function jsonClient(id, name, { dir, file, key, entry, skills }) {
  return {
    id, name, file, skills,
    detected: () => fs.existsSync(dir),
    registered: () => Boolean(getJson(file, [key, SERVER_NAME])),
    install: () => { setJson(file, [key, SERVER_NAME], entry(launch())); return file; },
    uninstall: () => { if (fs.existsSync(file) && getJson(file, [key, SERVER_NAME])) { setJson(file, [key, SERVER_NAME], undefined); return file; } return null; },
  };
}

async function claudeCli(args) {
  try { return { ok: true, output: (await run('claude', args, { windowsHide: true, timeout: 60000 })).stdout }; }
  catch (error) { return { ok: false, missing: error.code === 'ENOENT', output: String(error.stderr || error.message) }; }
}

export const clients = [
  {
    id: 'claude-code', name: 'Claude Code (CLI, IDE extensions)', file: 'claude mcp --scope user', skills: path.join(home, '.claude', 'skills'),
    detected: () => fs.existsSync(path.join(home, '.claude')),
    registered: async () => (await claudeCli(['mcp', 'get', SERVER_NAME])).ok,
    install: async () => {
      const { command, args } = launch();
      await claudeCli(['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
      const added = await claudeCli(['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', command, ...args]);
      if (!added.ok) throw new Error(added.missing ? `the claude command is not on PATH. Run: claude mcp add --scope user ${SERVER_NAME} -- "${command}" "${args[0]}"` : added.output.trim().slice(0, 300));
      return 'claude mcp (user scope)';
    },
    uninstall: async () => ((await claudeCli(['mcp', 'remove', '--scope', 'user', SERVER_NAME])).ok ? 'claude mcp (user scope)' : null),
  },
  jsonClient('claude-desktop', 'Claude Desktop app', {
    dir: path.join(userConfigDir, 'Claude'), file: path.join(userConfigDir, 'Claude', 'claude_desktop_config.json'),
    key: 'mcpServers', entry: ({ command, args }) => ({ command, args }),
  }),
  {
    id: 'codex', name: 'Codex (CLI, app, IDE extension)', file: path.join(codexHome, 'config.toml'), skills: path.join(codexHome, 'skills'),
    detected: () => fs.existsSync(codexHome),
    registered() { return fs.existsSync(this.file) && new RegExp(`^\\s*\\[${TOML_TABLE.replace('.', '\\.')}\\]`, 'm').test(fs.readFileSync(this.file, 'utf8')); },
    install() {
      const { command, args } = launch();
      const previous = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
      const eol = previous.includes('\r\n') ? '\r\n' : '\n';
      // JSON string escaping is valid TOML basic-string escaping for paths.
      const block = [`[${TOML_TABLE}]`, `command = ${JSON.stringify(command)}`, `args = [${args.map(x => JSON.stringify(x)).join(', ')}]`, 'startup_timeout_sec = 30', `tool_timeout_sec = ${TOOL_TIMEOUT_SECONDS}`].join(eol);
      const kept = stripTomlTable(previous, TOML_TABLE).trimEnd();
      backupOnce(this.file);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, (kept ? kept + eol + eol : '') + block + eol);
      return this.file;
    },
    uninstall() {
      if (!this.registered()) return null;
      backupOnce(this.file);
      fs.writeFileSync(this.file, stripTomlTable(fs.readFileSync(this.file, 'utf8'), TOML_TABLE));
      return this.file;
    },
  },
  jsonClient('vscode', 'VS Code (GitHub Copilot agent mode)', {
    dir: path.join(userConfigDir, 'Code', 'User'), file: path.join(userConfigDir, 'Code', 'User', 'mcp.json'),
    key: 'servers', entry: ({ command, args }) => ({ type: 'stdio', command, args }), skills: path.join(home, '.copilot', 'skills'),
  }),
  jsonClient('copilot-cli', 'GitHub Copilot CLI', {
    dir: path.join(home, '.copilot'), file: path.join(home, '.copilot', 'mcp-config.json'),
    key: 'mcpServers', entry: ({ command, args }) => ({ type: 'local', command, args, tools: ['*'] }), skills: path.join(home, '.copilot', 'skills'),
  }),
  jsonClient('cursor', 'Cursor', {
    dir: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json'),
    key: 'mcpServers', entry: ({ command, args }) => ({ command, args }),
  }),
  jsonClient('windsurf', 'Windsurf', {
    dir: path.join(home, '.codeium', 'windsurf'), file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    key: 'mcpServers', entry: ({ command, args }) => ({ command, args }),
  }),
  jsonClient('antigravity', 'Google Antigravity', {
    dir: path.join(home, '.gemini', 'antigravity'), file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    key: 'mcpServers', entry: ({ command, args }) => ({ command, args }),
  }),
  jsonClient('gemini-cli', 'Gemini CLI', {
    dir: path.join(home, '.gemini', 'settings.json'), file: path.join(home, '.gemini', 'settings.json'),
    key: 'mcpServers', entry: ({ command, args }) => ({ command, args, timeout: TOOL_TIMEOUT_SECONDS * 1000 }),
  }),
];

export const clientIds = clients.map(client => client.id);
export function selectClients(list) {
  if (!list) return clients;
  const ids = list.split(',').map(x => x.trim()).filter(Boolean);
  const unknown = ids.filter(id => !clientIds.includes(id));
  if (unknown.length) throw new Error(`Unknown client(s): ${unknown.join(', ')}. Known: ${clientIds.join(', ')}`);
  return clients.filter(client => ids.includes(client.id));
}
