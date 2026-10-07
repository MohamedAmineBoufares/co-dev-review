---
name: review-tests
description: Test-quality rubric - checks whether the new and changed tests can actually fail, cover the behaviour the change introduces at its boundaries, and test behaviour rather than implementation, and whether a changed behaviour shipped with no test at all. Use when an MR/PR or local review touches test files, or changes behaviour without touching any, or when the co-dev-review server returns a rubric with skill "review-tests".
---

# Reviewing tests

A test suite is only worth what it would catch. Review tests by asking which bug each one would catch, and which bug in this change none of them would.

## 1. Changed behaviour without a test

List the behaviours the change introduces or alters (from the correctness pass). For each one, find the test that would fail if it broke. A changed behaviour with no such test is a finding. Its severity follows the risk of the behaviour, not the size of the gap.

## 2. Can each test fail?

- Assertions that hold whatever the code does: `expect(result).toBeDefined()` on something that is always defined, snapshot of an empty render, asserting on the mock's return value instead of the code's output.
- Mocks that replace the unit under test, or mock so much that only the wiring is tested.
- `async` tests that don't `await` the assertion, or a `waitFor` that resolves immediately.
- Tests that pass because of shared state from a previous test, or fail only in isolation.
- Mentally break the code (invert a condition, drop a line the diff added): would this test go red? If not, it is not testing that line.

## 3. Boundaries, not just the happy path

The inputs from the correctness rubric belong in tests: empty, one, many, duplicates, null/missing fields, limits of every comparison, the error response, the concurrent case. One happy-path test for a function with five branches covers one branch.

## 4. Behaviour over implementation

- Assert on what the user or caller observes: rendered text, emitted calls, returned values, store state after an action.
- Avoid asserting on internal state, private function calls, component internals or exact call counts of incidental helpers. These tests break on every refactor and catch nothing.
- Testing Library: query by role or label as a user would; `getBy*` for presence, `queryBy*` for absence.

## 5. Hygiene

- Fake timers restored, mocks and spies reset, globals and modules un-stubbed after each test.
- No real network, clock or random dependence without control.
- Test names that state the behaviour and the condition (`returns 0 when the order has no lines`), so a failure explains itself.
- Fixtures shaped like production data (real hierarchy depth, real field names), not the minimal object that happens to pass.

## 6. Report

For each finding: the behaviour that is unprotected or the test that cannot fail, the concrete bug that would slip through, and the test case to add (inputs and expected result). If tests are absent for a risky change, say what minimal test would have caught the most likely regression.
