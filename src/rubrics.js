// Route changed paths to the domain rubrics a reviewer should load before judging code.
// The server only names the expertise; the host LLM supplies it from the matching skill.
const CODE = /\.(m|c)?[jt]sx?$|\.(cs|razor|cshtml)$/i;
const TEST = /\.(test|spec)\.[jt]sx?$|Tests?\.cs$|(^|\/)__tests__\//i;
const RUBRICS = [
  // Stack-independent passes a senior reviewer makes on every change; the stack rubrics below add the specifics.
  { id: 'correctness', skill: 'review-correctness', match: CODE, focus: 'intent of each changed function, concrete edge-case inputs traced through the code, guarantees lost in removed lines, contracts with callers outside the diff, JS/TS silent-wrong-result semantics, interleavings, error paths' },
  { id: 'complexity', skill: 'review-complexity', match: CODE, focus: 'realistic size of n and how often the code runs, derived Big O of changed loops, lookups, recursions, selectors and render paths, sequential or N+1 requests' },
  { id: 'design', skill: 'review-design', match: CODE, focus: 'whether the approach and layer are right, duplicates of existing helpers or patterns, smells that cause bugs (two sources of truth, boolean forks, lying names), calibrated so taste never outranks correctness' },
  { id: 'react-ts', skill: 'review-react-ts', match: /\.(tsx|jsx)$/i, focus: 'render cost, hook dependencies and cleanup, state ownership, list keys, controlled inputs, suspense/error boundaries, accessibility of interactive elements' },
  { id: 'typescript', skill: 'review-react-ts', match: /\.(ts|mts|cts|js|mjs|cjs)$/i, focus: 'type soundness over assertions, discriminated unions, nullability, async cancellation and error propagation, exhaustiveness' },
  { id: 'dotnet', skill: 'review-dotnet', match: /\.(cs|razor|cshtml)$/i, focus: 'async/await correctness, disposal and lifetimes, nullable reference types, EF Core query shape and tracking, model validation, exception handling' },
  { id: 'dotnet-api', skill: 'review-dotnet', match: /(Controller|Endpoint|Handler|Service|Repository)s?\.cs$|\/Controllers\//i, focus: 'authorization on every route, input validation, DTO boundaries, status codes, idempotency, N+1 queries' },
  { id: 'data', skill: 'review-dotnet', match: /\.sql$|(^|\/)Migrations\//i, focus: 'migration reversibility, locking and downtime, index coverage, nullable/default columns on existing rows' },
  { id: 'build', skill: 'review-build', match: /vite\.config\.|tsconfig.*\.json$|\.csproj$|Directory\.(Build|Packages)\.props$|package\.json$/i, focus: 'bundle and chunking impact, dependency additions and licences, env var exposure to the client bundle, target framework and analyzer settings' },
  { id: 'pipeline', skill: 'review-security', match: /\.(ya?ml)$|Dockerfile|\.github\/|\.gitlab-ci/i, focus: 'secret exposure, permission scope, pinned versions, artefact provenance' },
  { id: 'tests', skill: 'review-tests', match: TEST, focus: 'whether the assertions can actually fail, whether the new behaviour is covered at its boundaries, behaviour over implementation' },
];
const SECURITY = /auth|login|token|password|secret|crypt|cors|session|permission|role|claim|sanitiz|upload|payment/i;

export function suggestRubrics(paths = []) {
  const clean = paths.filter(Boolean);
  const rubrics = [];
  for (const { id, skill, match, focus } of RUBRICS) {
    const files = clean.filter(p => match.test(p));
    if (files.length) rubrics.push({ id, skill, focus, fileCount: files.length, examples: files.slice(0, 5) });
  }
  // Changed behaviour with no test changed is something to look for, not wait to be shown.
  const untested = clean.filter(p => CODE.test(p) && !TEST.test(p));
  if (untested.length && !clean.some(p => TEST.test(p))) rubrics.push({ id: 'tests-missing', skill: 'review-tests', focus: 'no test file changed: list each behaviour this change alters and the test that would catch its regression, or report it as unprotected', fileCount: untested.length, examples: untested.slice(0, 5) });
  const sensitive = clean.filter(p => SECURITY.test(p));
  if (sensitive.length) rubrics.push({ id: 'security', skill: 'review-security', focus: 'authentication and authorization boundaries, injection, secret handling, unsafe deserialization, missing server-side checks behind client-side ones', fileCount: sensitive.length, examples: sensitive.slice(0, 5) });
  const covered = new Set(rubrics.flatMap(r => clean.filter(p => RUBRICS.find(x => x.id === r.id)?.match.test(p))));
  return {
    rubrics,
    unmatched: clean.filter(p => !covered.has(p)).slice(0, 20),
    note: rubrics.length
      ? 'Load the named skills before forming findings, and review each listed focus explicitly. Unmatched files still need review; they simply have no packaged rubric.'
      : 'No packaged rubric matched these paths. Review from first principles and say so in the summary.',
  };
}
