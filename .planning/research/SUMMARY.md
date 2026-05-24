# Research Summary: Diagram Geometry Engine

**Date:** 2026-05-24

## Key Findings

**Stack:** TypeScript on Node.js should be the primary implementation route. Pretext and Dagre are native NPM dependencies and align with the project's deterministic geometry goal.

**Table Stakes:** v1 needs a stable IR, schema-validated YAML/JSON DSL, text measurement, label fitting, shape anchors, Dagre-backed initial layout, basic constraints, orthogonal routing, SVG export, Excalidraw export, CLI, and fixture-based tests.

**Watch Out For:** The main implementation risks are text measurement drift, exporters duplicating geometry logic, hidden constraint conflicts, and routing complexity expanding before the basic end-to-end path works.

## Project-Specific Recommendation

Implement DGE as a small TypeScript library plus CLI:

1. Establish types, parser, and deterministic serialization.
2. Prove the geometry pipeline with fixed-position SVG output.
3. Add Pretext label fitting, shape anchors, and basic routing.
4. Add Dagre auto-layout and simple constraint overrides.
5. Add Excalidraw export and CLI polish.

The roadmap should not begin with a UI or full draw.io support. Those are downstream consumers after the coordinated IR is reliable.

## Sources

- Local design: `diagram-geometry-engine-design.md`
- Local research: `dge-research-report.md`
- Pretext: https://github.com/chenglou/pretext
- Dagre: https://github.com/dagrejs/dagre
- Excalidraw API: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api
- Mermaid flowcharts: https://mermaid.js.org/syntax/flowchart.html
- mxGraph: https://github.com/jgraph/mxgraph
