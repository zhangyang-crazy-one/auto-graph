# Phase 1: Project Scaffold And Core IR - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 establishes the TypeScript package foundation, build/test/lint commands, public IR type contracts, and deterministic serialization rules. It must not implement text measurement, shape geometry, layout, routing, DSL parsing, CLI behavior, or exporters beyond minimal stubs needed to validate the scaffold and type exports.

</domain>

<decisions>
## Implementation Decisions

### Toolchain Baseline

- **D-01:** Use a single TypeScript package for v1 rather than a monorepo. The project can split packages later after core IR and CLI boundaries prove stable.
- **D-02:** Use npm for the initial lockfile and scripts unless dependency installation in the environment strongly favors pnpm during planning.
- **D-03:** Use `tsup` for distributable library/CLI bundling and keep `tsc --noEmit` as the explicit typecheck gate.
- **D-04:** Use Vitest for the first test suite because Phase 1 needs fast TypeScript unit tests and deterministic fixture checks.
- **D-05:** Use Biome or oxlint for linting; planner may choose the lower-friction option, but Phase 1 must expose a runnable lint command.

### Source Module Boundaries

- **D-06:** Start with clear module boundaries inside one package: shared IR/types, deterministic serialization utilities, and public entrypoints.
- **D-07:** Keep future concerns separated by module names even if Phase 1 only implements the IR and serializer. Expected future boundaries are DSL parsing, geometry, layout, routing, exporters, and CLI.
- **D-08:** Do not create a UI, preview app, or renderer surface in Phase 1. Export and CLI implementation belong to later phases.

### Public IR Types

- **D-09:** Define minimal but extensible TypeScript interfaces for diagram intent, normalized diagram, coordinated diagram, nodes, edges, groups, labels, constraints, diagnostics, points, sizes, and boxes.
- **D-10:** Keep rendering-specific details out of the core IR. Exporters may later map coordinated IR into SVG, Excalidraw, draw.io, Mermaid, or ASCII formats.
- **D-11:** Preserve the prepare/solve/export architecture in naming and type comments so later phases do not collapse measurement, layout, and serialization into one mixed layer.

### Deterministic Serialization

- **D-12:** Provide a canonical serializer for normalized and coordinated outputs. It must stable-sort arrays by ids or deterministic sequence keys, normalize object key ordering, omit `undefined`, and make repeated runs byte-stable for equivalent input.
- **D-13:** Round geometry numbers to a documented default precision in canonical serialized output. Use 3 decimal places initially; planner may add a named constant so later phases can tune this without touching every call site.
- **D-14:** Add at least one Phase 1 test proving repeated serialization of equivalent objects produces identical output.

### the agent's Discretion

- Exact directory names are flexible if they preserve the boundaries above and expose a clean public import path.
- Exact lint tool is flexible between Biome and oxlint if the chosen tool has a working script and does not slow down Phase 1.
- Exact package metadata fields are flexible, but the package should be clearly positioned as a TypeScript geometry engine rather than a renderer.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope And Requirements

- `.planning/PROJECT.md` — Project purpose, core value, constraints, and locked positioning.
- `.planning/REQUIREMENTS.md` — Phase 1 requirements FND-01, FND-02, and FND-03 plus later phase boundaries to avoid scope creep.
- `.planning/ROADMAP.md` — Phase 1 goal and success criteria.
- `.planning/STATE.md` — Current project state and open Phase 1 questions.

### Research And Design

- `.planning/research/STACK.md` — Recommended TypeScript, Node.js, build, test, and dependency baseline.
- `.planning/research/ARCHITECTURE.md` — Proposed component boundaries and data flow rule.
- `.planning/research/PITFALLS.md` — Phase 1 pitfalls around renderer creep and non-deterministic output.
- `.planning/research/SUMMARY.md` — Condensed implementation sequence and stack recommendation.
- `dge-research-report.md` — Pretext analysis, TypeScript rationale, and build-tool recommendation.
- `diagram-geometry-engine-design.md` — Full DGE product architecture and original roadmap context.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- No source code exists yet. The only reusable assets are the design documents and `.planning` research artifacts.

### Established Patterns

- The repository uses GSD planning artifacts and `AGENTS.md`.
- Shell commands in this repo must follow the local RTK rule referenced from `AGENTS.md`.
- Planning docs already position DGE as a TypeScript-first geometry computation engine, not a renderer or UI editor.

### Integration Points

- Phase 1 creates the initial package structure that all later phases will extend.
- Later phases will add Pretext, Dagre, DSL parsing, exporters, and CLI on top of the Phase 1 public types and deterministic serializer.

</code_context>

<specifics>
## Specific Ideas

- The package should make it hard for later phases to duplicate geometry logic in exporters. Coordinated IR is the handoff point.
- Determinism is not a nice-to-have; it is a core contract for tests and agent repeatability.
- Phase 1 should be small and strict: scaffold, type contracts, serializer, and proof tests only.

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 01-project-scaffold-and-core-ir*
*Context gathered: 2026-05-24*
