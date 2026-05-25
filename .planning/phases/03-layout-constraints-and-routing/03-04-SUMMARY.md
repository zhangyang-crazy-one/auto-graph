---
phase: 03-layout-constraints-and-routing
plan: 04
subsystem: solver
tags: [typescript, coordinated-ir, solver, deterministic-output]

requires:
  - phase: 03-layout-constraints-and-routing
    provides: Plans 03-01 through 03-03 layout, constraint, and routing modules.
provides:
  - Integrated solveDiagram coordinator for NormalizedDiagram to CoordinatedDiagram.
  - Coordinated nodes, edges, groups, bounds, and diagnostic propagation.
  - Deterministic canonical solver output coverage.
affects: [public-api, fixtures, exporters]

tech-stack:
  added: []
  patterns: [single-solver-entrypoint, partial-diagram-with-diagnostics, stable-input-sorting]

key-files:
  created:
    - src/solver/index.ts
    - src/solver/solve.ts
    - test/solver.test.ts
    - test/determinism.test.ts
  modified: []

key-decisions:
  - "solveDiagram() calls Dagre once, then applies DGE constraints, computes groups, routes edges, and builds coordinated IR."
  - "Constraint solving receives diagram.direction and options?.overlapSpacing ?? 40."
  - "Group containers are coordinated output, but are not used as obstacles for internal group edge routing."

patterns-established:
  - "Solver validates missing node, edge, and group references with solver.* diagnostics and omits unsafe routed/group output."
  - "Repeated solver output is verified with stringifyCanonical()."

requirements-completed: [LAY-01, LAY-02, LAY-03, LAY-04, RTE-01, RTE-02, RTE-03]

duration: 6min
completed: 2026-05-25
---

# Phase 03 Plan 04: Solver Integration Summary

**NormalizedDiagram to CoordinatedDiagram solving with nodes, groups, routed edges, bounds, diagnostics, and deterministic output**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-25T00:46:22Z
- **Completed:** 2026-05-25T00:51:48Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added `solveDiagram()` and solver barrel exports.
- Integrated Dagre initial boxes, constraint solving, shape geometry, container geometry, routing, bounds, and diagnostic propagation.
- Added tests for fixed-position preservation, default orthogonal routing, straight routing, malformed references, containment diagnostics, and deterministic canonical output.
- Verified 03-04 key links after implementation.

## Task Commits

Wave 2 was implemented and committed as a single sequential execution commit.

## Files Created/Modified

- `src/solver/index.ts` - Solver barrel export.
- `src/solver/solve.ts` - Integrated coordinated diagram solver.
- `test/solver.test.ts` - Integrated solver behavior coverage.
- `test/determinism.test.ts` - Repeated canonical output equality test.

## Decisions Made

- Group boxes are included in final output and bounds, but are not treated as routing obstacles for their own internal connectors.
- Missing edge/group references produce diagnostics and omit unsafe edges/groups while preserving safe coordinated nodes.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `exactOptionalPropertyTypes` required optional anchors to be omitted rather than passed as `undefined`.
- Biome formatting was required after creating solver files.

## Verification

- `rtk npm test -- solver determinism` - passed, 2 files / 5 tests.
- `rtk npm test -- layout constraints routing solver determinism` - passed, 5 files / 25 tests.
- `rtk npm run typecheck` - passed.
- `rtk npm run lint` - passed.
- `rtk gsd-sdk query verify.key-links .planning/phases/03-layout-constraints-and-routing/03-04-PLAN.md` - passed, 4/4 links verified.
- Renderer-neutral grep over `src/solver`, `test/solver.test.ts`, and `test/determinism.test.ts` - no matches.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The coordinated solver is ready for Plan 03-05 root exports, public API proof, canonical fixtures, and full verification.

---
*Phase: 03-layout-constraints-and-routing*
*Completed: 2026-05-25*
