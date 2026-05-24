---
phase: 01-project-scaffold-and-core-ir
plan: 02
subsystem: core-api
tags: [typescript, ir, public-api, types, vitest]
requires:
  - phase: 01-project-scaffold-and-core-ir
    provides: npm package scaffold with TypeScript, Vitest, and Biome commands
provides:
  - public package entrypoint exporting core IR type contracts
  - renderer-free geometry, element, constraint, diagnostic, and diagram types
  - public API test proving entrypoint type imports
affects: [phase-01, phase-02, phase-03, phase-04, FND-02, public-api, coordinated-ir]
tech-stack:
  added: []
  patterns: [type-only IR modules, root public entrypoint, prepare-solve-export stage contracts]
key-files:
  created: [src/index.ts, src/ir/geometry.ts, src/ir/elements.ts, src/ir/constraints.ts, src/ir/diagnostics.ts, src/ir/diagram.ts, src/ir/index.ts, test/public-api.test.ts]
  modified: []
key-decisions:
  - "Keep Phase 1 IR modules type-only and renderer-free; exporters will map from coordinated IR later."
  - "Expose public IR types only through the root entrypoint for this plan."
  - "Represent intent, normalized, and coordinated diagrams as distinct prepare/solve/export contracts."
patterns-established:
  - "Core IR files live under src/ir with a local barrel re-exported by src/index.ts."
  - "Public API tests import from ../src/index.js rather than internal module paths."
requirements-completed: [FND-02]
duration: 6min
completed: 2026-05-24
---

# Phase 01 Plan 02: Public IR Contracts Summary

**Renderer-free TypeScript IR contracts for intent, normalized, and coordinated diagrams exposed through the root package entrypoint**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-24T10:34:03Z
- **Completed:** 2026-05-24T10:40:16Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Added the public API test proving stable type imports from `../src/index.js`.
- Added geometry, diagnostics, constraints, labels, node, edge, and group contracts under `src/ir`.
- Added diagram-level `IntentDiagram`, `NormalizedDiagram`, and `CoordinatedDiagram` contracts with comments preserving the future prepare, future solve, and future exporters handoff.
- Exposed public types through `src/ir/index.ts` and `src/index.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add public API type import test** - `4b55b43` (test)
2. **Task 2: Create geometry, diagnostics, constraints, and element type modules** - `a8b6a68` (feat)
3. **Task 3: Create diagram contracts and public barrels** - `2721a61` (feat)

## Files Created/Modified

- `test/public-api.test.ts` - Public entrypoint type import proof and coordinated diagram sample assertion.
- `src/ir/geometry.ts` - JSON metadata types, direction, points, sizes, boxes, insets, and anchors.
- `src/ir/diagnostics.ts` - Diagnostic severity, path, message, and detail contract.
- `src/ir/constraints.ts` - Exact, relative, align, distribute, and containment constraint union.
- `src/ir/elements.ts` - Renderer-free labels, nodes, edges, groups, endpoints, and coordinated route points.
- `src/ir/diagram.ts` - Intent, normalized, and coordinated diagram contracts plus stage metadata.
- `src/ir/index.ts` - IR module barrel.
- `src/index.ts` - Root package entrypoint re-exporting the IR barrel.

## Decisions Made

- Used `src/index.ts` as the only public source entrypoint for this plan; no package subpath exports were added.
- Kept all IR modules free of renderer-native output fields and future algorithm behavior.
- Split diagram stages into distinct contracts so later prepare, solve, and exporter modules consume stable handoff shapes.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The Task 1 grep check expected `IntentDiagram`, `CoordinatedDiagram`, and `Constraint` on one import line, while Biome wrapped the initial grouped import. The test was adjusted to use two type imports from the same public entrypoint so the grep proof stays stable and formatting remains compliant.
- The renderer-creep grep passed, but `rtk bash -lc` emitted an unrelated local nvm warning about the user's `.npmrc` prefix/globalconfig setting. The command still exited 0.

## Verification

Passed:

- `rtk rg 'import type \{[^}]*IntentDiagram[^}]*CoordinatedDiagram[^}]*Constraint' test/public-api.test.ts`
- `rtk rg 'from "../src/index\.js"' test/public-api.test.ts`
- `rtk rg 'export interface (Point|Size|Box|Insets)|export type DiagramDirection' src/ir/geometry.ts`
- `rtk rg 'export type Constraint|kind: "exact-position"|kind: "containment"' src/ir/constraints.ts`
- `rtk rg 'export interface (IntentNode|NormalizedNode|CoordinatedNode|IntentEdge|NormalizedEdge|CoordinatedEdge|Label)' src/ir/elements.ts`
- `rtk rg 'export interface IntentDiagram|export interface NormalizedDiagram|export interface CoordinatedDiagram|future prepare|future solve|future exporters' src/ir/diagram.ts`
- `rtk rg 'export \* from "\./geometry\.js";' src/ir/index.ts`
- `rtk rg 'export \* from "\./ir/index\.js";' src/index.ts`
- `rtk npm run typecheck`
- `rtk npm test -- public-api`
- `rtk npm run lint`
- `rtk bash -lc "! rg -i 'svg|excalidraw|draw\.io|drawio|mermaid|html|css' src/ir"`

Expected during RED step:

- `rtk npm run typecheck` failed before Task 3 because `src/index.ts` did not exist yet.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None.

## Next Phase Readiness

Plan 03 can add deterministic serialization exports on top of the existing root entrypoint. Later phases can consume `CoordinatedDiagram` as the solver-to-exporter contract without adding renderer fields to core IR.

## Self-Check: PASSED

- Verified summary and key source/test files exist with `rtk bash -lc 'test -f ...'`.
- Verified task commits `4b55b43`, `a8b6a68`, and `2721a61` exist in git history.
- Scanned created source/test files for common stub markers; none found.

---
*Phase: 01-project-scaffold-and-core-ir*
*Completed: 2026-05-24*
