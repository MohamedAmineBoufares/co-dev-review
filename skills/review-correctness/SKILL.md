---
name: review-correctness
description: Bug-hunting rubric for any code change - runs concrete inputs through every changed function, reads what the diff removed, checks invariants against the callers outside the diff, and covers the JavaScript/TypeScript semantics that produce silent wrong results. Use on every MR/PR or local review that changes .ts, .tsx, .js, .jsx or .cs code, or when the co-dev-review server returns a rubric with skill "review-correctness".
---

# Hunting for bugs in a change

A checklist finds what it lists. This is a procedure: it finds bugs nobody listed by making you run the code in your head on inputs chosen to break it. Do it for every changed function, not only the ones that look risky; the bug is usually in the one that looked trivial.

## 1. State the intent before judging the code

For each changed function, write one sentence: what must be true when it returns? Take it from the ticket, the MR description, the function name and its callers, in that order. A function whose intent you cannot state cannot be reviewed for correctness. Say so and ask, rather than guessing.

## 2. Run concrete inputs through it

Pick values and trace them line by line through the new code. Do not reason about "an array". Reason about `[]`, then `[x]`, then `[x, x]`.

| Kind | Inputs to try |
| --- | --- |
| Collections | empty, one element, duplicates, already sorted, reverse sorted, a very large one, containing `null`/`undefined` holes |
| Numbers | `0`, `-1`, `NaN`, `Infinity`, `0.1 + 0.2`, a value at the boundary of every `<` / `<=` |
| Strings | `''`, whitespace only, accents and casing (`'É'` vs `'é'`), a number-like string `'08'` |
| Optional data | missing key, `null`, `undefined`, an empty object, an API field renamed or absent |
| Trees and hierarchies | a leaf, a root with no children, a deep chain, a node appearing twice, a cycle |
| Identity | two different objects with equal content; the same object reached by two paths |
| Time | midnight, a DST change, end of month, a user in another time zone, a date serialized and parsed back |

For each input, state the output. If you can't decide what the output should be, that's a finding about unclear intent.

## 3. Read what the diff removed

Deleted and replaced lines are where regressions hide. For every `-` line, ask what it guaranteed:

- a guard (`if (!x) return`), a default value, a `finally`, an `await`, a cleanup, a `key`, a dependency in a hook array, a validation, a permission check.
- an `else` branch whose case is now handled nowhere.
- a call that had a side effect someone else relied on (event emitted, cache invalidated, flag reset).

If the guarantee still holds, it should be visible elsewhere in the new code. If you cannot find it, it is a candidate blocker.

## 4. Invariants and contracts across the boundary

- Use step `blast_radius`: for every changed exported symbol, open at least the callers whose usage differs from the others. Does each caller still get what it expects (return shape, nullability, units, ordering, sync vs async, thrown vs returned errors)?
- A function that used to return `T` and now returns `T | undefined`, or a promise, or a sorted copy instead of the same array: every caller is in scope.
- Units and scales: hours vs days, unit price vs total, unit-level vs aggregated value, percentage `0.2` vs `20`. A value of the right type and the wrong scale passes every compiler.
- Ordering assumptions: does anything rely on the order of `Object.keys`, a `Set`, a server response, or `Promise.all` completion?

## 5. JavaScript and TypeScript semantics that produce silent wrong results

- `a || b` replaces `0`, `''` and `false`; `a ?? b` only `null`/`undefined`. Check which one the data needs.
- `.sort()` without a comparator sorts as strings (`[10, 9, 1]` gives `[1, 10, 9]`) and mutates in place. So do `.reverse()`, `.splice()`, `.fill()`.
- `x === NaN` is always false; `Number('')` is `0`; `parseInt('08')` needs a radix; `parseFloat('1,5')` is `1`.
- Money and quantities in floating point: sums drift (`0.1 + 0.2 !== 0.3`). Compare with a tolerance or round at a defined point. Never compare a computed amount with `===`.
- Shallow copies: `{...obj}` and `[...arr]` share nested objects. Mutating `copy.child.x` mutates the original, including frozen Redux/immer state (throws) or a grid's row objects (silent).
- Equality by reference: `includes`, `indexOf`, `Set`, `Map` keys and React deps compare objects by identity, not content.
- `forEach` with an `async` callback does not await anything. `array.map(async …)` returns promises, and without `Promise.all` they are lost.
- `new Date('2026-10-07')` is UTC midnight; `new Date(2026, 9, 7)` is local. Months are 0-based. `toISOString()` shifts the day for users east of UTC.
- `typeof null === 'object'`; `Array.isArray` is the only reliable array check; `in` walks the prototype.
- Closures capture variables, not values: a handler created before a state change still sees the old value.
- `JSON.stringify` drops `undefined`, functions and `Map`/`Set`, and turns `Date` into strings that do not come back as dates.
- TypeScript: `as`, `!`, `any` and `@ts-ignore` are unchecked claims. Ask what happens at runtime when the claim is false. An index access `obj[key]` is `T | undefined` at runtime whatever the type says.

## 6. Interleavings and lifecycle

- Two rapid clicks: is the action idempotent, or does it run twice?
- Two requests in flight: can the older response arrive last and overwrite the newer?
- Unmount, tab close or navigation while a promise is pending.
- An event emitted before its listener is registered, or a listener registered twice and never removed.
- Retry paths: does a retry repeat a non-idempotent write?

## 7. Error paths

- What does the user see when the call fails? A spinner forever, stale data presented as fresh, or a silent success?
- `catch` that swallows, logs and continues with `undefined`, or converts every error into "not found".
- Partial failure in a loop: are the items that succeeded rolled back, reported, or silently mixed with the failures?

## 8. Report

For each finding:

- **Trigger:** the concrete input or sequence from sections 2 to 7. No trigger, no blocker.
- **Consequence:** what the user or the data actually suffers.
- **Evidence:** the changed line, plus the caller or removed line that proves it.
- **Fix:** the smallest change that removes the trigger.

Say which sections found nothing. Never write "looks good" for a function you didn't trace.
