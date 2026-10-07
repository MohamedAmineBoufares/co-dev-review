import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { digest } from './store.js';

// The human approves in the assistant's own UI (MCP elicitation) or in a local browser page.
// Either way the answer comes from the person, not the model: elicitation responses are produced
// by the client's form, and the page's address carries a token the model never sees.

const PAGE_TTL_MS = 30 * 60 * 1000;
const FORM_TIMEOUT_MS = 15 * 60 * 1000;
const DESCRIPTION_LIMIT = 1800;
const stripHtml = html => String(html ?? '').replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export function itemTitle(item) {
  if (!item.severity) return `${item.id} · ${item.title} · ${item.estimatedHours} h`;
  const where = item.path ? `${item.path}:${item.line}` : 'general comment';
  return `${item.id} · ${item.severity.toUpperCase()}${item.confidence ? ` (${item.confidence})` : ''} · ${where}`;
}
export function itemText(item) {
  const body = item.body ?? stripHtml(item.description);
  const code = item.context?.snippet ? `\n\n${item.context.snippet.split('\n').slice(Math.max(0, item.context.markerIndex - 2), item.context.markerIndex + 3).join('\n')}` : '';
  return clip(body + code, DESCRIPTION_LIMIT);
}
const heading = draft => draft.kind === 'review'
  ? `${draft.snapshot?.title ?? 'Review'} · ${draft.target.provider} ${draft.target.project ?? ''} #${draft.target.number} · head ${String(draft.snapshot?.head).slice(0, 8)}`
  : `Tasks under work item ${draft.parent?.id}: ${draft.parent?.fields?.['System.Title'] ?? ''}`;

export const supportsForm = capabilities => Boolean(capabilities?.elicitation && (capabilities.elicitation.form || !capabilities.elicitation.url));
export const supportsUrl = capabilities => Boolean(capabilities?.elicitation?.url);

async function decide(service, draft, selectedIds, then, via) {
  if (!selectedIds.length) return { via, status: 'nothing-selected', note: 'The user selected no item. Nothing was approved or posted.' };
  await service.store.approve(draft.id, selectedIds, digest(draft), { via });
  if (then !== 'publish') return { via, status: 'approved', selectedIds, note: 'Approved for 24 hours. Publish when the user asks.' };
  try {
    const { journal } = await service.publish(draft.id);
    return { via, status: 'published', selectedIds, journal };
  } catch (error) {
    return { via, status: 'approved', selectedIds, publishError: error.message, note: 'Approved, but publication failed. Report the error; do not retry blindly.' };
  }
}

// One checkbox per item, in the assistant's own UI.
export async function approveInChat(mcp, service, draft) {
  const properties = {};
  for (const item of draft.items) properties[item.id] = { type: 'boolean', title: clip(itemTitle(item), 200), description: itemText(item), default: true };
  properties.then = {
    type: 'string', title: 'Then', enum: ['publish', 'approve'], default: 'publish',
    enumNames: [draft.kind === 'review' ? 'Post the ticked comments now' : 'Create the ticked tasks now', 'Approve only, publish later'],
  };
  const result = await mcp.server.elicitInput({
    mode: 'form',
    message: `${heading(draft)}\n${draft.destination}\nTicked items are ${draft.kind === 'review' ? 'posted' : 'created'} exactly as written; unticked ones are dropped. To reword one, cancel and ask the assistant.`,
    requestedSchema: { type: 'object', properties },
  }, { timeout: FORM_TIMEOUT_MS }); // the SDK's 60 s default is shorter than reading a dozen comments
  if (result.action !== 'accept') return { via: 'in-chat', status: result.action === 'decline' ? 'declined' : 'cancelled', note: 'The user did not approve. The draft is kept; nothing was posted.' };
  // The draft may not change between showing the form and approving it: approve() checks the hash.
  const current = await service.store.read(draft.id);
  if (digest(current) !== digest(draft)) throw new Error('Draft changed while the approval form was open. Ask for approval again.');
  return decide(service, draft, draft.items.filter(item => result.content?.[item.id] === true).map(item => item.id), result.content?.then, 'in-chat');
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderPage(draft, journal) {
  const items = draft.items.map(item => {
    const posted = journal[item.id]?.state === 'posted';
    const field = item.body !== undefined ? 'body' : 'description';
    const text = item.body ?? item.description;
    const code = item.context?.snippet ? `<pre class="code">${item.context.snippet.split('\n').map((line, i) => `<span class="${i === item.context.markerIndex ? 'mark ' : ''}${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}">${escapeHtml(line) || ' '}</span>`).join('\n')}</pre>` : '';
    return `<article class="item ${escapeHtml(item.severity ?? 'task')}">
      <label class="head"><input type="checkbox" name="pick" value="${escapeHtml(item.id)}" ${posted ? 'disabled' : 'checked'}>
        <span class="badge">${escapeHtml(item.severity ?? `${item.estimatedHours} h`)}</span>${item.confidence ? `<span class="conf">${escapeHtml(item.confidence)}</span>` : ''}
        <span class="where">${escapeHtml(item.id)} · ${escapeHtml(item.path ? `${item.path}:${item.line}` : item.title ?? 'general comment')}</span>${posted ? '<span class="done">already posted</span>' : ''}</label>
      ${code}
      <textarea data-id="${escapeHtml(item.id)}" data-field="${field}" rows="${Math.min(14, String(text).split('\n').length + 2)}" ${posted ? 'disabled' : ''}>${escapeHtml(text)}</textarea>
    </article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve ${draft.kind === 'review' ? 'review comments' : 'tasks'}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--card:#fff;--add:#e8f5ec;--del:#fbecec;--accent:#2457c5;--blocker:#b42318;--major:#b54708;--minor:#2457c5;--suggestion:#6b6b66}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#33322f;--card:#1f1f1d;--add:#16301f;--del:#3a1c1c;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 120px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px;word-break:break-all}
.item{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--suggestion);border-radius:8px;padding:12px 14px;margin:0 0 14px}
.item.blocker{border-left-color:var(--blocker)}.item.major{border-left-color:var(--major)}.item.minor{border-left-color:var(--minor)}
.head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;cursor:pointer}.head input{width:18px;height:18px}
.badge{font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:.04em}.conf,.done{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:0 8px}
.where{font-family:ui-monospace,monospace;font-size:13px;color:var(--muted);word-break:break-all}
.code{margin:10px 0;padding:8px;border-radius:6px;background:var(--bg);border:1px solid var(--line);overflow:auto;font:12.5px/1.45 ui-monospace,monospace}
.code span{display:block;white-space:pre}.code .add{background:var(--add)}.code .del{background:var(--del)}.code .mark{outline:1px solid var(--accent)}
textarea{width:100%;margin-top:8px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;resize:vertical}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
#result{max-width:980px;margin:0 auto 12px;padding:0 16px;font-weight:600}
</style></head><body><main>
<h1>${escapeHtml(draft.kind === 'review' ? 'Approve review comments' : 'Approve tasks')}</h1>
<p class="sub">${escapeHtml(heading(draft))}<br>${escapeHtml(draft.destination)}</p>
${items}
</main><div id="result"></div><div class="bar">
<button class="primary" data-then="publish">${draft.kind === 'review' ? 'Post selected' : 'Create selected'}</button>
<button data-then="approve">Approve only</button><button data-then="cancel">Cancel</button></div>
<script>
const bar=document.querySelector('.bar'),out=document.getElementById('result');
bar.addEventListener('click',async e=>{const then=e.target.dataset.then;if(!then)return;
 const selected=[...document.querySelectorAll('input[name=pick]:checked')].map(x=>x.value);
 const edits={};document.querySelectorAll('textarea:not([disabled])').forEach(t=>{if(t.value!==t.defaultValue)edits[t.dataset.id]={field:t.dataset.field,text:t.value}});
 bar.querySelectorAll('button').forEach(b=>b.disabled=true);out.textContent='Working…';
 const r=await fetch(location.pathname+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({then,selected,edits})});
 const data=await r.json();out.textContent=data.message;});
</script></body></html>`;
}

// A one-shot page on 127.0.0.1 for clients without elicitation. Returns as soon as the page is open;
// the decision is applied by this process when the user clicks, and the assistant reads it with view_draft.
export async function approveInBrowser(service, draft, { open = openBrowser } = {}) {
  const token = randomBytes(24).toString('hex');
  let decided = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-frame-options': 'DENY' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    // Only this exact page, from this machine: the token defeats other local pages, the Host check defeats DNS rebinding.
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return reply(403, { message: 'Forbidden' });
    if (req.method === 'GET' && req.url === `/${token}`) {
      const current = await service.store.read(draft.id);
      return reply(200, renderPage(current, await service.store.journal(draft.id)), 'text/html');
    }
    if (req.method !== 'POST' || req.url !== `/${token}/decision` || decided) return reply(404, { message: decided ? 'This approval page has already been used.' : 'Not found' });
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return reply(403, { message: 'Forbidden' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) return reply(413, { message: 'Too large' }); }
    try {
      const { then, selected = [], edits = {} } = JSON.parse(raw);
      decided = true;
      if (then === 'cancel') { setImmediate(() => server.close()); return reply(200, { message: 'Cancelled. Nothing was approved or posted. You can close this tab.' }); }
      for (const [id, edit] of Object.entries(edits)) if (['body', 'description'].includes(edit.field)) await service.store.updateItem(draft.id, id, { [edit.field]: String(edit.text) });
      const current = await service.store.read(draft.id);
      const ids = current.items.map(item => item.id);
      const outcome = await decide(service, current, selected.filter(id => ids.includes(id)), then, 'browser');
      setImmediate(() => server.close());
      const posted = Object.values(outcome.journal ?? {}).filter(x => x.state === 'posted').length;
      return reply(200, { message: outcome.status === 'published' ? `Done: ${posted} posted. You can close this tab and tell the assistant.`
        : outcome.publishError ? `Approved, but publishing failed: ${outcome.publishError}` : outcome.status === 'approved' ? 'Approved. Ask the assistant to publish when ready.' : outcome.note });
    } catch (error) { decided = false; return reply(400, { message: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => server.close(), PAGE_TTL_MS);
  server.on('close', () => clearTimeout(timer));
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/${token}`;
  return { url, opened: await open(url), close: () => server.close() };
}
