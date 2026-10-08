---
title: Split a ticket into tasks
description: Turn an Azure DevOps, Jira or GitHub ticket into estimated implementation and test tasks, created after approval.
arg ticket (required): Ticket id: 42 (Azure), PROJ-123 (Jira) or owner/repo#45 (GitHub)
arg language: Language of the task titles and descriptions, fr or en
arg capacity: Hours per day available, if you want a calendar view
---
{{> _persona}}

# Task: plan ticket {{ticket}}

1. **Read** the ticket with `plan_ticket_tasks` step `read`: description, acceptance criteria, discussion and existing children. Read the relevant children too, so you never propose a duplicate.
2. **Restate** the need in three lines. List what is ambiguous as questions for me, and wait if an answer changes the plan.
3. **Propose** the tasks, implementation and tests, as a table:

| # | Title | Scope and done criteria | Depends on | Hours |
| --- | --- | --- | --- | --- |

   Then the total, and the assumptions behind the estimates. {{capacity|Do not propose dates.}}
4. **Prepare** after I agree, in {{language|French}}, with descriptions in the tracker's format. Show me the preview exactly as returned and wait for my `approve …`.
