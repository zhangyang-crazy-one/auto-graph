# Research: Phase 8 Route/Label Feedback Loop

## Research Complete

**Phase:** 08 - Route/Label Feedback Loop
**Date:** 2026-07-08
**Question:** What needs to be true to plan Phase 8 well?

## Sources Consulted

- `.planning/phases/08-route-label-feedback-loop/08-CONTEXT.md` - locked Phase 8 decisions D-01 through D-13.
- `.planning/REQUIREMENTS.md` - LOOP-01 through LOOP-04.
- `.planning/ROADMAP.md` - Phase 8 scope and success criteria.
- `.planning/STATE.md` - milestone state and issue context.
- `.planning/quick/260708-hz4-issue-bug/260708-hz4-RESEARCH.md` - prior dense orthogonal routing algorithm research.
- `.planning/quick/260708-hz4-issue-bug/260708-hz4-SUMMARY.md` - PR #72 route-quality implementation summary.
- `.planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/07-CONTEXT.md` - evidence blocks are physical routing obstacles.
- GitHub issue #73 - latest downstream Stage 5 failure report for `@crazyhappyone/auto-graph@0.2.15`.
- GitHub PR #72 review comments updated on 2026-07-08.
- `src/solver/solve.ts` - solver pipeline, edge routing, final text annotations, reroute loop, text-clearance diagnostics.
- `src/routing/routes.ts` - route-quality ranking and fallback behavior from the previous quick fix.
- `src/ir/diagnostics.ts` - deliverability diagnostic strict-mode promotion set.
- `src/ir/label-layout.ts` - text-surface kinds and solved annotation shape.
- `test/solver.test.ts` and `test/determinism.test.ts` - current regression and determinism patterns.

## Current Pipeline Finding

The solver has a useful but incomplete loop:

1. `estimateEdgeLabelAnnotations` produces dry-run edge-label obstacles before final routing.
2. `coordinateEdges` routes edges once against node, soft, hard, group, and pre-route text obstacles.
3. `coordinateEdgeTextAnnotations` places final edge labels from the routed polylines.
4. The existing `edgeLabelRerouting` loop calls `reportRouteTextClearance`, but filters only final conflicts whose `textSurfaceKind` is `edge-label`.
5. Final `textAnnotations` are assembled only after the loop, and `reportRouteTextClearance` then reports all route/text conflicts post-hoc.

Issue #73's 0.2.15 failure breakdown has 128 edge-label route intersections and 76 node-label route intersections. A loop that only reacts to `edge-label` conflicts cannot address nearly half of the text-intersection class. The Phase 8 fix should therefore be a solver-level fixed-point loop over all final `isRouteClearanceText` surfaces.

## Algorithm Direction

The appropriate algorithm is not a new global router in Phase 8. PR #72 already moved `routeEdge` toward an obstacle-aware candidate ranking model: hard crossings, endpoint crossings, soft/text crossings, excessive length, backtracking, anchor preference, bends, and length. Phase 8 should add the missing outer loop that feeds final text geometry back into that router.

Recommended model:

1. Build an internal `RouteLabelFeedbackState` after initial routing and final edge-label placement.
2. Compute final text annotations for the current edge routes.
3. Use `reportRouteTextClearance(currentEdges, allFinalTextAnnotations, options)` as the conflict oracle.
4. Extract conflicting edge ids from all route-clearance text conflicts, not just `edge-label`.
5. Process conflicting edges in stable `edge.id` order.
6. For one edge at a time, reroute that edge with all final route-clearance text annotations as text obstacles, excluding connected text via `isEdgeConnectedTextAnnotation`.
7. Rebuild final edge-label annotations after each accepted candidate, because label positions are route-dependent.
8. Accept a candidate only when a deterministic score improves.
9. Stop when there are no conflicts, the iteration budget is exhausted, or an iteration accepts no candidate.

This is effectively bounded coordinate descent over route geometry and text geometry. It is a conservative fit for the existing solver because it reuses `coordinateEdges`, `routeEdge`, `coordinateEdgeTextAnnotations`, and `reportRouteTextClearance`.

## Acceptance Score

Phase 8 should compare current and candidate edge states before mutating the loop state. The score should be internal and deterministic. Minimum fields:

1. Route/text conflicts involving the candidate edge after final label placement.
2. Route obstacle diagnostics for that edge, especially `routing.evidence.crossing_forbidden` and `routing.obstacle.unavoidable`.
3. Backtracking diagnostics for that edge, especially `routing.backtracking_excessive`.
4. Route length.
5. Bend count or existing route-quality tie-breakers if needed.

The first three dimensions are correctness and deliverability dimensions. Route length and bends should only break ties after correctness does not regress.

Do not accept a candidate if it improves one local label conflict while increasing hard obstacle crossings, soft obstacle diagnostics, or excessive backtracking. This directly implements D-09 and avoids "fix one label, break another route" behavior.

## Diagnostic Direction

Add one structured loop-exhausted diagnostic in Phase 8:

- Recommended code: `routing.route-label-loop.exhausted`.
- Severity: `warning` in non-strict mode, promoted by strict mode once included in `DELIVERABILITY_DIAGNOSTIC_CODES`.
- Path: `["edges"]` or the first remaining conflicting edge path.
- Detail fields should include:
  - `iterations`
  - `maxIterations`
  - `conflictCount`
  - `edgeIds`
  - `ownerIds`
  - `textSurfaceKinds`
  - `acceptedReroutes`
  - `rejectedReroutes`
  - `suggestedRemedy`

Keep `routing.text-clearance.unresolved` diagnostics for compatibility. The loop-exhausted diagnostic summarizes that the bounded feedback loop has stopped, while the existing diagnostics preserve per-conflict detail for downstream tools.

## PR Review Additions Relevant To Phase 8

The latest PR #72 review comments include one directly relevant Phase 8 item:

- `discussion_r3541568275`: `edgeLabelRerouting` currently returns zero for every non-`obstacle-avoiding` solve. Because orthogonal `routeEdge` consumes text obstacles too, an explicit `edgeLabelRerouting: true` should be honored for orthogonal routes or rejected with a diagnostic. Phase 8 should implement the former for explicit true/object settings while preserving the default behavior for unsupported route kinds if necessary.

Related but not primary Phase 8 items:

- `discussion_r3541948211`: edge-label fallback scoring can prefer node-covered labels when every candidate conflicts. This is more directly Phase 10 label congestion, but Phase 8 should avoid relying on node-covered label fallbacks as proof that a loop succeeded.
- `discussion_r3541948203`: saved clean excessive routes can be discarded in a hard-obstacle fallback branch. This is routing fallback quality, not route-label feedback, and can remain Phase 11 or a targeted follow-up unless Phase 8 tests expose it.
- Fixed swimlane lane partition comments belong outside Phase 8 unless a Phase 8 fixture depends on fixed swimlane lane boxes.

## Implementation Risks

- Diagnostics can duplicate if old per-edge route diagnostics are not replaced when an edge is rerouted. The implementation should remove stale diagnostics for changed edge ids before adding candidate diagnostics.
- A naive batch reroute can make labels stale. Recompute final edge-label annotations after accepted route changes.
- A candidate reroute can avoid one text box but cross another final label. Candidate scoring must evaluate against all final route-clearance annotations.
- The loop can oscillate if candidates are accepted on weak tie-breakers. Stable edge order plus strict improvement only prevents that.
- Frame title annotations are recalculated after bounds expansion today. Phase 8 should use the same text annotation generation order as current final output and should not move Phase 11 frame/rail fixes into this phase.
- `routing.route-label-loop.exhausted` should not replace compatibility diagnostics in Phase 8.

## Planning Recommendation

Use two dependent plans:

1. Core feedback loop and diagnostics.
   - Add private state and scoring helpers.
   - Replace the narrow edge-label reroute loop with the all-route-clearance feedback loop.
   - Emit `routing.route-label-loop.exhausted`.
   - Preserve existing compatibility diagnostics.

2. Determinism and compatibility coverage.
   - Honor explicit `edgeLabelRerouting` for orthogonal routes when text-obstacle rerouting is requested.
   - Add determinism assertions and strict-mode diagnostic certification.
   - Add regression coverage for node-label and edge-label conflicts, exhausted loops, and stable repeated output.

## Validation Architecture

**Framework:** Vitest.

**Quick command:** `npm test -- test/solver.test.ts test/determinism.test.ts`

**Full command:** `npm run verify`

**Test design:**

- Add a solver regression where a final node label intersects a route after first routing, and the feedback loop reroutes the conflicting edge with the node-label box as a text obstacle.
- Add a solver regression where a final edge label intersects an unrelated route after first placement, and the same loop clears it without relying only on pre-route estimates.
- Add an exhausted-loop regression using an intentionally huge final label or impossible corridor. Assert both `routing.route-label-loop.exhausted` and compatibility `routing.text-clearance.unresolved` diagnostics remain.
- Add strict-mode certification for `routing.route-label-loop.exhausted` if it is added to `DELIVERABILITY_DIAGNOSTIC_CODES`.
- Add a determinism regression that solves the same feedback-loop fixture twice and compares `stringifyCanonical(result)`.
- Add an explicit orthogonal rerouting regression for `edgeLabelRerouting: true` if Phase 8 changes `edgeLabelRerouteIterations`.

**Validation gates:**

- After implementation tasks: `npm test -- test/solver.test.ts test/determinism.test.ts`
- Before phase completion: `npm run verify`

## Open Planning Questions

None blocking. The exact helper names and whether the private feedback state stays in `solve.ts` or a small private helper file can be decided during execution.
