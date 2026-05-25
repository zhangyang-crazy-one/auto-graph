---
phase: 04
slug: coordinated-exporters
status: planned
created: 2026-05-25
---

# Phase 04: Validation Strategy

## Validation Architecture

| Check ID | Plans | Requirements | Threat | Validation Target | Type | Command | Status |
|----------|-------|--------------|--------|-------------------|------|---------|--------|
| 04-01-01 | 04-01 | EXP-01, EXP-03 | T-04-01 | Coordinated IR carries optional label layout for exporters without remeasurement and without IR importing labels. | unit/type | `rtk npm test -- exporters public-api` | pending |
| 04-02-01 | 04-02 | EXP-01 | T-04-02 | SVG exports seven shapes, text lines, groups, edges, viewBox, and vector arrowheads. | unit/golden | `rtk npm test -- exporters` | pending |
| 04-03-01 | 04-03 | EXP-02 | T-04-03 | Excalidraw exports editable shape/text/arrow/group JSON with deterministic IDs and bindings. | unit/golden | `rtk npm test -- exporters` | pending |
| 04-04-01 | 04-04 | EXP-01, EXP-02, EXP-03 | T-04-04 | Same coordinated fixture generates stable SVG and Excalidraw goldens. | fixture | `rtk npm test -- determinism exporters` | pending |
| 04-04-02 | 04-04 | EXP-03 | T-04-05 | Exporter source files do not import or call solver/layout/text/routing/geometry recomputation modules; tests may contain the forbidden-term list used to enforce the gate. | static/unit | `rtk npm test -- exporters` plus `rtk rg -n 'solveDiagram|runDagreInitialLayout|applyLayoutConstraints|routeEdge|fitLabel|TextMeasurer|computeShapeGeometry|computeContainerGeometry' src/exporters` prints no output | pending |

## Threat IDs

| Threat ID | Risk | Mitigation |
|-----------|------|------------|
| T-04-01 | Exporters remeasure text because coordinated IR lacks line layout. | Add optional coordinated label layout before exporter work. |
| T-04-02 | SVG output is visually present but semantically incomplete. | Golden tests assert shape tags/paths, text/tspan, groups, edge paths, viewBox, and arrowhead geometry. |
| T-04-03 | Excalidraw JSON opens but is not meaningfully editable. | Tests assert separate text elements, arrow bindings, and group relationships. |
| T-04-04 | SVG and Excalidraw drift because they use separate source fixtures. | Both exporters consume the same committed coordinated fixture. |
| T-04-05 | Exporters duplicate solver geometry logic. | Static grep gate and import restrictions. |
