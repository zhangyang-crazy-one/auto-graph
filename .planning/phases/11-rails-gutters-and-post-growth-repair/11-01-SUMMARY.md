# Phase 11 Plan 01 Summary

**Completed:** 2026-07-08

## Delivered

- Added optional `routing` allocation report with rail and gutter entries.
- Rail validation now filters endpoint nodes by identity and validates against all other node obstacles.
- Framed LR/RL rails reserve title-tab clearance and expose accepted rail coordinates.
- Rail fast paths skip incompatible explicit sides rather than jogging through endpoint interiors.
- Anchor-capacity growth now runs after swimlane contracts and uses solver-local cloned nodes.
- Added `constraints.overlap.post-growth` for overlaps introduced by growth after constraints.
- `routeEdge` now uses final hard-obstacle predicates for hard-clear fallback and returns saved excessive clean routes before hard fallbacks.
- Explicit center anchors are no longer rejected by endpoint-interior checks.

## Key Files

- `src/ir/diagram.ts`
- `src/ir/diagnostics.ts`
- `src/solver/solve.ts`
- `src/routing/routes.ts`
- `test/solver.test.ts`

## Requirements

Completed: RAIL-01, RAIL-02, RAIL-03, RAIL-04, RAIL-05, CONS-01, CONS-02, CONS-03
