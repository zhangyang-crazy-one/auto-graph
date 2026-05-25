# Phase 03: Layout, Constraints, And Routing - Research

**Researched:** 2026-05-25
**Domain:** TypeScript graph layout, deterministic constraints, container solving, and connector routing
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Claude's Discretion

- Exact TypeScript names, file splits, and helper class/function shapes are flexible if the module boundaries remain clear.
- The planner may choose the exact Dagre wrapper API and spacing defaults, provided output is deterministic and directions map cleanly to existing `DiagramDirection`.
- The planner may decide whether to expose route options on edges immediately or keep them internal until the DSL phase, as long as straight and orthogonal routing are testable.
- The planner may choose diagnostic code names and severity thresholds, but conflicts must never be silent.

### Deferred Ideas (OUT OF SCOPE)

- Full grid A* orthogonal routing and advanced spatial partitioning belong after simple deterministic candidate routing works.
- Precise mathematical boundary intersection for non-rectangular shapes remains deferred from Phase 2.
- SVG/Excalidraw golden rendering checks belong to Phase 4.
- YAML/JSON DSL expression of route/constraint options belongs to Phase 5.
- HTML preview and visual review UI remain v2/future work.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LAY-01 | User can produce an automatic directed graph layout using Dagre-backed placement with TB, LR, BT, and RL directions. [VERIFIED: .planning/REQUIREMENTS.md] | Use `@dagrejs/dagre@3.0.0` with `Graph`, `layout()`, node `width/height`, and `rankdir` mapping. [VERIFIED: Context7 /dagrejs/dagre; VERIFIED: npm registry; VERIFIED: package dist types] |
| LAY-02 | User can mix fixed nodes with automatic layout for remaining nodes. [VERIFIED: .planning/REQUIREMENTS.md] | Treat fixed positions and `exact-position` constraints as hard locks, translate auto nodes relative to fixed obstacles, and diagnose unresolved overlaps. [VERIFIED: 03-CONTEXT.md] |
| LAY-03 | User can apply exact, relative, align, distribute, and containment padding constraints after initial layout. [VERIFIED: .planning/REQUIREMENTS.md] | Apply constraints in the locked precedence order over prepared boxes, not by rerunning Dagre. [VERIFIED: 03-CONTEXT.md] |
| LAY-04 | User receives diagnostics when constraints conflict or cannot be satisfied without overlap. [VERIFIED: .planning/REQUIREMENTS.md] | Reuse `Diagnostic` severity/code/message/path/detail and return partial coordinated diagrams when safe. [VERIFIED: src/ir/diagnostics.ts; VERIFIED: 03-CONTEXT.md] |
| RTE-01 | User can generate straight and orthogonal connector paths between node anchors. [VERIFIED: .planning/REQUIREMENTS.md] | Build routes from Phase 2 `computeShapeGeometry()` and `getEdgePort()`. [VERIFIED: src/geometry/shapes.ts] |
| RTE-02 | Orthogonal connector paths avoid source and target interiors and simple rectangular obstacles in fixture diagrams. [VERIFIED: .planning/REQUIREMENTS.md] | Use deterministic candidate elbows and AABB checks with existing `intersectsAabb()`. [VERIFIED: src/geometry/boxes.ts; VERIFIED: 03-CONTEXT.md] |
| RTE-03 | Connector output is simplified by merging collinear segments and removing redundant points. [VERIFIED: .planning/REQUIREMENTS.md] | Add a route simplifier before assigning `CoordinatedEdge.points`. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/elements.ts] |
</phase_requirements>

## Summary

Phase 3 should implement a renderer-neutral solve pipeline: prepare a stable graph/layout state from `NormalizedDiagram`, run Dagre once for initial center coordinates, convert Dagre centers to DGE top-left boxes, apply hard locks and constraints in the locked precedence order, solve simple containers from known child boxes, compute anchors/obstacles, route edges, simplify routes, and emit `CoordinatedDiagram` with diagnostics. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/diagram.ts; VERIFIED: src/ir/elements.ts]

The standard stack is the existing TypeScript/Vitest package plus one runtime dependency, `@dagrejs/dagre@3.0.0`; Dagre already exports `Graph`, `layout`, type definitions, ESM/CJS entrypoints, and its transitive `@dagrejs/graphlib@4.0.1` dependency. [VERIFIED: npm registry; VERIFIED: package dist types; VERIFIED: Context7 /dagrejs/dagre] DGE should not add a constraint solver, physics engine, pathfinding library, renderer dependency, or browser measurement dependency in this phase. [VERIFIED: 03-CONTEXT.md; VERIFIED: AGENTS.md]

**Primary recommendation:** Implement a small deterministic `solveDiagram()` coordinator backed by `layout/`, `constraints/`, and `routing/` modules; keep Dagre as replaceable initial placement and make coordinated IR the only Phase 4 exporter contract. [VERIFIED: .planning/research/ARCHITECTURE.md; VERIFIED: 03-CONTEXT.md]

## Project Constraints (from AGENTS.md)

- Prefix local shell commands with `rtk`. [VERIFIED: AGENTS.md; VERIFIED: /home/zhangyangrui/.codex/RTK.md]
- Runtime is TypeScript on Node.js first. [VERIFIED: AGENTS.md]
- Keep prepare/solve/export separation. [VERIFIED: AGENTS.md]
- Same input must produce byte-stable or numerically stable output. [VERIFIED: AGENTS.md]
- Text measurement must remain abstracted behind an interface. [VERIFIED: AGENTS.md]
- Golden tests must catch text overflow, connector misalignment, collisions, non-deterministic output, and malformed exports. [VERIFIED: AGENTS.md]
- v1 scope focuses on core library, CLI, SVG, Excalidraw, and enough layout/routing for architecture and flow diagrams. [VERIFIED: AGENTS.md]
- Start file-changing work through a GSD command unless the user explicitly asks to bypass it. [VERIFIED: AGENTS.md]
- Public APIs should continue to export through the package root rather than package subpaths. [VERIFIED: package.json; VERIFIED: test/public-api.test.ts; VERIFIED: 02-05-SUMMARY.md]
- Core modules must remain renderer-neutral and must not introduce SVG, HTML, CSS, Excalidraw, Mermaid, or draw.io fields into geometry APIs. [VERIFIED: 02-CONTEXT.md; VERIFIED: 03-CONTEXT.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Dagre initial layout | Core library solve tier | Runtime dependency `@dagrejs/dagre` | The library owns deterministic coordinates, while Dagre supplies only initial directed placement. [VERIFIED: 03-CONTEXT.md; VERIFIED: Context7 /dagrejs/dagre] |
| Fixed-node hybrid layout | Core library solve tier | Diagnostics tier | Fixed coordinates are part of the final geometry contract and conflicts must be reported. [VERIFIED: 03-CONTEXT.md] |
| Constraint precedence | Core library constraints tier | Diagnostics tier | Constraint application occurs after initial layout and before routing. [VERIFIED: 03-CONTEXT.md; VERIFIED: .planning/research/ARCHITECTURE.md] |
| Container/group solving | Core library geometry tier | Constraints tier | Phase 2 already computes known-child container geometry; Phase 3 decides child/container placement relationships. [VERIFIED: src/geometry/containers.ts; VERIFIED: 03-CONTEXT.md] |
| Straight/orthogonal routing | Core library routing tier | Shape geometry tier | Routes consume anchors, edge ports, and obstacle boxes from geometry. [VERIFIED: src/geometry/shapes.ts; VERIFIED: src/geometry/boxes.ts] |
| Coordinated IR fixtures | Test/validation tier | Serialization tier | Canonical fixture tests already use `stringifyCanonical()` with stable sorting and point-order preservation. [VERIFIED: src/serialization/canonical.ts; VERIFIED: test/serialization.test.ts] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 6.0.3 | Strict library implementation and declaration output. [VERIFIED: package.json; VERIFIED: local `./node_modules/.bin/tsc --version`] | Existing project language and build target. [VERIFIED: AGENTS.md; VERIFIED: tsconfig.json] |
| Node.js | >=20 in package, v24.13.0 available locally | Runtime for tests, build, and future CLI. [VERIFIED: package.json; VERIFIED: local `node --version`] | Project requires Node-first TypeScript and avoids Python subprocess complexity. [VERIFIED: AGENTS.md] |
| `@dagrejs/dagre` | 3.0.0, published 2026-03-22 | Directed graph initial layout. [VERIFIED: npm registry; VERIFIED: Context7 /dagrejs/dagre] | It provides JavaScript graph layout, ESM/CJS exports, bundled types, `Graph`, and `layout()`. [VERIFIED: npm registry; VERIFIED: package dist types] |
| `@chenglou/pretext` | 0.0.7, published 2026-05-10 | Existing Phase 2 text measurement backend. [VERIFIED: npm registry; VERIFIED: package.json] | Phase 3 consumes measured node sizes and must not remeasure labels. [VERIFIED: 03-CONTEXT.md] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@dagrejs/graphlib` | 4.0.1, published 2026-03-08 | Graph storage used by Dagre. [VERIFIED: npm registry; VERIFIED: `@dagrejs/dagre@3.0.0` package metadata] | Do not install directly unless implementation needs graphlib APIs not re-exported by Dagre. [VERIFIED: package dist types] |
| Vitest | 4.1.7 | Numeric unit, negative, determinism, and fixture tests. [VERIFIED: package.json; VERIFIED: local `npx vitest --version`] | Existing test framework and Node environment. [VERIFIED: vitest.config.ts] |
| tsup | 8.5.1 | Build ESM/CJS package output. [VERIFIED: package.json; VERIFIED: local `npx tsup --version`] | Existing build command. [VERIFIED: package.json] |
| Biome | 2.4.15 | Lint and format gate. [VERIFIED: package.json; VERIFIED: local `npx biome --version`] | Existing `npm run lint` and `npm run verify` gate. [VERIFIED: package.json] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Dagre initial layout | Graphviz subprocess | Out of v1 stack because it adds installation/runtime complexity and a separate layout model. [VERIFIED: AGENTS.md; VERIFIED: .planning/research/STACK.md] |
| Layered numeric constraints | SAT/SMT solver | Out of Phase 3 because v1 requires simple deterministic precedence and diagnostics. [VERIFIED: 03-CONTEXT.md] |
| Candidate orthogonal routing | Grid A* pathfinding | Deferred until simple deterministic routing works. [VERIFIED: 03-CONTEXT.md] |
| Numeric coordinated fixtures | SVG/Excalidraw goldens | Exporter goldens belong to Phase 4 after coordinated IR stabilizes. [VERIFIED: 03-CONTEXT.md] |

**Installation:**

```bash
rtk npm install @dagrejs/dagre@3.0.0
```

**Version verification:** `npm view @dagrejs/dagre version time --json` returned version `3.0.0` with publish time `2026-03-22T16:11:26.902Z`; `npm view @dagrejs/graphlib version time --json` returned version `4.0.1` with publish time `2026-03-08T10:33:18.534Z`; `npm view @chenglou/pretext version time license --json` returned version `0.0.7`, publish time `2026-05-10T07:36:30.751Z`, and MIT license. [VERIFIED: npm registry]

## Architecture Patterns

### System Architecture Diagram

```text
NormalizedDiagram
  -> prepareLayoutInput()
       nodes: measured size + shape + parentId
       edges: source/target endpoint refs
       constraints: stable sorted worklists
       groups: child membership + padding
  -> runDagreInitialLayout()
       Graph({ multigraph: true, compound: false for v1 wrapper })
       setGraph({ rankdir, nodesep, ranksep, edgesep, marginx, marginy, ranker })
       setNode(id, { width, height })
       setEdge(source, target, { minlen, weight })
       layout(g)
  -> convert centers to boxes
  -> applyHardLocks()
       position metadata + exact-position constraints
  -> applyConstraintsInOrder()
       containment -> relative-position -> align -> distribute
       branch: unresolved/missing/impossible -> diagnostics
  -> resolveAutoOverlapsNearFixed()
       branch: adjusted auto nodes -> continue
       branch: unresolved overlap -> warning/error diagnostic
  -> solveGroupsAndContainers()
       child boxes -> computeContainerGeometry()
       fixed container -> content-box fit diagnostics
  -> computeShapeGeometry()
       node anchors + obstacle boxes
  -> routeEdges()
       explicit anchors or direction-based ports
       straight or orthogonal candidate route
       AABB obstacle checks
       simplifyRoute()
  -> build CoordinatedDiagram
       nodes + edges + groups + bounds + diagnostics
```

All steps are renderer-neutral and operate on existing IR geometry primitives. [VERIFIED: src/ir/geometry.ts; VERIFIED: src/ir/elements.ts; VERIFIED: 03-CONTEXT.md]

### Recommended Project Structure

```text
src/
├── layout/              # Dagre wrapper, layout options, initial node boxes
├── constraints/         # Constraint normalization, precedence solver, conflict diagnostics
├── routing/             # Anchor selection, straight/orthogonal routes, simplification
├── solver/              # solveDiagram() coordinator producing CoordinatedDiagram
├── geometry/            # Existing boxes/shapes/containers reused by solver
└── ir/                  # Existing public contracts; minimal route option additions only if needed

test/
├── layout.test.ts
├── constraints.test.ts
├── routing.test.ts
├── solver.test.ts
├── determinism.test.ts
└── fixtures/phase-03/
    ├── dagre-directions.canonical.json
    ├── hybrid-layout.canonical.json
    ├── constraints.canonical.json
    └── routing.canonical.json
```

This structure matches the existing one-package, root-export pattern. [VERIFIED: src/index.ts; VERIFIED: package.json; VERIFIED: 02-05-SUMMARY.md]

### Pattern 1: Dagre Wrapper

**What:** Build a small wrapper that turns normalized nodes/edges into a Dagre `Graph`, runs `layout(g)`, and returns DGE boxes keyed by node ID. [VERIFIED: Context7 /dagrejs/dagre; VERIFIED: package dist types]

**When to use:** Use for initial automatic placement only, before fixed overrides and constraints. [VERIFIED: 03-CONTEXT.md]

**Example:**

```typescript
// Source: Context7 /dagrejs/dagre and @dagrejs/dagre@3.0.0 dist types
import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";

const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
graph.setGraph({
	rankdir: diagram.direction,
	nodesep: 80,
	ranksep: 100,
	edgesep: 40,
	marginx: 0,
	marginy: 0,
	ranker: "network-simplex",
});

for (const node of stableNodes) {
	graph.setNode(node.id, { width: node.size.width, height: node.size.height });
}

for (const edge of stableEdges) {
	graph.setEdge(edge.source.nodeId, edge.target.nodeId, { minlen: 1, weight: 1 }, edge.id);
}

layout(graph);

const label = graph.node(node.id);
const box = {
	x: label.x! - node.size.width / 2,
	y: label.y! - node.size.height / 2,
	width: node.size.width,
	height: node.size.height,
};
```

### Pattern 2: Prepared Solve State

**What:** Convert arrays to stable maps and sorted worklists before solving. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/serialization/canonical.ts]

**When to use:** Use once per `solveDiagram()` call, before Dagre and constraints. [VERIFIED: 03-CONTEXT.md]

**Example:**

```typescript
// Source: Existing IR contracts in src/ir/*.ts
interface PreparedLayoutState {
	direction: DiagramDirection;
	nodesById: Map<string, NormalizedNode>;
	edges: NormalizedEdge[];
	constraintsByPrecedence: {
		exact: ExactPositionConstraint[];
		containment: ContainmentConstraint[];
		relative: RelativePositionConstraint[];
		align: AlignConstraint[];
		distribute: DistributeConstraint[];
	};
	diagnostics: Diagnostic[];
}
```

### Pattern 3: Constraint Layering

**What:** Apply constraints in the locked order and mutate a local `Map<string, Box>` copy, never the normalized input. [VERIFIED: 03-CONTEXT.md]

**When to use:** Use after Dagre centers are converted to boxes and before routing. [VERIFIED: .planning/research/ARCHITECTURE.md]

**Example:**

```typescript
// Source: Constraint precedence locked in 03-CONTEXT.md
const boxes = new Map(initialBoxes);
applyExactPositions(boxes, exactConstraints, lockState, diagnostics);
applyContainment(boxes, containmentConstraints, groupState, diagnostics);
applyRelativePositions(boxes, relativeConstraints, lockState, diagnostics);
applyAlignment(boxes, alignConstraints, lockState, diagnostics);
applyDistribution(boxes, distributeConstraints, lockState, diagnostics);
detectConflictsAndOverlaps(boxes, lockState, diagnostics);
```

### Pattern 4: Candidate Orthogonal Routing

**What:** Generate a deterministic list of one- and two-elbow orthogonal paths, reject candidates crossing blocked AABBs, then simplify the first valid candidate. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/geometry/boxes.ts]

**When to use:** Use as the default route style when no edge-level route option requests straight routing. [VERIFIED: 03-CONTEXT.md]

**Example:**

```typescript
// Source: Phase 2 shape/box helpers and Phase 3 routing scope
const sourcePort = getEdgePort(sourceGeometry, targetGeometry.center, edge.source.anchor);
const targetPort = getEdgePort(targetGeometry, sourceGeometry.center, edge.target.anchor);

const candidates = [
	[sourcePort, { x: targetPort.x, y: sourcePort.y }, targetPort],
	[sourcePort, { x: sourcePort.x, y: targetPort.y }, targetPort],
	[sourcePort, midpointDogleg(sourcePort, targetPort, direction), targetPort],
];

const points = simplifyRoute(
	candidates.find((candidate) => !routeIntersectsObstacles(candidate, obstacles)) ??
		candidates[0],
);
```

### Anti-Patterns to Avoid

- **Rerunning Dagre after constraints:** It would make fixed positions and exact constraints non-authoritative. [VERIFIED: 03-CONTEXT.md]
- **Using Dagre edge points as final DGE routes:** Dagre can produce edge points, but Phase 3 requires DGE-owned anchors, obstacle boxes, orthogonal/straight options, and route simplification. [VERIFIED: package dist types; VERIFIED: 03-CONTEXT.md]
- **Adding exporter fields to coordinated geometry:** Core modules are renderer-neutral and Phase 4 owns SVG/Excalidraw. [VERIFIED: 02-CONTEXT.md; VERIFIED: 03-CONTEXT.md]
- **Throwing for all constraint problems:** The locked decision prefers partial coordinated output plus diagnostics when coordinates remain safe. [VERIFIED: 03-CONTEXT.md]
- **Solving v1 constraints with SAT/SMT or physics:** Phase 3 scope requires deterministic layered numeric adjustments. [VERIFIED: 03-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Directed graph ranking and coarse placement | Custom Sugiyama/layered graph layout | `@dagrejs/dagre` | Dagre already provides directed graph layout, rank directions, spacing options, and TypeScript declarations. [VERIFIED: Context7 /dagrejs/dagre; VERIFIED: package dist types] |
| Text measurement during layout | Recalculate label sizes or call Pretext in Phase 3 | Phase 2 `NormalizedNode.size` and label layout outputs | Text measurement is Phase 2's responsibility and Phase 3 must not remeasure. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/elements.ts] |
| Shape anchors and port approximations | New shape math in routing | `computeShapeGeometry()` and `getEdgePort()` | Phase 2 already supports seven v1 shapes, anchors, obstacle boxes, and deterministic edge ports. [VERIFIED: src/geometry/shapes.ts] |
| Known-child group bounds | Duplicate container union/padding logic | `computeContainerGeometry()` | Phase 2 already computes child bounds, content box, anchors, and obstacle box from child boxes. [VERIFIED: src/geometry/containers.ts] |
| Canonical fixture serialization | Ad hoc JSON stringify/sort logic | `stringifyCanonical()` | Existing serializer rounds finite numbers, removes negative zero, sorts unordered collections, and preserves point order. [VERIFIED: src/serialization/canonical.ts; VERIFIED: test/serialization.test.ts] |

**Key insight:** The hard work in Phase 3 is ownership ordering, not algorithm novelty: Dagre gives a useful suggestion, but DGE must deterministically enforce locks, constraints, containers, anchors, obstacle checks, and diagnostics before any exporter sees geometry. [VERIFIED: 03-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Dagre Center Coordinates Treated As Top-Left Boxes

**What goes wrong:** Nodes shift by half their width/height and routes start from visually wrong anchors. [VERIFIED: package dist types; VERIFIED: Context7 /dagrejs/dagre]

**Why it happens:** Dagre node labels expose `x` and `y` as center coordinates after layout, while DGE `Box` uses `x/y/width/height` with top-left semantics. [VERIFIED: src/ir/geometry.ts; VERIFIED: Context7 /dagrejs/dagre]

**How to avoid:** Convert `x = center.x - width / 2` and `y = center.y - height / 2` immediately after Dagre. [VERIFIED: src/ir/geometry.ts; VERIFIED: package dist types]

**Warning signs:** Direction tests show plausible spacing but anchors/routes are offset by half a node. [ASSUMED]

### Pitfall 2: Fixed Nodes Silently Moved By Later Constraints

**What goes wrong:** A fixed node satisfies align/distribute but violates user placement. [VERIFIED: 03-CONTEXT.md]

**Why it happens:** Constraint code does not carry lock state from `position` or `exact-position`. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/elements.ts; VERIFIED: src/ir/constraints.ts]

**How to avoid:** Maintain `lockedNodeIds` with lock source and reject weaker moves against locked boxes with diagnostics. [VERIFIED: 03-CONTEXT.md]

**Warning signs:** Hybrid fixtures pass without checking the fixed node's exact coordinates. [ASSUMED]

### Pitfall 3: Constraint Conflicts Hidden As "Best Effort"

**What goes wrong:** Coordinated IR appears valid but violates a constraint without any diagnostic. [VERIFIED: .planning/research/PITFALLS.md; VERIFIED: 03-CONTEXT.md]

**Why it happens:** Layered numeric solvers can overwrite earlier moves unless they validate postconditions. [ASSUMED]

**How to avoid:** After each constraint family, verify the affected relation and emit stable diagnostics for missing refs, locked-target conflicts, non-finite numbers, impossible containment, and unresolved overlaps. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/diagnostics.ts]

**Warning signs:** Negative fixtures only assert coordinates and not diagnostic codes. [ASSUMED]

### Pitfall 4: Orthogonal Routes Intersect Source Or Target Interiors

**What goes wrong:** A connector visually cuts through a node instead of leaving from an edge port. [VERIFIED: 03-CONTEXT.md]

**Why it happens:** Candidate elbows are generated from centers or unsnapped anchors instead of shape ports. [VERIFIED: src/geometry/shapes.ts]

**How to avoid:** Compute ports with `getEdgePort()` and test line segments against expanded source/target obstacle boxes after excluding legal endpoint contact. [VERIFIED: src/geometry/shapes.ts; VERIFIED: src/geometry/boxes.ts]

**Warning signs:** Straight routes pass while orthogonal fixtures fail on nodes with larger widths. [ASSUMED]

### Pitfall 5: Route Simplification Changes Semantic Point Order

**What goes wrong:** Simplifier sorts points or removes necessary elbows, producing invalid paths. [VERIFIED: src/serialization/canonical.ts; VERIFIED: test/serialization.test.ts]

**Why it happens:** Existing canonical serializer intentionally preserves `points` order, so routing must also treat point arrays as ordered paths. [VERIFIED: src/serialization/canonical.ts]

**How to avoid:** Simplify with a single left-to-right pass: drop exact duplicate consecutive points and middle points where previous/current/next are collinear. [ASSUMED]

**Warning signs:** A fixture's canonical JSON changes by point reordering rather than numeric route change. [VERIFIED: test/serialization.test.ts]

## Code Examples

### Stable Layout Wrapper Return Shape

```typescript
// Source: src/ir/geometry.ts, src/ir/elements.ts, and @dagrejs/dagre dist types
export interface LayoutNodeBox {
	id: string;
	box: Box;
	rank?: number;
	order?: number;
}

export interface DagreLayoutOptions {
	direction: DiagramDirection;
	nodesep?: number;
	ranksep?: number;
	edgesep?: number;
	marginx?: number;
	marginy?: number;
	ranker?: "network-simplex" | "tight-tree" | "longest-path";
}
```

### Diagnostic Shape For Constraint Conflicts

```typescript
// Source: src/ir/diagnostics.ts
const diagnostic: Diagnostic = {
	severity: "warning",
	code: "constraints.locked-target-not-moved",
	message: "Constraint could not move locked node.",
	path: ["constraints", constraintIndex],
	detail: {
		constraintId: constraint.id ?? null,
		nodeId,
		lockSource: "exact-position",
	},
};
```

### Route Simplifier

```typescript
// Source: RTE-03 and point-order preservation in src/serialization/canonical.ts
export function simplifyRoute(points: readonly Point[]): Point[] {
	const deduped = points.filter((point, index) => {
		const previous = points[index - 1];
		return previous === undefined || point.x !== previous.x || point.y !== previous.y;
	});

	return deduped.filter((point, index) => {
		const previous = deduped[index - 1];
		const next = deduped[index + 1];
		if (previous === undefined || next === undefined) return true;
		return !(
			(previous.x === point.x && point.x === next.x) ||
			(previous.y === point.y && point.y === next.y)
		);
	});
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Legacy `dagre` npm package | Scoped `@dagrejs/dagre` package | The current package README states only the DagreJS org package is receiving updates. [VERIFIED: `@dagrejs/dagre@3.0.0` README] | Install `@dagrejs/dagre`, not the older unscoped package. [VERIFIED: `@dagrejs/dagre@3.0.0` README] |
| Dagre as final geometry engine | Dagre as initial placement only | Locked in Phase 3 discussion on 2026-05-24. [VERIFIED: 03-CONTEXT.md] | DGE owns fixed overrides, constraints, containers, anchors, routing, and diagnostics. [VERIFIED: 03-CONTEXT.md] |
| Rendering-based verification | Numeric coordinated IR verification | Established by Phase 2 fixture pattern. [VERIFIED: 02-05-SUMMARY.md] | Phase 3 should create canonical coordinated fixtures before exporter goldens. [VERIFIED: 03-CONTEXT.md] |

**Deprecated/outdated:**

- Direct Graphviz subprocess layout is not the first v1 route because the project is TypeScript-first and Dagre-native. [VERIFIED: AGENTS.md; VERIFIED: .planning/research/STACK.md]
- Full A* orthogonal routing is deferred because Phase 3 scope is deterministic candidate paths and simple AABB checks. [VERIFIED: 03-CONTEXT.md]
- Exporter-driven geometry is invalid because exporters must consume coordinated IR only. [VERIFIED: 03-CONTEXT.md; VERIFIED: .planning/research/ARCHITECTURE.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Warning signs about half-node offset can be detected by anchor/route offsets. | Common Pitfalls | Low; tests can catch it even if the symptom wording differs. |
| A2 | Hybrid fixtures should explicitly assert fixed node exact coordinates. | Common Pitfalls | Medium; missing this assertion could let LAY-02 regress. |
| A3 | Layered numeric solvers can overwrite earlier moves unless they validate postconditions. | Common Pitfalls | Low; this is standard implementation risk, and mitigation is already locked by diagnostics. |
| A4 | A route simplifier should use a single pass over duplicate and collinear points. | Common Pitfalls / Code Examples | Low; implementation can choose equivalent deterministic logic. |

## Open Questions (RESOLVED)

1. **Should route style be added to public IR now?**
   - What we know: Phase 3 must test straight and orthogonal routing, and edge endpoints already support optional anchors. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/elements.ts]
   - What's unclear: `NormalizedEdge` has no route-style property today. [VERIFIED: src/ir/elements.ts]
   - RESOLVED: Phase 3 should expose route style through solver/routing options and keep `NormalizedEdge` unchanged unless implementation tests prove a public IR field is necessary. DSL-level route style belongs to Phase 5. [VERIFIED: 03-CONTEXT.md]

2. **How far should auto-node overlap repair go?**
   - What we know: Fixed nodes are hard locks, auto nodes may move, and unresolved overlap should produce diagnostics. [VERIFIED: 03-CONTEXT.md]
   - What's unclear: The exact adjustment budget and direction are discretionary. [VERIFIED: 03-CONTEXT.md]
   - RESOLVED: Use a bounded deterministic repair pass: push automatic nodes along the primary diagram axis using stable sorted IDs and configured spacing, never move fixed/exact nodes, then emit diagnostics for remaining overlaps. [VERIFIED: 03-CONTEXT.md]

3. **Should Dagre compound graph support be used for groups in Phase 3?**
   - What we know: Dagre and graphlib support compound graphs in types/API. [VERIFIED: package dist types]
   - What's unclear: Phase 3 locked simple container solving and deferred complex nested layout. [VERIFIED: 03-CONTEXT.md]
   - RESOLVED: Do not use Dagre compound layout in the Phase 3 wrapper. Solve groups after child boxes through `computeContainerGeometry()` and emit containment diagnostics for fixed containers whose children cannot fit. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/geometry/containers.ts]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Build/test/CLI runtime | Yes | v24.13.0 | Package minimum is Node >=20. [VERIFIED: local `node --version`; VERIFIED: package.json] |
| npm | Install Dagre and run scripts | Yes | 10.9.7 | None needed. [VERIFIED: local `npm --version`] |
| TypeScript | Typecheck | Yes | 6.0.3 local package | None needed. [VERIFIED: package.json; VERIFIED: local `./node_modules/.bin/tsc --version`] |
| Vitest | Unit and fixture tests | Yes | 4.1.7 | None needed. [VERIFIED: package.json; VERIFIED: local `npx vitest --version`] |
| tsup | Build | Yes | 8.5.1 | None needed. [VERIFIED: package.json; VERIFIED: local `npx tsup --version`] |
| Biome | Lint | Yes | 2.4.15 | None needed. [VERIFIED: package.json; VERIFIED: local `npx biome --version`] |
| `@dagrejs/dagre` | Phase 3 layout | No, not installed yet | 3.0.0 current on npm | Add dependency with `rtk npm install @dagrejs/dagre@3.0.0`. [VERIFIED: local `ls node_modules/@dagrejs/dagre/package.json`; VERIFIED: npm registry] |
| `@chenglou/pretext` | Existing Phase 2 text measurement | Yes | 0.0.7 | Already installed. [VERIFIED: local `ls node_modules/@chenglou/pretext/package.json`; VERIFIED: package.json] |

**Missing dependencies with no fallback:**

- `@dagrejs/dagre` is missing from `node_modules` and `package.json`; planner must include an install/update task. [VERIFIED: package.json; VERIFIED: local `ls node_modules/@dagrejs/dagre/package.json`]

**Missing dependencies with fallback:**

- None. [VERIFIED: environment audit]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.7. [VERIFIED: package.json; VERIFIED: local `npx vitest --version`] |
| Config file | `vitest.config.ts`, Node environment, `test/**/*.test.ts`. [VERIFIED: vitest.config.ts] |
| Quick run command | `rtk npm test -- layout constraints routing solver determinism` [VERIFIED: package.json pattern; ASSUMED test filenames] |
| Full suite command | `rtk npm run verify` [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| LAY-01 | Dagre-backed TB/LR/BT/RL placement from measured node sizes. [VERIFIED: .planning/REQUIREMENTS.md] | unit + fixture | `rtk npm test -- layout` | No, Wave 0. [VERIFIED: `find src test`] |
| LAY-02 | Fixed nodes coexist with auto nodes and fixed boxes remain unchanged. [VERIFIED: .planning/REQUIREMENTS.md] | unit + fixture | `rtk npm test -- solver` | No, Wave 0. [VERIFIED: `find src test`] |
| LAY-03 | exact, containment, relative, align, distribute apply in precedence order. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: 03-CONTEXT.md] | unit | `rtk npm test -- constraints` | No, Wave 0. [VERIFIED: `find src test`] |
| LAY-04 | Missing refs, conflicts, impossible containment, and unresolved overlaps emit diagnostics. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: 03-CONTEXT.md] | negative unit | `rtk npm test -- constraints solver` | No, Wave 0. [VERIFIED: `find src test`] |
| RTE-01 | Straight and orthogonal connector paths use shape anchors/ports. [VERIFIED: .planning/REQUIREMENTS.md] | unit | `rtk npm test -- routing` | No, Wave 0. [VERIFIED: `find src test`] |
| RTE-02 | Orthogonal fixtures avoid source/target interiors and simple rectangular obstacles. [VERIFIED: .planning/REQUIREMENTS.md] | unit + fixture | `rtk npm test -- routing` | No, Wave 0. [VERIFIED: `find src test`] |
| RTE-03 | Route simplification removes repeated and collinear points without reordering semantic points. [VERIFIED: .planning/REQUIREMENTS.md] | unit | `rtk npm test -- routing serialization` | No, Wave 0. [VERIFIED: `find src test`] |

### Sampling Rate

- **Per task commit:** `rtk npm test -- layout constraints routing solver determinism` after relevant files exist. [VERIFIED: package.json; ASSUMED test filenames]
- **Per wave merge:** `rtk npm run typecheck && rtk npm test -- layout constraints routing solver determinism && rtk npm run lint`. [VERIFIED: package.json; ASSUMED test filenames]
- **Phase gate:** `rtk npm run verify` plus renderer-neutral grep over new Phase 3 modules. [VERIFIED: package.json; VERIFIED: 02-05-SUMMARY.md]

### Wave 0 Gaps

- [ ] `test/layout.test.ts` covers LAY-01 and Dagre option mapping. [VERIFIED: `find src test`]
- [ ] `test/constraints.test.ts` covers LAY-03 and LAY-04. [VERIFIED: `find src test`]
- [ ] `test/routing.test.ts` covers RTE-01, RTE-02, and RTE-03. [VERIFIED: `find src test`]
- [ ] `test/solver.test.ts` covers LAY-02 and integrated `CoordinatedDiagram`. [VERIFIED: `find src test`]
- [ ] `test/determinism.test.ts` covers repeated solve canonical equality. [VERIFIED: `find src test`]
- [ ] `test/fixtures/phase-03/*.canonical.json` fixture directory. [VERIFIED: `find src test`]
- [ ] `@dagrejs/dagre` dependency install. [VERIFIED: package.json]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No | No authentication surface in Phase 3 core library. [VERIFIED: Phase 3 scope in 03-CONTEXT.md] |
| V3 Session Management | No | No session surface in Phase 3 core library. [VERIFIED: Phase 3 scope in 03-CONTEXT.md] |
| V4 Access Control | No | No user/resource authorization surface in Phase 3 core library. [VERIFIED: Phase 3 scope in 03-CONTEXT.md] |
| V5 Input Validation | Yes | Validate finite numbers, missing references, unsupported anchors, invalid boxes, and impossible coordinates before coordinated IR is trusted. [VERIFIED: src/geometry/boxes.ts; VERIFIED: src/geometry/shapes.ts; VERIFIED: 03-CONTEXT.md] |
| V6 Cryptography | No | No cryptography surface in Phase 3. [VERIFIED: Phase 3 scope in 03-CONTEXT.md] |

### Known Threat Patterns for TypeScript Geometry Solver

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Non-finite numeric input creates NaN/Infinity output | Tampering | Reuse finite-number validation and diagnostic errors before serialization. [VERIFIED: src/geometry/boxes.ts; VERIFIED: src/serialization/canonical.ts] |
| Extremely large diagrams cause slow layout/routing | Denial of Service | Keep Phase 3 APIs deterministic, avoid unbounded pathfinding, and use simple candidate routing. [VERIFIED: 03-CONTEXT.md] |
| Malformed node/edge/constraint references corrupt output | Tampering | Emit error diagnostics for missing references and avoid unsafe coordinated output. [VERIFIED: 03-CONTEXT.md; VERIFIED: src/ir/diagnostics.ts] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/03-layout-constraints-and-routing/03-CONTEXT.md` - locked Phase 3 decisions, routing scope, diagnostics policy, and deferred ideas.
- `.planning/REQUIREMENTS.md` - LAY/RTE requirements.
- `.planning/ROADMAP.md` - Phase 3 goal and success criteria.
- `AGENTS.md` - project constraints and shell/GSD workflow rules.
- `src/ir/*.ts`, `src/geometry/*.ts`, `src/serialization/canonical.ts`, and tests - existing contracts and patterns.
- Context7 `/dagrejs/dagre` - Dagre API examples, graph options, TypeScript imports, and `layout()` usage.
- npm registry - package versions and publish times for `@dagrejs/dagre`, `@dagrejs/graphlib`, `@chenglou/pretext`, Vitest, and TypeScript.
- `@dagrejs/dagre@3.0.0` published package types - `GraphLabel`, `NodeLabel`, `EdgeLabel`, `LayoutOptions`, `Graph`, and `layout()` signatures.

### Secondary (MEDIUM confidence)

- `.planning/research/ARCHITECTURE.md` - proposed component boundaries and solve/export flow.
- `.planning/research/PITFALLS.md` - known project risks.
- `@dagrejs/dagre@3.0.0` README - scoped package is currently the updated npm package and license is MIT.

### Tertiary (LOW confidence)

- Assumptions listed in the Assumptions Log about warning signs and simple route simplifier implementation shape.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - verified through package.json, npm registry, Context7, and Dagre published type files.
- Architecture: HIGH - locked by Phase 3 CONTEXT and existing IR/geometry modules.
- Pitfalls: MEDIUM - core pitfalls are verified by project decisions, while a few warning-sign descriptions are implementation-risk assumptions.

**Research date:** 2026-05-25
**Valid until:** 2026-06-01 for Dagre package/version details; project-local architecture constraints remain valid until the next phase context changes.
