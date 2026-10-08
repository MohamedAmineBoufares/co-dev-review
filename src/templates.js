import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, localDir } from './config.js';

// Conversation starters: Markdown files that open a session with the persona, the general rules and
// the steps of one task. They are served as MCP prompts and printed by `co-dev-review template`.
//
//   ---
//   title: Review a merge request
//   description: One line shown in the assistant's prompt list
//   arg target (required): what to pass
//   arg language: optional argument
//   ---
//   {{> _persona}}            includes templates/_persona.md (files starting with _ are partials)
//   {{target}}                 the argument's value
//   {{ticket|fallback text}}   the value, or the fallback when the argument was not given
//
// Files in <state folder>/templates override or extend the packaged ones by name.

export const templateDirs = () => [path.join(projectRoot, 'templates'), path.join(localDir, 'templates')];
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function parseTemplate(text, name) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!match) throw new Error(`Template ${name} has no front matter`);
  const meta = { name, title: name, description: '', args: [] };
  for (const line of match[1].split(/\r?\n/)) {
    const arg = /^arg\s+([a-zA-Z][\w-]*)\s*(\(required\))?\s*:\s*(.*)$/.exec(line.trim());
    if (arg) { meta.args.push({ name: arg[1], required: Boolean(arg[2]), description: arg[3].trim() }); continue; }
    const field = /^(title|description)\s*:\s*(.*)$/.exec(line.trim());
    if (field) meta[field[1]] = field[2].trim();
  }
  return { ...meta, body: match[2].trim() };
}

export function loadTemplates(dirs = templateDirs()) {
  const templates = new Map();
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir).filter(file => file.endsWith('.md')); } catch { continue; }
    for (const file of files) {
      const name = file.slice(0, -3);
      const key = name.replace(/^_/, '');
      if (!NAME.test(key)) continue;
      try { templates.set(name, { ...parseTemplate(fs.readFileSync(path.join(dir, file), 'utf8'), name), source: path.join(dir, file), partial: name.startsWith('_') }); }
      catch { /* a broken user template must not hide the others; `npm run check` reports packaged ones */ }
    }
  }
  return templates;
}

export function renderTemplate(templates, name, values = {}) {
  const template = templates.get(name);
  if (!template || template.partial) throw new Error(`Unknown template "${name}". Available: ${[...templates.values()].filter(t => !t.partial).map(t => t.name).join(', ')}`);
  const missing = template.args.filter(arg => arg.required && !String(values[arg.name] ?? '').trim()).map(arg => arg.name);
  if (missing.length) throw new Error(`Template ${name} needs: ${missing.join(', ')}`);
  const expand = (body, depth) => body.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, partial) => {
    const included = templates.get(partial);
    if (!included || depth > 3) return '';
    return expand(included.body, depth + 1);
  });
  return expand(template.body, 0)
    .replace(/\{\{\s*([a-zA-Z][\w-]*)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback) => {
      const value = String(values[key] ?? '').trim();
      return value || (fallback ?? '').trim();
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Placeholders that name no declared argument are a typo the author should hear about.
export function lintTemplate(templates, template) {
  const declared = new Set(template.args.map(arg => arg.name));
  const problems = [];
  for (const [, partial] of template.body.matchAll(/\{\{>\s*([\w-]+)\s*\}\}/g)) if (!templates.get(partial)) problems.push(`unknown partial ${partial}`);
  const bodies = [template.body, ...[...template.body.matchAll(/\{\{>\s*([\w-]+)\s*\}\}/g)].map(([, p]) => templates.get(p)?.body ?? '')];
  for (const body of bodies) for (const [, key, fallback] of body.matchAll(/\{\{\s*([a-zA-Z][\w-]*)\s*(?:\|([^}]*))?\}\}/g)) {
    if (!declared.has(key) && fallback === undefined) problems.push(`{{${key}}} is not a declared argument and has no fallback`);
  }
  return problems;
}
