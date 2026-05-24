# Architecture Research: Diagram Geometry Engine

**Date:** 2026-05-24

## Proposed Architecture

```text
DSL input
  -> parser and validator
  -> internal intent IR
  -> prepare phase
       - text measurement
       - label fitting
       - shape size resolution
       - graph and constraint normalization
  -> solve phase
       - dagre initial layout
       - fixed position and constraint overrides
       - anchor calculation
       - routing with obstacle checks
       - collision diagnostics
  -> coordinated diagram IR
  -> exporters
       - SVG
       - Excalidraw
       - future draw.io, Mermaid, ASCII
```

## Component Boundaries

| Component | Owns | Must Not Own |
|-----------|------|--------------|
| `dsl` | YAML/JSON parsing, schema validation, defaults | Geometry solving |
| `text` | `TextMeasurer` interface, Pretext adapter, fallback adapter | Node placement |
| `shape` | Shape bounds, anchors, contains/overlap math | Graph ranking |
| `label` | Text plus padding to node size | Export-specific text rendering |
| `layout` | Dagre wrapper, fixed nodes, coarse placement | Final edge routing |
| `constraints` | exact/relative/align/distribute/container solving | DSL parsing |
| `routing` | orthogonal and straight paths, obstacle avoidance | Node sizing |
| `ir` | stable normalized and coordinated data types | Format-specific serialization |
| `exporters` | SVG/Excalidraw serialization | Geometry decisions |
| `cli` | command arguments, stdin/stdout/files, exit codes | Core algorithm logic |

## Build Order Implications

1. Define IR and validation first. Every later module depends on stable data shapes.
2. Build text measurement and label fitting before layout, because Dagre needs node dimensions.
3. Build shape geometry before routing, because edge paths need anchors and obstacles.
4. Build a minimal solver and SVG exporter before Excalidraw, because SVG makes visual bugs easier to inspect.
5. Add CLI after one end-to-end library call exists.
6. Add constraint diagnostics before advanced exporters, because exporter correctness depends on a trustworthy coordinated IR.

## Data Flow Rule

Exporters should never guess geometry. They receive a fully coordinated diagram containing all node boxes, labels, anchors, and edge points. If an exporter needs missing geometry, that is a solver bug.
