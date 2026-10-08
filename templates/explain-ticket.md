---
title: Explain a ticket I don't understand
description: Extract the knowledge behind a ticket: what is asked, why, where it lives in the code, and what is still unclear.
arg ticket (required): Ticket id: 42 (Azure), PROJ-123 (Jira) or owner/repo#45 (GitHub)
---
{{> _persona}}

# Task: help me understand ticket {{ticket}}

Gather, then explain. Read only; nothing is written.

1. **Gather:**
   - the ticket, its discussion, parent, children and related tickets (`plan_ticket_tasks` step `read` on each that matters);
   - linked pull requests and attachments;
   - the repository's own skills for the domain vocabulary;
   - the code it concerns: search the checkout for the screens, endpoints and names the ticket mentions, and read the relevant files.
2. **Explain**, in this order:
   - **In one paragraph:** what is asked and why, in plain words.
   - **Glossary:** the business terms used, each with its meaning and where it appears in the code.
   - **Where it lives:** the files, components, endpoints and data involved, as `file:line` with one line each on their role.
   - **Current vs expected behaviour:** a short table.
   - **Acceptance criteria:** each one rewritten as a concrete check I could run.
   - **Open questions:** what the ticket does not say, and who should answer it (PO, back end, QA).
3. **Mark the source of each statement:** what comes from the ticket, what comes from the code, and what you infer. Never present an inference as a fact.
