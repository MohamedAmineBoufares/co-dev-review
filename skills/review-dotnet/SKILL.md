---
name: review-dotnet
description: Review rubric for C# and .NET code under review, including ASP.NET Core APIs, EF Core and SQL migrations. Use when reviewing an MR/PR or local changes that touch .cs, .razor, .cshtml, .sql or Migrations files, or when the co-dev-review server returns a rubric with skill "review-dotnet". Covers async correctness, disposal, nullability, query shape, validation and migration safety.
---

# Reviewing .NET changes

Work through every section against the changed hunks, and say which sections found nothing. For each candidate finding, name the **trigger** — the request, data shape or concurrency pattern that produces the failure — before writing the comment.

## 1. Async correctness

- `async void` anywhere but an event handler: the exception cannot be caught and crashes the process.
- `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` on an async call — deadlock risk and thread-pool starvation.
- A method declared `async` that never awaits, or an awaitable returned without `await` inside a `using` block (the resource disposes before the task completes).
- `CancellationToken` accepted but not passed down, or not accepted at all on a long-running request path.
- `Task.Run` wrapping already-async I/O.
- Parallel `await`s over a shared `DbContext` — it is not thread-safe.
- `ConfigureAwait` usage inconsistent with the surrounding project's convention.

## 2. Lifetime, disposal and DI

- `IDisposable`/`IAsyncDisposable` created and not disposed; `HttpClient` constructed per call instead of `IHttpClientFactory`.
- Captive dependencies: a scoped or transient service injected into a singleton.
- `DbContext` captured in a field of a longer-lived object, or used after the scope ends.
- Static mutable state introduced into a request-handling path.

## 3. Nullability and defensive shape

- Nullable reference type warnings suppressed with `!` or `#pragma`: what makes null impossible there?
- `FirstOrDefault`/`SingleOrDefault`/`Find` results dereferenced without a null check.
- `First`/`Single` used where the collection can legitimately be empty (throws instead of returning a status).
- Value converted with `Parse` rather than `TryParse` on data from outside the process.
- Struct default values (`0`, `DateTime.MinValue`, `Guid.Empty`) silently standing in for "missing".

## 4. EF Core and data access

- **N+1**: a navigation property accessed inside a loop without `Include`/projection.
- Missing `AsNoTracking` on read-only queries, or `AsNoTracking` on a query whose results are then modified.
- Client-side evaluation: `.ToList()` before `.Where()`, or a predicate calling a C# method EF cannot translate.
- Unbounded queries — no paging, no `Take`, on a table that grows.
- `SaveChanges` called inside a loop instead of once, or multiple writes that need one transaction and do not have one.
- Raw SQL built by string interpolation rather than parameters.
- Concurrency: read-modify-write without a rowversion/optimistic concurrency check.

## 5. API surface (controllers, endpoints, handlers)

- **Authorization on every new route.** An added endpoint without `[Authorize]` (or an explicit, justified `[AllowAnonymous]`) is a blocker.
- Object-level authorization: the caller is authenticated, but may they act on *this* record? Check the id comes from the token, not the request body.
- Model validation actually enforced, and validation attributes present on new DTO fields.
- Entities returned directly instead of DTOs, exposing fields the client should not see.
- Status codes: created resources return 201, not-found returns 404 rather than 200 with null, validation failures return 400.
- Idempotency for retryable operations, and whether a duplicate POST creates duplicate rows.
- Exception detail leaking to the client in error responses.

## 6. Migrations and SQL

- Is the migration reversible, and is `Down` correct rather than empty?
- Adding a non-nullable column to a populated table without a default backfills nothing and fails.
- Index added or removed: does the new query shape still have index coverage?
- Locking and duration on large tables — will this block writes during deployment?
- Data migration and code deployment ordering: does the new code run against the old schema, or the old code against the new schema, during rollout?

## 7. Errors, logging and configuration

- `catch (Exception)` that swallows, or that logs and returns success.
- `throw ex;` resetting the stack trace instead of `throw;`.
- Secrets, tokens, personal data or full request bodies written to logs.
- Configuration read with a hard-coded fallback that silently works in production.

## 8. Tests

- Can the new test fail? Assertions that hold regardless of the change are noise.
- Boundaries covered: null, empty, duplicate, concurrent, and the unauthorised caller.
- Tests depending on execution order, wall-clock time, or a shared database left dirty.

## Writing the comments

Anchor each finding to a changed line. Lead with the consequence, then the evidence, then the suggested change. Distinguish:

- **blocker** — incorrect behaviour, data loss, missing authorization, or a broken contract for existing callers.
- **major** — will cause bugs or material performance loss under realistic load.
- **minor** — correctness-neutral quality issue.
- **suggestion** — optional improvement, explicitly droppable.

Do not comment on formatting or on anything the analyzers already reported in `step=checks`.
