#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, localDir } from './config.js';
import { Store, digest } from './store.js';
import { safe, style, parseSelection, renderItem, renderHeader, editInEditor } from './review-ui.js';
import { readTrace } from './trace.js';
import { doctor } from './doctor.js';
import { init, uninstall, importConfig } from './init.js';
import { clients } from './clients.js';
import { linkSkills } from './skill-links.js';
import { relaunchWithExtraCa } from './ca.js';

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
      case 'checkout': detail = `head ${e.head ?? '?'}${e.reused ? ' · reused worktree' : ' · new worktree'} · install ${e.install ?? '?'}`; break;
      case 'checks': detail = `${style.dim(e.scope ?? '')}  ` + (e.changedFiles === 0 ? style.yellow('no changed files in range') : Object.entries(e.runners ?? {}).map(([n, s]) => `${n} ${s}`).join(' · ') || style.dim('no runners')); break;
      case 'blast_radius': detail = `${style.dim(e.scope ?? '')}  ${e.symbols} symbol(s), ${e.callers} caller(s) outside the diff`; break;
      case 'read_file': detail = safe(e.path); break;
      case 'prepare_comments': detail = `draft ${e.draft?.slice(0, 8)} · ${e.items} item(s) ${Object.entries(e.severities ?? {}).map(([s, n]) => `${n} ${s}`).join(', ')} · ${e.coverage}\n${' '.repeat(29)}declared applied: ${e.declared?.length ? style.green(e.declared.map(safe).join(', ')) : style.yellow('none')}`
        + (e.approval ? `
${' '.repeat(29)}approval: ${e.approval}` : '')
        + (e.deterministic ? `\n${' '.repeat(29)}deterministic: ${Object.entries(e.deterministic).map(([pass, how]) => how === 'run' ? style.green(`${pass} run`) : style.yellow(`${pass} skipped`)).join(', ')}` : ''); break;
      case 'prepare': detail = `draft ${e.draft?.slice(0, 8)} · ${e.tasks} task(s) · ${e.totalHours} h${e.approval ? ` · approval ${e.approval}` : ''}`; break;
      case 'request_approval': detail = `draft ${e.draft?.slice(0, 8)} · approval ${e.approval ?? '?'}`; break;
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

const HELP = `co-dev-review <command>

  serve                      start the MCP server on stdio (what assistants launch)
  init [--clients a,b] [--yes] [--no-config] [--no-skills] [--import mcp.json] [--force]
                             configure credentials, check them, register the server in every
                             detected assistant and link the skills
  uninstall [--clients a,b]  remove the registrations and skill links (state is kept)
  doctor                     check credentials and connectivity, read-only
  approve [draft]            inspect and approve a draft in this terminal
  pending                    list drafts and their state
  trace [n]                  what the last reviews actually did
  link-skills [client...] [--dry-run] [--force]
  import-config <mcp.json>   import allowlisted settings from another MCP configuration
  reconcile <draft> <item> posted <remote-id> | not-posted

Assistants: ${clients.map(c => c.id).join(', ')}`;

async function main() {
  const [command, arg, itemId, resolution, remoteId] = process.argv.slice(2);
  const rest = process.argv.slice(3);
  // The server handles its own CA relaunch; importing it starts it.
  if (command === 'serve') { await import('./server.js'); return; }
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(HELP); return; }
  const relaunched = relaunchWithExtraCa(loadConfig());
  if (relaunched) { process.exitCode = await relaunched; return; }
  const store = new Store();
  if (command === 'init' || command === 'setup') return init(rest);
  if (command === 'uninstall') return uninstall(rest);
  if (command === 'import-config') {
    if (!arg) throw new Error('Usage: co-dev-review import-config <path-to-mcp.json>');
    console.log(`Imported keys only: ${importConfig(arg).join(', ') || 'none'}\nSaved to ${localDir}. No server commands or unrelated integrations were imported.`);
    return;
  }
  if (command === 'doctor') { if (!await doctor(loadConfig())) process.exitCode = 1; return; }
  if (command === 'link-skills') {
    const wanted = rest.filter(x => !x.startsWith('--'));
    const dirs = [...new Set(clients.filter(c => c.skills && (wanted.length ? wanted.includes(c.id) : c.detected())).map(c => c.skills))];
    if (!dirs.length) throw new Error('No assistant with a skills folder found. Name one: claude-code, codex, vscode, copilot-cli');
    for (const dir of dirs) {
      const report = linkSkills(dir, { dryRun: rest.includes('--dry-run'), force: rest.includes('--force') });
      console.log(`${dir}: ${report.linked.length} linked, ${report.unchanged.length} unchanged${report.conflicts.length ? `, left alone (not our link): ${report.conflicts.join(', ')}` : ''}${report.failed.length ? `, failed: ${report.failed.join('; ')}` : ''}`);
    }
    return;
  }
  if (command === 'pending') {
    const drafts = await store.list();
    if (!drafts.length) { console.log('No drafts.'); return; }
    drafts.forEach((draft, index) => console.log(renderDraftLine(draft, index + 1) + '\n'));
    console.log(style.dim('Approve one with: co-dev-review approve <first 8 characters>'));
    return;
  }
  if (command === 'approve') return approve(store, arg);
  if (command === 'trace') {
    const events = readTrace(arg ? Number(arg) : 60);
    if (!events.length) { console.log(`No trace yet. Run a review through the server first; every tool call is recorded in ${localDir}/trace.jsonl.`); return; }
    console.log(renderTrace(events));
    console.log(style.dim('\nSkills a client loads natively (Claude Code Skill tool, Codex skills) and files read with the host\'s own tools do not pass through this server. "offered" is what the server returned, "fetched via tool" is what came through step=rubric, "declared applied" is the assistant\'s own statement at prepare time.'));
    return;
  }
  if (command === 'reconcile') {
    if (!['posted', 'not-posted'].includes(resolution)) throw new Error('Usage: co-dev-review reconcile <draft-id> <item-id> posted <remote-id> | not-posted');
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
  throw new Error(`Unknown command "${command}".\n\n${HELP}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
