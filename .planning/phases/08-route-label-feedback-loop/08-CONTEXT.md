# Phase 8: Route/Label Feedback Loop - Context

**Gathered:** 2026-07-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 8 delivers the internal feedback loop between final edge routes and final text geometry. It should validate final routes against final route-clearance text boxes after edge-label placement, reroute conflicting edges within a bounded deterministic loop, and emit a structured loop-exhausted diagnostic when conflicts remain.

This phase must not absorb the later milestone phases: public strict/deliverable status belongs to Phase 9, external-label semantics belong to Phase 10, page-level rail/gutter architecture belongs to Phase 11, and dense MBSE Stage 5 acceptance fixtures belong to Phase 12.

</domain>

<decisions>
## Implementation Decisions

### Conflict Scope
- **D-01:** The feedback loop must consider all final `isRouteClearanceText` conflicts, not only `edge-label` conflicts. This includes edge labels, node labels, port labels, group labels, frame titles, and other route-clearance text surfaces already included by `reportRouteTextClearance`.
- **D-02:** When rerouting one edge, the text obstacle set should include all final route-clearance text boxes except annotations connected to that same edge. Use the existing `isEdgeConnectedTextAnnotation` exclusion model so an edge is not forced to avoid its own label.
- **D-03:** Do not introduce Phase 9 hard/soft deliverability semantics in Phase 8. Phase 8 treats final route-clearance text as avoidable reroute obstacles and reports loop exhaustion when avoidance fails; Phase 9 defines public clean/degraded/unsatisfiable contracts.

### Loop State Shape
- **D-04:** Introduce a private internal route/label feedback state object rather than continuing to mutate `coordinatedEdges`, `edgeTextAnnotations`, and routing diagnostics through scattered local variables. The state should track current edges, current final text annotations, per-edge routing diagnostics, route/text conflicts, iteration number, and changed edge ids.
- **D-05:** Keep this state internal to `src/solver/solve.ts` or a private solver helper module. Do not expose a public API shape in Phase 8 unless planning discovers that a small internal type must be exported for tests.
- **D-06:** Preserve prepare/solve/export separation. The loop belongs in the solver after initial edge routing and edge-label placement; exporters should still consume final coordinated geometry only.

### Failure Boundary
- **D-07:** If the bounded feedback loop cannot clear all route/text conflicts, emit a structured Phase 8 diagnostic such as `routing.route-label-loop.exhausted` or an equivalent code chosen during planning. It should include edge ids, conflicting text surface kinds, conflicting owner ids, iteration count, and conflict count.
- **D-08:** Keep existing `routing.text-clearance.unresolved` diagnostics for compatibility in Phase 8. The new loop-exhausted diagnostic summarizes why the loop stopped; Phase 9 can decide how strict mode gates or promotes it.
- **D-09:** The loop must never silently accept a worse reroute. If a reroute increases route/text conflicts, hard/soft obstacle conflicts, or excessive backtracking, keep the previous route and record why the candidate was rejected.

### Determinism Budget
- **D-10:** Use a fixed global iteration budget derived from the existing `edgeLabelRerouting` option for Phase 8. The current default of 4 iterations can remain unless planning finds a local reason to adjust it.
- **D-11:** Process conflicting edges in stable edge-id order within each iteration. Recompute final edge labels after accepted route changes so subsequent iterations see current geometry.
- **D-12:** Accept a reroute only if it improves a deterministic per-edge score: fewer final route/text conflicts first, then fewer route obstacle diagnostics, then lower excessive backtracking, then shorter route length or existing route-quality tie-breakers.
- **D-13:** Stop early when an iteration accepts no improvements or when no route/text conflicts remain.

### the agent's Discretion
- Planner may choose whether the private feedback state lives inside `solve.ts` or in a small helper file under `src/solver/`, as long as public exports stay stable.
- Planner may choose the exact diagnostic code name and detail fields, but the diagnostic must be structured and must not replace the existing compatibility diagnostics in Phase 8.
- Planner may add focused tests before implementation if that makes the feedback-loop acceptance criteria clearer.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone And Phase Scope
- `.planning/PROJECT.md` - Milestone v1.1 goal, target features, and boundaries.
- `.planning/REQUIREMENTS.md` - Phase 8 requirements LOOP-01 through LOOP-04 and downstream phase boundaries.
- `.planning/ROADMAP.md` - Phase 8 goal, success criteria, and notes.
- `.planning/STATE.md` - Current milestone state and accumulated context.

### Prior Decisions
- `.planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/07-CONTEXT.md` - Evidence blocks are physical routing obstacles; PR-A lane contracts and PR-C semantic ports were deferred.
- `.planning/quick/260708-hz4-issue-bug/260708-hz4-RESEARCH.md` - Dense orthogonal routing research and route-quality direction used by PR #72 follow-up.
- `.planning/quick/260708-hz4-issue-bug/260708-hz4-SUMMARY.md` - Existing dense-route cost-ranking changes and verification record.

### Issue And Review Evidence
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/73` - Latest failure report: 0.2.15 still has 224 Stage 5 criticals and needs a closed-loop route/label pipeline.
- `https://github.com/zhangyang-crazy-one/auto-graph/pull/72#discussion_r3529473028` - Codex review: rerun overlap repair after anchor-capacity growth.
- `https://github.com/zhangyang-crazy-one/auto-graph/pull/72#discussion_r3529473034` - Codex review: keep framed rails clear of title obstacle.
- `https://github.com/zhangyang-crazy-one/auto-graph/pull/72#discussion_r3529473047` - Codex review: exclude only actual endpoint nodes from rail validation.
- `https://github.com/zhangyang-crazy-one/auto-graph/pull/72#discussion_r3529473057` - Codex review: skip rails for anchors that jog through endpoints.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/solver/solve.ts::reportRouteTextClearance` already computes final route/text conflicts across route-clearance text surfaces and filters connected edge text through `isEdgeConnectedTextAnnotation`.
- `src/solver/solve.ts::coordinateEdges` already accepts `textObstacles` and routes each edge through `routeEdge`.
- `src/solver/solve.ts::coordinateEdgeTextAnnotations` already places final edge labels after routing.
- `src/solver/solve.ts::edgeLabelRerouteIterations` already provides a bounded reroute budget from `edgeLabelRerouting`.
- `src/routing/routes.ts::routeEdge` already has route-quality ranking, endpoint-interior protection, excessive-backtracking diagnostics, and obstacle-aware fallbacks.
- `src/ir/diagnostics.ts::DELIVERABILITY_DIAGNOSTIC_CODES` is the current strict-mode promotion surface, but Phase 8 should not finalize public strict semantics.

### Established Patterns
- `solveDiagram` currently follows a linear sequence with a small reroute loop: initial routing, final edge-label placement, edge-label conflict detection, reroute conflicting edges, final route/text diagnostics.
- Diagnostics are plain structured objects with `severity`, `code`, `message`, optional `path`, and optional `detail`.
- Non-strict behavior preserves degraded geometry with warning diagnostics; strict mode currently promotes deliverability warnings to errors.
- Tests in `test/solver.test.ts` already assert edge-label placement, text clearance, label congestion diagnostics, strict promotion, and `edgeLabelRerouting` behavior.

### Integration Points
- The loop should be inserted around the existing block in `solveDiagram` that starts with `let coordinatedEdges = coordinateEdges(...)` and ends before final `diagnostics.push(...edgeRoutingDiagnostics)`.
- Rerouted edges should continue to use `coordinateEdges` so existing node, group, evidence, text, and routing obstacle behavior is reused.
- Final text obstacles should be built from `textAnnotations` or equivalent final route-clearance annotations after each placement pass, excluding the current edge's connected annotation during route construction.
- Candidate acceptance should compare previous and candidate edge quality before mutating the current state.

</code_context>

<specifics>
## Specific Ideas

- User explicitly selected all recommended decisions after reviewing the phase breakdown. Treat the choices in `<decisions>` as locked guidance for planning.
- The planner should avoid turning Phase 8 into a full Issue #73 solution. The milestone intentionally spans Phases 8-12.
- The loop should improve node-label and edge-label route intersections reported in Issue #73 without waiting for Phase 10 external labels or Phase 11 rails.

</specifics>

<deferred>
## Deferred Ideas

- Public clean/degraded/unsatisfiable output status and strict deliverability semantics remain Phase 9.
- Structured edge-label externalization and callout-required metadata remain Phase 10.
- Page-level rails/gutters, frame title rail fixes, rail endpoint identity filtering, side-anchor rail fixes, and anchor-capacity post-growth repair remain Phase 11.
- Dense CV/OV/SV Stage 5 acceptance fixtures and evidence reports remain Phase 12.

</deferred>

---

*Phase: 8-Route/Label Feedback Loop*
*Context gathered: 2026-07-08*
