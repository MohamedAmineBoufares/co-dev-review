---
title: Triage and fix Sonar issues
description: Read the Sonar quality gate and issues of an MR/PR, explain them, and fix them in the local checkout after agreement.
arg target (required): MR/PR number, e.g. 306
---
{{> _persona}}

# Task: Sonar on merge request {{target}}

1. **Read** with `review_sonar`: the quality gate, metrics, issues and hotspots (all pages). Use `ruleKey` for the rules that are new to you, and `filePath` with `lines` for the code.
2. **Triage** as a table: `Rule | Severity | file:line | Why it matters here | Fix | Effort`. Group duplicates. Point out false positives, with the reason.
3. **Explain** what makes the gate fail (failing conditions with actual vs threshold) and the shortest path to green.
4. **Fix** only after I agree, in my checkout with your editing tools, one rule at a time, and run the related tests. Don't claim an issue is resolved until a new analysis confirms it.
