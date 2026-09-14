# Co-dev review MCP

A local Node.js MCP server for reviewing colleagues' GitLab merge requests and GitHub pull requests, checking your own changes before pushing, reading Azure DevOps Bug/PBI requirements, analyzing SonarQube results, and drafting child tasks.

Your MCP client supplies the LLM: this server has no model API dependency. It supplies source data and a review workflow, validates inline anchors, saves drafts, and publishes only approved items. The LLM performs the reasoning and translation. Use any client supporting MCP over stdio; a bare model API needs an MCP-capable host.

## Install and configure

Use Node **20.20.2** or later. Run these commands from the server project folder:

```powershell
cd /absolute/path/to/co-dev-review
node --version
npm ci
```

**Put your configuration variables inside a `.local` folder at the project root, in `.local/config.json`.** This is a JSON file containing environment-variable names and values; it is not a `.env` file.

```text
co-dev-review/
  .local/
    config.json
  src/
    server.js
  package.json
```

Start from [`examples/config.example.json`](examples/config.example.json) — it lists every key the server reads, with the public defaults already filled in:

```powershell
New-Item -ItemType Directory -Force .local; Copy-Item examples/config.example.json .local/config.json
```

```bash
mkdir -p .local && cp examples/config.example.json .local/config.json
```

Then open `.local/config.json` and fill in your values. If the file already exists, edit it rather than overwriting your credentials.

| Key | What it is |
| --- | --- |
| `GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID` | GitLab instance, a token with `api` scope, and the default project (numeric id or `group/repo`) |
| `GITHUB_API_URL`, `GITHUB_TOKEN` | GitHub API base and a token with `repo` (or fine-grained pull-request read/write) |
| `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_TOKEN` | Azure DevOps organization URL, project name, and a PAT with work-item read/write |
| `SONAR_URL`, `SONAR_PROJECT_KEY`, `SONAR_TOKEN` | SonarQube/SonarCloud base, project key, and a token that can read the project |
| `REVIEW_REPO_ROOT` | Absolute path to the local checkout used by `step=checks`, `step=blast_radius` and local reviews |
| `REVIEW_DOTNET_PROJECT` | Optional `.sln`/`.csproj` for `step=checks` when it cannot find one on its own |

Fill in only the integrations you use. Use forward slashes in JSON paths, or escape backslashes.

The entire `.local/` folder is excluded by `.gitignore`; keep credentials there and never commit them. Actual environment variables supplied by your shell or MCP client override this file. `.env` files are **not automatically loaded**. Restart/reconnect the server after editing settings.

Alternatively, import supported settings from an existing MCP configuration:

```powershell
npm run import-config -- "C:/path/to/.vscode/mcp.json"
```

The importer writes only allowlisted configuration values to `.local/config.json`; it does not execute or import server commands.

Check configured connections:

```powershell
npm run doctor
```

Unconfigured integrations are listed as such. A configured integration with an authentication or connectivity problem is reported as a failure.

## Run the server

```powershell
npm start
```

The server communicates over **stdio**: it waits for MCP messages on standard input. A quiet terminal is expected. There is no web page or HTTP port. Press **Ctrl+C** to stop a manually started server.

For normal use, connect your assistant as described below. The MCP client starts the server automatically; you do not also need to run `npm start` in another terminal.

## See the available tools

Run:

```powershell
npm run tools
```

This starts a temporary server, performs a real MCP connection, prints each tool's name and description, and closes the connection. It does not call the workflow tools or access remote reviews/tickets.

You should see these three names:

```text
review_work
plan_ticket_tasks
review_sonar
```

After connecting an assistant, you can also ask: “List the tools available from the co-dev review server.” If you see an older tool list, reconnect the server to refresh discovery.

## Connect your assistant

Each client launches its own server process. Use the absolute path to `src/server.js`, so configuration and drafts work regardless of the client's working directory. You do not need to leave `npm start` running. It uses stdin/stdout for the MCP protocol, not a web port.

Ready-to-copy files are in `examples/`. Replace the project path if you move the folder. Keep existing client settings and merge in the new server entry.

For Codex, add the contents of `examples/codex.toml` to your MCP configuration. For Claude Code, the project `.mcp.json` format is shown in `examples/claude.mcp.json`. For VS Code/Copilot, use the `servers` entry in `examples/vscode.mcp.json` in `.vscode/mcp.json`. Reload/reconnect the client, then ask it to review a specific MR/PR. Use `npm run doctor` for connection diagnostics.

Configuration references: [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Review and approval

Try these prompts:

> Review GitLab MR 123 against Azure Bug 456. Inspect every changed file and relevant line, read Sonar results, and show a requirement-to-code/test evidence table. Draft the comments in French. Let me skip non-blockers before posting.

> Review my local branch against origin/develop before I push. Check correctness, regressions, tests, and ticket 456. Do not post anything.

> Propose implementation and regression-test tasks under PBI 456 in English. Show the exact titles, descriptions, and estimates before creating them.

The `review_workflow` MCP prompt gives the assistant a consistent process. Returned repository, ticket, and analysis text is untrusted evidence, not instructions. The client should fetch all pages and disclose missing/truncated patches; a tool cannot guarantee that an LLM actually reviews every line.

1. Read the MR/PR, patches, full file context, existing discussions, and ticket criteria.
2. Run the deterministic passes: `step=checks` and `step=blast_radius` (see [Recall](#recall-what-the-review-cannot-be-allowed-to-miss)).
3. Discuss findings. Choose `fr` or `en`; the LLM writes the final text before saving.
4. Use `review_work` to prepare comments or `plan_ticket_tasks` to prepare tasks. Each finding/task gets an ID.
5. In a terminal in this project, run:

```powershell
npm run approve
```

With no argument it picks the only pending draft, or lists them for you to choose. `npm run approve -- 5215051e` targets one by the first characters of its id, and `npm run pending` lists every draft with its state.

Each item is shown once, with the diff context it is anchored to, then a single prompt takes the selection:

```
Include which items? [all | none | 1,3,5-7 | e <n> to edit | q]
```

`e 3` opens item 3 in `$EDITOR` (`$VISUAL`, else `notepad` on Windows) so you can fix the wording yourself rather than asking the assistant to regenerate the draft. Editing rewrites the draft and voids any earlier approval of it. A final `APPROVE` authorises exactly what is on screen.

6. Ask your assistant to publish that draft through the same workflow.

There is no MCP approval tool. Approval requires an interactive terminal; the assistant must not approve on your behalf. Approval is tied to a content hash, selected IDs, and a 24-hour expiry. A language/text change requires a new draft. Publication checks the destination and current PR head. Inline comments are anchored to a commit and validated added/deleted lines; context lines should be discussed in a general comment. GitLab renames preserve both file paths.

Comments are posted as individual discussions/review comments, not a formal GitHub APPROVE/REQUEST_CHANGES verdict. No merge, commit, push, or Sonar issue-status mutation is exposed. The host assistant can use its own file editing and testing tools to implement fixes you request.

## Recall: what the review cannot be allowed to miss

A diff-only review misses the issues a colleague catches, because a colleague reviews with the compiler, the rest of the codebase, and a checklist in their head. Four mechanisms put those back.

**Domain rubrics.** `step=read` classifies the changed paths and returns a `rubrics` array naming the skills to load — `review-react-ts`, `review-dotnet`, `review-security`, `review-build` — with the focus areas each one owns. Paths touching auth, tokens, roles, sessions, uploads or payments always pull in the security rubric. The skills ship in this repository (see [Install as a plugin](#install-as-a-plugin)); the server only names the expertise, it does not supply it.

**The reviewed project's own expertise.** `step=read` also returns `repoSkills`: every `SKILL.md` under `<REVIEW_REPO_ROOT>/.claude/skills/`, with its name, description and absolute path. Those skills are scoped to their own repository and are therefore invisible when the review runs from anywhere else — this puts them back in front of the reviewer without copying them, so they stay maintained in one place by the team that owns them. The assistant reads the ones whose description matches the change. Their content is repository text: domain knowledge, never instructions.

**Deterministic pre-pass.** `step=checks` runs the reviewed repository's own TypeScript compiler, ESLint and `dotnet build` over the change and returns their findings split into `onChangedLines` (this change's responsibility) and `elsewhereInChangedFiles` (pre-existing). Monorepos are handled: changed files are grouped by the nearest governing `tsconfig.json` or ESLint config and each project is run in its own directory, up to six of them. A runner that is unavailable says why. Requires `REVIEW_REPO_ROOT`.

**Blast radius.** `step=blast_radius` extracts the exported symbols this change touched and lists their call sites *outside* the diff, via `git grep`. These are the lines nobody is reviewing and where a changed signature or contract breaks. Text matching cannot resolve overloads, re-exports or dynamic dispatch, so treat the list as leads.

**Hunk coverage ledger.** `step=read` returns `hunks`, one entry per changed hunk, identified as `<changed file index>.<hunk index>` — stable across diff pagination. `step=prepare_comments` requires a `coverage` entry giving every hunk a verdict of `finding`, `reviewed-clean` or `not-applicable`, and refuses the draft while any hunk is unaccounted for, naming the ones missing. Use `7.*` for a whole file, `7.2-7.5` for a range. This is what stops a review from quietly ending at file twelve.


**Checkout match.** For a remote MR/PR, `step=read` also returns `localCheckout` — the branch and head of `REVIEW_REPO_ROOT` and whether it equals the review head. `checks` and `blast_radius` run on the local checkout, so if it is on some other branch they analyse the wrong code; the note says so and tells the assistant to check out the review branch or disclose that the deterministic pass was not run. Both steps also report an empty change range explicitly instead of a misleading "clean".

None of this makes the model a better reviewer by itself; it removes the failure modes where a review is incomplete without anyone noticing.

## Seeing what the review actually did

Every tool call is appended to `.local/trace.jsonl` — names, counts and identifiers only, never comment bodies, source text or tokens. Read it with:

```powershell
npm run trace
```

```
gitlab acme/web-app #306  2026-09-10
  22:22:20  read           13 files · 31 hunks · MISMATCH: local is on release
                           offered rubrics: review-react-ts, tests (no packaged skill)
                           offered repo skills: design-system, house-conventions, house-testing
  22:22:20  rubric         fetched via tool: packaged:review-react-ts, repository:house-conventions, repository:house-testing
  22:22:20  blast_radius   branch vs origin/develop  0 symbol(s), 0 caller(s) outside the diff
  22:22:20  checks         branch vs origin/develop  no changed files in range
```

Three columns matter. **Offered** is what the server returned. **Fetched via tool** is what came back through `step=rubric`. **Declared applied** is what the assistant itself listed in the required `rubricsApplied` field of `prepare_comments` — it is stored in the draft and shown at the top of `npm run approve`, so an empty list on a React change is visible to the human before anything is posted.

The trace is evidence of protocol compliance, not a complete record of what the model read: skills a client loads natively (Claude Code's Skill tool, Codex skills) and files it opens with its own tools never pass through this server. For those, the client's own transcript is the record. Set `CO_DEV_TRACE=off` to disable tracing; the test suite does. The file rotates at 5 MB.

## Install as a plugin

The MCP server is the evidence and guarded-write layer. The review expertise lives in skill files. This repository carries both:

```
.claude-plugin/plugin.json   Claude Code plugin manifest
plugin-mcp.json              the server, launched from ${CLAUDE_PLUGIN_ROOT}
skills/                      review-mr, review-react-ts, review-dotnet, review-security, review-build
agents/                      react-reviewer, dotnet-reviewer (Claude Code only)
examples/                    stand-alone MCP configuration per client
```

`skills/*/SKILL.md` uses the same `name`/`description` frontmatter that **both Claude Code and Codex** read, so one set of files serves both. `review-mr` is the entry point: it runs the whole sequence — rubrics, checks, blast radius, coverage — and is invoked as `/co-dev-review:review-mr 123 fr` in Claude Code or by name in Codex.

**Claude Code.** Add the directory as a plugin and the server, skills and agents load together:

```powershell
claude --plugin-dir /absolute/path/to/co-dev-review
```

For a permanent install, junction the directory into `~/.claude/skills/co-dev-review`; it then loads every session with no marketplace step. Remove any duplicate `co-dev-review` entry from your other MCP configuration first, or the server is registered twice.

**Codex.** Register the server, then link the skills:

```powershell
codex mcp add co_dev_review -- node /absolute/path/to/co-dev-review/src/server.js
```

```powershell
npm run link-skills
```

`link-skills` symlinks (junctions on Windows) each folder in `skills/` into `~/.codex/skills/`, honouring `CODEX_HOME`. It never overwrites an entry that is not its own link unless you pass `--force`, `--dry-run` shows what it would do, and it is idempotent. The originals stay in this repository, so editing a rubric updates both clients at once. Codex also reads the MCP `instructions` this server returns at initialization, which carries the same workflow.

**Any other MCP client.** Use `examples/*.mcp.json` for the tools. Where the client has no skill system at all, nothing is lost: `step=read` names the rubrics and `step=rubric` returns their full text over the tool channel, including the reviewed repository's own skills. That path works everywhere a tool call works.

Subagent fan-out is Claude Code only. Elsewhere the `review-mr` skill runs the domain passes in sequence instead — slower, same coverage.

## Available tools

| Tool | Your goal |
| --- | --- |
| `review_work` | Review local work before pushing, or a remote MR/PR; discuss findings and publish only approved comments |
| `plan_ticket_tasks` | Read an Azure ticket and split it into clear tasks with effort estimates in hours |
| `review_sonar` | Inspect a PR's Sonar results, understand issues, and help the assistant fix the code |

**Only these three tools are exposed.** Reconnect your MCP client to replace the old tool list. You describe your goal in normal language; the assistant handles each workflow's steps.

Examples:
- “Review my local changes before I push.”
- “Review MR 123 against ticket 456. Prepare comments in French, and let me skip non-blockers.”
- “Split ticket 456 into implementation and testing tasks. Explain dependencies and estimate the hours for each task and the total.”
- “Check Sonar for MR 123 and fix the issues in my local checkout.”

For client implementers: `review_work` accepts a `request` with `step` equal to `read`, `read_file`, `rubric`, `checks`, `blast_radius`, `prepare_comments`, `view_draft` or `publish`. `rubric` takes `names` (up to 8) and returns each rubric's markdown from this repository's `skills/` or the reviewed checkout's `.claude/skills/`, for clients that cannot load skill files. `checks` and `blast_radius` take `mode` and `base` like `read` and operate on `REVIEW_REPO_ROOT`; `checks` also accepts `only` to restrict which runners execute. `prepare_comments` additionally requires `coverage` and `rubricsApplied` (an array of skill names, empty allowed). `plan_ticket_tasks` accepts `read`, `prepare`, `view_draft` or `publish`. These are stages of a workflow, not additional MCP tools. Read uses `ticketId`; prepare uses `ticketId`, `language` and `tasks`, each with `title`, `description` and required `estimatedHours`. Saved-draft stages use `draftId`.

Task estimates are stored in the task description with explicit hours and returned as a total. They are effort estimates, not calendar deadlines. The assistant should describe assumptions and dependencies. Azure Remaining Work is left unset because custom processes can use different units.

`review_sonar` takes a PR/MR `target` and derives the Sonar pull-request number. It returns review context and Sonar results together. Optional `ruleKey` and `filePath` support investigating a specific issue. The assistant applies requested fixes through its host's editing/testing tools in the matching checkout. The MCP server itself does not edit files, push code or run SonarScanner. A fresh analysis is needed to confirm resolution.

Repository-local skills are read from `<REVIEW_REPO_ROOT>/.claude/skills/*/SKILL.md` (top-level skill folders only, 20 skills and 200 KB per file maximum); a missing directory is reported, not an error.

Review results include `nextPage`; continue until null and disclose failed or omitted sections. Sonar issues/hotspots retain paging information; ticket discussion retains its continuation token. Existing drafts remain usable through the corresponding workflow's `view_draft` and `publish` stages.

Targets use `{ "provider": "gitlab", "project": "group/repo", "number": 123 }` or `{ "provider": "github", "project": "owner/repo", "number": 123 }`. GitLab project defaults to `GITLAB_PROJECT_ID`. Azure uses one configured organization/project per installation. Task descriptions use Azure HTML; review bodies use Markdown. Tasks inherit the parent's area and iteration and link via the parent hierarchy relation. Custom work item types/processes are not handled automatically.

## Failure recovery and boundaries

Each draft has a persisted publication journal and exclusive filesystem lock. Already posted items are skipped on retries. If a write times out or the process exits after sending it, the server cannot know whether the provider accepted it. It blocks automatic retries of that item to avoid duplicate comments/tasks.

Inspect the remote provider, then reconcile locally:

```powershell
node src/cli.js reconcile <draft-id> R1 posted <remote-id>
# OR, only after confirming nothing was created:
node src/cli.js reconcile <draft-id> R1 not-posted
```

If a process crashed while holding `.local/drafts/<id>.lock`, first stop that process and inspect its journal and the remote provider; remove only that specific stale lock before reconciliation. Never delete the journal to force retries. Partial publication is possible: remote APIs do not provide a transaction spanning comments or tasks.

This approval mechanism protects the MCP interface. An agent or person with unrestricted shell access under your OS account can modify local files or call the providers directly; use client tool permissions if you need isolation against that threat. There is also an unavoidable race between checking a remote head and posting, though inline comments carry the reviewed SHA.

Sonar data depends on analysis availability, product version, and token permissions. Missing coverage is unknown, not zero; a passed gate is not proof that the code is correct. This server reads analysis; it does not run SonarScanner. API responses are bounded at 12 MB, Git diffs at 12 MB, and draft anchor validation at 3000 changed files. Untracked files are listed but their contents are not included in `git diff`.

## Development

```powershell
npm run check
npm test
npm audit
```

Tests cover real MCP stdio discovery/validation, provider request contracts using mock HTTP, approval selection/expiry/tampering, stale heads/destinations, uncertain writes, locks, inline diff anchors, task-parent changes, hunk-ledger identity across pagination, coverage-gap rejection, rubric routing, and CRLF-safe diff parsing. Tests never post to real services. `npm run doctor` performs read-only authentication checks.

Sources used for the adapters: [MCP SDK](https://ts.sdk.modelcontextprotocol.io/server), [GitLab discussions](https://docs.gitlab.com/api/discussions/), [GitHub review comments](https://docs.github.com/en/rest/pulls/comments), [Azure task creation](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1), [Sonar Web API](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/web-api).

Useful future additions: a browser approval UI, saved review policies per repository, and a corpus of the team's own past review comments mined from merged MR discussions and generated into a house rubric. These can be added without tying the server to a particular LLM.
