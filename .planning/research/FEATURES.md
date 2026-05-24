# Feature Research: Diagram Geometry Engine

**Date:** 2026-05-24

## Table Stakes

| Feature | Why It Matters | Complexity |
|---------|----------------|------------|
| Declarative YAML/JSON input | LLMs and agents need a compact intent format | Medium |
| Schema validation and actionable errors | Bad DSL is expected; errors must guide automatic repair | Medium |
| Label measurement and auto-sizing | Text overflow is the most visible diagram failure | Medium |
| Shape geometry primitives | Anchors, bounds, and collision checks depend on consistent shape math | Medium |
| Directed graph auto-layout | Users expect relationship graphs to arrange themselves | Medium |
| Constraint overrides | DGE's differentiator is precise intent beyond generic auto-layout | High |
| Orthogonal routing | Arrow paths must avoid nodes and attach cleanly | High |
| SVG export | Fast visual verification and broad compatibility | Medium |
| Excalidraw export | Editable output proves this is not just static rendering | Medium |
| CLI | Agents need a non-interactive execution surface | Low |
| Golden tests | Deterministic geometry needs fixture-based verification | Medium |

## Differentiators

| Feature | Value | v1 Decision |
|---------|-------|-------------|
| Hybrid fixed plus automatic layout | Lets users pin important nodes while auto-placing the rest | Include |
| Multi-format coordinated IR | One solve can feed several exporters consistently | Include core IR, export two formats first |
| Constraint conflict diagnostics | Makes layout repair possible for agents | Include basic diagnostics |
| ASCII output | Useful for terminals and chat | Defer |
| draw.io XML export | Important ecosystem target | Defer to v2 unless v1 schedule permits |
| Python port | Useful for data science/Hermes workflows | Defer |
| HTML preview | Helps human review without making DGE a UI product | Defer until CLI works |

## Anti-Features

- Full diagram editor UI: too much surface area and dilutes the computation-layer goal.
- Randomized force layouts: makes outputs hard to reproduce and test.
- Style-heavy theme engine: upstream tools can own aesthetics; DGE should provide geometry-safe defaults.
- Runtime dependency on browser DOM layout: contradicts the agent/CLI target.
