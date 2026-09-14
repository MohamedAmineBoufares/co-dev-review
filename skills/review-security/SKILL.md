---
name: review-security
description: Security review rubric for changes touching authentication, authorization, tokens, secrets, uploads, CORS, sessions, roles, sanitisation, payments or CI/CD pipeline files. Use when reviewing an MR/PR whose changed paths match those concerns, or when the co-dev-review server returns a rubric with skill "review-security".
---

# Security review

Apply this in addition to the language rubric, not instead of it. Security findings are blockers by default; downgrade one only with a stated reason.

## 1. Authorization is the first question

For every added or modified route, handler, query or mutation:

- Is authentication required, and is authorization checked?
- Is the check **object-level**? Authenticated is not authorised — verify the caller may act on this specific record. The owning id must come from the verified token or session, never from the request body or a query parameter.
- Are role and permission checks server-side? A hidden button is not an access control.
- Does a new query filter by tenant/organisation where the surrounding code does?

## 2. Input crossing a trust boundary

- Every value from a request, file, message queue or third-party API is untrusted, including ids, sort fields and page sizes.
- SQL built by concatenation or interpolation; ORM raw-SQL escape hatches.
- Path handling: user input reaching `Path.Combine`, `fs` calls or a static file route without traversal checks.
- Command execution with interpolated arguments.
- Deserialisation of untrusted payloads into polymorphic types.
- Redirect targets, webhook URLs and image sources taken from input (open redirect, SSRF).

## 3. Output and rendering

- `dangerouslySetInnerHTML`, `v-html`, `Html.Raw`, or any markup built from user data.
- User data placed into a URL, `href`, inline `<script>`, or a template that renders without escaping.
- Error responses that echo stack traces, SQL, or internal paths.

## 4. Secrets and tokens

- Credentials, API keys or connection strings in source, config committed to the repo, test fixtures, or log output.
- Client-bundled environment variables (`VITE_*` and anything referenced in browser code) holding anything that is not public.
- Tokens stored in `localStorage`/`sessionStorage` where an `httpOnly` cookie is available.
- Token lifetime, refresh and revocation on logout; session fixation on privilege change.

## 5. Configuration and transport

- CORS: a wildcard origin, or a reflected `Origin`, combined with credentials.
- Cookies missing `HttpOnly`, `Secure` or `SameSite`.
- CSRF protection on state-changing requests that rely on cookies.
- Certificate validation disabled, or HTTP used for an internal call.
- Rate limiting on authentication, password reset and expensive endpoints.

## 6. Files and uploads

- Type and size validated server-side; extension not trusted.
- Stored outside the web root, served with a safe content type and `Content-Disposition`.
- Filenames normalised; archive extraction bounded.

## 7. Pipeline and dependency changes

- Workflow permissions widened, secrets exposed to a job that runs untrusted code, or a pull-request trigger that grants write access.
- Actions and images pinned to a digest or exact version rather than a moving tag.
- New dependency: maintained, popular enough to be scrutinised, licence acceptable, and not a typo of a well-known package.

## 8. What to do with a finding

State the attacker, the input they control, and the outcome. "A user could pass another organisation's id in `customerId` and read their invoices" is actionable. "Potential IDOR" is not.

If the change is safe only because of something outside the diff — a gateway rule, a middleware, a policy applied globally — say so and ask the author to confirm, rather than assuming either way. If you could not verify a control, report it as unverified rather than as absent.
