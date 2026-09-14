---
name: review-react-ts
description: Review rubric for React, TypeScript and Vite code under review. Use when reviewing an MR/PR or local changes that touch .tsx, .jsx, .ts or .js files, or when the co-dev-review server returns a rubric with skill "review-react-ts". Covers hook correctness, render cost, state ownership, async cancellation, type soundness and accessibility.
---

# Reviewing React and TypeScript changes

Work through every section below against the changed hunks. Say explicitly which sections found nothing — a section you skipped silently is indistinguishable from a section that passed.

For each candidate finding, state the **trigger** (the input or sequence that produces the bug) before writing the comment. If you cannot name a trigger, it is a suggestion, not a blocker.

## 1. Hook correctness

- **Missing or lying dependency arrays.** A `useEffect`/`useMemo`/`useCallback` whose body reads a value absent from its deps captures a stale value. Check every identifier in the body against the array. An intentionally-empty array needs a comment saying why.
- **Effects that should not exist.** Deriving state from props inside an effect, then setting state, causes a double render and a frame of wrong UI. Compute during render instead.
- **No cleanup.** Subscriptions, `setTimeout`/`setInterval`, event listeners, `IntersectionObserver`, `AbortController` — each needs a cleanup return. Absence leaks and fires after unmount.
- **Async effects without cancellation.** `useEffect(() => { fetchX().then(setState) })` sets state after unmount and races when deps change fast. Look for an `AbortController` or an `ignore` flag.
- **Conditional hooks** or hooks inside loops/callbacks — a hard React violation.
- **Ref reads during render.** `ref.current` during render is not reactive and breaks under Strict Mode double-invocation.

## 2. Render cost and reference identity

- Object/array/function literals passed as props to a memoised child defeat the memo on every render.
- `useMemo`/`useCallback` whose dependencies change every render are pure overhead — flag the wasted indirection.
- Context values built inline (`value={{ a, b }}`) re-render every consumer on every provider render.
- State placed higher in the tree than it needs to be re-renders siblings that do not use it. Ask whether the state can move down or into a ref.
- Expensive work (sorting, filtering, formatting large lists) executed unconditionally in the render body.
- Long lists rendered without virtualisation, and list `key` values taken from array index while the list can reorder, insert or delete.

## 3. State and data flow

- Two sources of truth for the same fact (server state mirrored into local state) that can drift.
- Derived state stored instead of computed.
- Updates that read the previous value without the functional form (`setCount(count + 1)` inside async or batched paths).
- Direct mutation of state objects or arrays (`.push`, `.sort`, assignment) — `.sort()` and `.reverse()` mutate in place.
- Loading, empty, error and partial states: is each one actually rendered, or does the component assume success?

## 4. TypeScript soundness

- `any`, `as`, `!` and `@ts-ignore` introduced by this change: each is an assertion that the compiler could not verify. Ask what happens when it is wrong.
- Non-null assertion on a value that genuinely can be null at runtime (route params, query results, `find()` results, env vars).
- Unions widened to `string`, or a discriminated union handled without an exhaustive `switch` and `never` fallback — new variants will silently fall through.
- Optional properties treated as present, and `strictNullChecks` gaps.
- Types from API responses declared by hand rather than generated, then trusted without validation at the boundary.

## 5. Async and error handling

- Promises started and not awaited (floating promises), especially in event handlers.
- `Promise.all` where one rejection should not cancel the rest (`allSettled`).
- Errors swallowed by an empty `catch`, or a `catch` that logs and continues with undefined data.
- No error boundary above a component that can throw during render.
- Race conditions between rapid user input and in-flight requests: does the last response always win?

## 6. Accessibility and semantics

- `onClick` on a `div`/`span` without role, `tabIndex` and keyboard handling.
- Inputs without labels, icon-only buttons without accessible names.
- Focus not managed when a modal/drawer opens and closes.
- Colour used as the only signal for state or error.

## 7. Vite and bundle impact

- New dependencies: size, licence, and whether the repo already has something equivalent.
- `import.meta.env` values consumed on the client — anything not prefixed `VITE_` is undefined, and anything prefixed `VITE_` ships to the browser. A secret here is a leak.
- Barrel-file imports (`import { x } from '../components'`) that pull in the whole barrel.
- Dynamic import removed or added in a way that changes chunking, and `React.lazy` without a `Suspense` boundary.

## 8. Tests

- Can the new test fail? Look for assertions that hold regardless of the change.
- Is the new behaviour covered at its boundaries, not just the happy path?
- Tests asserting on implementation details (internal state, component names) rather than behaviour.
- `waitFor` wrapping a synchronous assertion, or `act` warnings suppressed rather than fixed.

## Writing the comments

Anchor each finding to a changed line. Lead with the consequence, then the evidence, then the suggested change. Distinguish:

- **blocker** — incorrect behaviour, data loss, security, or a broken contract for existing callers.
- **major** — will cause bugs or material performance loss under realistic use.
- **minor** — correctness-neutral quality issue.
- **suggestion** — optional improvement, explicitly droppable.

Do not comment on formatting a linter already owns.
