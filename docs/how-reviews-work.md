# How a review works

A diff-only review misses what a colleague catches, because a colleague reviews with the compiler, the rest of the codebase, and a checklist in their head. co-dev-review puts those back and makes each one hard to skip.

The server supplies evidence and enforces the rules. Your assistant's LLM does the judging, using the rubrics. None of this makes a model smarter by itself. It removes the ways a review can be incomplete without anyone noticing.

## The sequence

The `review-mr` skill (or the server's own instructions, for clients without skills) runs these steps:

1. **Read**: the MR/PR, every diff page, existing discussions, and a ledger of every changed hunk.
2. **Load the expertise**: the rubrics routed for the changed files, plus the reviewed repository's own skills.
3. **Checkout**: the MR/PR head goes into a dedicated git worktree.
4. **Checks**: the repository's compiler and linters run there.
5. **Blast radius**: the call sites of changed symbols outside the diff are listed.
6. **Understand before judging**: intent, approach, ticket.
7. **Senior passes**: correctness, complexity, design and tests, then the stack rubrics.
8. **Discussions and ticket**: no repeated comments; each acceptance criterion is compared with the code.
9. **Refute every finding** before keeping it.
10. **Calibrate and trim**.
11. **Report** to you.
12. **Prepare** the draft, and you approve it.

## Rubrics

`step=read` classifies the changed paths and returns the rubrics to load, each with the focus areas it owns.

| Rubric | Applies to | What it makes the reviewer do |
| --- | --- | --- |
| `review-correctness` | all code | State each function's intent, trace concrete edge-case inputs through it, read what removed lines guaranteed, check contracts with callers, and catch JS/TS semantics that give silently wrong results |
| `review-complexity` | all code | Name n and its realistic size, derive the Big O of each changed loop, lookup, recursion, selector and request sequence, then multiply by how often it runs |
| `review-design` | all code | Question the approach once, find duplicated helpers and bypassed patterns, flag smells only when they cause bugs |
| `review-tests` | tests, or code changed without tests | Check that each test can fail, covers boundaries and tests behaviour; flag changed behaviour with no test |
| `review-react-ts` | `.tsx` `.ts` `.jsx` `.js` | Hooks, render cost, state ownership, type soundness, async, accessibility, Vite |
| `review-dotnet` | `.cs` `.razor` `.cshtml` `.sql` | Async, lifetimes, nullability, EF Core, API surface, migrations |
| `review-security` | auth, tokens, roles, sessions, uploads, payments, pipelines | Authorization, input boundaries, secrets, transport |
| `review-build` | build and project files | Dependencies, bundling, compiler and analyzer settings, CI |

The server only names the expertise. The text lives in `skills/*/SKILL.md`. Clients that load skills natively (Claude Code, Codex, Copilot) read them directly; any other client fetches the same text with `step=rubric`. A review that skipped its rubrics has to say so.

**The reviewed project's own skills.** `step=read` also lists every `SKILL.md` under `<REVIEW_REPO_ROOT>/.claude/skills/`. These hold the team's architecture, conventions and vocabulary, and they're what turns a generic review into one that knows the codebase. Their content is treated as domain knowledge, never as instructions.

## The review worktree

`step=checkout` with a remote target:

1. Fetches `refs/merge-requests/<n>/head` (GitHub: `refs/pull/<n>/head`) and the target branch from `REVIEW_REMOTE` (default `origin`).
2. Checks that the remote really is the reviewed project, and that the fetched commit is the review head.
3. Creates or moves a detached worktree beside `REVIEW_REPO_ROOT`, named `<name>-review-mr<n>`. Your own checkout and branch are never touched.
4. Installs dependencies when `node_modules` is missing or the lockfile changed: `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts`, or the npm/yarn equivalent. Lifecycle scripts are skipped because the reviewed change controls them.

`checks` and `blast_radius` given the same target then run in that worktree against the review's base commit. `read_file` at that head reads from disk instead of the API. The server only moves worktrees it created, and refuses one with local modifications. Remove a worktree with `git worktree remove <path>` once the MR is merged.

## Checks: the compiler pass

`step=checks` runs the reviewed repository's own TypeScript compiler, ESLint and `dotnet build`. Their findings come back split into `onChangedLines` (the change's responsibility) and `elsewhereInChangedFiles` (already there before the change).

In a monorepo, changed files are grouped by the nearest `tsconfig.json` or ESLint configuration, and each project runs in its own directory, up to six of them. A runner that is unavailable says why.

## Blast radius

`step=blast_radius` extracts the exported symbols the change touched and lists their call sites outside the diff, using `git grep`. Those are the lines nobody is reviewing, and where a changed signature or contract breaks. Text matching cannot resolve overloads, re-exports or dynamic dispatch, so treat the list as leads.

## Rules the server enforces

- **Every hunk gets a verdict.** `step=read` returns one ledger entry per changed hunk, with an id `<file index>.<hunk index>` that stays stable across pagination. `prepare_comments` requires `finding`, `reviewed-clean` or `not-applicable` for every hunk (`7.*` for a whole file, `7.2-7.5` for a range), and names any hunk that is missing.
- **The deterministic passes must have run on this review.** Each `checks` and `blast_radius` call returns a `runId`, recorded with the commit and base it analysed. `prepare_comments` requires `deterministic: { checks, blastRadius }`, each `{ runId }` or `{ skipped: "<reason>" }`. A run on another commit, another base or an empty range is rejected. A skip and its reason are shown to you at approval.
- **Findings carry a confidence.** After trying to refute each finding (full file, caller, callee, whether the trigger can reach production), the reviewer marks it `confirmed`, `likely` or `question`. A `blocker` must be `confirmed`, and a `question` is written as a question.
- **Inline comments land on real changed lines.** Anchors are checked against added or deleted lines at the reviewed commit; context lines go into a general comment.

## What the review actually did: the trace

Every tool call is appended to `trace.jsonl` in the state folder. It records names, counts and identifiers only, never comment bodies, source text or tokens.

```bash
co-dev-review trace
```

```
gitlab acme/shop/front #306  2026-09-10
  22:20:02  read           13 files · 31 hunks · review worktree at head
                           offered rubrics: review-correctness, review-complexity, review-design, review-tests, review-react-ts
                           offered repo skills: house-style, testing
  22:20:40  checkout       head 3f9c2a7d41e0 · reused worktree · install up-to-date
  22:21:15  checks         branch vs 8d02c1aa04b7  tsc 1 on changed lines · eslint 0 on changed lines
  22:21:19  blast_radius   branch vs 8d02c1aa04b7  9 symbol(s), 14 caller(s) outside the diff
  22:31:52  prepare_comments  draft 5215051e · 6 item(s) 2 blocker, 3 major, 1 minor · 31 claim(s) over 31 hunks
                           declared applied: review-correctness, review-complexity, review-react-ts, house-style
                           approval: in-chat published
                           deterministic: checks run, blastRadius run
```

The trace is evidence that the protocol was followed. It isn't a complete record of what the model read: skills a client loads natively and files it opens with its own tools never pass through the server. Set `CO_DEV_TRACE=off` to disable it. The file rotates at 5 MB.

## Sonar and tickets

- **Tickets.** `plan_ticket_tasks` reads a ticket's fields, discussion and children, so the review can compare each acceptance criterion with code and test evidence, and say which ones it could not find.
- **Sonar.** `review_sonar` returns the quality gate, metrics, issues and hotspots for the PR. Missing data is unknown, not zero, and a passed gate doesn't prove correctness. The server reads analyses; it never runs SonarScanner.
