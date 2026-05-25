---
phase: 04-coordinated-exporters
plan: 04
subsystem: exporters
tags: [public-api, fixtures, svg, excalidraw, determinism]
requires:
  - phase: 04-02
    provides: standalone SVG exporter
  - phase: 04-03
    provides: Excalidraw exporter adapter
provides:
  - root package exporter API
  - shared coordinated exporter fixture
  - golden SVG and Excalidraw export checks
  - static gate against exporter geometry recomputation
affects: [phase-05-cli, phase-06-verification, public-api]
tech-stack:
  added: []
  patterns: [root exporter barrel, shared coordinated fixture goldens, exporter recomputation gate]
key-files:
  created:
    - test/fixtures/phase-04/coordinated-export.canonical.json
    - test/fixtures/phase-04/coordinated-export.svg
    - test/fixtures/phase-04/coordinated-export.excalidraw.json
  modified:
    - src/index.ts
    - test/public-api.test.ts
    - test/exporters.test.ts
    - test/determinism.test.ts
    - biome.json
key-decisions:
  - "Both exporters are public through the root package entrypoint without package subpath exports."
  - "One coordinated fixture is the source contract for both SVG and Excalidraw golden output."
  - "Exporter recomputation is blocked by an automated static test over src/exporters."
patterns-established:
  - "Exporter goldens are generated from coordinated IR, not from renderer-specific source fixtures."
  - "Excalidraw remains an attachment-style adapter while neutral SVG stays the default engineering export."
requirements-completed: [EXP-01, EXP-02, EXP-03]
duration: 14 min
completed: 2026-05-25
---

# Phase 04 Plan 04: Public Exporter API And Golden Fixture Summary

**Root-importable coordinated exporters locked by one shared fixture, exact goldens, and a no-recompute exporter gate**

## Performance

- **Duration:** 14 min
- **Started:** 2026-05-25T02:07:45Z
- **Completed:** 2026-05-25T02:21:22Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Published `exportSvg`, `exportExcalidraw`, and `computeArrowhead` through the root package entrypoint.
- Added a shared Phase 4 coordinated fixture with two labeled nodes, a group, and a routed edge.
- Locked SVG and Excalidraw output with committed golden files generated from the same coordinated fixture.
- Added an automated static gate that fails if exporter files call solver, layout, routing, label fitting, or geometry recomputation APIs.
- Ran full verification successfully.

## Task Commits

1. **Task 1: Publish exporter APIs and public import proof** - `f743496` (feat)
2. **Task 2: Add shared Phase 4 coordinated fixtures and golden checks** - `f743496` (feat)
3. **Task 3: Add exporter geometry-recompute and full verification gates** - `f743496` (feat)

## Files Created/Modified

- `src/index.ts` - Root barrel now exports `./exporters/index.js`.
- `test/public-api.test.ts` - Proves root imports for SVG, Excalidraw, and arrowhead APIs.
- `test/determinism.test.ts` - Compares Phase 4 SVG and Excalidraw output against committed goldens.
- `test/exporters.test.ts` - Adds the static no-recompute gate for exporter source files.
- `test/fixtures/phase-04/coordinated-export.canonical.json` - Shared coordinated source fixture.
- `test/fixtures/phase-04/coordinated-export.svg` - SVG golden output.
- `test/fixtures/phase-04/coordinated-export.excalidraw.json` - Canonical Excalidraw golden output.
- `biome.json` - Excludes Phase 4 fixtures from formatter-owned rewrites.

## Decisions Made

- Kept package exports root-only; exporter functions are reachable through `src/index.ts`.
- Treated Excalidraw as a recommended adapter/attachment export while keeping the neutral SVG engineering export independent.
- Made the recomputation rule executable by scanning exporter source files for forbidden solver, layout, routing, text, and geometry APIs.

## Deviations from Plan

None - plan executed exactly as written.

---

**Total deviations:** 0 auto-fixed.
**Impact on plan:** No scope change.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Verification

- `rtk npm test -- public-api exporters determinism` passed: 3 test files, 17 tests.
- `rtk npm run typecheck` passed.
- `rtk npm run lint` passed.
- `rtk npm run verify` passed: 13 test files, 83 tests.
- `rtk rg -n 'solveDiagram|runDagreInitialLayout|applyLayoutConstraints|routeEdge|fitLabel|TextMeasurer|computeShapeGeometry|computeContainerGeometry' src/exporters` printed no output.

## Next Phase Readiness

Ready for Phase 5. The CLI can now call the root package exporter APIs and write either neutral SVG or Excalidraw-compatible JSON from coordinated IR.

---
*Phase: 04-coordinated-exporters*
*Completed: 2026-05-25*
