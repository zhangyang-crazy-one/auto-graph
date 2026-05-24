# Stack Research: Diagram Geometry Engine

**Date:** 2026-05-24

## Recommendation

Use a TypeScript monorepo-style package layout only if the project grows into multiple packages. For v1, start with one package containing `src/core`, `src/dsl`, `src/exporters`, `src/cli`, and `test/fixtures`.

## Runtime And Language

| Choice | Recommendation | Rationale | Confidence |
|--------|----------------|-----------|------------|
| Language | TypeScript | Native path to Pretext and Dagre, strong geometry IR typing, straightforward SVG/JSON/XML output | High |
| Runtime | Node.js 20+ | Modern baseline for CLI tools and package publishing; good ESM/CJS support | High |
| Package manager | npm or pnpm | Either is fine; avoid over-optimizing before package scaffold exists | Medium |
| Build | tsup or tsdown | Simple dual ESM/CJS output and CLI bundling | Medium |
| Tests | Vitest | Fast TS-native unit and snapshot testing | High |
| Lint/format | Biome or oxlint plus prettier-compatible formatting | Fast enough for a small TS library | Medium |

## Core Dependencies

| Dependency | Current Check | Use |
|------------|---------------|-----|
| `@chenglou/pretext` | `npm view` returned version `0.0.7` | Default text measurement backend |
| `@dagrejs/dagre` | `npm view` returned version `3.0.0` | Directed graph initial layout |
| YAML parser | To choose during implementation | CLI and DSL parser |
| JSON Schema validator | To choose during implementation | DSL validation and helpful error messages |

## Source Notes

- Pretext repository describes a pure JS/TS multiline text measurement and layout library, avoiding DOM measurement and exposing `prepare()` plus `layout()` APIs for one-time analysis and cheap hot-path layout: https://github.com/chenglou/pretext
- Dagre repository describes client-side directed graph layout for JavaScript, suitable as the initial automatic layout layer: https://github.com/dagrejs/dagre
- Excalidraw developer docs expose `updateScene(sceneData)` with `elements` and `appState`, confirming JSON scene export is a practical editable target: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api
- Mermaid flowchart docs define direction, nodes, edges, subgraphs, and many semantic shapes, confirming Mermaid should be treated as a text DSL export/import target rather than DGE's coordinate source of truth: https://mermaid.js.org/syntax/flowchart.html
- mxGraph is the legacy JavaScript diagramming library behind draw.io-style XML concepts, but the project notes it is stable and not advised for new direct dependency use, so DGE should implement draw.io export as an XML adapter: https://github.com/jgraph/mxgraph

## What Not To Use First

- Do not start with Graphviz subprocess integration. It complicates installation and produces a different layout model from the TS-native Dagre route.
- Do not use a browser-only measurement dependency in the core package. Text measurement must be callable from CLI tests.
- Do not build a React UI before the CLI and golden outputs exist. Visual preview is useful after deterministic output is proven.
