---
phase: 04-coordinated-exporters
plan: 01
subsystem: exporters
tags: [ir, labels, exporters, arrowheads, geometry]
requires:
  - phase: 03
    provides: coordinated diagram geometry
provides:
  - renderer-neutral label layout in coordinated IR
  - exporter contracts and barrel
  - deterministic arrowhead vector helper
affects: [svg-exporter, excalidraw-exporter, public-api]
tech-stack:
  added: []
  patterns: [renderer-neutral IR fields, final-segment arrowhead vectors]
key-files:
  created:
    - src/ir/label-layout.ts
    - src/exporters/index.ts
    - src/exporters/types.ts
    - src/exporters/arrow.ts
    - test/exporters.test.ts
  modified:
    - src/ir/elements.ts
    - src/ir/index.ts
    - src/labels/types.ts
    - src/solver/solve.ts
key-decisions:
  - "LabelLayout lives in IR and labels/types.ts re-exports it, avoiding an IR -> labels dependency."
  - "Solver copies labelLayout only when defined to preserve exact optional property semantics."
  - "Arrowheads are computed from the final non-zero edge segment with deterministic tip, base, and direction points."
patterns-established:
  - "Exporter foundation modules live under src/exporters and export through a local barrel before root publication."
  - "Renderer adapters consume coordinated geometry instead of calling solver or routing code."
requirements-completed: [EXP-01, EXP-02, EXP-03]
duration: 12 min
completed: 2026-05-25
---

# Phase 04 Plan 01: Exporter Foundation Summary

**Renderer-neutral label layout pass-through and deterministic arrowhead geometry for downstream exporters**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-25T01:49:00Z
- **Completed:** 2026-05-25T02:00:45Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Moved `LabelLayout` and `LabelLineLayout` ownership into `src/ir/label-layout.ts` and re-exported them from labels.
- Added optional `labelLayout` fields to normalized/coordinated nodes and groups with solver pass-through.
- Created exporter contracts and a vector-aware `computeArrowhead()` helper with tests.

## Task Commits

1. **Task 1: Add coordinated label layout fields** - `1a1a376` (feat)
2. **Task 2: Create exporter contracts and arrowhead helper** - `387a5b4` (feat)

## Files Created/Modified

- `src/ir/label-layout.ts` - Renderer-neutral label layout contracts.
- `src/ir/elements.ts` - Optional coordinated label layout fields.
- `src/ir/index.ts` - IR barrel export for label layout contracts.
- `src/labels/types.ts` - Label fit options plus IR label layout re-exports.
- `src/solver/solve.ts` - Label layout pass-through for nodes and groups.
- `src/exporters/types.ts` - Export format/result/options contracts.
- `src/exporters/arrow.ts` - Final-segment arrowhead geometry helper.
- `src/exporters/index.ts` - Exporter barrel.
- `test/exporters.test.ts` - Arrowhead geometry tests.

## Decisions Made

- Put `LabelLayout` in IR because exporters need it from coordinated output without depending on label fitting internals.
- Preserved optional property semantics with conditional spreads instead of assigning `undefined`.
- Kept arrowhead computation local to exporters because it is render geometry derived from already-routed points, not route recomputation.

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

- `rtk npm test -- exporters` passed.
- `rtk npm test -- public-api` passed.
- `rtk npm run typecheck` passed.
- `rtk rg -n 'svg|excalidraw|css|html' src/ir/elements.ts` printed no output.
- `rtk rg -n '../labels|\"../labels|\\.\\./labels' src/ir` printed no output.

## Next Phase Readiness

Ready for `04-02` SVG exporter and `04-03` Excalidraw adapter. Both can consume `LabelLayout` and `computeArrowhead()` without remeasuring text or rerouting edges.

---
*Phase: 04-coordinated-exporters*
*Completed: 2026-05-25*
