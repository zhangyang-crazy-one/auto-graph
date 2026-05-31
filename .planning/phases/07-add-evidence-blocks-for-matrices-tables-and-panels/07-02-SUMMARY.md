---
phase: 07-add-evidence-blocks-for-matrices-tables-and-panels
plan: 02
subsystem: solver-routing
tags: [typescript, solver, routing, evidence-blocks, matrices, tables]

requires:
  - phase: 07-add-evidence-blocks-for-matrices-tables-and-panels
    provides: 07-01 evidence block DSL, IR, canonical handling, and fixture skeletons
provides:
  - Coordinated matrix, table, and evidence panel boxes in solver output
  - Table column offset geometry stable across row and cell text mutations
  - Evidence block routing obstacles with hard matrix exclusion diagnostics
affects: [phase-07, solver, routing, exporters]

tech-stack:
  added: []
  patterns:
    - Solver-side evidence block box coordination from explicit position and size
    - Table column offsets derived from column definitions and solved table box width
    - Routing hard obstacles layered over existing soft obstacle fallback behavior

key-files:
  created:
    - .planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/07-02-SUMMARY.md
  modified:
    - src/solver/solve.ts
    - src/routing/routes.ts
    - test/solver.test.ts
    - test/routing.test.ts

key-decisions:
  - "Matrices are passed to routing as hard obstacles; if no bounded orthogonal candidate avoids them, the route is omitted and `routing.evidence.crossing_forbidden` is emitted."
  - "Tables and evidence panels are passed as soft obstacles so existing fallback routing behavior remains available when soft avoidance is impossible."
  - "Table `columnXOffsets` are derived only from table columns and solved table box width, not from row count or cell text."

patterns-established:
  - "Evidence block solver output mirrors normalized blocks and adds solved `box` geometry."
  - "Routing can consume optional hard obstacles without changing the public typed route contract in this plan."

requirements-completed: [V2-INT-01]

duration: 21min
completed: 2026-05-31
---

# Phase 07 Plan 02: Evidence Block Solver And Routing Summary

**Matrices, tables, and evidence panels now become physical solved regions, with stable table column offsets and matrix hard-exclusion routing diagnostics.**

## Performance

- **Duration:** 21 min
- **Started:** 2026-05-31T14:06:32Z
- **Completed:** 2026-05-31T14:27:31Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added solver coordination for `matrices`, `tables`, and `evidencePanels` with explicit `box` geometry included in diagram bounds.
- Added table `columnXOffsets` and tests proving offsets remain byte-identical when row count and cell text change.
- Added evidence block routing obstacles: matrices are hard-exclusion zones, while tables and panels remain soft obstacles that are avoided when a route exists.
- Added routing tests for soft evidence obstacle avoidance and `routing.evidence.crossing_forbidden` with no crossing route.

## Task Commits

1. **Task 1: Add coordinated geometry for evidence blocks** - `8492f73` (feat)
2. **Task 2: Treat evidence blocks as routing obstacles with hard matrix exclusion** - `c6b7d73` (feat)

## Files Created/Modified

- `src/solver/solve.ts` - Coordinates evidence block boxes, includes them in bounds, passes table/panel soft obstacles and matrix hard obstacles into routing.
- `src/routing/routes.ts` - Adds internal hard-obstacle handling and emits `routing.evidence.crossing_forbidden` with an empty route when hard evidence cannot be avoided.
- `test/solver.test.ts` - Covers coordinated evidence block boxes, bounds contribution, and stable table `columnXOffsets`.
- `test/routing.test.ts` - Covers soft table/panel obstacle avoidance and hard matrix crossing rejection.
- `.planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/07-02-SUMMARY.md` - Execution summary and verification record.

## Verification

- `rtk npm test -- test/solver.test.ts` - PASS, 1 file / 28 tests.
- `rtk npm test -- test/routing.test.ts` - PASS, 1 file / 11 tests.
- `rtk npm test -- test/solver.test.ts test/routing.test.ts` - PASS, 2 files / 39 tests.
- `rtk rg -n "evidencePanels|matrices|tables" src/solver src/routing test` - PASS, solver/routing/tests evidence found.
- `rtk rg -n "evidencePanels|matrices|tables|hardObstacles|routing\\.evidence\\.crossing_forbidden" src/solver src/routing test` - PASS, hard and soft obstacle coverage found.
- `rtk npm run typecheck` - FAIL due existing 07-01 write-set errors in `src/dsl/normalize.ts` and `test/dsl.test.ts`; 07-02-introduced type errors were fixed in `c6b7d73`.

## Decisions Made

- Matrix obstacle semantics are hard because crossing a matrix corrupts traceability evidence; the route is omitted instead of degraded through the matrix.
- Table and panel obstacle semantics remain soft to preserve existing bounded fallback behavior for non-critical evidence regions.
- The route type surface was not permanently expanded in this plan because the requested write set did not include `src/routing/types.ts`; hard obstacles are consumed through an internal structural extension.

## Deviations from Plan

None - plan scope executed as written.

## Issues Encountered

- Extra typecheck verification exposed pre-existing 07-01 type errors in `src/dsl/normalize.ts` and `test/dsl.test.ts`. These files are outside the explicit 07-02 write set, so they were not modified in this plan.

## Known Stubs

None. Stub scan matches only normal local accumulator initialization, default parameter objects, and existing defensive empty-array construction.

## Threat Flags

None. This plan added local solver/routing geometry behavior only; it did not add network endpoints, authentication paths, file access patterns, or new trust-boundary schema changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

07-03 can consume solved evidence block `box` geometry and table `columnXOffsets` for SVG and Excalidraw rendering. Matrix hard-exclusion diagnostics are available for exporter and fixture-level assertions.

## Self-Check: PASSED

- Summary file created at `.planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/07-02-SUMMARY.md`.
- Task commits exist: `8492f73`, `c6b7d73`.
- Plan-level verification commands passed.

---
*Phase: 07-add-evidence-blocks-for-matrices-tables-and-panels*
*Completed: 2026-05-31*
