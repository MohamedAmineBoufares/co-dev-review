---
title: Work on a ticket
description: Read a ticket and its acceptance criteria, name the branch and the conversation after it, then write a prompt for a coding agent or implement it to review-ready quality, and finish with a detailed PR description.
arg ticket (required): Ticket id: 42 (Azure), PROJ-123 (Jira) or owner/repo#45 (GitHub)
arg mode: prompt (write a prompt for another agent), start (implement here), or ask (default)
arg base: Branch to start from, e.g. release or develop
arg branch: Branch name to use instead of the generated one
---
{{> _persona}}

# Task: work on ticket {{ticket}}

The goal is a change that passes someone else's review with **zero threads**. A colleague will review it with their own tools, so every rubric that review applies must already be satisfied before I open the MR.

1. **Read** the ticket with `plan_ticket_tasks` step `read`: title, description, **acceptance criteria**, discussion, attachments and children. Read the relevant children too. If the criteria are in the description or the discussion rather than their own field, extract them. If there are none, write the ones you infer and mark them "to confirm".
2. **Name things after the ticket.**
   - **Branch:** {{branch|`<type>/<id>-<short-slug>`, where type is `feat` for a story or feature and `fix` for a bug, and the slug is 3 to 5 lowercase words of the ticket title in kebab-case without accents, e.g. `fix/56088-stgo-commentaire-taches`}}.
   - **Conversation title:** `<id> · <ticket title>`. If you have a tool to rename this conversation, use it; otherwise give me the title in one line so I can rename it (`/rename …` in Claude Code).
3. **Restate** the need in three lines, then a table of the acceptance criteria and where each one lives in the code (`file:line`, found by reading, not guessed). List what the ticket leaves open as questions. Never fill a gap with UI, text or behaviour the ticket does not state; ask instead.
4. **Load the quality bar.** Fetch the rubrics with `review_work` step `rubric`: `review-correctness`, `review-complexity`, `review-design`, `review-tests`, plus the stack ones that apply (`review-react-ts`, `review-dotnet`, `review-security`, `review-build`), and read the project's own skills or conventions files if it has any. These are the rules the change will be judged by; write the code to them, not against them.
5. **Mode:** {{mode|ask me in one short question: "prompt" (you write a prompt for another agent) or "start" (you implement it here)}}.

## If the mode is prompt

Write one self-contained prompt in English, in a single code block, ready to paste into a coding agent working in my checkout. It must contain:
- the ticket id and title, the need in plain words, and the acceptance criteria verbatim, numbered;
- the branch to create and the base to start from ({{base|ask me before writing the prompt}});
- the files and symbols to change, with `file:line`, and the existing patterns to follow;
- the plan as numbered steps, each with how to verify it (test, type check or behaviour);
- the open questions, marked as "stop and ask, do not guess";
- the quality bar, summarised from the rubrics of step 4 as a short checklist (edge cases and error paths, no needless complexity, naming, no duplication, typing, security), so that a reviewer finds nothing to comment on;
- the rules: change only what the ticket asks, keep the codebase's patterns, write a test for each acceptance criterion and each edge case, add a comment in plain English only where the code cannot say why on its own, run the related tests, the linter and the type check at the end, never commit or push, and report each criterion as done, partial or blocked;
- the way of working: if the agent has subagents, it designs the contract (signatures, types, cases per criterion) and hands the production code to one cheap subagent and the unit tests to another, in parallel, then integrates; lint, type check and test runs go to a third cheap subagent that only reports;
- the final deliverable: the PR description described below.

## If the mode is start

1. **Branch:** show me the branch name and the base ({{base|ask me which base}}), then wait for my yes. Fetch, and create the branch from the up-to-date remote base. Never reuse or reset an existing branch without asking.
2. **You are the lead, not the typist.** Your job is the thinking: the design, the contract, the review. The typing and the mechanical work go to cheaper, faster subagents (the smallest model your client offers). If your client has no subagents, do the same steps yourself, in the same order.
3. **Plan and write the contract.** Show me the plan as numbered steps with the files involved, and wait for my go if a question from step 3 is still open. Then write the contract both workers build from, so they can work at the same time without talking to each other:
   - each function, component, hook or endpoint to add or change: file, exact name and signature or props, types, return value, errors thrown;
   - the behaviour of each one as a list of cases: input or state → expected result, including the edge cases and error paths;
   - each acceptance criterion mapped to the cases that prove it;
   - the patterns and existing files to imitate, and the rubric points that apply.
4. **Run two workers in parallel**, each with the contract, the rubric checklist and a strict scope:
   - **Coder:** writes the production code to the contract and nothing else. Follows the codebase's patterns; smallest change that fully meets the criteria; a comment in plain English only where the code cannot say why on its own (a business rule, a workaround, a non-obvious constraint), never one that repeats the code. Does not touch test files.
   - **Tester:** writes the unit tests from the contract's cases, one or more per acceptance criterion, edge case and error path, in the project's test style and folders. Tests behaviour, not implementation details. Does not touch production files.
   - Both: no commit, no push, no new dependency without asking, no change outside their scope; report the files they touched and anything in the contract that was unclear or impossible, instead of guessing.
5. **Integrate.** Read both diffs yourself. Check the code against the contract and the rubrics, and the tests against the cases. If they disagree, the contract decides: fix the contract if it was wrong, then send the gap back to the right worker.
6. **Verify with a cheap worker.** A third subagent runs only the commands you give it: install if needed, the related unit tests, the linter and the type check, and returns at most 10 lines per command (pass/fail, failing test names, `file:line` of errors). It edits nothing. Failures go back to the coder or the tester, with your diagnosis; never weaken a test to make it pass.
7. **Review yourself as the colleague will.** Run `review_work` from step `read` without a target, against the base, with steps `checks`, `blast_radius` and `tests`. Go through every rubric of step 4 against the full diff, look for what a strict reviewer would comment on, and send the fixes to the workers. Repeat until there is nothing left to comment on.
8. **Report:** the acceptance criteria table again, with the evidence for each (code, test), then the checks you ran and their result, and what is left or uncertain. Wait for my changes. Do not commit or push until I ask; when I do, the commit message starts with the type and references the ticket id.

## The PR description

When I have no further changes, write the PR description in English, in one Markdown code block, ready to paste:
- **Title:** the ticket title, with the ticket id;
- **Context:** the need and why, in two or three sentences, with the link or id of the ticket;
- **Changes:** what changed and why, grouped by area, with the key files;
- **Acceptance criteria:** a checklist, each one with how it is met and the test that proves it;
- **How to test:** numbered steps a reviewer or QA can follow, with the data or setup they need;
- **Risks and impact:** what else this touches (from the blast radius), migrations, config or breaking changes, or "none";
- **Screenshots:** a placeholder if the UI changed;
- **Out of scope / follow-ups:** what was left out on purpose.
