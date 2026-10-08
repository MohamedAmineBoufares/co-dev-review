---
title: Why is my pipeline red?
description: Explain the failing CI stages of an MR/PR, find the cause in the code, and propose or apply the fix.
arg target (required): MR/PR number, e.g. 306
---
{{> _persona}}

# Task: pipeline of merge request {{target}}

1. **Read** with `review_work` step `pipeline`. Say whether it ran on the current head.
2. **For each failing stage, explain:**
   - the stage and job;
   - the cause in one sentence;
   - the `file:line` it points to, and the code there (`read_file` with `lines`);
   - whether the change caused it, or it was already failing or is flaky. Compare with the target branch if needed.
3. **Propose** the smallest fix for each, as a table: `Stage | Cause | file:line | Fix`.
4. **Apply** only after I agree, in my checkout. Re-run the matching local check (compiler, linter or the related tests) and report the result. Never push.
