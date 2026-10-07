# Tool reference

The server exposes three MCP tools. Each tool takes one `request` object whose `step` selects a stage of the workflow, so the tool list stays small and stable. The server's MCP `instructions`, and each tool description, name the version and every step, so a client holding an older schema is easy to spot.

Targets look like `{ "provider": "gitlab", "project": "group/repo", "number": 123 }` or `{ "provider": "github", "project": "owner/repo", "number": 123 }`. For GitLab, `project` defaults to `GITLAB_PROJECT_ID`.

## `review_work`

Reviews local changes before pushing, or a remote GitLab MR or GitHub PR, and publishes only approved comments.

| Step | Parameters | Returns |
| --- | --- | --- |
| `read` | `target?`, `page`, `mode` (`working`/`staged`/`branch`), `base` | Diff page (path, status, patch), existing discussions without system notes, hunk ledger and `nextPage`. Page 1 also returns the rubrics, repository skills, worktree status and `checkoutPlan` (policy, detected package manager, existing worktree), so the assistant can ask before checking out. Without a `target`, it reads the local checkout, paged by 100 files or about 200 KB |
| `read_file` | `target`, `path`, `ref`, `lines?` | A file at the reviewed head, from the review worktree when it is at that commit, otherwise from the API. `lines` (`"120-220"`, `"120-"`, `"-80"`) returns a range; without it, files over 1,500 lines are cut with a continuation hint |
| `rubric` | `names` (≤ 8) | Full text of packaged or repository skills, for clients that cannot load skill files |
| `checkout` | `target`, `packageManager` (`auto`/`link`/`pnpm`/`npm`/`yarn`/`none`), `install` | Prepares the review worktree at the head; dependencies are linked from your checkout when the change touches no lockfile or `package.json`, otherwise installed |
| `checks` | `target?` or `mode`/`base`, `only?`, `detail?` | Compiler and linter findings on changed lines, pre-existing ones counted by rule (`detail: "full"` lists them), plus a `runId` |
| `blast_radius` | `target?` or `mode`/`base`, `detail?`, `symbols?` | Changed exported symbols with their caller count and one caller per file; `symbols: [name]` or `detail: "full"` lists up to 50 callers each. Plus a `runId` |
| `tests` | `target?` or `mode`/`base` | Runs only the unit tests related to the changed files (Vitest `related`, Jest `--findRelatedTests`), per project; returns counts and the first lines of each failure, plus a `runId` |
| `prepare_comments` | `target`, `language` (`fr`/`en`), `items`, `coverage`, `rubricsApplied`, `deterministic`, `approval?` | The saved draft and the approval outcome |
| `request_approval` | `draftId`, `approval?` | Asks for approval of an existing draft again (in conversation mode, returns the preview to show) |
| `approve` | `draftId`, `selectedIds`, `userWords`, `publish` (default `true`) | Records the approval the user typed in the conversation and publishes it. Only for a draft whose preview was shown and is unchanged; disabled unless `REVIEW_APPROVAL` is `conversation` |
| `revise` | `draftId`, `itemId`, `text` | Rewords one item at the user's request; returns its new preview, and voids any earlier approval |
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
- **`deterministic`**: `{ checks, blastRadius, tests? }`, each `{ runId }` from a run on this head and base, or `{ skipped: "<reason, 20+ characters>" }`. `tests` is optional and verified the same way when given.
- **`approval`**: `default` (the `REVIEW_APPROVAL` setting, `conversation` unless changed), `conversation`, `in-chat`, `browser`, `terminal` or `auto`.

The result confirms the draft by id, severity, confidence and anchor without repeating the bodies you sent; `view_draft` shows everything.

`approval.status` in the result is one of:

| Status | Meaning |
| --- | --- |
| `pending` with a `preview` | Conversation mode: show the preview, then call `approve` with the user's reply |
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
| `read` | `ticketId`, `continuationToken?`, `full?` | Reviewer-relevant fields with HTML converted to text (description, acceptance criteria, repro steps), parent, children, related items, linked pull requests and attachments, and the discussion. `full: true` returns the raw work item |
| `prepare` | `ticketId`, `language`, `tasks`, `approval?` | The saved draft, the total hours and the approval outcome |
| `request_approval`, `approve`, `revise`, `view_draft`, `publish` | `draftId`… | As for reviews; task ids are `T1`, `T2`… |

Each task has a `title`, a `description` in Azure HTML (scope, completion criteria, dependencies, estimate assumptions), `estimatedHours` and an optional `assignedTo`, which defaults to `AZURE_DEVOPS_ASSIGNEE`.

Tasks inherit the parent's area and iteration, link to it as children, and get Original Estimate and Remaining Work set. Estimates are effort, not deadlines. WIQL supports `@project` and `@Me`.

## `review_sonar`

Takes `target`, an optional Sonar `project`, `page`, `ruleKey`, `filePath`, `lines` and `full`. It returns the review's title, head and branches, together with the quality gate, metrics, issues and hotspots for that PR number. Issues and hotspots carry their key, rule, severity, path, line and message; `full: true` returns the raw Sonar responses. `ruleKey` adds the rule's remediation guidance as text, and `filePath` (optionally with `lines`) adds the file's source at the PR head. For the diff itself, use `review_work` `read`.

The tool only reads. Fixes are made with the assistant's own editing tools, and a fresh analysis is needed to confirm them.

## Output size

Every response is compact JSON, and each tool returns what a reviewer or planner uses rather than the providers' raw payloads: no avatars, links, hashes or styling markup. Repeated context (rubrics, repository skills, checkout state) comes once, on page 1. Where more detail can matter, an explicit option returns it: `detail: "full"`, `symbols`, `lines`, `full: true` and `view_draft`.

## Prompt

`review_workflow` (argument: `language`) returns the full workflow as a prompt, for clients that surface MCP prompts as commands.

## Pagination and partial data

- Review reads return `nextPage`: keep reading until it is `null`.
- Sonar issues and hotspots keep their paging fields.
- Ticket discussions return a `continuationToken`.
- Sections that failed are reported as errors next to the data that loaded, never silently dropped.
