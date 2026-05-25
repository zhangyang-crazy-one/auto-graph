---
phase: 03-layout-constraints-and-routing
plan: 02
subsystem: constraints
tags: [typescript, constraints, diagnostics, deterministic-layout]

requires:
  - phase: 02-text-labels-and-shape-geometry
    provides: Box validation, AABB collision checks, normalized IR, and constraint union types.
provides:
  - Fixed-position support on NormalizedNode.
  - Layered layout constraint solving with hard fixed/exact locks.
  - Stable diagnostics for missing references, invalid positions, lock conflicts, containment failures, and unresolved overlaps.
affects: [solver, layout, routing, public-api]

tech-stack:
  added: []
  patterns: [locked-constraint-precedence, diagnostic-conflict-reporting, bounded-overlap-repair]

key-files:
  created:
    - src/constraints/index.ts
    - src/constraints/types.ts
    - src/constraints/solver.ts
    - test/constraints.test.ts
  modified:
    - src/ir/elements.ts

key-decisions:
  - "Fixed positions and exact-position constraints are hard locks."
  - "Constraint precedence is fixed/exact, containment, relative-position, align, distribute, followed by bounded overlap repair."
  - "Overlap repair uses the diagram primary axis, stable sorted IDs, and configured spacing."

patterns-established:
  - "Constraint solvers copy input boxes before mutation and return diagnostics with partial finite geometry."
  - "Weaker constraints never move locked boxes; they emit constraints.locked-target-not-moved."

requirements-completed: [LAY-02, LAY-03, LAY-04]

duration: 26min
completed: 2026-05-25
---

# Phase 03 Plan 02: Constraint Layer Summary

**Deterministic constraint solving with fixed/exact locks, precedence, and stable conflict diagnostics**

## Performance

- **Duration:** 26 min
- **Started:** 2026-05-25T00:19:59Z
- **Completed:** 2026-05-25T00:46:22Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added renderer-neutral fixed-position support to `NormalizedNode`.
- Created constraint solver contracts with `direction` and `overlapSpacing`.
- Implemented exact-position, containment, relative-position, align, distribute, and deterministic overlap repair.
- Covered hard locks, missing references, invalid positions, lock conflicts, containment failures, and unresolved overlap diagnostics.

## Task Commits

Wave 1 was implemented and committed as a single sequential execution commit.

## Files Created/Modified

- `src/ir/elements.ts` - Adds `position?: Point` to normalized nodes.
- `src/constraints/types.ts` - Constraint solver input/result and lock contracts.
- `src/constraints/solver.ts` - Layered constraint solver implementation.
- `src/constraints/index.ts` - Constraint barrel exports.
- `test/constraints.test.ts` - Lock, precedence, diagnostics, and overlap repair coverage.

## Decisions Made

- Followed the planned precedence order and kept the solver renderer-neutral.
- Used a bounded primary-axis overlap pass rather than an optimizer or physics-style loop.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Container content-box shrinking was implemented directly instead of using `expandBox()` with negative insets, because `normalizeInsets()` intentionally rejects negative margins.
- `rtk npm run format` was needed to satisfy Biome import ordering and formatting.

## Verification

- `rtk rg -n 'position\?: Point' src/ir/elements.ts` - passed.
- `rtk rg -n 'export interface ConstraintSolverInput|direction: DiagramDirection|overlapSpacing\?: number|export interface ConstraintSolverResult|export interface LayoutLock' src/constraints/types.ts` - passed.
- `rtk npm test -- constraints` - passed, 1 file / 9 tests.
- Wave gate: `rtk npm run typecheck`, `rtk npm test -- layout constraints routing`, and `rtk npm run lint` - passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The constraint layer is ready for Plan 03-04 `solveDiagram()` integration.

---
*Phase: 03-layout-constraints-and-routing*
*Completed: 2026-05-25*
