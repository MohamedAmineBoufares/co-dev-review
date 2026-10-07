# Approval and safety

co-dev-review reads freely, but writes only after you've approved exactly what will be written. It writes two kinds of thing: review comments on GitLab or GitHub, and tasks in Azure DevOps.

## Approving a draft

When the assistant calls `prepare_comments` (reviews) or `prepare` (tasks), the server saves the exact draft and asks you to approve it, in the first of these places your assistant supports:

| Where | When | What you do |
| --- | --- | --- |
| **A form in the assistant** | The client supports MCP elicitation (Claude Code 2.1.76+, Codex) | One checkbox per item, ticked by default, showing severity, confidence, location, text and the code it lands on. Untick what you don't want, choose "post now" or "approve only", and submit. |
| **A page in your browser** | No form support | The server opens a page on `127.0.0.1` showing every item with its diff context. Tick or untick items, **edit the text in place**, then post or approve. |
| **A terminal** | No browser either | `co-dev-review approve` shows each item with its context. `e 3` edits item 3 in `$EDITOR`. Typing `APPROVE` authorises what is on screen. |

With "post now", the selected items are published immediately and the assistant reports what was posted. With "approve only", ask the assistant to publish when you're ready.

The assistant can force a route with `approval: "in-chat" | "browser" | "terminal"`, or ask again later with step `request_approval`.

## What the model can and cannot do

- **No tool argument approves anything.** The model can only ask for approval.
- **The model never answers the form.** The form is answered by you, in the assistant's own interface. If you configure a Claude Code `Elicitation` hook, it can answer forms on your behalf, so don't add one that auto-accepts.
- **The model never sees the browser page's address.** It carries a random token that is never returned to the model. The page accepts requests only for `127.0.0.1:<port>`, which blocks DNS rebinding, can be used once, and expires after 30 minutes.
- **Approval is tied to exact content.** It is bound to the draft's content hash, the selected item ids and a 24-hour expiry, and records where it came from (`via`: in-chat, browser or terminal). Editing an item voids any earlier approval.
- **Publishing re-checks the target.** It checks the destination and the current PR head. A new commit on the MR, or a changed parent ticket, means a new draft.
- **Inline comments are anchored to the reviewed commit,** on validated added or deleted lines.

No merge, approval verdict, commit, push or Sonar status change is ever exposed. Comments are posted as individual discussions, not as a GitHub APPROVE/REQUEST_CHANGES review.

Reading is guarded too. Everything that comes from repositories, tickets and analyses is treated as untrusted data, never as instructions. Tokens are redacted from error messages, and the trace never records bodies, source text or tokens.

## The limits of this protection

These guarantees protect the MCP interface. A process with unrestricted shell access under your OS account, including an assistant you've allowed to run any command, could modify local files or call the providers directly. Use your assistant's tool permissions if you need isolation against that.

There's also an unavoidable gap between checking the remote head and posting, although inline comments carry the reviewed commit.

## Failure recovery

Each draft has a publication journal and an exclusive lock, and already-posted items are skipped on retry. If a write times out, or the process exits after sending it, the server can't know whether the provider accepted it. It then blocks automatic retries of that item, to avoid duplicate comments or tasks.

Check the provider, then reconcile:

```bash
co-dev-review reconcile <draft-id> R1 posted <remote-id>
# or, only after confirming nothing was created:
co-dev-review reconcile <draft-id> R1 not-posted
```

If a process crashed while holding `drafts/<id>.lock` in the state folder:

1. Stop that process.
2. Inspect its journal and the provider.
3. Remove only that lock file.

Never delete a journal to force a retry. Publication can be partial, because no provider offers a transaction spanning several comments or tasks.

## Limits worth knowing

- API responses and git diffs are capped at 12 MB, and anchor validation at 3,000 changed files.
- Untracked files are listed in local reviews, but `git diff` doesn't include their content.
- Sonar data depends on analysis availability, product version and token permissions. Missing coverage is unknown, not zero.
- Task estimates are written as Original Estimate and Remaining Work, which assumes the project's Task fields are in hours. Custom work item types or processes are not handled automatically.
