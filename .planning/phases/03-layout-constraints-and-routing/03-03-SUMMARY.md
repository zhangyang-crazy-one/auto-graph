---
phase: 03-layout-constraints-and-routing
plan: 03
subsystem: routing
tags: [typescript, routing, orthogonal, shape-ports]

requires:
  - phase: 02-text-labels-and-shape-geometry
    provides: Shape geometry, edge ports, boxes, and AABB checks.
provides:
  - Straight and default orthogonal edge routing.
  - Deterministic bounded orthogonal candidate selection.
  - Route simplification that removes duplicate and collinear points without reordering.
affects: [solver, public-api, fixtures]

tech-stack:
  added: []
  patterns: [bounded-route-candidates, shape-port-routing, route-simplification]

key-files:
  created:
    - src/routing/index.ts
    - src/routing/types.ts
    - src/routing/routes.ts
    - test/routing.test.ts
  modified: []

key-decisions:
  - "Orthogonal routing is the default route kind."
  - "Routing uses Phase 2 shape ports and a fixed candidate list, not grid A*."
  - "Obstacle-heavy input returns a deterministic fallback route with routing.obstacle.unavoidable."

patterns-established:
  - "Routing modules consume ShapeGeometry and Box values only; they do not know about renderers or exporters."
  - "Route simplification preserves semantic point order."

requirements-completed: [RTE-01, RTE-02, RTE-03]

duration: 26min
completed: 2026-05-25
---

# Phase 03 Plan 03: Routing Layer Summary

**Shape-port straight and orthogonal routing with bounded candidates and stable route simplification**

## Performance

- **Duration:** 26 min
- **Started:** 2026-05-25T00:19:59Z
- **Completed:** 2026-05-25T00:46:22Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added renderer-neutral route input/result contracts.
- Implemented `routeEdge()` for straight and orthogonal routes, with orthogonal as the default.
- Reused `getEdgePort()` and AABB obstacle checks from Phase 2.
- Added route simplification and deterministic obstacle fallback diagnostics.

## Task Commits

Wave 1 was implemented and committed as a single sequential execution commit.

## Files Created/Modified

- `src/routing/types.ts` - Route kind, input, and result contracts.
- `src/routing/routes.ts` - Route generation, candidate checks, and simplification.
- `src/routing/index.ts` - Routing barrel exports.
- `test/routing.test.ts` - Simplification, straight routing, orthogonal routing, obstacle, and fallback coverage.

## Decisions Made

- Followed the planned bounded candidate approach and avoided full grid pathfinding.
- Kept route output as point arrays plus diagnostics only.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Tests were calibrated to actual rectangle port clipping from Phase 2, which can choose corner coordinates when the target is diagonal.

## Verification

- `rtk rg -n 'export type RouteKind = "orthogonal" \| "straight"' src/routing/types.ts` - passed.
- `rtk rg -n -i 'a\*|astar|grid' src/routing src/geometry test/routing.test.ts` - no matches.
- `rtk npm test -- routing` - passed, 1 file / 5 tests.
- Wave gate: `rtk npm run typecheck`, `rtk npm test -- layout constraints routing`, and `rtk npm run lint` - passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The routing layer is ready to be called by Plan 03-04 solver integration.

---
*Phase: 03-layout-constraints-and-routing*
*Completed: 2026-05-25*
