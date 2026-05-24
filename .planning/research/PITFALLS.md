# Pitfalls Research: Diagram Geometry Engine

**Date:** 2026-05-24

## Critical Pitfalls

| Pitfall | Warning Sign | Prevention | Phase |
|---------|--------------|------------|-------|
| Treating DGE as a renderer | Core APIs start accepting CSS-like visual knobs before geometry is stable | Keep renderer/exporter adapters thin; coordinated IR is the contract | Phase 1 |
| Letting exporters compute geometry | SVG and Excalidraw outputs disagree for the same diagram | Require exporters to consume the same coordinated IR and test both from one fixture | Phase 4 |
| Text measurement drift | SVG text overflows even though LabelFitter says it fits | Golden fixtures for multilingual labels; document font assumptions | Phase 2 |
| Constraint conflicts hidden by auto-layout | Nodes silently move away from exact/relative intent | Add conflict diagnostics and precedence rules | Phase 3 |
| A* routing overbuilt too early | Weeks spent on routing before simple diagrams work | Start with direct orthogonal routes and obstacle checks, then add grid A* | Phase 2 and 3 |
| Non-deterministic output | Snapshots change across runs without input changes | Stable sorting, seeded IDs, rounded numeric serialization | Phase 1 |
| CLI errors too vague for agents | Invalid DSL requires human debugging | Include JSON-path/YAML-path style error locations and repair hints | Phase 5 |
| Premature Python port | TS API changes force duplicate rewrites | Wait until TS IR and fixture suite stabilize | Future |

## Validation Strategy

- Unit-test geometry functions with exact numeric expectations.
- Snapshot coordinated IR before exporter output.
- Snapshot SVG and Excalidraw JSON for representative diagrams.
- Include negative fixtures for invalid DSL and conflicting constraints.
- Add determinism tests that run the same input multiple times and compare normalized output.
