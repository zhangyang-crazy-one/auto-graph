# Pattern Map: Phase 8 Route/Label Feedback Loop

## Purpose

Map Phase 8 work to existing files, functions, and tests so execution can reuse local patterns instead of inventing a parallel solver path.

## Files To Modify

| File | Role | Existing Analog | Phase 8 Use |
|------|------|-----------------|-------------|
| `src/solver/solve.ts` | Solver orchestration, routing, text annotations, route/text diagnostics | Existing `edgeLabelRerouting` loop after `coordinateEdgeTextAnnotations` | Replace narrow edge-label-only reroute loop with private route/label feedback loop |
| `src/ir/diagnostics.ts` | Deliverability diagnostic set | `DELIVERABILITY_DIAGNOSTIC_CODES` strict promotion list | Add `routing.route-label-loop.exhausted` if loop exhaustion should set `degraded` and promote in strict mode |
| `test/solver.test.ts` | Solver regression coverage | Text-clearance, label congestion, strict promotion, routing diagnostic tests | Add node-label feedback, edge-label feedback, exhausted-loop, and explicit orthogonal rerouting regressions |
| `test/determinism.test.ts` | Byte-stable output coverage | `stringifyCanonical(solveDiagram(input))` repeated solve assertions | Add a feedback-loop fixture determinism assertion |

## Solver Patterns To Reuse

### Initial Routing And Existing Reroute Loop

Existing flow in `solveDiagram`:

- Build `routingTextObstacles` from base text, frame title text, and edge-label estimates.
- Call `coordinateEdges`.
- Call `coordinateEdgeTextAnnotations`.
- Run bounded `edgeLabelRerouting` iterations.
- Push final route diagnostics.
- Assemble `textAnnotations`.
- Report final `routing.text-clearance.unresolved` and `routing.label-congestion.unresolved`.

Phase 8 should keep this order but make the loop operate on all final route-clearance text surfaces, not only `edge-label`.

### Text Obstacle Exclusion

Existing helper:

- `isEdgeConnectedTextAnnotation(edge, annotation)` excludes an edge's own label, endpoint node labels, endpoint port labels, and endpoint compartment rows.

Phase 8 must reuse this exclusion indirectly through `coordinateEdges` rather than manually filtering text obstacles in a new way.

### Final Conflict Oracle

Existing helper:

- `reportRouteTextClearance(edges, annotations, options)` reports `routing.text-clearance.unresolved` for final route/text intersections and already filters with `isRouteClearanceText`.

Phase 8 should use this helper as the loop conflict oracle and keep the final compatibility diagnostics.

### Label Placement

Existing helper:

- `coordinateEdgeTextAnnotations(edges, obstacleBoxes, textMeasurer, labelPlacement, labelOffset)` places final edge labels.
- `edgeLabelAnchor` selects candidates and can fall back to a conflicted candidate.

Phase 8 should recompute edge labels after accepted route changes. It should not redesign structured external-label semantics; that remains Phase 10.

### Route Candidate Quality

Existing pattern in `src/routing/routes.ts`:

- `routeQuality` and `compareRouteQuality` rank route candidates by hard crossings, endpoint crossings, soft crossings, excessive length, backtracking, anchor preference, bends, and length.

Phase 8 does not need to export these helpers. It can implement a private solver-level score over final conflicts and per-edge route diagnostics, then use route length/bends as tie-breakers.

## Diagnostic Patterns

Diagnostics are plain objects:

- `severity`
- `code`
- `message`
- optional `path`
- optional `detail`

Existing aggregate diagnostic pattern:

- `reportLabelCongestionDiagnostics(routeTextDiagnostics, coordinatedEdges)` aggregates remaining label clearance conflicts with stable sorted `edgeIds`, `ownerIds`, and `textSurfaceKinds`.

Phase 8 should mirror this style for `routing.route-label-loop.exhausted`, including stable joined id lists and a `suggestedRemedy`.

## Test Patterns

### Focused Solver Tests

Use `solveDiagram` with small hand-built `NormalizedDiagram` objects and assert diagnostics or route geometry.

Existing local helpers:

- `node(id, position?)`
- `nodeBox(result, id)`
- `createTestLabelLayout(text, box)`
- `routeCrossesBox(points, box)`
- `DeterministicTextMeasurer`

### Strict Diagnostic Certification

Existing test pattern:

- `certifies the deliverability diagnostics strict mode gates on`
- `promotes every deliverability diagnostic code in strict mode`

If Phase 8 adds `routing.route-label-loop.exhausted` to `DELIVERABILITY_DIAGNOSTIC_CODES`, update the certification list and rely on the loop in the generic strict-promotion test.

### Determinism

Existing pattern:

- `expect(stringifyCanonical(solveDiagram(input))).toBe(stringifyCanonical(solveDiagram(input)))`

Add one fixture that exercises the feedback loop so stable edge order, deterministic score acceptance, and final diagnostics are covered.

## Execution Notes

- Do not add public API types for the feedback state unless tests make it unavoidable.
- Keep `SolveDiagramOptions.edgeLabelRerouting` shape unchanged.
- Use `edgeLabelRerouteIterations(options)` as the budget source, but update route-kind gating so explicit rerouting is honored for orthogonal routing if supported.
- When rerouting a subset of edges, remove stale route diagnostics for changed edge ids before appending candidate diagnostics.
- Stable sorting must be by edge id with `localeCompare` or equivalent deterministic ordering.
- Do not move Phase 9 strict status, Phase 10 external labels, or Phase 11 rails/gutters into Phase 8.
