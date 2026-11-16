# Tool reference

The server exposes three MCP tools. The two workflow tools take flat arguments, `{ "step": "...", ...fields }`, where `step` selects a stage of the workflow, so the tool list stays small and stable. The server's MCP `instructions`, and each tool description, name the version and every step, so a client holding an older schema is easy to spot.

## Calls are forgiving

Models don't all call tools the same way, and a rejected call costs a round trip. The server accepts what they actually send:

| The model sends | The server reads it as |
| --- | --- |
| `target: "https://gitlab.example.com/group/app/-/merge_requests/12"` | `{ provider: "gitlab", project: "group/app", number: 12 }` |
| `target: 12`, `"12"`, `"!12"` or `"owner/repo#12"` | That MR/PR, in the configured project when none is named |
| `{ "request": { "step": "read", … } }` (the 1.4 shape) or the arguments as a JSON string | The same call, unwrapped |
| `null` for a field it doesn't want | The field left out |
| `draftId: "5215051e"` | The draft whose id starts that way |
| `line: "42"`, `page: "2"` | Numbers |

The published schema has no `anyOf`, `oneOf`, `const` or `$ref`: Gemini-based clients and some Copilot models reject or flatten those.

When a call is still wrong, the error says how to fix it and lists every problem at once, and the failed call is recorded in the trace (`co-dev-review stats`).

Every result of a review step carries **`next`**: what to do after it, in order. The workflow lives there rather than in a long prompt.

## `review_work`

Reviews local changes before pushing, or a remote GitLab MR or GitHub PR, and publishes only approved comments.

| Step | Parameters | Returns |
| --- | --- | --- |
| `read` | `target?`, `page`, `mode` (`working`/`staged`/`branch`), `base`, `since?` | The diff page: each file with its number `n`, path, status, patch and hunk count; existing discussions without system notes; `designLinks`; `hunkCount`; `nextPage`. Page 1 adds `rubrics` (`requiredSkills`, the list to copy into `rubricsApplied`), repository skills, `pipeline` (GitLab: status of the head pipeline), worktree status, `checkoutPlan`, and `rejectedBefore`: comments the approver left out of earlier reviews of this project. Without a `target`, it reads the local checkout, paged by 100 files or about 200 KB |
| `read` with `since` | `target`, `since: "last"` or a commit sha | A re-review: only what changed since the head of your previous draft of this MR/PR (or since that commit), plus `previous`, that draft's comments and whether each was posted |
| `read_file` | `target`, `path`, `paths` (≤ 20) or `hunks`, `lines?`, `context?`, `ref?` | A file at the review head, or `files` for several (one failing path is reported in its own entry). `hunks: "3.2"` reads each hunk with `context` lines around it (default 30). A path that doesn't exist is looked up by name: a unique match is returned with `resolvedFrom`, several are listed. `lines` (`"120-220"`, `"120-"`, `"-80"`) returns a range; without it, files over 1,500 lines are cut with a continuation hint |
| `find` | `target`, `path?`, `query?` | `path`: the paths at the review head that match a file name or partial path. `query`: where an exact text appears, from the review worktree when there is one, otherwise from the provider's search (GitHub searches the default branch only) |
| `pipeline` | `target` | The MR/PR's latest pipeline (GitLab, including child pipelines) or check runs (GitHub): status, whether it ran on the review head, and for each failing required job its stage, cause (the meaningful log lines) and `file:line` locations, marked `inDiff` / `onChangedLine` |
| `rubric` | `names` (≤ 8) | Full text of packaged or repository skills, for clients that cannot load skill files |
| `checkout` | `target`, `packageManager` (`auto`/`link`/`pnpm`/`npm`/`yarn`/`none`), `install` | Prepares the review worktree at the head; dependencies are linked from your checkout when the change touches no lockfile or `package.json`, otherwise installed |
| `checks` | `target?` or `mode`/`base`, `only?`, `detail?` | Compiler and linter findings on changed lines, pre-existing ones counted by rule (`detail: "full"` lists them) |
| `blast_radius` | `target?` or `mode`/`base`, `detail?`, `symbols?` | Changed exported symbols with their caller count and one caller per file; `symbols: [name]` or `detail: "full"` lists up to 50 callers each |
| `tests` | `target?` or `mode`/`base` | Runs only the unit tests related to the changed files (Vitest `related`, Jest `--findRelatedTests`), per project; returns counts and the first lines of each failure |
| `verify` | `target`, `packageManager`, `install`, `tests` | `pipeline` and `checkout` run together, then `checks`, `blastRadius` and `tests` in the worktree, each as `{ data }` or `{ error }`. The runs are recorded; `prepare_comments` finds them |
| `prepare_comments` | `target`, `language` (`fr`/`en`), `items`, `coverage`, `rubricsApplied`, `rubricsSkipped?`, `deterministic?`, `approval?` | The saved draft and the approval outcome |
| `prepare_replies` | `target`, `language`, `replies` (`threadId`, `body`, `resolve?`), `approval?` | A draft of replies to existing threads, approved and published like comments. `resolve` also resolves the thread (GitLab only) |
| `request_approval` | `draftId`, `approval?` | Asks for approval of an existing draft again (in conversation mode, returns the preview to show) |
| `approve` | `draftId`, `selectedIds`, `userWords`, `publish` (default `true`) | Records the approval the user typed in the conversation and publishes it. Only for a draft whose preview was shown and is unchanged; disabled unless `REVIEW_APPROVAL` is `conversation` |
| `revise` | `draftId`, `itemId`, `text` | Rewords one item at the user's request; returns its new preview, and voids any earlier approval |
| `view_draft` | `draftId` | The draft, its stored approval and its publication journal |
| `publish` | `draftId` | Posts the approved items; refuses without a valid approval |

### Files, hunks and generated code

Each file of a diff has a number `n`. Hunk `n.k` is the k-th `@@` of that file's patch, and the numbering continues across pages. There is no separate list repeating every hunk header.

Lockfiles, snapshots, source maps, minified files and generated C# (`*.Designer.cs`, `*.g.cs`, model snapshots) come back with their size instead of their patch, and their hunks need no verdict. `read_file` shows one when it matters.

### The parameters of `prepare_comments`

- **`items`**: up to 100 findings, each with:
  - `body`: final Markdown text
  - `severity`: `blocker`, `major`, `minor` or `suggestion`
  - `confidence`: `confirmed`, `likely` or `question`; a blocker must be confirmed
  - for an inline comment: `path` plus `lineText`, the text of a line shown in the patch. The server finds its line number. Whitespace is ignored, a copied `+`/`-` marker is dropped, part of a line is enough when only one line contains it, and a miss names the three closest lines. `line` only chooses between identical lines. A path missing its root is matched to the changed file
  - an unchanged line shown in a hunk is a valid anchor too; the preview marks it `(unchanged line)`
  - `suggestion`: the replacement for the anchored line, posted as a suggestion block the author applies in one click
- **`coverage`**: `{ hunks, verdict, note? }` claims that give every hunk a verdict:
  - `hunks`: `7.2`, `7.*`, `7.2-7.5`, a comma-separated mix, or `rest` for every hunk not named elsewhere
  - `verdict`: `finding`, `reviewed-clean` or `not-applicable`
  - a hunk that carries a comment is a finding without being claimed, and generated files need no claim
  - the preview tells the approver how many hunks were claimed in bulk with `rest`
- **`rubricsApplied`** and **`rubricsSkipped`**: every rubric skill routed by `read` must be in one of them; a skip needs a reason (15+ characters). Both are shown to the approver.
- **`deterministic`**: leave it out. The server looks up the `checks`, `blast_radius` and `tests` runs it recorded for this review head and base. A pass that didn't run is saved as not run, and the preview says so. Pass `{ checks: { skipped: "<reason, 20+ characters>" } }` only to explain why a pass could not run; a `runId` is still accepted.
- **`approval`**: `default` (the `REVIEW_APPROVAL` setting, `conversation` unless changed), `conversation`, `in-chat`, `browser`, `terminal` or `auto`.

A draft with several problems is refused once, with all of them numbered, so one retry fixes it.

Before the draft is saved, each inline comment is compared with the open threads of the review: one within three lines of an open thread is flagged `nearExisting`, and the preview shows whose thread it is.

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

Turns a ticket into estimated child tasks, in Azure DevOps (child Tasks), Jira (sub-tasks) or GitHub Issues (sub-issues). The tracker is inferred from the id (`42`, `PROJ-123`, `owner/repo#45`), else `TICKET_TRACKER`; pass `tracker` to force one.

| Step | Parameters | Returns |
| --- | --- | --- |
| `search` | `query` (WIQL, JQL or GitHub issue search) or `queryId` (Azure saved query, Jira filter), `tracker?` | Up to 200 tickets: id, title, type, state, assignee, tags, area, iteration |
| `read` | `ticketId`, `continuationToken?`, `full?` | Reviewer-relevant fields with HTML converted to text (description, acceptance criteria, repro steps), parent, children, related items, linked pull requests and attachments, `designLinks` (Figma URLs found in the ticket and its comments), and the discussion. `full: true` returns the raw work item |
| `prepare` | `ticketId`, `language`, `tasks`, `approval?` | The saved draft, the total hours and the approval outcome |
| `request_approval`, `approve`, `revise`, `view_draft`, `publish` | `draftId`… | As for reviews; task ids are `T1`, `T2`… |

Each task has a `title`, a `description` in Azure HTML (scope, completion criteria, dependencies, estimate assumptions), `estimatedHours` and an optional `assignedTo`, which defaults to `AZURE_DEVOPS_ASSIGNEE`.

Tasks inherit the parent's area and iteration, link to it as children, and get Original Estimate and Remaining Work set. Estimates are effort, not deadlines. WIQL supports `@project` and `@Me`.

## `review_sonar`

Takes `target`, an optional Sonar `project`, `page`, `ruleKey`, `filePath`, `lines` and `full`. It returns the review's title, head and branches, together with the quality gate, metrics, issues and hotspots for that PR number. Issues and hotspots carry their key, rule, severity, path, line and message; `full: true` returns the raw Sonar responses. `ruleKey` adds the rule's remediation guidance as text, and `filePath` (optionally with `lines`) adds the file's source at the PR head. For the diff itself, use `review_work` `read`.

The tool only reads. Fixes are made with the assistant's own editing tools, and a fresh analysis is needed to confirm them.

## Output size

Every response is compact JSON, and each tool returns what a reviewer or planner uses rather than the providers' raw payloads: no avatars, links, hashes or styling markup. Repeated context (rubrics, repository skills, checkout state) comes once, on page 1, and rubrics are named rather than described: the skills hold the detail. The server instructions are about 2,600 characters, short enough that no client cuts them, with the approval rules first. Where more detail can matter, an explicit option returns it: `detail: "full"`, `symbols`, `lines`, `full: true` and `view_draft`.

## Prompt

`review_workflow` (argument: `language`) returns the full workflow as a prompt. Every template in `templates/` is also a prompt (`co-dev`, `review-mr`, `address-threads`, `review-local`, `plan-ticket`, `explain-ticket`, `qa-ticket`, `fix-sonar`, `fix-pipeline`, `work-ticket`, and your own); see [Templates](templates.md).

## Pagination and partial data

- Review reads return `nextPage`: keep reading until it is `null`.
- Sonar issues and hotspots keep their paging fields.
- Ticket discussions return a `continuationToken`.
- Sections that failed are reported as errors next to the data that loaded, never silently dropped.
