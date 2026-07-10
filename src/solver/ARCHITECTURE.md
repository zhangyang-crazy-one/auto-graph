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

## Follow-ups

- Push per-phase `LayoutState` mutation so early phases stop being extension-point no-ops.
- Algorithm work for #76 should land primarily in `ports.ts` / `route-edges.ts` / `src/routing/*`.
- Dense remediation work for #75 should land primarily in `remediation.ts` / `labels.ts`.
