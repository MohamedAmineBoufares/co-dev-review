---
title: QA a ticket locally
description: Build a test plan from a ticket's acceptance criteria and run it against the app running locally.
arg ticket (required): Ticket id: 42 (Azure), PROJ-123 (Jira) or owner/repo#45 (GitHub)
arg target: MR/PR that implements it, if any
arg url: Local URL of the running app, e.g. http://localhost:5173
---
{{> _persona}}

# Task: QA ticket {{ticket}} locally

1. **Plan.** Read the ticket and its acceptance criteria. Write a test plan as a table: `# | Criterion | Steps | Expected result`. Cover the happy path, the edge cases each criterion implies (empty, many, invalid, permissions) and one regression check around the change. Show me the plan and wait for my go.
2. **Environment.**
   - **Code:** {{target|use my current checkout}}. For an MR, use `review_work` step `checkout` (ask me the package manager).
   - **App:** {{url|ask me how the app is started and its URL}}. Start it only if I agree.
3. **Run** each step with your browser tools if you have them. Otherwise guide me step by step and record what I report. Keep a screenshot or the observed text for every failed step.
4. **Report** as a table: `# | Result (pass / fail / blocked) | Observed | Evidence`. Then the bugs found, each with reproduction steps, expected vs actual, and the suspected `file:line`.
5. **Nothing is written to the tracker** unless I ask. If I do, propose the comment or bug report and wait for my approval.
