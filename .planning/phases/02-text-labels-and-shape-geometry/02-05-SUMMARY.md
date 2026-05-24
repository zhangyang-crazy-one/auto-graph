---
phase: 02-text-labels-and-shape-geometry
plan: 05
subsystem: public-api
tags: [typescript, vitest, canonical-fixtures, public-api]

requires:
  - phase: 02-text-labels-and-shape-geometry
    provides: Plans 02-01 through 02-04 text, label, geometry, and container modules.
provides:
  - Root public exports for Phase 2 modules.
  - Canonical numeric fixtures for labels, shapes, and containers.
  - Final renderer-neutral and full verification gate evidence.
affects: [public-api, fixtures, verification, future-layout]

tech-stack:
  added: []
  patterns: [root-only package exports, canonical numeric fixture tests, renderer-creep grep gate]

key-files:
  created:
    - test/fixtures/phase-02/labels.canonical.json
    - test/fixtures/phase-02/shapes.canonical.json
    - test/fixtures/phase-02/containers.canonical.json
  modified:
    - src/index.ts
    - test/public-api.test.ts
    - test/label-fitting.test.ts
    - test/shape-geometry.test.ts
    - test/container-geometry.test.ts
    - biome.json

key-decisions:
  - "Expose text, labels, and geometry through the package root, while keeping package.json exports root-only."
  - "Lock Phase 2 behavior with numeric canonical fixtures, not renderer snapshots."
  - "Exclude canonical fixture JSON from Biome formatting so it stays byte-identical to stringifyCanonical output."

patterns-established:
  - "Phase fixtures live under test/fixtures/phase-02 and are compared directly against stringifyCanonical()."
  - "Final phase gates include focused tests, typecheck, renderer grep, and full npm verify."

requirements-completed: [TXT-01, TXT-02, TXT-03, GEO-01, GEO-02, GEO-03]

duration: 24min
completed: 2026-05-24
---

# Phase 02 Plan 05: Public API And Fixtures Summary

**Root public exports for Phase 2 with canonical numeric fixtures and full renderer-neutral verification**

## Performance

- **Duration:** 24 min
- **Started:** 2026-05-24T14:45:00Z
- **Completed:** 2026-05-24T15:09:14Z
- **Tasks:** 3
- **Files modified:** 13

## Accomplishments

- Exposed `geometry`, `labels`, and `text` barrels through `src/index.ts`.
- Extended public API tests to construct text, label, shape, and container geometry from root imports.
- Added committed canonical JSON fixtures for label, shape, and container outputs and locked them in tests.
- Ran and passed focused Phase 2 tests, typecheck, renderer grep, and full `rtk npm run verify`.

## Task Commits

1. **Task 1: Extend public API import proof for Phase 2** - `3070031` (feat)
2. **Task 2: Add canonical numeric fixtures for Phase 2** - `80f2cd7` (test)
3. **Task 3: Run renderer-neutral and full verification gates** - `c49b2d6` (test)

## Files Created/Modified

- `src/index.ts` - Root public exports for `geometry`, `ir`, `labels`, `serialization`, and `text`.
- `test/public-api.test.ts` - Root import proof for representative Phase 2 APIs and root-only package export assertion.
- `test/fixtures/phase-02/labels.canonical.json` - Stable label layout fixture.
- `test/fixtures/phase-02/shapes.canonical.json` - Stable seven-shape geometry fixture.
- `test/fixtures/phase-02/containers.canonical.json` - Stable container geometry fixture.
- `biome.json` - Excludes generated canonical fixture JSON from formatter rewrites.
- Phase 2 tests and modules - Biome formatting cleanup plus lint-safe fixture comparison changes.

## Decisions Made

- Root package exports remain `"."` only; no subpath exports were added for Phase 2 modules.
- Fixture JSON is committed as `stringifyCanonical()` output and excluded from Biome formatting to preserve exact bytes.
- The public `LabelFitter.fit()` method remains, while internal/test call sites avoid Biome's false positive focused-test heuristic.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Biome rewrote canonical fixture formatting**
- **Found during:** Task 3 full verify
- **Issue:** `biome check --write` changed canonical JSON indentation, causing byte comparisons against `stringifyCanonical()` to fail.
- **Fix:** Excluded `test/fixtures/phase-02` from Biome file includes and regenerated fixtures from the built package entrypoint.
- **Files modified:** `biome.json`, `test/fixtures/phase-02/*.canonical.json`
- **Verification:** Focused tests and full verify passed.
- **Committed in:** `c49b2d6`

**2. [Rule 3 - Blocking] Biome false-positive noFocusedTests on `.fit()`**
- **Found during:** Task 3 full verify
- **Issue:** Biome interpreted `LabelFitter.fit()` call sites as focused tests.
- **Fix:** Routed `fitLabel()` through an internal helper and used bracket method invocation in the one test exercising `LabelFitter`.
- **Files modified:** `src/labels/fit.ts`, `test/label-fitting.test.ts`
- **Verification:** `rtk npm run lint` and full verify passed.
- **Committed in:** `c49b2d6`

---

**Total deviations:** 2 auto-fixed (Rule 3)
**Impact on plan:** Verification-only fixes. No API scope expansion and no renderer/exporter behavior added.

## Issues Encountered

- Direct Node execution against `src/index.ts` failed because ESM imports use `.js` paths. Fixture generation was done from `dist/index.js` after `rtk npm run build`, matching the package output path.

## Verification

- `rtk npm test -- text-measurer label-fitting box-geometry shape-geometry container-geometry public-api serialization` - passed, 7 files / 46 tests.
- `rtk npm run typecheck` - passed.
- `rtk rg -n -i "svg|html|css|excalidraw|draw\\.io|drawio|mermaid|<svg|<tspan|<text|path d=" src/text src/labels src/geometry test/text-measurer.test.ts test/label-fitting.test.ts test/box-geometry.test.ts test/shape-geometry.test.ts test/container-geometry.test.ts test/fixtures/phase-02` - no matches.
- `rtk npm run verify` - passed: typecheck, build, tests, lint.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 2 APIs and fixtures are ready for Phase 3 layout/constraint work. Text, labels, shapes, boxes, and known-child containers are public through the root entrypoint.

---
*Phase: 02-text-labels-and-shape-geometry*
*Completed: 2026-05-24*
