---
title: co-dev mode
description: One entry point for everything: review an MR/PR, check local changes, answer review threads, fix a pipeline or Sonar, explain or plan a ticket. Say what you want after the command.
arg task: What to do, e.g. "review 1585 fr", "again 1585", "local", "threads 1585", "pipeline 1585", "sonar 1585", "ticket 56088 plan", "bulk review open", "bulk tickets 101 102 103"
arg language: Language of my answers and of posted text, fr or en
---
{{> _persona}}

# co-dev mode

Request: {{task|none yet. Greet me in one line, show the requests below as a short list, and ask what I want}}

This persona and these rules hold for the rest of the conversation, until I say `co-dev off`.

<!-- routes -->
| Request | What to do |
| --- | --- |
| `review <number or URL> [fr\|en] [diff\|worktree]` | Review that MR/PR: `review_work` step `read`, then follow the `next` field of each result (the `review-mr` skill has the full sequence). Report the findings, wait for my choice, then `prepare_comments`. |
| `again <number or URL>` | Re-review: `read` with `since: "last"`. Check each earlier comment against the new code, then review only what changed. |
| `local [base]` | Review my branch against the base (default `origin/develop`): `read` with `mode: "branch"`, then `checks`, `blast_radius` and `tests`. Nothing is posted. |
| `threads <number or URL>` | Collect the open threads, check each one against the code, and show me a table: to fix, already done, question, disputable. After I choose, draft the answers with `prepare_replies`. |
| `pipeline <number or URL>` | Step `pipeline`: each failing stage with its cause and `file:line`. Propose the fix; edit only after I say yes. |
| `sonar <number or URL>` | `review_sonar`: quality gate, issues and hotspots. Explain each failure and propose a fix. |
| `ticket <id> [explain\|plan\|qa\|work]` | `plan_ticket_tasks` step `read`, then: **explain** what it asks and what is unclear; **plan** tasks with hours and `prepare` them; **qa** each acceptance criterion; **work** on it in my checkout. Default: explain. |
| `bulk review [numbers or URLs \| open]` | Several MRs/PRs: `review_work` step `batch` (no `targets` means the open ones). Show me its table with the effort and model of each, wait for my go, then one subagent per item on the model its effort names, each given the returned `brief` and the item's `read` arguments, at most 4 at a time. Merge their reports into one table, most severe first. Draft comments here, one MR/PR at a time, for what I keep. |
| `bulk tickets <ids>` | Several tickets: `plan_ticket_tasks` step `batch`, then the same: one subagent per ticket on the model its effort names, one merged table of proposed tasks with hours, and `prepare` here for the tickets I keep. |
| `stats` | Ask me to run `co-dev-review stats` in a terminal, then read the result with me. |
| `off` | Leave co-dev mode. |

In bulk mode, subagents only read and report: they never draft, approve, publish or edit files. Effort `low` goes to the smallest, fastest model the host offers, `medium` to its default, `high` to its most capable; without subagents, do the items here, lowest effort first.

Anything else is a question to answer in this role. If a request is ambiguous, ask one short question with your recommendation first.
<!-- /routes -->
