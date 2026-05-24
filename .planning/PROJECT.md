# Diagram Geometry Engine

## What This Is

Diagram Geometry Engine (DGE), code name "Pretext for Graphics", is a deterministic geometry computation engine that translates high-level diagram intent into precise numeric coordinates. It is for LLMs, coding agents, and developers who need to generate accurate architecture diagrams, flowcharts, and editable diagram files without hand-guessing x/y positions or relying on visual feedback.

DGE is not a renderer or a visual editor. It is the missing geometry solving layer between automatic graph layout engines and render/export formats such as SVG, Excalidraw JSON, draw.io XML, Mermaid, and ASCII.

## Core Value

Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

## Requirements

### Validated

- Phase 1 validated the TypeScript/npm scaffold, root public entrypoint, renderer-free core IR contracts, and deterministic canonical serializer for future fixtures.

### Active

- [ ] Build a TypeScript-first geometry engine with a clean prepare/solve/export pipeline.
- [ ] Reuse proven libraries where they fit: Pretext for text measurement and Dagre for directed graph initial layout.
- [ ] Provide a simple YAML/JSON DSL that LLMs can generate reliably.
- [ ] Calculate label-driven node sizes, shape anchors, collision boxes, and connection paths deterministically.
- [ ] Export at least SVG and Excalidraw JSON in v1, with draw.io XML and ASCII tracked as follow-up formats.
- [ ] Provide a CLI that accepts file and pipe input and writes requested output formats.
- [ ] Keep output deterministic and testable with golden fixtures and numeric tolerances.

### Out of Scope

- Rich drag-and-drop editing UI - DGE is the computation layer, not a draw.io or Visio replacement.
- Non-deterministic force-directed layout - random or physics-based output breaks agent reproducibility.
- Advanced visual styling system - upstream skills or callers own aesthetics; DGE owns geometry correctness.
- Real-time collaboration - unrelated to the core coordinate computation problem.
- Python implementation in v1 - useful later for data workflows, but TypeScript has the native Pretext and Dagre path.

## Context

The current folder contains two source documents:

- `diagram-geometry-engine-design.md`: full product and architecture design for DGE.
- `dge-research-report.md`: Pretext source analysis, feasibility review, and language choice report.

The design frames DGE as a deterministic geometry calculator for LLM-generated diagrams. The immediate implementation target is a TypeScript package and CLI that can take declarative nodes, edges, constraints, and styles, then output precise coordinates and renderable/exportable diagram formats.

Current implementation state:

- Phase 1 is complete: npm, TypeScript, tsup, Vitest, and Biome tooling are in place.
- Public IR contracts exist for intent, normalized, and coordinated diagram stages.
- Canonical serialization is available through the root package entrypoint and verified for deterministic ordering, numeric rounding, anchor ordering, and route-order preservation.

External research confirms the local direction:

- Pretext is a pure JavaScript/TypeScript multiline text measurement and layout library. Its API separates `prepare()` one-time work from cheap arithmetic `layout()` calls, which directly informs DGE's two-stage architecture.
- Dagre is a JavaScript library for directed graph layout and is a good fit for initial automatic graph positioning, while DGE still needs its own constraint override, shape geometry, and routing layers.
- Excalidraw supports scene updates using element arrays and app state, making it a viable editable JSON export target.
- Mermaid flowcharts provide text-native graph syntax and many shapes, but Mermaid is a relationship DSL rather than a precise coordinate output format.
- mxGraph/draw.io XML remains relevant as an interchange target, but its upstream mxGraph project is stable and legacy-oriented, so DGE should treat draw.io export as an adapter rather than a core dependency.

## Constraints

- **Runtime**: TypeScript on Node.js first - Pretext and Dagre are native NPM dependencies and avoid Python subprocess complexity.
- **Architecture**: Prepare/solve/export separation - expensive measurement and validation happen before hot path geometry solving.
- **Determinism**: Same input must produce byte-stable or numerically stable output - required for tests and agent repeatability.
- **Measurement**: Text measurement must be abstracted behind an interface - Pretext is default, but exporters or runtimes may need alternate measurement backends.
- **Quality**: Golden tests must catch text overflow, connector misalignment, collisions, non-deterministic output, and malformed exports.
- **Scope**: v1 focuses on core library, CLI, SVG, Excalidraw, and enough layout/routing to support real architecture and flow diagrams.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript is the primary implementation language | Pretext and Dagre are NPM-native, and V8 is suitable for geometry hot paths | - Phase 1 validated the package scaffold and public TypeScript entrypoint |
| Use Pretext as the default text measurement backend | It already provides DOM-free multiline text measurement with a prepare/layout split | - Pending |
| Use Dagre for initial directed graph layout only | It solves rank-based graph placement but not DGE's exact constraints, anchors, and routing | - Pending |
| Model DGE as a geometry engine, not a renderer | Keeps the package composable with SVG, Excalidraw, draw.io, Mermaid, and future skills | - Phase 1 IR stayed renderer-free |
| Start with SVG and Excalidraw exports | SVG verifies visual geometry quickly; Excalidraw proves editability | - Pending |
| Defer Python implementation | Python is valuable for data workflows, but it would complicate v1 measurement fidelity | - Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-24 after Phase 1 completion*
