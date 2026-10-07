---
name: review-complexity
description: Algorithmic cost and performance rubric - names the realistic size of n, derives the Big O of every changed loop, lookup, recursion, render path and network sequence, and flags only what matters at that size. Use on every MR/PR or local review that changes .ts, .tsx, .js, .jsx or .cs code, or when the co-dev-review server returns a rubric with skill "review-complexity".
---

# Reviewing algorithmic cost

Complexity without a size is trivia. O(n²) on a 12-item dropdown is fine; O(n²) on a 5,000-row grid that runs on every keystroke freezes the browser. Every finding here must name n, derive the cost, and say when it hurts.

## 1. Name n first

For each changed loop, transformation, selector or request sequence, write down:

- **What is n?** The thing that grows: rows, tree nodes, children per node, store entities, files, requests.
- **How big does it get in production?** Use the domain, not the test fixture. The repository's own skills (`repoSkills` in the read result) are the best source for which collections are large in this codebase. Typical large collections in business applications:
  - hierarchies (documents, quotes, bills of materials, org charts) with thousands of nodes and several levels, where expanding a composition multiplies one root into many leaves;
  - data grids with thousands of rows, where handlers can run per row, per cell or per keystroke;
  - store slices (Redux, Zustand, a cache) holding whole trees or entity lists, which every selector call scans;
  - imports, exports and batch jobs over whole tables.
- **How often does it run?** Once on load, per user action, per render, per keystroke, per row, per scroll frame.

The real cost is **complexity × frequency**. O(n) per render × renders per keystroke is often worse than one O(n log n) on load.

## 2. Derive the cost, don't guess it

Write the derivation in the finding: "`items.map` (n) × `others.find` (m) = O(n·m); n ≈ 3,000 lines, m ≈ 3,000 components → 9M comparisons per recompute, recomputed on every grid edit."

Patterns that hide quadratic or worse behaviour:

| Pattern | Cost | Usual fix |
| --- | --- | --- |
| `.find` / `.filter` / `.some` / `.includes` / `.indexOf` inside `.map`, `.forEach`, `.reduce` or a `for` loop | O(n·m) | Build a `Map`/`Set` index once, O(n + m) |
| `reduce((acc, x) => [...acc, x])` or `({ ...acc, [k]: v })` | O(n²) copies | Mutate a local accumulator, or `Object.fromEntries` |
| `arr.splice`, `arr.shift`, `arr.unshift` in a loop | O(n²) | Build a new array, or iterate with an index |
| `sort` inside a loop or inside a frequently called function | O(k · n log n) | Sort once, or keep the collection sorted |
| String `+=` building in a long loop | Often O(n²) | Collect into an array, `join` once |
| Recursion over a tree that recomputes subtrees (sum of children computed again at every ancestor) | O(n · depth) or O(n²) | One post-order pass, or memoise by node id |
| Walking a hierarchy from every node up to the root | O(n · depth) | Precompute parent maps or depths once |
| `JSON.parse(JSON.stringify(x))` or deep clone per item or per render | O(size) each time | Clone once, or don't clone (structural sharing) |
| `Object.keys(obj).length` or `Object.values(obj)` inside a loop | O(n) per iteration | Hoist |
| Regex with nested quantifiers (`(a+)+`, `(.*)*`) on user input | Exponential backtracking | Rewrite without nested quantifiers |

Also check memory: building an O(n²) intermediate structure, retaining large closures in listeners that are never removed, or copying a whole tree to change one node.

## 3. React and front-end multipliers

- **Work in the render body** (filter, sort, group, format over a big list) runs on every render of that component, including renders caused by unrelated state. Memoise with correct dependencies, or move it out.
- **Selectors** that return a new array or object each call (`state.items.filter(...)`) recompute the whole scan and re-render every subscriber on every store update. Use a memoised selector keyed on its real inputs.
- **Per-row work in grids:** a function or object created per row per render, a `calculateCellValue` or `cellRender` that does a lookup over the full dataset (O(rows × dataset)), or a `customizeText` that formats with a heavy routine. Precompute a lookup keyed by row id.
- **Context and props churn:** an inline object or callback passed to a provider or a memoised child cancels the memo; the cost is the subtree size × the update frequency.
- **Lists:** thousands of DOM nodes without virtualization or paging; index keys forcing full re-renders on insert.
- **Events:** scroll, resize, input and mousemove handlers doing O(n) work without throttling or debouncing.

## 4. Network and I/O

- `await` inside a `for` loop: n sequential round-trips. If the calls are independent, `Promise.all` turns n × latency into ~1 × latency. With unbounded n, cap the concurrency.
- N+1: fetching a list, then one request per item. Ask whether the API has (or should have) a batch endpoint.
- Refetching data that is already in the store or was fetched a moment ago.
- On the .NET side: queries in loops, missing `Include` causing lazy loads per row, loading whole tables to filter in memory, `ToList()` before `Where`.

## 5. Severity calibration

- **blocker:** the realistic n makes a user-visible freeze, timeout or crash likely, for example quadratic work per keystroke over thousands of rows, or exponential regex on user input.
- **major:** a measurable slowdown under normal production sizes, or a cost that grows with data the team expects to grow.
- **minor:** asymptotically worse than necessary, but n is bounded and small, or it runs rarely.
- **suggestion:** micro-optimisations with no measurable effect. Prefer to say nothing.

Never flag a theoretical complexity without the realistic n. Never propose an optimisation that makes the code harder to read for a collection that stays small.

## 6. Report

For each finding: what n is and its realistic size, how often the code runs, the derivation and the current Big O, the fix, and the Big O after the fix. Say explicitly which changed loops and data paths you checked and found fine.
