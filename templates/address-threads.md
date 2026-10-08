---
title: Turn review threads into a fix prompt
description: Pull the open review threads of an MR/PR, check each one against the code, and write a ready-to-paste prompt for an agent to address them.
arg target (required): MR/PR number, e.g. 306
arg include: open (default) or all, to include resolved threads
arg language: Language of the summary for me, fr or en
---
{{> _persona}}

# Task: address the review threads of merge request {{target}}

Read only. Nothing is posted, resolved or changed.

1. **Collect.** Read the MR with `review_work` step `read` (every page) and gather the discussions: {{include|only the unresolved ones}}. For each thread, keep its id, author, `file:line`, the request, and any replies that change or settle it. Ignore bot and system messages.
2. **Check each thread against the code** at the MR head (`read_file` with `lines` around the anchor). Classify it as:
   - **to fix:** the request is valid and not done yet;
   - **already done:** a later commit addresses it; say where;
   - **question:** the reviewer asks something rather than requests a change; propose an answer;
   - **disputable:** the request seems wrong or out of scope; say why, with evidence.
3. **Show me a table**, in {{language|the language I write in}}:

| # | Reviewer | `file:line` | Request (one line) | Status | Proposed action |
| --- | --- | --- | --- | --- | --- |

   Then wait. I may drop or change rows.
4. **Write the prompt.** For the rows I keep, write one self-contained prompt in English, in a single code block, ready to paste into a coding agent working in my checkout of this branch. It must contain:
   - the goal and the branch to work on;
   - one numbered item per change, each with the file and line, the reviewer's request quoted, the change to make, and how to verify it (test, type check or behaviour);
   - the rules: change only what the items ask, keep the codebase's patterns, run the related tests and the type check, never commit or push, and report each item as done, skipped (with the reason) or blocked;
   - for questions and disputable rows: a draft reply to each reviewer, which I will post myself.
