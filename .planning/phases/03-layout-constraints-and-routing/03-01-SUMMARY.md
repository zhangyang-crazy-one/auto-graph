---
phase: 03-layout-constraints-and-routing
plan: 01
subsystem: layout
tags: [typescript, dagre, vitest, renderer-neutral]

requires:
  - phase: 02-text-labels-and-shape-geometry
    provides: Renderer-neutral Box, Size, DiagramDirection, and diagnostics contracts.
provides:
  - Dagre-backed initial placement for TB, LR, BT, and RL directions.
  - Immediate Dagre center-to-DGE top-left Box conversion.
  - Stable diagnostics for invalid node sizes and missing edge references.
affects: [layout, solver, constraints, routing]

tech-stack:
  added: ["@dagrejs/dagre@3.0.0"]
  patterns: [external-layout-wrapper, top-left-box-normalization, diagnostic-before-unsafe-geometry]

key-files:
  created:
    - src/layout/index.ts
    - src/layout/types.ts
    - src/layout/dagre.ts
    - test/layout.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Dagre is used only for initial placement; DGE converts output to owned top-left Box geometry immediately."
  - "Invalid node dimensions produce diagnostics and are omitted from layout output."

patterns-established:
  - "Phase 3 layout modules return maps and diagnostics instead of throwing for recoverable malformed layout input."
  - "Dagre graph objects do not escape the layout wrapper."

requirements-completed: [LAY-01]

duration: 26min
completed: 2026-05-25
---

# Phase 03 Plan 01: Dagre Initial Layout Summary

**Dagre-backed initial placement with deterministic DGE top-left boxes and invalid-size diagnostics**

## Performance

- **Duration:** 26 min
- **Started:** 2026-05-25T00:19:59Z
- **Completed:** 2026-05-25T00:46:22Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Installed `@dagrejs/dagre@3.0.0` as a runtime dependency.
- Added `runDagreInitialLayout()` with TB/LR/BT/RL direction support and deterministic Dagre defaults.
- Converted Dagre center coordinates into DGE-owned top-left `Box` values before returning geometry.
- Added invalid node-size and missing edge-reference diagnostics.

## Task Commits

Wave 1 was implemented and committed as a single sequential execution commit.

## Files Created/Modified

- `src/layout/types.ts` - Dagre wrapper input/result contracts.
- `src/layout/dagre.ts` - Dagre graph construction, layout execution, diagnostics, and box conversion.
- `src/layout/index.ts` - Layout barrel exports.
- `test/layout.test.ts` - Direction, conversion, and invalid-size coverage.
- `package.json` - Runtime Dagre dependency.
- `package-lock.json` - Locked Dagre and graphlib packages.

## Decisions Made

- Followed the planned Dagre dependency and kept it behind a local wrapper.
- Used diagnostics rather than exceptions for recoverable malformed layout input.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- TypeScript treats Dagre label coordinates as optional, so `runDagreInitialLayout()` now narrows `label.x` and `label.y` before building boxes.
- The center-to-top-left test uses Dagre's actual single-node margin behavior to prove the conversion.

## Verification

- `rtk node -e "const pkg=require('./package.json'); if (!pkg.dependencies['@dagrejs/dagre']) process.exit(1)"` - passed.
- `rtk rg -n '"@dagrejs/dagre"' package.json package-lock.json` - passed.
- `rtk npm test -- serialization` - passed.
- `rtk npm test -- layout` - passed, 1 file / 6 tests.
- Wave gate: `rtk npm run typecheck`, `rtk npm test -- layout constraints routing`, and `rtk npm run lint` - passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The initial placement layer is ready for solver integration in Plan 03-04.

---
*Phase: 03-layout-constraints-and-routing*
*Completed: 2026-05-25*
