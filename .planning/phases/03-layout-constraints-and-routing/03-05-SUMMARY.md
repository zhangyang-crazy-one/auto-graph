---
phase: 03-layout-constraints-and-routing
plan: 05
subsystem: public-api
tags: [typescript, public-api, canonical-fixtures, verification]

requires:
  - phase: 03-layout-constraints-and-routing
    provides: Plans 03-01 through 03-04 layout, constraints, routing, and solver APIs.
provides:
  - Root public exports for Phase 3 modules.
  - Public API proof for layout, constraints, routing, and solver imports.
  - Phase 3 canonical coordinated fixtures and full verification evidence.
affects: [public-api, exporters, fixtures, verification]

tech-stack:
  added: []
  patterns: [root-only-package-exports, canonical-coordinated-fixtures, full-verify-gate]

key-files:
  created:
    - test/fixtures/phase-03/dagre-directions.canonical.json
    - test/fixtures/phase-03/hybrid-layout.canonical.json
    - test/fixtures/phase-03/constraints.canonical.json
    - test/fixtures/phase-03/routing.canonical.json
  modified:
    - src/index.ts
    - test/public-api.test.ts
    - test/determinism.test.ts
    - biome.json
    - .planning/phases/03-layout-constraints-and-routing/03-05-PLAN.md

key-decisions:
  - "Expose Phase 3 modules from the root package entrypoint while keeping package.json exports root-only."
  - "Generate Phase 3 fixtures from stringifyCanonical(solveDiagram(input)), not hand-written JSON."
  - "Exclude Phase 3 canonical fixtures from Biome formatting to preserve byte-identical serializer output."

patterns-established:
  - "Phase fixtures live under test/fixtures/phase-03 and are compared directly against fresh solver output."
  - "Final phase gates include focused tests, typecheck, lint, renderer grep, key-links, and full npm verify."

requirements-completed: [LAY-01, LAY-02, LAY-03, LAY-04, RTE-01, RTE-02, RTE-03]

duration: 6min
completed: 2026-05-25
---

# Phase 03 Plan 05: Public API And Fixtures Summary

**Root Phase 3 exports with canonical coordinated fixtures and full renderer-neutral verification**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-25T00:51:48Z
- **Completed:** 2026-05-25T00:57:50Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Exported `layout`, `constraints`, `routing`, and `solver` modules from the package root.
- Extended public API tests to prove Phase 3 APIs are importable from `../src/index.js`.
- Added four canonical coordinated Phase 3 fixtures covering Dagre directions, hybrid layout, constraint diagnostics, and routing.
- Ran focused Phase 3 gates, renderer-neutral grep, key-link verification, and full `rtk npm run verify`.

## Task Commits

Wave 3 was implemented and committed as a single sequential execution commit.

## Files Created/Modified

- `src/index.ts` - Adds Phase 3 barrel exports.
- `test/public-api.test.ts` - Root import proof for `runDagreInitialLayout`, `applyLayoutConstraints`, `routeEdge`, `simplifyRoute`, and `solveDiagram`.
- `test/determinism.test.ts` - Reads Phase 3 fixtures and compares them to fresh canonical solver output.
- `test/fixtures/phase-03/*.canonical.json` - Committed canonical coordinated fixtures.
- `biome.json` - Excludes Phase 3 fixtures from formatting rewrites.
- `.planning/phases/03-layout-constraints-and-routing/03-05-PLAN.md` - Adjusts key-link `to` metadata so the verifier checks actual root export strings.

## Decisions Made

- Used `dist/index.js` after `rtk npm run build` to generate fixtures because source ESM imports use `.js` paths.
- Kept package exports root-only; no package subpaths were added.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] key-links verifier could not parse regex pattern fields**
- **Found during:** Task 3 (key-link validation)
- **Issue:** GSD key-link parser ignored `pattern` in this plan's nested YAML and fell back to checking whether `src/index.ts` contained `src/layout/index.ts`, which does not match real ESM root exports.
- **Fix:** Updated the plan metadata `to` values to `./layout/index.js` and `./solver/index.js`, matching the actual source import strings.
- **Files modified:** `.planning/phases/03-layout-constraints-and-routing/03-05-PLAN.md`
- **Verification:** `rtk gsd-sdk query verify.key-links .planning/phases/03-layout-constraints-and-routing/03-05-PLAN.md` passed 3/3.

---

**Total deviations:** 1 auto-fixed (Rule 3)
**Impact on plan:** Verification metadata repair only. No implementation scope changed and no acceptance criterion was weakened.

## Issues Encountered

- `rtk test -s ...` is not usable in this environment because `test` is parsed as shell invocation by the wrapper. Equivalent file existence checks were run with `rtk /usr/bin/test -s ...`.
- Direct Node execution against TypeScript source failed on `.js` ESM import paths; fixtures were generated from built `dist/index.js`.

## Verification

- `rtk npm test -- public-api solver` - passed.
- `rtk npm test -- determinism solver` - passed.
- `rtk /usr/bin/test -s test/fixtures/phase-03/*.canonical.json` - passed for all four fixture files.
- `rtk npm run typecheck` - passed.
- `rtk npm test -- layout constraints routing solver determinism` - passed, 5 files / 29 tests.
- `rtk npm run lint` - passed.
- Renderer-neutral grep over Phase 3 source and tests - no matches.
- `rtk npm run verify` - passed: typecheck, build, 12 test files / 76 tests, lint.
- `rtk gsd-sdk query verify.key-links .planning/phases/03-layout-constraints-and-routing/03-05-PLAN.md` - passed, 3/3 links verified.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 3 coordinated geometry APIs are public and fixture-locked. Phase 4 exporters can consume `solveDiagram()` output from the root package entrypoint.

---
*Phase: 03-layout-constraints-and-routing*
*Completed: 2026-05-25*
