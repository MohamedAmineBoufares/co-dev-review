import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Node reads NODE_EXTRA_CA_CERTS once, at startup, and Node 20 cannot read the OS certificate store.
// MCP clients launch the server with whatever environment they happened to start with (a desktop app
// started before the variable existed keeps the stale environment for its whole lifetime, and some
// rewrite their config and drop an env block), so the server cannot rely on the launcher. When
// EXTRA_CA_CERTS is configured and the variable is absent, the process re-launches itself once with
// the variable set and relays stdio; the MCP client never notices.
export function extraCaFile(config) {
  if (process.env.NODE_EXTRA_CA_CERTS || !config.EXTRA_CA_CERTS) return null;
  const file = path.resolve(config.EXTRA_CA_CERTS);
  if (!existsSync(file)) throw new Error(`EXTRA_CA_CERTS points to a missing file: ${file}`);
  return file;
}

// Resolves with the child's exit code once it ends; null when no relaunch is needed.
export function relaunchWithExtraCa(config) {
  const file = extraCaFile(config);
  if (!file) return null;
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: file },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  process.on('exit', () => { if (child.exitCode === null) child.kill(); });
  return new Promise(resolve => child.on('close', code => resolve(code ?? 1)));
}
