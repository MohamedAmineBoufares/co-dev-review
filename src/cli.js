import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { configKeys, loadConfig, localDir } from './config.js';
import { Store, digest } from './store.js';
import { Providers } from './providers.js';
import { safe, style, parseSelection, renderItem, renderHeader, editInEditor } from './review-ui.js';
import { readTrace } from './trace.js';

// One line per server call, grouped by what was being reviewed, so a review's protocol is
// readable at a glance: what was offered, what was fetched, what was run, what was declared.
function renderTrace(events) {
  const time = iso => new Date(iso).toTimeString().slice(0, 8);
  const list = value => (value?.length ? value.join(', ') : style.dim('none'));
  let group = null;
  const lines = [];
  for (const e of events) {
    if (e.step === 'read' || group === null) { if (e.target !== group) { group = e.target; lines.push('', style.bold(safe(group)) + style.dim(`  ${e.at.slice(0, 10)}`)); } }
    const step = `${e.tool === 'review_work' ? '' : e.tool + '/'}${e.step ?? ''}`.padEnd(18);
    let detail;
    if (e.error) detail = style.red(`error: ${safe(e.error)}`);
    else switch (e.step) {
      case 'read':
        detail = e.ticket ? `ticket ${e.ticket} (${safe(e.type ?? '?')})`
          : [e.files !== undefined && `${e.files} files`, e.hunks !== undefined && `${e.hunks} hunks`, e.page > 1 && `page ${e.page}`, e.incomplete && style.yellow('incomplete'), e.gate && `gate ${e.gate}`, e.checkout && (e.checkout.startsWith('MISMATCH') ? style.yellow(e.checkout) : style.dim(e.checkout))].filter(Boolean).join(' · ')
            + `\n${' '.repeat(29)}offered rubrics: ${list(e.rubricsOffered)}\n${' '.repeat(29)}offered repo skills: ${list(e.repoSkillsOffered)}`;
        break;
      case 'rubric': detail = `fetched via tool: ${style.green(list(e.fetched))}${e.missing?.length ? style.yellow(`  missing: ${e.missing.join(', ')}`) : ''}`; break;
      case 'checks': detail = `${style.dim(e.scope ?? '')}  ` + (e.changedFiles === 0 ? style.yellow('no changed files in range') : Object.entries(e.runners ?? {}).map(([n, s]) => `${n} ${s}`).join(' · ') || style.dim('no runners')); break;
      case 'blast_radius': detail = `${style.dim(e.scope ?? '')}  ${e.symbols} symbol(s), ${e.callers} caller(s) outside the diff`; break;
      case 'read_file': detail = safe(e.path); break;
      case 'prepare_comments': detail = `draft ${e.draft?.slice(0, 8)} · ${e.items} item(s) ${Object.entries(e.severities ?? {}).map(([s, n]) => `${n} ${s}`).join(', ')} · ${e.coverage}\n${' '.repeat(29)}declared applied: ${e.declared?.length ? style.green(e.declared.map(safe).join(', ')) : style.yellow('none')}`; break;
      case 'prepare': detail = `draft ${e.draft?.slice(0, 8)} · ${e.tasks} task(s) · ${e.totalHours} h`; break;
      case 'publish': detail = `draft ${e.draft?.slice(0, 8)} · ${e.posted} posted`; break;
      case 'view_draft': detail = `draft ${e.draft?.slice(0, 8)}`; break;
      default: detail = '';
    }
    lines.push(`  ${style.dim(time(e.at))}  ${step} ${detail}`);
  }
  return lines.join('\n');
}

const interactive = () => {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('This command requires an interactive human terminal; piped input is disabled.');
  return createInterface({ input: stdin, output: stdout });
};
const age = iso => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};
function renderDraftLine(draft, position) {
  const state = draft.posted >= draft.items ? style.grey('published') : draft.approved ? style.green('approved, awaiting publish') : style.yellow('needs approval');
  return `${style.bold(`[${position}]`)} ${style.dim(draft.id.slice(0, 8))} ${draft.kind === 'review' ? 'review' : 'tasks '} ${String(draft.items).padStart(2)} items  ${state}  ${style.grey(age(draft.createdAt))}\n     ${style.dim(safe(String(draft.label ?? '')).slice(0, 90))}`;
}

async function pickDraft(store, reference, rl) {
  if (reference) return store.resolve(reference);
  const pending = (await store.list()).filter(draft => draft.posted < draft.items);
  if (!pending.length) throw new Error('No pending drafts. Ask your assistant to prepare comments or tasks first.');
  if (pending.length === 1) { console.log(style.dim(`Using the only pending draft ${pending[0].id.slice(0, 8)}.\n`)); return pending[0].id; }
  console.log(style.bold('Pending drafts\n'));
  pending.forEach((draft, index) => console.log(renderDraftLine(draft, index + 1) + '\n'));
  const answer = Number((await rl.question('Which draft? ')).trim());
  if (!Number.isInteger(answer) || answer < 1 || answer > pending.length) throw new Error('Cancelled.');
  return pending[answer - 1].id;
}

async function approve(store, reference) {
  const rl = interactive();
  try {
    const id = await pickDraft(store, reference, rl);
    let draft = await store.read(id);
    console.log('\n' + renderHeader(draft) + '\n');
    draft.items.forEach((item, index) => console.log(renderItem(item, index + 1) + '\n'));

    let selected;
    for (;;) {
      const answer = (await rl.question(style.bold(`Include which items? [all | none | 1,3,5-7 | e <n> to edit | q] `))).trim();
      if (answer.toLowerCase() === 'q') { console.log('Cancelled.'); return; }
      const edit = /^e\s*(\d+)$/i.exec(answer);
      if (edit) {
        const position = Number(edit[1]);
        const item = draft.items[position - 1];
        if (!item) { console.log(style.red(`There is no item ${position}.`)); continue; }
        try {
          const field = item.body === undefined ? 'description' : 'body';
          draft = await store.updateItem(id, item.id, { [field]: await editInEditor(item[field]) });
          console.log('\n' + renderItem(draft.items[position - 1], position) + '\n' + style.dim('Edited. Any earlier approval of this draft is now void.') + '\n');
        } catch (error) { console.log(style.red(error.message)); }
        continue;
      }
      try { selected = parseSelection(answer, draft.items.length); }
      catch (error) { console.log(style.red(error.message)); continue; }
      if (!selected.length) { console.log('Nothing approved.'); return; }
      break;
    }

    const ids = selected.map(position => draft.items[position - 1].id);
    console.log(`\n${style.bold('Approving')} ${ids.join(', ')} → ${safe(draft.destination)}`);
    if ((await rl.question('Type APPROVE to authorize this exact content for 24 hours: ')).trim() !== 'APPROVE') { console.log('Cancelled.'); return; }
    await store.approve(id, ids, digest(draft));
    console.log(style.green('Approval saved.') + ' Ask your assistant to publish this draft.');
  } finally { rl.close(); }
}

async function main() {
  const [command, arg, itemId, resolution, remoteId] = process.argv.slice(2);
  const store = new Store();
  if (command === 'import-config') {
    if (!arg) throw new Error('Usage: npm run import-config -- <path-to-mcp.json>');
    const errors = [];
    const data = parse(await fs.readFile(arg, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`Invalid JSONC: ${printParseErrorCode(errors[0].error)}`);
    const imported = {};
    for (const server of Object.values(data.servers || data.mcpServers || {})) {
      for (const [key, value] of Object.entries(server.env || {})) {
        if (configKeys.includes(key) && typeof value === 'string' && value && !value.includes('${')) {
          if (imported[key] && imported[key] !== value) throw new Error(`Conflicting values for ${key}; configure it manually`);
          imported[key] = value;
        }
      }
    }
    await fs.mkdir(localDir, { recursive: true, mode: 0o700 });
    const file = path.join(localDir, 'config.json');
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(file, JSON.stringify({ ...previous, ...imported }, null, 2), { mode: 0o600 });
    console.log(`Imported keys only: ${Object.keys(imported).join(', ')}\nSaved to ignored .local/config.json. No server commands or unrelated integrations were imported.`);
    return;
  }
  if (command === 'doctor') {
    const config = loadConfig();
    const providers = new Providers(config);
    const checks = [
      ['GitLab', config.GITLAB_TOKEN, () => providers.client('gitlab').request('/user')],
      ['GitHub', config.GITHUB_TOKEN, () => providers.client('github').request('/user')],
      ['Azure DevOps', config.AZURE_DEVOPS_TOKEN, () => providers.client('azure').request(`/_apis/projects/${encodeURIComponent(config.AZURE_DEVOPS_PROJECT)}`, { query: { 'api-version': '7.1' } })],
      ['SonarQube', config.SONAR_TOKEN, async () => { const result = await providers.client('sonar').request('/api/authentication/validate'); if (!result.valid) throw new Error('Authentication rejected'); }],
    ];
    console.log(`Node ${process.version}`);
    for (const [name, enabled, check] of checks) {
      if (!enabled) { console.log(`${name}: not configured`); continue; }
      try { await check(); console.log(`${name}: connected`); }
      catch (error) { console.log(`${name}: ${error.message}`); process.exitCode = 1; }
    }
    console.log(config.REVIEW_REPO_ROOT ? `Local checkout: ${config.REVIEW_REPO_ROOT}` : 'Local checkout: not configured (step=checks and step=blast_radius are unavailable)');
    return;
  }
  if (command === 'pending') {
    const drafts = await store.list();
    if (!drafts.length) { console.log('No drafts.'); return; }
    drafts.forEach((draft, index) => console.log(renderDraftLine(draft, index + 1) + '\n'));
    console.log(style.dim('Approve one with: npm run approve -- <first 8 characters>'));
    return;
  }
  if (command === 'approve') return approve(store, arg);
  if (command === 'trace') {
    const events = readTrace(arg ? Number(arg) : 60);
    if (!events.length) { console.log('No trace yet. Run a review through the server first; every tool call is recorded in .local/trace.jsonl.'); return; }
    console.log(renderTrace(events));
    console.log(style.dim('\nSkills a client loads natively (Claude Code Skill tool, Codex skills) and files read with the host\'s own tools do not pass through this server. "offered" is what the server returned, "fetched via tool" is what came through step=rubric, "declared applied" is the assistant\'s own statement at prepare time.'));
    return;
  }
  if (command === 'reconcile') {
    if (!['posted', 'not-posted'].includes(resolution)) throw new Error('Usage: node src/cli.js reconcile <draft-id> <item-id> posted <remote-id> | not-posted');
    const rl = interactive();
    try {
      const id = await store.resolve(arg);
      await store.withLock(id, async () => {
        const draft = await store.read(id);
        const journal = await store.journal(id);
        if (!draft.items.some(x => x.id === itemId) || !['attempting', 'uncertain'].includes(journal[itemId]?.state)) throw new Error('Item is not uncertain');
        console.log(safe(JSON.stringify(draft.items.find(x => x.id === itemId), null, 2)));
        if ((await rl.question('Inspect the remote provider first. Type VERIFIED to confirm the stated outcome: ')).trim() !== 'VERIFIED') return;
        if (resolution === 'posted') {
          if (!remoteId) throw new Error('A remote ID is required');
          journal[itemId] = { state: 'posted', remoteId, reconciledAt: new Date().toISOString() };
        } else delete journal[itemId];
        await store.saveJournal(id, journal);
        console.log('Reconciled.');
      });
    } finally { rl.close(); }
    return;
  }
  throw new Error('Commands: import-config <file>, doctor, pending, approve [draft-id], trace [n], reconcile <draft-id> <item-id> posted <remote-id>|not-posted');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
