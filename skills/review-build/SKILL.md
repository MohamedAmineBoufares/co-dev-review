---
name: review-build
description: Review rubric for build and dependency changes - vite.config, tsconfig, package.json, .csproj, Directory.Build.props and lockfiles. Use when an MR/PR touches those files, or when the co-dev-review server returns a rubric with skill "review-build".
---

# Reviewing build and dependency changes

Build changes are reviewed less carefully than application code and break more people at once. Treat every hunk here as load-bearing.

## Dependencies

- What does each added package do, how large is it, and does the repo already have something equivalent?
- Licence compatible with the product's distribution.
- Is it added to the right place — `dependencies` vs `devDependencies`, and the right project in a monorepo or solution?
- Version range: a caret on a pre-1.0 package accepts breaking changes.
- Lockfile updated in the same commit, and the diff consistent with the manifest change.
- A removed dependency: is every import of it gone?
- A major-version bump: were the release notes checked, and does the changed code reflect the migration?

## Vite

- `define`, `envPrefix` and `import.meta.env`: anything reaching client code ships to the browser. A secret here is a leak, not a config choice.
- `build.rollupOptions.manualChunks` and `build.target` changes — confirm the intended effect on chunking and browser support.
- Alias changes that shadow a real package name.
- `optimizeDeps` entries added to work around a problem that has a real fix.
- Proxy configuration used to paper over a CORS issue that production will still have.
- Plugin ordering, and plugins that run in the wrong mode (dev-only tooling reaching the production build).

## TypeScript configuration

- `strict` or any of its constituent flags being turned **off**, even for one project: this silently removes checks from existing code.
- `skipLibCheck`, `noImplicitAny`, `strictNullChecks` relaxations.
- `paths` and `references` changes in a monorepo — do all projects still resolve?
- `target`/`lib` lowered or raised without a matching runtime or polyfill decision.

## .NET project files

- `TargetFramework` changes, and whether every dependent project follows.
- `TreatWarningsAsErrors`, `Nullable`, `AnalysisMode` or analyzer packages being weakened.
- `NoWarn` entries added: which rule, and why is it acceptable here rather than fixed?
- Package versions floating, or diverging from `Directory.Packages.props` in a centrally-managed solution.
- `PublishTrimmed`/`AOT` settings against a codebase that uses reflection.

## CI and deployment

- Does the change alter what runs on every commit — steps skipped, caches keyed differently, a job made non-blocking?
- Build reproducibility: unpinned tool versions, `latest` image tags.
- Anything that makes a failing check pass without fixing the cause.

## Comments

Say what breaks and for whom: "this drops `strictNullChecks` for the whole `web` project, so existing null bugs stop being reported" beats "please reconsider". If the change is intentional and justified, ask for the justification in the MR description rather than blocking silently.
