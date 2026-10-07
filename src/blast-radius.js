import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { required } from './config.js';
import { splitUnifiedDiff } from './hunks.js';

const exec = promisify(execFile);
// A reviewer who knows the codebase asks "who else calls this?". The diff alone cannot answer it,
// which is the single largest class of finding a diff-only review misses.
const SYMBOL = /^[A-Za-z_$][\w$]{2,63}$/;
const SEARCHED = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.cs', '*.razor', '*.cshtml'];
const DECLARATIONS = [
  { kind: 'export', pattern: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'export', pattern: /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'type', pattern: /^\s*(?:public\s+|internal\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/gm },
  { kind: 'member', pattern: /^\s*public\s+(?:static\s+|async\s+|virtual\s+|override\s+|sealed\s+|new\s+)*(?:[\w<>[\],?.]+\s+)+([A-Za-z_]\w*)\s*\(/gm },
];

function declared(source) {
  const found = new Map();
  for (const { kind, pattern } of DECLARATIONS) {
    for (const match of source.matchAll(pattern)) if (SYMBOL.test(match[1])) found.set(match[1], found.get(match[1]) || kind);
  }
  for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && SYMBOL.test(name)) found.set(name, found.get(name) || 'export');
    }
  }
  return found;
}

export async function blastRadius(config, { mode = 'working', base = 'HEAD', maxSymbols = 30, maxCallersPerSymbol = 15 } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./~^@{}-]*$/.test(base)) throw new Error('Invalid base ref');
  if (!['working', 'staged', 'branch'].includes(mode)) throw new Error('Invalid diff mode');
  const cwd = required(config, 'REVIEW_REPO_ROOT');
  const git = async args => {
    try { return (await exec('git', ['--no-pager', ...args], { cwd, windowsHide: true, timeout: 60000, maxBuffer: 24_000_000 })).stdout; }
    catch (error) {
      if (error.killed || error.signal) throw new Error('Git search timed out');
      if (typeof error.stdout === 'string') return error.stdout; // git grep exits 1 on no match
      throw new Error('Git read failed. Check REVIEW_REPO_ROOT and the base ref.');
    }
  };
  const range = mode === 'staged' ? ['--cached'] : mode === 'branch' ? [`${base}...HEAD`] : ['HEAD'];
  const touched = splitUnifiedDiff(await git(['diff', '--no-ext-diff', '--no-textconv', '--unified=0', ...range, '--']));
  const changed = new Set(touched.map(file => file.path));
  if (!changed.size) return { mode, base, changedFileCount: 0, symbols: [], symbolsFound: 0, symbolsInspected: 0, note: 'No changed files in this range, so no symbols were examined. If a change was expected, the checkout is on the wrong branch or the base is wrong.' };

  const candidates = [];
  for (const file of touched) {
    if (!/\.(m|c)?[jt]sx?$|\.(cs|razor|cshtml)$/.test(file.path)) continue;
    const absolute = path.resolve(cwd, file.path);
    if (!absolute.startsWith(path.resolve(cwd) + path.sep) || !fs.existsSync(absolute)) continue;
    let source;
    try { source = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    if (source.length > 2_000_000) continue;
    for (const [name, kind] of declared(source)) {
      // Only symbols this change actually touched; every other export in the file is noise.
      if (file.patch.includes(name)) candidates.push({ name, kind, definedIn: file.path });
    }
  }

  const unique = [...new Map(candidates.map(item => [`${item.definedIn}:${item.name}`, item])).values()];
  const symbols = [];
  for (const candidate of unique.slice(0, maxSymbols)) {
    const output = await git(['grep', '-n', '--word-regexp', '--fixed-strings', '-e', candidate.name, '--', ...SEARCHED]);
    const callers = [];
    for (const line of output.split('\n')) {
      // Git emits CRLF on Windows checkouts; an untrimmed carriage return defeats the anchor.
      const match = /^(.+?):(\d+):(.*)$/.exec(line.trimEnd());
      if (!match) continue;
      const file = match[1].replaceAll('\\', '/');
      if (changed.has(file)) continue; // already visible in the diff
      callers.push({ path: file, line: Number(match[2]), text: match[3].trim().slice(0, 200) });
    }
    symbols.push({ ...candidate, callerCount: callers.length, callers: callers.slice(0, maxCallersPerSymbol), truncated: callers.length > maxCallersPerSymbol });
  }

  return {
    mode, base, changedFileCount: changed.size, symbols, symbolsFound: unique.length, symbolsInspected: symbols.length,
    note: 'Callers listed here are outside the diff and were not reviewed. For each changed signature, contract or behaviour, check whether these call sites still hold. A symbol with zero callers may be new, dead, or reached dynamically. Text matching cannot resolve overloads, re-exports or dynamic dispatch.',
  };
}
