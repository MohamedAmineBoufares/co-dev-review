# co-dev-review

**A senior code reviewer for your AI assistant.** co-dev-review is an MCP server that lets Claude Code, Codex, GitHub Copilot, Cursor, Antigravity or any other MCP client review merge requests the way an experienced colleague would. It runs your compiler and linters, checks the callers outside the diff, traces edge cases and algorithmic cost, and posts only the comments you approve.

It also turns Azure DevOps, Jira or GitHub tickets into estimated tasks and helps triage SonarQube results.

```
You:        Review MR 306 against ticket 54639, comments in French.
Assistant:  checks out MR 306 in a separate worktree · runs tsc + eslint · lists 14 callers outside the diff
            · reviews 31 hunks with the correctness, complexity, design, test and React rubrics
            → 2 blockers (confirmed), 3 majors, 1 question
            [approval form: tick what to post] → 5 comments posted on GitLab
```

## Why it is different

- **It checks the evidence, not only the diff.** Each MR/PR is checked out in its own git worktree, without touching your branch. The repository's own TypeScript compiler, ESLint and `dotnet build` run there, the unit tests related to the change run too, and every call site of a changed symbol outside the diff is listed.
- **It's light on context.** Responses are compact and shaped for review, without the providers' raw payloads. Mechanical steps can run on a cheaper subagent, so the reviewer's context is kept for the code.
- **It reviews like a senior.** Rubrics for correctness (edge cases traced through each function, guarantees lost in removed lines), complexity (realistic n, derived Big O), design (duplicated helpers, smells that cause bugs) and tests are applied to every change. React/TypeScript, .NET, security and build rubrics add the specifics.
- **It can't skip work silently.** Every changed hunk needs a verdict. The compiler and call-site passes must have run on the exact commit under review, or the draft must say why they were skipped. A blocker must be `confirmed`.
- **Nothing is posted without you.** You approve each draft in the chat (`approve all except R2`), or, if you prefer, in a form, a local browser page or the terminal. Your words are recorded with the approval.
- **It works with any LLM.** The server has no model dependency, and every MCP client works.

## Quick start

Requirements: Node.js 20.20.2 or later, and git.

```bash
git clone https://github.com/MohamedAmineBoufares/co-dev-review.git
cd co-dev-review
npm ci
npm run setup
```

`npm run setup` asks for your tokens, checks them, registers the server in every assistant it finds on your machine, and links the review skills. Restart your assistant, then ask:

> List the tools from co-dev-review.

You should see `review_work`, `plan_ticket_tasks` and `review_sonar`. Details: [Configuration](docs/configuration.md).

### What you need to configure

Fill in only what you use:

| To… | Configure |
| --- | --- |
| Review GitLab merge requests | `GITLAB_TOKEN` (api scope), `GITLAB_PROJECT_ID` |
| Review GitHub pull requests | `GITHUB_TOKEN` |
| Run the compiler, linters and call-site search | `REVIEW_REPO_ROOT`: a local clone of the reviewed repository |
| Read tickets and create tasks in Azure DevOps | `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_TOKEN` |
| … in Jira | `JIRA_URL`, `JIRA_TOKEN` (+ `JIRA_EMAIL` on Jira Cloud) |
| … in GitHub Issues | `GITHUB_TOKEN`, `GITHUB_REPO` |
| Read Sonar results | `SONAR_TOKEN`, `SONAR_PROJECT_KEY` |

## Use it

Talk to your assistant normally:

> Review MR 123 against ticket 456. Comments in French; let me skip non-blockers.

> Review my local branch against origin/develop before I push. Don't post anything.

> Split ticket 456 into implementation and test tasks with hour estimates.

> List my open Azure tickets in the current iteration.

> Check Sonar for MR 123 and fix the issues in my checkout.

In assistants that load skills (Claude Code, Codex, Copilot), the `review-mr` skill runs the complete sequence: just ask for a review, or invoke it directly (`/review-mr 123 fr`; `/co-dev-review:review-mr 123 fr` when loaded as a Claude Code plugin).

### Starting a session from a template

Each task has a ready-made opening message: who the assistant is, its rules, the steps and the expected answer. Use them as slash commands (`/mcp__co-dev-review__review-mr 306 fr` in Claude Code), or print one to paste anywhere:

```bash
co-dev-review template explain-ticket ticket=PROJ-123
```

The templates: `review-mr`, `address-threads`, `review-local`, `plan-ticket`, `explain-ticket`, `qa-ticket`, `fix-sonar` and `fix-pipeline`. You can override them or add your own: see [Templates](docs/templates.md).

### Approving what gets posted

When the comments or tasks are ready, the assistant shows them right in the chat. Each one shows its severity, `file:line`, the code it lands on and the text. You reply:

> approve all except R2

Only what you named is posted. You can also say `approve R1 R3`, add `later` to approve without posting, or ask to reword an item first. If you'd rather approve outside the chat (a form, a local browser page or the terminal), set `REVIEW_APPROVAL`. See [Approval and safety](docs/approval-and-safety.md).

Before a review, the assistant also asks how deep to go: **diff only** (fast, cheap) or a **local worktree** with the compiler, linters and tests. For a worktree, it asks which package manager to use; when the MR doesn't touch dependencies, your own `node_modules` are linked in seconds.

## Supported assistants

`npm run setup` registers the server automatically in:

| Assistant | Skills linked |
| --- | --- |
| Claude Code (CLI and IDE extensions) | yes |
| Claude Desktop | no (rubrics are served over MCP) |
| Codex (CLI, app, IDE extension) | yes |
| VS Code with GitHub Copilot | yes |
| GitHub Copilot CLI | yes |
| Cursor | no (rubrics are served over MCP) |
| Windsurf | no (rubrics are served over MCP) |
| Google Antigravity | no (rubrics are served over MCP) |
| Gemini CLI | no (rubrics are served over MCP) |

Any other MCP client works with a manual entry from [`examples/`](examples/).

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` / `co-dev-review init` | Configure, check, register in assistants, link skills |
| `co-dev-review doctor` | Check credentials and connectivity (read-only) |
| `co-dev-review approve [draft]` | Approve a draft in the terminal |
| `co-dev-review pending` | List drafts and their state |
| `co-dev-review worktrees [remove <n>]` | List or safely remove review worktrees |
| `co-dev-review template <name> k=v…` | Print a conversation template, filled in |
| `co-dev-review trace` | Show what the last reviews actually did |
| `co-dev-review uninstall` | Remove the registrations and skill links |
| `co-dev-review help` | All commands and options |

`co-dev-review` becomes available in any terminal once installed globally; `setup` offers to do it. In this folder, `npm run doctor` and `npm run approve` work too.

## Documentation

- [How a review works](docs/how-reviews-work.md): rubrics, worktree, compiler pass, blast radius, coverage ledger, evidence rules, trace
- [Configuration](docs/configuration.md): every setting, where state lives, assistant registration, corporate proxies
- [Approval and safety](docs/approval-and-safety.md): approval modes, what the model can and cannot do, failure recovery
- [Templates](docs/templates.md): conversation starters per task, and how to write your own
- [Tool reference](docs/tools.md): the MCP tools and their steps, for client implementers

## Project layout

```
src/          MCP server, CLI and providers (GitLab, GitHub, Azure DevOps, Sonar)
skills/       review rubrics as SKILL.md files (review-mr is the entry point)
templates/    conversation starters per task, served as MCP prompts
docs/         documentation
examples/     manual MCP client configuration
test/         node:test suite; never calls real services
```

## Development

```bash
npm run verify    # static checks, then the test suite
npm run tools     # start a temporary server and list its tools and steps
npm run schema    # also report the JSON Schema constructs each tool uses
```

Tests cover MCP stdio discovery and validation, provider request contracts against mock HTTP, approval selection, expiry and tampering, the in-chat and browser approval paths, stale heads, uncertain writes, locks, diff anchors, the hunk ledger, coverage gaps, deterministic evidence and rubric routing.

## License

[MIT](LICENSE)
