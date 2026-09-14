// Route changed paths to the domain rubrics a reviewer should load before judging code.
// The server only names the expertise; the host LLM supplies it from the matching skill.
const RUBRICS = [
  { id: 'react-ts', skill: 'review-react-ts', match: /\.(tsx|jsx)$/i, focus: 'render cost, hook dependencies and cleanup, state ownership, list keys, controlled inputs, suspense/error boundaries, accessibility of interactive elements' },
  { id: 'typescript', skill: 'review-react-ts', match: /\.(ts|mts|cts|js|mjs|cjs)$/i, focus: 'type soundness over assertions, discriminated unions, nullability, async cancellation and error propagation, exhaustiveness' },
  { id: 'dotnet', skill: 'review-dotnet', match: /\.(cs|razor|cshtml)$/i, focus: 'async/await correctness, disposal and lifetimes, nullable reference types, EF Core query shape and tracking, model validation, exception handling' },
  { id: 'dotnet-api', skill: 'review-dotnet', match: /(Controller|Endpoint|Handler|Service|Repository)s?\.cs$|\/Controllers\//i, focus: 'authorization on every route, input validation, DTO boundaries, status codes, idempotency, N+1 queries' },
  { id: 'data', skill: 'review-dotnet', match: /\.sql$|(^|\/)Migrations\//i, focus: 'migration reversibility, locking and downtime, index coverage, nullable/default columns on existing rows' },
  { id: 'build', skill: 'review-build', match: /vite\.config\.|tsconfig.*\.json$|\.csproj$|Directory\.(Build|Packages)\.props$|package\.json$/i, focus: 'bundle and chunking impact, dependency additions and licences, env var exposure to the client bundle, target framework and analyzer settings' },
  { id: 'pipeline', skill: 'review-security', match: /\.(ya?ml)$|Dockerfile|\.github\/|\.gitlab-ci/i, focus: 'secret exposure, permission scope, pinned versions, artefact provenance' },
  { id: 'tests', skill: null, match: /\.(test|spec)\.[jt]sx?$|Tests?\.cs$|(^|\/)__tests__\//i, focus: 'whether the assertions can actually fail, and whether the new behaviour is covered at its boundaries' },
];
const SECURITY = /auth|login|token|password|secret|crypt|cors|session|permission|role|claim|sanitiz|upload|payment/i;

export function suggestRubrics(paths = []) {
  const clean = paths.filter(Boolean);
  const rubrics = [];
  for (const { id, skill, match, focus } of RUBRICS) {
    const files = clean.filter(p => match.test(p));
    if (files.length) rubrics.push({ id, skill, focus, fileCount: files.length, examples: files.slice(0, 5) });
  }
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
