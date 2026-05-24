---
phase: 02-text-labels-and-shape-geometry
plan: 04
subsystem: geometry
tags: [typescript, vitest, container-geometry, label-layout]

requires:
  - phase: 02-text-labels-and-shape-geometry
    provides: Plan 02-02 LabelLayout and Plan 02-03 box/shape geometry.
provides:
  - ContainerGeometry contracts.
  - computeContainerGeometry from known child boxes, padding, optional label layout, min size, anchors, and obstacle box.
  - Tests proving container geometry does not move children or solve placement.
affects: [geometry, labels, containers, public-api]

tech-stack:
  added: []
  patterns: [known-child container aggregation, precomputed label layout input, no solver boundary]

key-files:
  created:
    - src/geometry/containers.ts
    - test/container-geometry.test.ts
  modified:
    - src/geometry/index.ts

key-decisions:
  - "Container geometry accepts precomputed LabelLayout and does not import label fitting."
  - "minSize enlarges the outer container box without translating children."
  - "Container geometry rejects empty child box arrays instead of attempting placement."

patterns-established:
  - "Container computation composes unionBoxes, normalizeInsets, expandBox, and computeShapeGeometry."
  - "Known child coordinates remain authoritative until Phase 3 containment solving."

requirements-completed: [TXT-02, GEO-01, GEO-02]

duration: 8min
completed: 2026-05-24
---

# Phase 02 Plan 04: Container Geometry Summary

**Known-child container geometry with label header reservation, padding, min size, anchors, and obstacle boxes without child placement**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-24T14:26:00Z
- **Completed:** 2026-05-24T14:33:58Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added RED tests for known child boxes, optional label headers, min size, anchors, obstacle boxes, invalid input, and no child mutation.
- Implemented `ContainerGeometryInput`, `ContainerGeometry`, and `computeContainerGeometry()`.
- Verified container code stays solver-free and renderer-neutral.

## Task Commits

1. **Task 1: Add RED container geometry tests** - `2874fca` (test)
2. **Task 2: Implement computeContainerGeometry** - `675cb2d` (feat)

## Files Created/Modified

- `src/geometry/containers.ts` - Container geometry contracts and implementation.
- `src/geometry/index.ts` - Added `containers.js` barrel export.
- `test/container-geometry.test.ts` - Container geometry coverage.

## Decisions Made

- `labelLayout.fittedSize.height` drives header reservation when a label is present.
- `contentBox` remains the known child content area; children are not translated or normalized.
- Empty child arrays are invalid in Phase 2 because automatic containment solving is Phase 3 scope.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The RED test initially expected a smaller header offset. The implementation followed the planned `labelLayout.fittedSize.height` rule, so the test was corrected to match the precomputed label layout height.

## Verification

- `rtk npm test -- container-geometry box-geometry shape-geometry label-fitting` - passed.
- `rtk npm run typecheck` - passed.
- `rtk rg -n -i "dagre|constraint|router|routing|svg|html|css|excalidraw|draw\\.io|drawio|mermaid" src/geometry/containers.ts test/container-geometry.test.ts` - no matches.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 02-05 can now wire root public exports and add an end-to-end canonical fixture across text, labels, shape, and container geometry.

---
*Phase: 02-text-labels-and-shape-geometry*
*Completed: 2026-05-24*
