# Tool reference

The server exposes three MCP tools. Each tool takes one `request` object whose `step` selects a stage of the workflow, so the tool list stays small and stable. The server's MCP `instructions`, and each tool description, name the version and every step, so a client holding an older schema is easy to spot.

Targets look like `{ "provider": "gitlab", "project": "group/repo", "number": 123 }` or `{ "provider": "github", "project": "owner/repo", "number": 123 }`. For GitLab, `project` defaults to `GITLAB_PROJECT_ID`.

## `review_work`

Reviews local changes before pushing, or a remote GitLab MR or GitHub PR, and publishes only approved comments.

| Step | Parameters | Returns |
| --- | --- | --- |
| `read` | `target?`, `page`, `mode` (`working`/`staged`/`branch`), `base` | Diff page, hunk ledger, rubrics, repository skills, review worktree status, `nextPage`. Without a `target`, it reads the local checkout |
| `read_file` | `target`, `path`, `ref` | A file at the reviewed head, from the review worktree when it is at that commit, otherwise from the API |
| `rubric` | `names` (≤ 8) | Full text of packaged or repository skills, for clients that cannot load skill files |
| `checkout` | `target`, `install` (default `true`) | Prepares the review worktree at the head and installs dependencies |
| `checks` | `target?` or `mode`/`base`, `only?` | Compiler and linter findings split by changed lines, plus a `runId` |
| `blast_radius` | `target?` or `mode`/`base` | Changed exported symbols and their callers outside the diff, plus a `runId` |
| `prepare_comments` | `target`, `language` (`fr`/`en`), `items`, `coverage`, `rubricsApplied`, `deterministic`, `approval?` | The saved draft and the approval outcome |
| `request_approval` | `draftId`, `approval?` | Asks for approval of an existing draft again |
| `view_draft` | `draftId` | The draft, its stored approval and its publication journal |
| `publish` | `draftId` | Posts the approved items; refuses without a valid approval |

The parameters of `prepare_comments`:

- **`items`**: up to 100 findings, each with:
  - `body`: final Markdown text
  - `severity`: `blocker`, `major`, `minor` or `suggestion`
  - `confidence`: `confirmed`, `likely` or `question`; a blocker must be confirmed
  - `path` and `line` (optional, together) and `side` (`RIGHT` or `LEFT`)
- **`coverage`**: one or more `{ hunks, verdict, note? }` claims that together give every hunk in the ledger exactly one verdict:
  - `hunks`: `7.2`, `7.*`, `7.2-7.5` or a comma-separated mix
  - `verdict`: `finding`, `reviewed-clean` or `not-applicable`
- **`rubricsApplied`**: the rubric and repository skill names actually applied. They are shown to the approver.
- **`deterministic`**: `{ checks, blastRadius }`, each `{ runId }` from a run on this head and base, or `{ skipped: "<reason, 20+ characters>" }`.
- **`approval`**: `auto` (default), `in-chat`, `browser` or `terminal`.

`approval.status` in the result is one of:

| Status | Meaning |
| --- | --- |
| `published` | Approved and posted; `journal` lists what was created |
| `approved` | Approved; publish when the user asks |
| `pending` | The user is deciding in the browser or terminal |
| `declined`, `cancelled`, `nothing-selected` | Nothing was approved |
| `timed-out` | The in-chat form wasn't answered |

## `plan_ticket_tasks`

Turns an Azure DevOps Bug or PBI into estimated child tasks.

| Step | Parameters | Returns |
| --- | --- | --- |
| `search` | `wiql` or `queryId` (exactly one) | Up to 200 tickets: id, title, type, state, assignee, tags, area, iteration |
| `read` | `ticketId`, `continuationToken?` | Fields, relations (children), discussion |
| `prepare` | `ticketId`, `language`, `tasks`, `approval?` | The saved draft, the total hours and the approval outcome |
| `request_approval`, `view_draft`, `publish` | `draftId` | As for reviews |

Each task has a `title`, a `description` in Azure HTML (scope, completion criteria, dependencies, estimate assumptions), `estimatedHours` and an optional `assignedTo`, which defaults to `AZURE_DEVOPS_ASSIGNEE`.

Tasks inherit the parent's area and iteration, link to it as children, and get Original Estimate and Remaining Work set. Estimates are effort, not deadlines. WIQL supports `@project` and `@Me`.

## `review_sonar`

Takes `target`, an optional Sonar `project`, `page`, `ruleKey` and `filePath`. It returns the review context, together with the quality gate, metrics, issues and hotspots for that PR number. `ruleKey` adds the remediation guidance for a rule, and `filePath` adds the file's source at the PR head.

The tool only reads. Fixes are made with the assistant's own editing tools, and a fresh analysis is needed to confirm them.

## Prompt

`review_workflow` (argument: `language`) returns the full workflow as a prompt, for clients that surface MCP prompts as commands.

## Pagination and partial data

- Review reads return `nextPage`: keep reading until it is `null`.
- Sonar issues and hotspots keep their paging fields.
- Ticket discussions return a `continuationToken`.
- Sections that failed are reported as errors next to the data that loaded, never silently dropped.
