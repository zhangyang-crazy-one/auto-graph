# Phase 3: Layout, Constraints, And Routing - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 03-layout-constraints-and-routing
**Areas discussed:** Dagre boundary, fixed-node hybrid layout, constraint precedence, container solving, routing scope, Pretext calculation model

---

## Discussion Scope

| Option | Description | Selected |
|--------|-------------|----------|
| 全部讨论 | 依次锁定 Dagre 边界、固定节点、约束优先级、容器求解和路由范围。 | ✓ |
| 核心优先 | 只讨论会阻塞规划的固定节点、约束冲突和容器边界。 | |
| 我来指定 | 用户指定要先讨论哪些点，其他由 agent 暂定。 | |

**User's choice:** 全部讨论
**Notes:** The environment could not show an interactive picker, so text-mode selection was used.

---

## Default Decision Set

| Option | Description | Selected |
|--------|-------------|----------|
| 确认 | Lock all proposed defaults for Dagre boundary, fixed nodes, constraint precedence, containers, and routing. | ✓ |
| 修改某条 | User edits one or more numbered defaults before context creation. | |
| 逐条讨论 | Discuss each default separately before locking. | |

**User's choice:** 确认
**Notes:** User confirmed the proposed decisions, with an extra request to inspect how Pretext performs calculation.

---

## Dagre Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Dagre 初始布局 only | Dagre produces coarse placement from measured sizes and graph edges; DGE owns final geometry. | ✓ |
| Dagre owns more layout truth | Let Dagre decisions leak further into final geometry and exporters. | |

**User's choice:** Confirmed default.
**Notes:** Locked to keep coordinated IR as the final exporter contract.

---

## Fixed Nodes

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed nodes are hard locks | Never silently move fixed nodes; move automatic nodes or emit diagnostics. | ✓ |
| Fixed nodes can be adjusted | Solver may move fixed nodes to satisfy layout or avoid overlap. | |

**User's choice:** Confirmed default.
**Notes:** Supports hybrid fixed plus automatic layout without losing exact user intent.

---

## Constraint Precedence

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic layered precedence | fixed/exact > containment > relative > align > distribute > Dagre suggestion. | ✓ |
| Best-effort all constraints together | Solve constraints without a clear precedence order. | |

**User's choice:** Confirmed default.
**Notes:** Conflicts should produce diagnostics rather than silently corrupting geometry.

---

## Container Solving

| Option | Description | Selected |
|--------|-------------|----------|
| Simple first-class containers | Compute containers from child boxes; constrain children inside fixed containers with diagnostics. | ✓ |
| Complex nested layout solver | Build automatic grid/packing/container layout in Phase 3. | |

**User's choice:** Confirmed default.
**Notes:** Keeps Phase 3 focused on coordinated geometry while reusing Phase 2 known-child container geometry.

---

## Routing Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Straight + deterministic orthogonal | Default orthogonal; use candidate elbow paths and AABB obstacle checks; simplify output. | ✓ |
| Full A* grid routing now | Implement full grid A* obstacle avoidance in Phase 3. | |

**User's choice:** Confirmed default.
**Notes:** A* is explicitly deferred to avoid routing overbuild before simple diagrams work.

---

## Pretext Calculation Check

| Source | Finding | Selected |
|--------|---------|----------|
| `node_modules/@chenglou/pretext/src/layout.ts` | `prepare()` segments/measures/caches; `layout()` counts lines from cached widths. | ✓ |
| `node_modules/@chenglou/pretext/src/measurement.ts` | Measurement uses OffscreenCanvas or DOM canvas `measureText`, caches by font/segment, and applies emoji correction. | ✓ |
| `node_modules/@chenglou/pretext/src/line-break.ts` | Line walking is deterministic arithmetic over widths, segment kinds, and break opportunities. | ✓ |

**User's choice:** User asked to verify this before writing context.
**Notes:** Captured as a computation model influence, not as a direct graph-layout algorithm.

---

## the agent's Discretion

- Exact TypeScript naming and module split for layout, constraints, routing, and solver entrypoints.
- Exact Dagre wrapper options and spacing defaults, provided output remains deterministic.
- Exact diagnostic code names and severity split, provided conflicts are not silent.

## Deferred Ideas

- Full grid A* routing.
- Precise non-rectangular boundary intersection.
- SVG/Excalidraw golden rendering checks.
- DSL/CLI expression of advanced layout and routing options.
