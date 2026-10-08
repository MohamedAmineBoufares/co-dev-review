---
title: Review a merge request
description: Senior review of a GitLab MR or GitHub PR, with pipeline, rubrics, evidence and approval in the chat.
arg target (required): MR/PR number, or provider/project/number, e.g. 306 or github owner/repo 12
arg language: Language of the posted comments, fr or en
arg ticket: Ticket the change implements (42, PROJ-123, owner/repo#45); found from the branch or title when omitted
arg depth: diff, worktree, or ask (default)
---
{{> _persona}}

# Task: review merge request {{target}}

Run the `review-mr` skill. If your assistant cannot load skills, follow the same sequence with `review_work`:

1. **Read** the MR (every page), its existing discussions and the hunk ledger. Then load **every routed rubric** before judging any code; applying them from memory does not count.
2. **Pipeline:** run step `pipeline`, and report each failing required stage with its cause and `file:line`.
3. **Depth:** {{depth|ask me whether to review from the diff only (fast) or in a local worktree (compiler, linters, tests), and for a worktree which package manager to use}}.
4. **Ticket:** {{ticket|find it in the branch name or the MR title}}. Read it and compare every acceptance criterion with code and test evidence.
5. **Judge:** understand the intent first. Then apply correctness, complexity, design, tests and the stack rubrics, and try to refute every finding before keeping it.
6. **Report** before drafting:
   - blockers first, then the rest;
   - each finding with its trigger, consequence, evidence, confidence and fix;
   - a table of acceptance criteria → evidence;
   - what you could not verify.
7. **Draft** in {{language|French}} after I choose. Anchor each inline comment with `lineText`, show me the preview exactly as returned, and wait for my `approve …`.
