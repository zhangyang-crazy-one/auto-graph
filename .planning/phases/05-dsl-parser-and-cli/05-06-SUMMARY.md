---
phase: 05-dsl-parser-and-cli
plan: 06
subsystem: public-api
tags: [dsl, cli, public-api, determinism, static-guards]
requires:
  - phase: 05-dsl-parser-and-cli
    provides: 05-05 DSL examples and fixture smoke tests
provides:
  - root package exports for selected DSL APIs
  - deterministic Phase 5 DSL render proof
  - static DSL/CLI guard against geometry recomputation
  - built package dge binary smoke test
  - README CLI usage notes
affects: [phase-06-verification, public-api, release-readiness]
tech-stack:
  added: []
  patterns: [root-only DSL API barrel, fixture-backed determinism, DSL/CLI no-recompute static guard, built binary smoke]
key-files:
  created: []
  modified:
    - src/index.ts
    - src/dsl/index.ts
    - test/public-api.test.ts
    - test/determinism.test.ts
    - test/exporters.test.ts
    - README.md
key-decisions:
  - "The package root exports selected DSL APIs while low-level Zod schema objects remain private."
  - "sortDslDiagnostics remains exported from the DSL barrel because existing diagnostic contract tests already consume it."
  - "DSL/CLI source may call pipeline APIs like solveDiagram/exportSvg/exportExcalidraw, but must not import or call layout, routing, or geometry internals directly."
patterns-established:
  - "Phase fixture determinism compares normalized diagrams, coordinated diagrams, and raw SVG content."
  - "Built binary smoke tests execute dist/cli/index.js against committed examples after build."
requirements-completed:
  - DSL-01
  - DSL-02
  - DSL-03
  - CLI-01
  - CLI-02
  - CLI-03
duration: 8 min
completed: 2026-05-25
---

# Phase 05 Plan 06: DSL Parser And CLI Summary

**Root-importable DSL APIs, built `dge` binary proof, static no-recompute guards, README CLI docs, and full verification**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-25T04:52:50Z
- **Completed:** 2026-05-25T05:00:42Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Published selected DSL APIs from the root entrypoint through `src/dsl/index.ts` and `src/index.ts`.
- Added public API tests that parse, normalize, render, resolve format defaults, and parse edge shorthand through root imports.
- Added Phase 5 architecture fixture determinism coverage for normalized output, coordinated output, and raw SVG bytes.
- Extended static no-recompute guards to `src/dsl` and `src/cli`, while preserving allowed pipeline calls and label fitting.
- Added a built `dist/cli/index.js` smoke test against `examples/architecture.yaml`.
- Documented CLI commands and format precedence in `README.md`.

## Task Commits

Each task was committed atomically:

1. **Task 1 and Task 2: Public DSL API and verification gates** - `7fb5cca`

## Files Created/Modified

- `src/index.ts` - Root barrel now exports `./dsl/index.js`.
- `src/dsl/index.ts` - Publishes selected stable DSL APIs and DSL types without exporting schema internals.
- `test/public-api.test.ts` - Proves root imports for Phase 5 DSL APIs.
- `test/determinism.test.ts` - Proves Phase 5 architecture DSL rendering is deterministic.
- `test/exporters.test.ts` - Extends static no-recompute gates and runs the built CLI binary against an example.
- `README.md` - Adds CLI build, file output, stdin/stdout, JSON diagnostics, and format precedence documentation.

## Decisions Made

- Kept low-level schema exports private to avoid making the current Zod schema a public compatibility contract.
- Kept `sortDslDiagnostics` public because existing diagnostic tests and downstream automation can reasonably depend on stable diagnostic ordering.
- Treated direct `rtk test -f dist/cli/index.js` as an environment-specific shell-wrapper issue; `rtk ls dist/cli/index.js` and the built binary smoke test prove the artifact exists and runs.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first public API test used `nodes.web: Web`, but the locked DSL schema requires node values to be objects. The test was corrected to `nodes.web.label: Web`.
- Initial DSL barrel narrowing removed `sortDslDiagnostics`; typecheck caught the existing diagnostic test dependency, so the stable diagnostic sorting helper remains exported.
- `rtk test -f dist/cli/index.js` invokes shell help in this environment; file existence and execution were verified with `rtk ls dist/cli/index.js` plus the built binary smoke test.

## Verification

- `rtk npm test -- public-api determinism exporters` passed: 3 files, 21 tests.
- `rtk npm run typecheck` passed.
- `rtk npm run build` passed and generated `dist/cli/index.js`.
- `rtk ls dist/cli/index.js` confirmed the built CLI file exists.
- `rtk rg -n 'runDagreInitialLayout|applyLayoutConstraints|routeEdge|computeShapeGeometry|computeContainerGeometry|from "../layout|from "../routing|from "../geometry' src/dsl src/cli` printed no output.
- `rtk npm run verify` passed: typecheck, build, 16 test files / 126 passing tests / 3 todo, and Biome lint.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 5 is complete. Phase 6 can now focus on milestone-level verification and release readiness using the full DSL/CLI surface, examples, exporters, and static architecture guards.

---
*Phase: 05-dsl-parser-and-cli*
*Completed: 2026-05-25*
