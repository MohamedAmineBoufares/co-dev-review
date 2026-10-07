---
name: review-design
description: Design and maintainability rubric - checks that a change fits the codebase's existing patterns and helpers, finds the code smells that turn into bugs (duplicated sources of truth, boolean-flag forks, lying names, shotgun surgery, premature abstraction), and calibrates them so taste never outranks correctness. Use on every MR/PR or local review that changes application code, or when the co-dev-review server returns a rubric with skill "review-design".
---

# Reviewing design and code smells

A senior reviewer's design comments are rare, specific and tied to a cost. "This could be cleaner" is not a finding. "This duplicates `formatAmount` in `shared/utils`, and the two already round differently" is.

## 1. Understand the approach before the lines

Before any line-level comment, answer:

- What problem does the change solve, and is this the place in the architecture where it should be solved? A fix in the view for a data bug, or a workaround for something a lower layer should guarantee, will be repeated by the next developer.
- Is there a simpler approach the author may have missed? If yes, raise it once, as a question, near the top of the review, not as twenty line comments on the current approach.
- Is the change the right size? Unrelated refactoring mixed into a bug fix makes both harder to review and to revert. Say so.

## 2. Fit with the codebase

This is the most common real design finding, and the one only a reviewer who knows the codebase can make.

- **Search before you accept something new.** For every new helper, hook, constant, type, selector or component, grep the repository (or read the repository skills) for an existing equivalent. Duplicates drift apart: two date formatters, two rounding rules, two "is this element used" checks.
- **Follow the house pattern.** If the codebase talks across apps through an emitter, persists through a given slice, or builds grids with a shared config, a change that invents a new path needs a reason.
- **Layering and dependency direction.** A shared/library module importing from a feature, a component reaching into another app's internals, or business rules inside a render function.
- **Public surface.** A new export that only one file uses, or an internal detail exported "for tests".

## 3. Smells that become bugs

Flag these when you can name the bug they will cause:

| Smell | Why it bites |
| --- | --- |
| Two sources of truth for one fact (prop mirrored into state, a value cached in two slices) | They drift; the UI shows one, the save sends the other |
| Boolean parameter that forks a function (`doThing(x, true, false)`) | Every call site is unreadable, and new cases add more flags |
| Name that lies (`getX` that mutates, `isValid` that also saves, `total` that is a unit value) | The next developer trusts the name |
| Shotgun surgery: one concept changed in many files by hand | The next change will miss one |
| God component or function (hundreds of lines, many reasons to change) | Every change risks unrelated behaviour; nobody can test it |
| Magic values (`type === 3`, `'ENS'` strings repeated) | A changed code value breaks distant comparisons silently |
| Primitive obsession (ids, amounts and codes as bare `string`/`number`) | Arguments get swapped without a type error |
| Long parameter lists, especially same-typed | Swapped arguments |
| Dead code, commented-out code, unreachable branches added by the change | Misleads readers, hides real paths |
| Premature abstraction: a generic layer with one caller | Cost now, flexibility nobody needs |
| Duplicated logic copied with a small change | Bug fixes land in one copy |
| Feature envy: a function mostly manipulating another module's data | The logic is in the wrong place |
| Comments explaining *what* the code does because the code is unclear | Rename or extract instead; keep comments for *why* |

## 4. Readability that affects review and maintenance

- Deep nesting where a guard clause would flatten the happy path.
- One function mixing levels of abstraction (HTTP details next to business rules next to DOM tweaks).
- Inconsistent naming with the surrounding code (domain vocabulary: use the codebase's terms, not synonyms).
- Do not comment on formatting, import order or anything a linter or formatter owns.

## 5. Severity calibration

- **blocker:** only when the design choice causes a concrete bug now (two sources of truth already diverging, a duplicated rule already inconsistent).
- **major:** a pattern break that will predictably cause bugs or block upcoming work, such as a new cross-app path bypassing the established one, or business logic in the wrong layer.
- **minor:** a real smell with a modest cost.
- **suggestion:** taste. Group all suggestions into one general comment instead of many inline ones, and drop them entirely if the review already has blockers.

## 6. Report

For each finding: the smell or pattern break, the concrete cost or the bug it invites, the evidence (including the existing helper or pattern it duplicates or bypasses, with its path), and the change you suggest. When unsure whether a pattern exists, ask rather than assert.
