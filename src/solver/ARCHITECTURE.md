# Solver architecture (#77)

`solveDiagram` is the public orchestrator. Domain logic lives in sibling modules so routing / remediation / label work can land without editing a mega-file.

## Module ownership

| Module | Owns |
|--------|------|
| `options.ts` | `SolveDiagramOptions`, layout/port option types, `resolveRemediationPolicy` |
| `page-policy.ts` | page-policy resolve / classify |
| `cjk-typography.ts` | CJK font / size enhancement |
| `helpers.ts` | shared geometry / diagnostic / clone helpers |
| `initial-layout.ts` | Dagre/position seed, stack wrap, growth helpers |
| `swimlane-contracts.ts` | swimlane contract layout + fixed-lane geometry |
| `ports.ts` | port boxes, anchor capacity, fan-out anchors |
| `coordinate.ts` | node / group / frame box coordination |
| `evidence.ts` | matrices, tables, evidence panels |
| `route-edges.ts` | `coordinateEdges`, rails, route/label feedback scoring |
| `labels.ts` | text annotations, external label shelves |
| `remediation.ts` | remediation plans / apply loop / deliverability |
| `solve.ts` | thin orchestration + `createDefaultPipeline` |
| `src/routing/*` | A* / visibility / bus primitives (not solver orchestration) |

## Pipeline phase order

`createDefaultPipeline()` exposes replaceable named phases:

```text
prepare → initial-layout → ports-and-constraints → coordinate
  → route-edges → labels-and-remediate → quality-score
```

Default phase bodies keep one behavior-preserving `solveDiagram` run (mirrored into `LayoutState` during `labels-and-remediate`) so the direct API and pipeline stay aligned. Use `LayoutPipeline.replacePhase(name, phase)` to override a named stage.

## Dependency DAG (required)

Solver modules must form a **directed acyclic graph**. Lower layers must not import higher layers.

```text
options / page-policy / cjk-typography / helpers
  → initial-layout / swimlane-contracts / evidence
  → ports → coordinate
  → route-edges
  → labels
  → remediation
  → solve (orchestrator) / index
```

Routing primitives stay in `src/routing/*` and are imported by `ports` / `route-edges` only — they must not import `src/solver/*`.

### Cycle-break rules

| Shared concern | Lives in | Why |
|----------------|----------|-----|
| `resolveRemediationPolicy` | `options.ts` | `labels` needs policy mode without importing `remediation` |
| `labelOffset`, `recenterNodeLabelLayout`, `isEdgeConnectedTextAnnotation` | `helpers.ts` | `ports` / `route-edges` / `remediation` share leaf helpers |
| `buildCenteredTextAnnotation`, `normalizeOutputFontFamily` | `ports.ts` | annotation builders used before label placement |

### Forbidden edges

- `labels` ↛ `remediation`
- `route-edges` / `ports` / `coordinate` / `helpers` / `options` ↛ `labels` or `remediation`
- `helpers` ↛ `ports` / `route-edges` / `labels` / `remediation`
- Any reverse edge that would close a cycle with `solve`

`test/solver-architecture.test.ts` asserts the solver-local import graph has no cycles and none of the forbidden edges above.

## Guardrails (auto-graph-dev)

- **Determinism**: stable id sorts / fingerprints; same input → stable coordinates.
- **Prepare → solve → export**: solver owns geometry; exporters consume IR, they do not re-solve.
- **#76 algorithm work**: primarily `ports.ts` / `route-edges.ts` / `src/routing/*`.
- **#75 remediation work**: primarily `remediation.ts` / `labels.ts`.

## Follow-ups

- Push per-phase `LayoutState` mutation so early phases stop being extension-point no-ops.
