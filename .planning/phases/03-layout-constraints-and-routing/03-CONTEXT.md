# Phase 3: Layout, Constraints, And Routing - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 produces coordinated geometry from measured nodes, edges, diagram direction, fixed positions, constraints, groups, and routing options. It should add Dagre-backed initial layout, deterministic fixed-node and constraint handling, container/containment solving around already measured child geometry, anchor-aware straight and orthogonal edge routing, route simplification, collision/conflict diagnostics, and coordinated IR output suitable for later exporters.

This phase does not implement the YAML/JSON DSL parser, CLI behavior, SVG/Excalidraw/draw.io/Mermaid exporters, visual preview UI, rich styling systems, force-directed layout, full grid A* routing, or precise non-rectangular shape boundary math beyond the Phase 2 practical anchor/port approximations.

</domain>

<decisions>
## Implementation Decisions

### Dagre Initial Layout Boundary

- **D-01:** Use Dagre only as the initial directed graph placement layer. Dagre receives measured node dimensions and graph edges, and returns a deterministic coarse layout for `TB`, `LR`, `BT`, and `RL`.
- **D-02:** DGE remains the source of final coordinated geometry. After Dagre, DGE owns fixed-node overrides, constraint application, container geometry, shape anchors, obstacle boxes, routing, diagnostics, and final `CoordinatedDiagram` construction.
- **D-03:** Do not let Dagre behavior leak into exporters or become the final geometry contract. Exporters in Phase 4 must consume coordinated IR and must not rerun Dagre or recompute layout.

### Pretext-Inspired Computation Model

- **D-04:** Carry forward the Pretext-style split between expensive preparation and cheap deterministic solving. Pretext's `prepare()` normalizes/segments text, uses canvas `measureText`, applies language rules and emoji correction, and caches segment widths; its `layout()` then performs arithmetic over cached widths with no canvas, DOM, string work, or renderer dependency.
- **D-05:** Apply that lesson to graph geometry without pretending graph layout is one-dimensional text wrapping. Phase 3 should cache or normalize measured node sizes, graph edges, constraints, anchors, and obstacle boxes before solving; the solve path should be deterministic math over those prepared structures.
- **D-06:** Phase 3 must not remeasure labels or call Pretext directly for routing/layout decisions except through Phase 2 label/size outputs. Text measurement remains Phase 2's concern.

### Fixed Nodes And Hybrid Layout

- **D-07:** Fixed positions and `exact-position` constraints are hard locks. The solver must not silently move a fixed node to satisfy Dagre layout or weaker constraints.
- **D-08:** Automatic nodes may move around fixed nodes. If a fixed node collides with an automatic node, the solver should attempt deterministic adjustment of automatic nodes first and then emit diagnostics if the overlap cannot be resolved within Phase 3's simple solver scope.
- **D-09:** Fixed-node behavior should support hybrid diagrams where users pin important nodes while the rest of the graph remains automatically arranged.

### Constraint Precedence And Diagnostics

- **D-10:** Apply constraints in a deterministic precedence order: fixed positions / `exact-position` first, then containment padding, then `relative-position`, then `align`, then `distribute`, with Dagre initial coordinates treated as the lowest-precedence suggestion.
- **D-11:** Conflicting constraints must produce diagnostics instead of silent geometry corruption. Diagnostics should include severity, stable code, readable message, and path/detail data where practical.
- **D-12:** Prefer returning a partial coordinated diagram plus diagnostics when coordinates can still be produced. Use `error` diagnostics for unrecoverable issues such as missing node references, invalid finite numbers, impossible basic coordinates, or constraint conflicts that make the coordinated IR unsafe to consume.
- **D-13:** Constraint solving should stay simple and deterministic for v1: layered application, direct numeric adjustments, and collision checks are preferred over SAT/SMT or non-deterministic iterative physics.

### Container And Group Solving

- **D-14:** Support two Phase 3 containment cases. First, after children have positions, a group/container may be computed from child boxes plus padding using the Phase 2 known-child container geometry. Second, when a container is fixed or exact-positioned, children should be constrained to its content box with padding diagnostics if they cannot fit.
- **D-15:** Container geometry is a first-class coordinated element: it should produce box, anchors/obstacle information as needed, and diagnostics using the same renderer-neutral geometry chain as normal nodes.
- **D-16:** Do not build a complex nested layout solver, automatic grid packer, or container-specific visual layout language in Phase 3. Nested groups may be supported only if a deterministic, simple ordering falls out naturally from child/group dependencies.

### Routing Scope

- **D-17:** Implement both straight and orthogonal connector paths. Orthogonal routing should be the default for coordinated diagrams unless a caller/edge explicitly requests straight routing.
- **D-18:** Route endpoints should use Phase 2 shape anchors and edge-port approximations. Respect explicit endpoint anchors when provided; otherwise choose deterministic ports from source/target geometry and diagram direction.
- **D-19:** Orthogonal obstacle avoidance in Phase 3 is limited to source/target interiors and simple rectangular obstacle boxes from fixture diagrams. Use deterministic candidate elbow paths and AABB checks first; do not implement full grid A* in this phase.
- **D-20:** Connector output must be simplified by merging collinear segments and removing redundant repeated points before it enters coordinated IR.

### Verification Direction

- **D-21:** Verify Phase 3 with numeric unit tests and canonical coordinated IR fixtures. Tests should cover Dagre directions, hybrid fixed/auto layouts, constraint precedence, conflict diagnostics, containment padding, straight routes, orthogonal routes, obstacle avoidance, and route simplification.
- **D-22:** Keep verification renderer-neutral in Phase 3. SVG/Excalidraw golden tests belong to Phase 4, after coordinated IR is stable.

### the agent's Discretion

- Exact TypeScript names, file splits, and helper class/function shapes are flexible if the module boundaries remain clear.
- The planner may choose the exact Dagre wrapper API and spacing defaults, provided output is deterministic and directions map cleanly to existing `DiagramDirection`.
- The planner may decide whether to expose route options on edges immediately or keep them internal until the DSL phase, as long as straight and orthogonal routing are testable.
- The planner may choose diagnostic code names and severity thresholds, but conflicts must never be silent.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope And Requirements

- `.planning/PROJECT.md` — Project purpose, TypeScript-first constraint, DGE-as-geometry-engine boundary, Pretext/Dagre reuse decisions, and deterministic output requirements.
- `.planning/REQUIREMENTS.md` — Phase 3 requirements `LAY-01` through `LAY-04` and `RTE-01` through `RTE-03`.
- `.planning/ROADMAP.md` — Phase 3 goal and success criteria.
- `.planning/STATE.md` — Current progress and preserved decisions after Phase 2.

### Prior Phase Contracts

- `.planning/phases/01-project-scaffold-and-core-ir/01-CONTEXT.md` — Renderer-free IR, prepare/solve/export separation, and deterministic serialization decisions.
- `.planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md` — Pretext reuse, renderer-neutral label layouts, Phase 2 shape approximations, and container boundary decisions.
- `.planning/phases/02-text-labels-and-shape-geometry/02-05-SUMMARY.md` — Phase 2 public exports, canonical fixture style, and verification gates.

### Research And Design

- `.planning/research/ARCHITECTURE.md` — Proposed data flow: text/label/shape preparation, Dagre initial layout, constraints, routing, and coordinated IR.
- `.planning/research/PITFALLS.md` — Risks around hidden constraint conflicts, exporter geometry duplication, and overbuilt A* routing.
- `.planning/research/SUMMARY.md` — Stack and implementation sequence, including Dagre-backed layout and basic constraints/routing.
- `.planning/research/STACK.md` — TypeScript and `@dagrejs/dagre` stack recommendation.
- `diagram-geometry-engine-design.md` §5.3-5.4 — Original LayoutEngine, constraint, and RouteEngine design notes.
- `dge-research-report.md` §1-2 — Pretext two-stage calculation analysis and how the prepare/layout model informs DGE.
- `node_modules/@chenglou/pretext/src/layout.ts` — Local installed Pretext source confirming `prepare()` vs `layout()` behavior.
- `node_modules/@chenglou/pretext/src/measurement.ts` — Local installed Pretext source confirming canvas measurement and width caching.
- `node_modules/@chenglou/pretext/src/line-break.ts` — Local installed Pretext source confirming arithmetic line walking over prepared width arrays.
- `node_modules/@chenglou/pretext/package.json` and `node_modules/@chenglou/pretext/LICENSE` — MIT license confirmation for attribution context.
- `https://github.com/dagrejs/dagre` — Upstream Dagre project to research before implementing the wrapper.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/ir/geometry.ts` — Existing `Point`, `Size`, `Box`, `Insets`, `DiagramDirection`, `AnchorName`, and `AnchorPoint` contracts for layout/routing APIs.
- `src/ir/elements.ts` — Existing intent, normalized, and coordinated node/edge/group contracts; Phase 3 should fill `CoordinatedNode.box`, `CoordinatedNode.anchors`, `CoordinatedEdge.points`, and `CoordinatedGroup.box`.
- `src/ir/constraints.ts` — Existing `exact-position`, `relative-position`, `align`, `distribute`, and `containment` constraint types.
- `src/ir/diagnostics.ts` — Existing diagnostic shape for conflict and recovery messages.
- `src/geometry/boxes.ts` — Existing box validation, center, expansion, union, and AABB intersection helpers.
- `src/geometry/shapes.ts` — Existing shape anchors, obstacle boxes, and edge-port approximations for seven v1 shapes.
- `src/geometry/containers.ts` — Existing known-child container geometry helper that Phase 3 should reuse after child boxes are solved.
- `src/serialization/canonical.ts` — Existing canonical serializer for Phase 3 coordinated IR fixtures.

### Established Patterns

- Public APIs are exported through `src/index.ts` and validated from the package root in tests.
- Canonical fixtures live under `test/fixtures/phase-XX` and are compared against `stringifyCanonical()` output.
- Core modules remain renderer-neutral; Phase 3 should not introduce SVG, HTML, CSS, Excalidraw, Mermaid, or draw.io fields into geometry APIs.
- Commands in this repository must use the `rtk` prefix.

### Integration Points

- Add a Dagre dependency and layout wrapper that consumes `NormalizedNode.size`, `NormalizedEdge`, and `DiagramDirection`.
- Add constraint helpers/solver that consumes Dagre output plus `Constraint[]` and returns final node boxes plus diagnostics.
- Add routing helpers that consume final node shape geometry, edge endpoints, and obstacle boxes and return simplified point arrays.
- Add a solve/coordinator entrypoint that converts `NormalizedDiagram` to `CoordinatedDiagram` without requiring DSL or exporter code.

</code_context>

<specifics>
## Specific Ideas

- The user confirmed the full Phase 3 discussion defaults: Dagre is initial layout only, fixed nodes are hard locks, constraints use deterministic precedence, containers are first-class but simple, and routing starts with deterministic straight/orthogonal paths rather than full A*.
- The user specifically asked to check how Pretext calculates. The confirmed takeaway is that Pretext pushes expensive measurement and language handling into `prepare()` and keeps `layout()` as cached-width arithmetic; DGE should mirror the staged computation discipline while acknowledging graph layout has more dimensions and constraints than text wrapping.
- `@chenglou/pretext` is MIT licensed and already credited in the README; DGE should remain MIT as previously decided.

</specifics>

<deferred>
## Deferred Ideas

- Full grid A* orthogonal routing and advanced spatial partitioning belong after simple deterministic candidate routing works.
- Precise mathematical boundary intersection for non-rectangular shapes remains deferred from Phase 2.
- SVG/Excalidraw golden rendering checks belong to Phase 4.
- YAML/JSON DSL expression of route/constraint options belongs to Phase 5.
- HTML preview and visual review UI remain v2/future work.

</deferred>

---

*Phase: 03-layout-constraints-and-routing*
*Context gathered: 2026-05-24*
