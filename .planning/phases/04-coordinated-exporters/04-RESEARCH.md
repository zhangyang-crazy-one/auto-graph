---
phase: 04
slug: coordinated-exporters
status: complete
researched: 2026-05-25
requirements: [EXP-01, EXP-02, EXP-03]
---

# Phase 04: Coordinated Exporters Research

## Research Question

What must the planner know to implement SVG and Excalidraw exporters without letting exporters recompute geometry?

## Findings

### Exporter Boundary

Exporters must consume `CoordinatedDiagram` as the only geometry source. They can serialize boxes, points, anchors, labels, group boxes, and bounds, but must not call:

- `solveDiagram`
- `runDagreInitialLayout`
- `applyLayoutConstraints`
- `fitLabel`
- `routeEdge`
- `computeShapeGeometry`
- `computeContainerGeometry`
- `TextMeasurer` or Pretext adapters

If an exporter needs geometry that is missing from `CoordinatedDiagram`, that is a coordinated IR or solver gap, not an exporter responsibility.

### Label Layout Gap

Current `CoordinatedNode` and `CoordinatedGroup` carry `label?: Label`, but not `LabelLayout`. Phase 4 context requires SVG text to render from existing line boxes/baselines and not remeasure text. Planning should therefore include an early coordinated-IR extension.

Important layering constraint: do not make `src/ir/elements.ts` import from `src/labels/*`, because labels already depends on IR geometry/diagnostics. The safer plan is:

- extract renderer-neutral label layout types into a core IR-level file such as `src/ir/label-layout.ts`;
- update `src/labels/types.ts` to import/re-export those types rather than owning duplicate definitions;
- add optional `labelLayout?: LabelLayout` to coordinated nodes and groups.

Existing objects remain backwards compatible because the field is optional.

### SVG Export

SVG can be implemented with standard string serialization and no runtime dependency.

Required mappings:

| IR shape | SVG output |
|----------|------------|
| `rectangle` | `<rect>` |
| `rounded-rectangle` | `<rect rx="...">` |
| `ellipse` | `<ellipse>` |
| `diamond` | `<path>` or `<polygon>` |
| `parallelogram` | `<path>` or `<polygon>` |
| `hexagon` | `<path>` or `<polygon>` |
| `cylinder` | grouped `<path>` elements or one deterministic path |

Edges should serialize `CoordinatedEdge.points` into stable path data. The user explicitly requires precise arrow direction and arrowhead/tip placement. The plan should add a tiny arrow geometry helper that:

- reads the final non-zero segment from `edge.points`,
- normalizes the direction vector,
- calculates arrow base points from a fixed arrow length/width,
- places the arrow tip at the coordinated edge endpoint,
- shortens or terminates the visible shaft so the arrowhead lands exactly on the endpoint.

SVG marker documentation supports marker-based arrowheads, but generic `marker-end` alone is not enough for the user's precision requirement. Use vector helper output for deterministic tests; marker/default attributes may still exist for standalone SVG compatibility if implemented consistently.

### Excalidraw Export

Excalidraw export is a JSON adapter, not the DGE semantic model. Current Excalidraw scene data generally uses a top-level JSON object with `type`, `version`, `source`, `elements`, `appState`, and `files`.

Planning should avoid adding an Excalidraw dependency unless a small type package is clearly needed. A local minimal JSON structure is enough for Phase 4 golden tests.

Required adapter behavior:

- shapes export as editable Excalidraw shape elements;
- node/group text exports as separate text elements;
- arrows export from coordinated points and include `startBinding`/`endBinding` where possible;
- groups preserve visible boundary boxes and children group relationships;
- IDs are deterministic from diagram/node/edge/group IDs, not random.

### Shared Fixtures

Use committed `CoordinatedDiagram` JSON fixtures as source truth. Exporter tests should not solve normalized diagrams before exporting; that would mix solver regressions into exporter tests.

Recommended fixture layout:

- `test/fixtures/phase-04/coordinated-export.canonical.json`
- `test/fixtures/phase-04/coordinated-export.svg`
- `test/fixtures/phase-04/coordinated-export.excalidraw.json`

SVG golden can be compared as exact stable strings. Excalidraw golden should be compared through `stringifyCanonical()`.

### Verification Architecture

Required gates:

- `rtk npm test -- exporters`
- `rtk npm test -- public-api`
- `rtk npm test -- determinism`
- `rtk rg -n 'from "../(solver|layout|routing|text|labels|geometry)|from "../solver|from "../layout|from "../routing|from "../text|from "../labels|from "../geometry' src/exporters` prints no output, except renderer-neutral type imports explicitly introduced by Phase 4 are allowed.
- `rtk npm run typecheck`
- `rtk npm run lint`
- `rtk npm run verify`

## Validation Architecture

| Check ID | Requirement | What it proves | Command |
|----------|-------------|----------------|---------|
| 04-VAL-01 | EXP-01 | SVG includes seven shapes, labels, groups, edges, arrowheads, and viewBox from coordinated bounds. | `rtk npm test -- exporters` |
| 04-VAL-02 | EXP-02 | Excalidraw JSON includes editable shapes, text elements, arrow bindings, group relationships, and deterministic IDs. | `rtk npm test -- exporters` |
| 04-VAL-03 | EXP-03 | Exporters consume coordinated IR only and do not recompute geometry. | `rtk npm test -- exporters` plus `rtk rg -n 'solveDiagram|runDagreInitialLayout|applyLayoutConstraints|routeEdge|fitLabel|TextMeasurer|computeShapeGeometry|computeContainerGeometry' src/exporters` prints no output |
| 04-VAL-04 | EXP-01, EXP-02, EXP-03 | Shared coordinated fixture generates stable SVG and Excalidraw goldens. | `rtk npm test -- determinism exporters` |

## Source References

- `.planning/phases/04-coordinated-exporters/04-CONTEXT.md`
- `.planning/research/ARCHITECTURE.md`
- `.planning/research/PITFALLS.md`
- `diagram-geometry-engine-design.md` §5.6 and §8.1-8.3
- Excalidraw docs: scene data uses `elements`, `appState`, and `files` shape for scene updates/export targets.
- MDN SVG marker/path documentation: marker orientation exists, but Phase 4 will use deterministic vector math for tested arrowhead placement.
