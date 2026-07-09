---
phase: quick-20260706-issue-69-71-dense-routing
plan: full-dense-mbse-routing-completion
type: execute
wave: 1
depends_on: []
files_modified:
  - src/solver/solve.ts
  - src/routing/types.ts
  - src/routing/routes.ts
  - src/routing/visibility-router.ts
  - src/routing/astar.ts
  - src/dsl/schema.ts
  - src/dsl/normalize.ts
  - src/dsl/render.ts
  - src/ir/elements.ts
  - test/solver.test.ts
  - test/routing.test.ts
  - test/dsl.test.ts
  - test/public-api.test.ts
  - README.md
  - README.zh-CN.md
autonomous: true
requirements:
  - GH-69
  - GH-71
---

# Full Plan: Complete Dense MBSE Route/Text Avoidance In PR #72

<objective>
Turn PR #72 from a narrow edge-label estimate fix into the complete upstream implementation for GitHub issues #69 and #71. The finished PR must make dense, position-preserving MBSE diagrams either route without node-label, edge-label, port-label, compartment-row, swimlane-label, and unrelated-node intersections under the requested contract, or return structured unsatisfiable diagnostics that identify the remaining congested region and remedy.
</objective>

<scope>
Implement all remaining #69/#71 capabilities in this PR:

1. Iterative edge-label rerouting using actual label boxes after first placement.
2. Compact text-obstacle boxes and configurable text-intersection tolerance.
3. Text-aware router vertices for small text surfaces.
4. Position-preserving / fixed-bounds swimlane and container behavior.
5. Anchor-capacity-aware node growth and diagnostics.
6. Dense rail routing for dependency-style pages.
7. Structured congestion diagnostics.
8. Regression and integration tests that prove the whole contract.
</scope>

<must_haves>
<truths>
- Keep determinism: identical input must produce byte-stable output.
- Keep public APIs headless and TypeScript-only; no browser or Python dependency.
- Do not merge PR #72 until the user explicitly approves merge.
- Keep #72 linked with `Refs #69` and `Refs #71`; only use `Fixes` after the full contract below passes.
- Preserve the already implemented edge-label estimate expansion unless a stronger implementation replaces it with equivalent or better test coverage.
</truths>

<done_definition>
- `npm run verify` passes locally.
- GitHub CI passes on Node 20 and Node 22.
- PR #72 contains implementation, tests, docs, and updated PR body.
- `@codex review` is requested after the final push.
- Issue #69 can be closed as fully implemented, not merely superseded.
- Issue #71 can be closed only if all suggested upstream work items have code/tests or explicit structured diagnostics.
</done_definition>
</must_haves>

<waves>

## Wave 0: Baseline And Acceptance Harness

<task id="W0-T1" type="execute">
<read_first>
- .planning/quick/20260706-issue-71-edge-label-avoidance/PLAN.md
- test/solver.test.ts
- test/routing.test.ts
- src/solver/solve.ts
- src/routing/routes.ts
- GitHub issue #69
- GitHub issue #71
</read_first>
<action>
Add focused acceptance fixtures to `test/solver.test.ts` before implementation:
- `dense dependency edges avoid actual edge labels after reroute`
- `dense routes avoid compact node labels with tolerance`
- `fixed contract swimlane boxes are preserved in positions mode`
- `anchor capacity grows overloaded node side or emits anchor-capacity diagnostic`
- `rail routing separates same-rank dependency edges`
- `unsatisfiable dense page emits routing.label-congestion.unresolved`
Use synthetic diagrams small enough for Vitest but shaped like #69/#71: same-rank labeled dependency edges, high fan-in/out nodes, fixed swimlane/container boxes, and long cross-zone flows.
</action>
<verify>
- `npx vitest run test/solver.test.ts -t "dense|fixed contract|anchor capacity|rail routing|label-congestion"` initially fails for missing behavior, then passes after later waves.
</verify>
<acceptance_criteria>
- Test names listed above exist in `test/solver.test.ts`.
- At least one test asserts zero `routing.text-clearance.unresolved` diagnostics for `textSurfaceKind === "edge-label"`.
- At least one test asserts zero `routing.text-clearance.unresolved` diagnostics for `textSurfaceKind === "node-label"`.
- At least one test asserts a structured diagnostic code exactly equal to `routing.label-congestion.unresolved` for an intentionally impossible layout.
</acceptance_criteria>
</task>

## Wave 1: Public Option Model And Diagnostics

<task id="W1-T1" type="execute">
<read_first>
- src/solver/solve.ts
- src/routing/types.ts
- src/ir/diagnostics.ts
- src/dsl/schema.ts
- src/dsl/normalize.ts
- src/dsl/render.ts
- README.md
- README.zh-CN.md
</read_first>
<action>
Extend `SolveDiagramOptions` and route input types with concrete dense-routing controls:
- `textIntersectionTolerance?: number` with default `2` for clearance diagnostics.
- `compactTextObstacles?: boolean | "labels-only"` with default `false`.
- `edgeLabelRerouting?: boolean | { maxIterations?: number }` with default enabled for `routeKind: "obstacle-avoiding"`.
- `textObstacleVertices?: boolean` with default enabled for obstacle-avoiding routes.
- `fixedSwimlaneGeometry?: boolean | "diagnose-overflow"` with default `false`.
- `anchorCapacity?: boolean | { minSpacing?: number; grow?: boolean }` with default enabled.
- `railRouting?: false | "auto" | "dependency"` with default `"auto"`.
Add diagnostic codes:
- `routing.label-congestion.unresolved`
- `routing.rail-capacity.exceeded`
- `routing.anchor-capacity.requires-resize`
- `routing.container-fixed-bounds-overflow`
- `layout.positions.missing`
Wire DSL metadata/rendering for the options that belong in YAML input: text tolerance, fixed swimlane geometry, anchor capacity, and rail routing.
</action>
<verify>
- `npm run typecheck`
- `npx vitest run test/dsl.test.ts test/public-api.test.ts`
</verify>
<acceptance_criteria>
- `SolveDiagramOptions` contains every option name listed above.
- `RouteEdgeInput` contains the router-level fields needed by later waves.
- `src/ir/diagnostics.ts` or local diagnostic emission accepts every listed code without string typos in tests.
- DSL tests prove YAML can enable `initialLayout: positions`, `railRouting`, `fixedSwimlaneGeometry`, `anchorCapacity`, and `textIntersectionTolerance`.
</acceptance_criteria>
</task>

## Wave 2: Edge-Label Iterative Rerouting

<task id="W2-T1" type="execute">
<read_first>
- src/solver/solve.ts
- src/routing/routes.ts
- test/solver.test.ts
</read_first>
<action>
Replace the one-shot edge-label avoidance flow with a deterministic two-pass loop:
1. Route all edges with base text annotations plus edge-label estimates.
2. Place actual edge labels with `coordinateEdgeTextAnnotations`.
3. Detect edges crossing other edges' actual edge-label boxes using the same clearance logic as `reportRouteTextClearance`.
4. Re-route only conflicting edges with actual edge-label boxes included as text obstacles, excluding the edge's own label.
5. Re-place labels and repeat up to `edgeLabelRerouting.maxIterations ?? 2`.
6. If conflicts remain, emit `routing.label-congestion.unresolved` with `edgeIds`, `labelOwnerIds`, `iterationCount`, and `suggestedRemedy`.
Keep route order stable by edge id and keep already-routed non-conflicting edges unchanged unless their label obstacle is needed by a later reroute.
</action>
<verify>
- `npx vitest run test/solver.test.ts -t "edge-label|label-congestion|dense dependency"`
- `npm run typecheck`
</verify>
<acceptance_criteria>
- Existing PR #72 edge-label estimate test still passes.
- New dense dependency edge-label test reports zero `routing.text-clearance.unresolved` diagnostics for edge labels.
- Unsatisfiable edge-label test reports `routing.label-congestion.unresolved` instead of silently returning only generic text-clearance diagnostics.
- Rerouting loop has a hard iteration cap and cannot loop indefinitely.
</acceptance_criteria>
</task>

## Wave 3: Compact Text Obstacles, Tolerance, And Text Vertices

<task id="W3-T1" type="execute">
<read_first>
- src/solver/solve.ts
- src/routing/routes.ts
- src/routing/visibility-router.ts
- src/routing/astar.ts
- test/routing.test.ts
- test/solver.test.ts
</read_first>
<action>
Implement the #69 text-clearance improvements:
- Apply `textIntersectionTolerance` inside route/text clearance checks so overlaps at or below the configured pixel tolerance are ignored.
- When `compactTextObstacles` is true, build routing obstacle boxes from actual text line extents plus minimal padding instead of full padded label layout boxes for node-label, port-label, compartment-row, swimlane-label, and edge-label surfaces.
- Add text-surface midpoint vertices for small text boxes in the corner visibility graph: top-mid, right-mid, bottom-mid, left-mid when box width < 120 or height < 30.
- Ensure grid A* sees the same compact text obstacle boxes as corner routing.
- Preserve rendered text annotation boxes; compact boxes affect routing/diagnostics only, not output geometry.
</action>
<verify>
- `npx vitest run test/routing.test.ts test/solver.test.ts -t "text|compact|tolerance|midpoint"`
- `npm run typecheck`
</verify>
<acceptance_criteria>
- A 1 px text overlap does not emit `routing.text-clearance.unresolved` when `textIntersectionTolerance: 2`.
- The same overlap emits `routing.text-clearance.unresolved` when `textIntersectionTolerance: 0`.
- With `compactTextObstacles: true`, dense node-label regression has zero node-label clearance diagnostics.
- A route that previously had no legal corner around a small label uses a text midpoint vertex and avoids the text box.
</acceptance_criteria>
</task>

## Wave 4: Position-Preserving And Fixed Swimlane Geometry

<task id="W4-T1" type="execute">
<read_first>
- src/ir/elements.ts
- src/solver/solve.ts
- src/dsl/schema.ts
- src/dsl/normalize.ts
- src/dsl/render.ts
- test/solver.test.ts
- test/dsl.test.ts
</read_first>
<action>
Implement first-class fixed geometry for position-preserving consumers:
- When `initialLayout: "positions"` and any node lacks `position`, emit `layout.positions.missing` with missing node ids.
- When `fixedSwimlaneGeometry` is true and `Swimlane.box` / `SwimlaneLane.box` are provided, `coordinateSwimlanes` must preserve those boxes exactly instead of deriving larger contract boxes.
- When fixed swimlane content overflows the supplied lane/content box, emit `routing.container-fixed-bounds-overflow` or `layout.container-fixed-bounds-overflow` with `swimlaneId`, `laneId`, `overflowBox`, and `suggestedRemedy`.
- Keep non-fixed contract swimlane layout behavior unchanged.
- Add DSL support for authored swimlane/lane boxes if missing from schema/normalize path.
</action>
<verify>
- `npx vitest run test/solver.test.ts test/dsl.test.ts -t "fixed|positions|swimlane|container"`
- `npm run typecheck`
</verify>
<acceptance_criteria>
- A test with supplied swimlane and lane boxes gets byte-equivalent `box`, `lane.box`, `headerBox`, and `contentBox` coordinates on output.
- A test with missing positions in positions mode emits `layout.positions.missing`.
- A test with fixed bounds too small emits `container-fixed-bounds-overflow`.
- Existing non-fixed contract swimlane tests continue to pass.
</acceptance_criteria>
</task>

## Wave 5: Anchor Capacity Sizing And Diagnostics

<task id="W5-T1" type="execute">
<read_first>
- src/solver/solve.ts
- src/ir/elements.ts
- test/solver.test.ts
</read_first>
<action>
Add anchor-capacity-aware sizing before final routing:
- Count required anchors per `(nodeId, side)` after endpoint side selection and explicit port anchors are resolved.
- Use `anchorCapacity.minSpacing ?? 12` and a 5%-95% side span.
- If `anchorCapacity.grow !== false`, grow node width or height before `computeShapeGeometry` so the busiest side can host all anchors at the minimum spacing.
- Recompute node geometry, ports, text annotations, layout bounds, and route obstacles after any growth.
- If growth is impossible because fixed bounds or page bounds prevent it, emit `routing.anchor-capacity.requires-resize` with node id, side, required span, available span, requiredAnchorCount, and suggested size.
</action>
<verify>
- `npx vitest run test/solver.test.ts -t "anchor capacity|port anchors|requires-resize"`
- `npm run typecheck`
</verify>
<acceptance_criteria>
- A high fan-in/out node with 8 same-side connections has anchors spaced at least 12 px apart after growth.
- A fixed-size node that cannot grow emits `routing.anchor-capacity.requires-resize`.
- Existing port shifting tests still pass.
- No route endpoint anchor lies outside its node or port box.
</acceptance_criteria>
</task>

## Wave 6: Rail Routing For Dense Dependency Pages

<task id="W6-T1" type="execute">
<read_first>
- src/solver/solve.ts
- src/routing/routes.ts
- src/routing/types.ts
- test/solver.test.ts
- test/routing.test.ts
</read_first>
<action>
Implement deterministic rail routing for dense same-rank dependency/resource-flow pages:
- Detect rail candidates when `railRouting: "auto"` and at least 6 labeled edges connect nodes with similar rank/axis span, or force it when `railRouting: "dependency"`.
- Allocate top/bottom/side rails outside node and swimlane content boxes with stable ordering by edge id.
- Route dependency edges through assigned rail waypoints before calling obstacle finalization.
- Treat rail occupancy as soft capacity; if no rail slot can satisfy clearance, emit `routing.rail-capacity.exceeded` with rail id, edge ids, capacity, and suggested extra gutter.
- Keep ordinary small diagrams on existing obstacle-avoiding routing.
</action>
<verify>
- `npx vitest run test/solver.test.ts test/routing.test.ts -t "rail|dependency|capacity"`
- `npm run typecheck`
</verify>
<acceptance_criteria>
- A dense same-row dependency test produces monotonic rail y coordinates with no route/text diagnostics.
- `railRouting: false` preserves existing route behavior for the same fixture.
- An intentionally over-constrained rail fixture emits `routing.rail-capacity.exceeded`.
- Rail route output is deterministic across two repeated `solveDiagram` calls.
</acceptance_criteria>
</task>

## Wave 7: Structured Congestion Diagnostics And Strict Mode

<task id="W7-T1" type="execute">
<read_first>
- src/solver/solve.ts
- src/ir/diagnostics.ts
- test/solver.test.ts
- test/quality.test.ts
</read_first>
<action>
Consolidate unresolved dense-layout failures into structured diagnostics:
- Convert residual repeated `routing.text-clearance.unresolved` groups into `routing.label-congestion.unresolved` when they involve edge-label/node-label congestion after all reroute passes.
- Preserve individual diagnostics for debuggability, but add grouped detail with `textSurfaceKind`, `ownerIds`, `routeEdgeIds`, `count`, `bounds`, and `suggestedRemedy`.
- Ensure `strict: true` promotes the new deliverability-breaking diagnostics consistently with existing deliverability diagnostics.
</action>
<verify>
- `npx vitest run test/solver.test.ts test/quality.test.ts -t "congestion|strict|deliverability"`
- `npm run typecheck`
</verify>
<acceptance_criteria>
- Residual dense text failures include one grouped `routing.label-congestion.unresolved` diagnostic.
- `strict: true` marks the diagram degraded or error-bearing consistently with existing strict behavior.
- Diagnostic details contain enough data for downstream drawio-mbse to point to the congested area without re-running geometry analysis.
</acceptance_criteria>
</task>

## Wave 8: Documentation, PR Update, And Closeout

<task id="W8-T1" type="execute">
<read_first>
- README.md
- README.zh-CN.md
- package.json
- .planning/quick/20260706-issue-71-edge-label-avoidance/PLAN.md
- GitHub PR #72
- GitHub issue #69
- GitHub issue #71
</read_first>
<action>
Document the dense-routing contract and update PR #72:
- README examples show `initialLayout: "positions"`, `routeKind: "obstacle-avoiding"`, `edgeLabelRerouting`, `compactTextObstacles`, `anchorCapacity`, `fixedSwimlaneGeometry`, and `railRouting`.
- PR body changes from a narrow `Refs #71` slice to the full #69/#71 implementation summary.
- Add a final PR comment `@codex review` after the last push.
- Do not merge.
</action>
<verify>
- `npm run verify`
- `gh pr checks 72 --repo zhangyang-crazy-one/auto-graph`
- `gh pr view 72 --repo zhangyang-crazy-one/auto-graph --json files,reviews,comments,statusCheckRollup`
</verify>
<acceptance_criteria>
- `npm run verify` exits 0.
- GitHub CI passes on Node 20 and Node 22.
- PR #72 includes this PLAN.md plus code, tests, and docs.
- PR #72 has a fresh `@codex review` comment after final implementation.
- Final response tells the user whether #69/#71 are safe to close.
</acceptance_criteria>
</task>

</waves>

<verification>
Run in this order:

1. `npx vitest run test/solver.test.ts -t "dense|edge-label|node-label|fixed|anchor capacity|rail|congestion"`
2. `npx vitest run test/routing.test.ts test/dsl.test.ts test/public-api.test.ts`
3. `npm run typecheck`
4. `npm run verify`
5. `gh pr checks 72 --repo zhangyang-crazy-one/auto-graph`

The phase is not complete until every command exits successfully and PR #72 has a new Codex review request.
</verification>

<success_criteria>
- Edge-label chicken-and-egg is resolved by actual-label rerouting, not only dry-run estimates.
- Node-label intersections are reduced by compact obstacles, text vertices, tolerance, or reported with structured congestion diagnostics.
- Fixed position/swimlane consumers can preserve authored geometry.
- High fan-in/out anchors are either spaced by automatic growth or diagnosed as unsatisfiable.
- Dense dependency pages can use deterministic rails.
- Remaining impossible cases produce actionable structured diagnostics.
- #69 and #71 no longer need to remain open for missing upstream features after PR #72 is merged.
</success_criteria>

<plan_check>
Inline verification of this PLAN:
- Every task has `read_first`, `action`, `verify`, and `acceptance_criteria`.
- Each major #69 proposal is covered: iterative reroute, compact labels, text vertices, tolerance, sequential/actual label avoidance through rerouting.
- Each #71 suggested upstream work item is covered: fixed-bounds containers, anchor capacity, label avoidance, rail routing, structured congestion diagnostics.
- The plan keeps PR merge gated by user approval.
</plan_check>
