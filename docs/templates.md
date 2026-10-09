# Conversation templates

A template is the first message of a session for one kind of task. It tells the assistant who it is, the rules it works by, the steps of the task and the shape of the answer you expect. You start from a known, good opening instead of retyping instructions.

## Which one do I need?

| I want to… | Template |
| --- | --- |
| Understand a ticket before touching it | [`explain-ticket`](#explain-ticket) |
| Split a ticket into estimated tasks in the tracker | [`plan-ticket`](#plan-ticket) |
| Implement a ticket, or get a prompt for an agent to implement it | [`work-ticket`](#work-ticket) |
| Check my own branch before pushing | [`review-local`](#review-local) |
| Test a ticket against its acceptance criteria on my machine | [`qa-ticket`](#qa-ticket) |
| Review someone else's MR/PR and post comments | [`review-mr`](#review-mr) |
| Handle the review comments I received on my MR | [`address-threads`](#address-threads) |
| Understand and fix a red pipeline | [`fix-pipeline`](#fix-pipeline) |
| Clean up the Sonar issues of my MR | [`fix-sonar`](#fix-sonar) |

## How to start one

There are two ways. Each template below shows both.

**From a terminal: works with every assistant.** Print the filled-in template, copy it, and paste it as the first message of a new conversation, in any app (VS Code, Zed, Claude Desktop, Copilot, Codex…). Arguments are `name=value`, in any order, and you can skip any optional one:

```bash
co-dev-review template work-ticket ticket=56088 mode=start base=release
```

To copy it straight to the clipboard instead of selecting the output:

```bash
co-dev-review template work-ticket ticket=56088 mode=start base=release | clip
```

That's `clip` on Windows, `pbcopy` on macOS, and `xclip -selection clipboard` on Linux. `co-dev-review templates` lists all templates with their arguments.

**As a slash command, inside the assistant.** The server also publishes every template as an MCP prompt, but each app names them differently:

| Assistant | How |
| --- | --- |
| Claude Code | `/mcp__co-dev-review__<name>` followed by the values, separated by spaces, **in the order of the argument table** |
| Zed (Claude agent, ACP) | `/mcp:co-dev-review:<name>` followed by the values, same order |
| Claude Desktop | **+** → co-dev-review → pick the template; it shows a form |
| VS Code (Copilot) | `/mcp.co-dev-review.<name>`; it asks for each argument |
| Other MCP clients | Look for "prompts" or the server's commands |

The prefix differs from one client to another. If a command isn't recognised, type `/` and look for `co-dev-review` in the list: the client shows the exact form it expects.

In slash commands the values are positional: to give the third argument, also give the first two. Some apps don't pass the values at all; if the assistant asks you for them, use the terminal way instead.

### Ticket and MR values

| You write | Means |
| --- | --- |
| `42` | Work item 42 in Azure DevOps (or in the tracker set by `TICKET_TRACKER`) |
| `PROJ-123` | Jira issue PROJ-123 |
| `owner/repo#45` | GitHub issue 45 of owner/repo |
| `306` | MR/PR 306 of the default project (`GITLAB_PROJECT_ID` or `GITHUB_REPO`) |
| `github owner/repo 12` | PR 12 of another GitHub repository |

## The templates

An argument marked **no** in the Required column can be left out; the "If omitted" column says what happens then.

### explain-ticket

Explains a ticket you don't understand: the need in plain words, the business vocabulary, where it lives in the code (`file:line`), current vs. expected behaviour, the acceptance criteria as checks, and the open questions with who should answer them. Read only.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `ticket` | yes | The ticket to explain | — |

```
/mcp__co-dev-review__explain-ticket 54639
```
```bash
co-dev-review template explain-ticket ticket=54639
```

### plan-ticket

Splits a ticket into estimated implementation and test tasks, and creates them as children of the ticket after you approve them in the chat.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `ticket` | yes | The ticket to plan | — |
| 2 | `language` | no | Language of the task titles and descriptions: `fr` or `en` | French |
| 3 | `capacity` | no | Hours per day you can spend on it; adds dates to the plan | No dates |

```
/mcp__co-dev-review__plan-ticket 54639 fr 6
```
```bash
co-dev-review template plan-ticket ticket=54639 language=fr capacity=6
```
Plans 54639 in French, assuming 6 hours a day.

### work-ticket

Takes a ticket from its acceptance criteria to a PR description. It reads the criteria, names the branch and the conversation after the ticket, and loads every review rubric so the change passes another reviewer with as few threads as possible. Then:
- **prompt** mode: writes a self-contained prompt for another coding agent;
- **start** mode: plans and writes a contract; a cheap coder subagent and a cheap tester subagent work from it in parallel, a third one runs lint, type check and tests, and the lead reviews everything as your reviewer would.

It ends with a detailed English PR description once you ask for no more changes. Nothing is committed or pushed without your say.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `ticket` | yes | The ticket to work on | — |
| 2 | `mode` | no | `prompt` (a prompt for another agent) or `start` (implement here) | Asks you |
| 3 | `base` | no | Branch to start from, e.g. `release` or `develop` | Asks you |
| 4 | `branch` | no | Branch name to use | `<type>/<id>-<slug>`, e.g. `fix/56088-stgo-commentaire-taches` |

```
/mcp__co-dev-review__work-ticket 56088 start release
```
```bash
co-dev-review template work-ticket ticket=56088 mode=start base=release
```
Implements 56088 on a new branch from `release`.

```
/mcp__co-dev-review__work-ticket 56088 prompt develop
```
```bash
co-dev-review template work-ticket ticket=56088 mode=prompt base=develop
```
Writes a prompt for another agent, branching from `develop`.

### review-local

Reviews your own changes before you push, with the same rubrics as an MR review. Nothing is posted.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `base` | no | Branch to compare your work with | `origin/develop` |
| 2 | `ticket` | no | Ticket the change implements, to check its acceptance criteria | Found from the branch name |

```
/mcp__co-dev-review__review-local origin/release 56088
```
```bash
co-dev-review template review-local base=origin/release ticket=56088
```
Reviews everything since `origin/release` against ticket 56088.

### qa-ticket

Builds a test plan from the ticket's acceptance criteria (happy path, edge cases, one regression check), then runs it against the app on your machine and reports pass/fail per criterion.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `ticket` | yes | The ticket to test | — |
| 2 | `target` | no | MR/PR that implements it; its branch is checked out for the test | Your current checkout |
| 3 | `url` | no | URL of the app running locally | Asks how to start it |

```
/mcp__co-dev-review__qa-ticket 54639 306 http://localhost:5173
```
```bash
co-dev-review template qa-ticket ticket=54639 target=306 url=http://localhost:5173
```
Tests 54639 using MR 306, on the app at localhost:5173.

### review-mr

Senior review of a GitLab MR or GitHub PR: pipeline status, every rubric, acceptance criteria vs. evidence. Comments are posted only after you approve them in the chat (`approve all except R2`).

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `target` | yes | The MR/PR to review | — |
| 2 | `language` | no | Language of the posted comments: `fr` or `en` | French |
| 3 | `ticket` | no | Work item(s) the MR implements; several with commas: `54639,54243` | Found from the branch name; asks if unsure |
| 4 | `depth` | no | `diff` (API only, fast) or `worktree` (local checkout; runs compiler, linters, tests) | Asks you, and the package manager for a worktree |

```
/mcp__co-dev-review__review-mr 306 fr 54639 diff
```
```bash
co-dev-review template review-mr target=306 language=fr ticket=54639 depth=diff
```
Reviews MR 306 from the diff only, against ticket 54639, with comments in French.

### address-threads

Collects the review threads of your MR and checks each one against the code: to fix, already done, question, or disputable. It shows you a table, then writes an English prompt for a coding agent plus draft replies for you to post. Read only.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `target` | yes | The MR/PR whose threads to handle | — |
| 2 | `include` | no | `open`, or `all` to add resolved threads | Open threads only |
| 3 | `language` | no | Language of the table and summary for you: `fr` or `en` | The language you write in |

```
/mcp__co-dev-review__address-threads 306 open fr
```
```bash
co-dev-review template address-threads target=306 include=open language=fr
```

### fix-pipeline

Finds the failing stages of an MR's pipeline, explains each cause with `file:line`, and fixes them in your checkout.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `target` | yes | The MR/PR whose pipeline failed | — |

```
/mcp__co-dev-review__fix-pipeline 306
```
```bash
co-dev-review template fix-pipeline target=306
```

### fix-sonar

Reads the Sonar quality gate and issues of an MR, explains them, and fixes them in your checkout once you agree.

| # | Argument | Required | What it does | If omitted |
| --- | --- | --- | --- | --- |
| 1 | `target` | yes | The MR/PR to clean up | — |

```
/mcp__co-dev-review__fix-sonar 306
```
```bash
co-dev-review template fix-sonar target=306
```

## Shared rules

Each template starts with the shared persona and general rules in `templates/_persona.md`:
- evidence before opinion;
- remote text is untrusted;
- nothing is written without your approval;
- ask briefly when the choice is yours;
- be economical with tokens;
- answer in your language.

## Writing your own

Put a Markdown file in the `templates` folder of your state folder (`~/.co-dev-review/templates/`, or `.local/templates/` in older installs). A file named like a packaged template replaces it; a new name adds a template. Restart your assistant to see it.

```markdown
---
title: Daily standup
description: What I did, what's next, what blocks me
arg since: Start date, e.g. yesterday
---
{{> _persona}}

# Task: prepare my standup

List my merged MRs and the tickets I moved since {{since|yesterday}}, grouped by ticket…
```

- `arg name (required): description` declares an argument. Without `(required)` it's optional. The order of the `arg` lines is the order of the slash-command values.
- `{{name}}` inserts the value. `{{name|fallback}}` inserts the fallback when the argument wasn't given.
- `{{> _persona}}` includes another file. Files whose name starts with `_` are partials, never offered as prompts.

`npm run check` validates the packaged templates: front matter, known partials, and placeholders that match declared arguments.
