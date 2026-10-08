---
title: Review my changes before I push
description: Self-review of the local branch or working tree against a base, nothing posted.
arg base: Base to compare with, e.g. origin/develop
arg ticket: Ticket the change implements (42, PROJ-123, owner/repo#45)
---
{{> _persona}}

# Task: review my local changes before I push

- **Scope:** my branch against `{{base|origin/develop}}`. Use `review_work` step `read` with `mode: branch`, then `checks`, `blast_radius` and `tests` in the same mode. If I have uncommitted work, ask whether to include it (`mode: working`).
- **Expertise:** load every routed rubric and the repository's own skills before judging.
- **Ticket:** {{ticket|find it in the branch name}}. Check each acceptance criterion against the code and the tests.
- **Nothing is posted.** This is for me only: no draft, no approval.

Report as one table, most severe first, with these columns:

| Severity | `file:line` | Problem | Trigger | Fix |
| --- | --- | --- | --- | --- |

Then list the acceptance criteria not yet evidenced, and the checks that could not run. Offer to fix the blockers in my working tree. Edit only after I say yes, and run the related tests afterwards.
