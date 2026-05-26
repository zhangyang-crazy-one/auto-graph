# Phase 06: Verification And Release Readiness - Context

**Gathered:** 2026-05-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 6 closes the v1 milestone by making the existing DGE implementation reliable enough for release preparation. It does not add new diagram capabilities or new exporter families. It strengthens numeric tests, coordinated and exporter golden fixtures, determinism checks, README documentation, and release-facing verification around the already-built TypeScript core, DSL, CLI, SVG exporter, and Excalidraw exporter.

In scope:
- Numeric and fixture tests for text adapters, label fitting, shape geometry, constraints, routing, coordinated IR, exporters, CLI, and determinism.
- Golden coordinated IR fixtures for the main supported diagram families.
- Golden SVG and Excalidraw outputs generated from the same coordinated IR.
- README documentation for positioning, public API, CLI examples, current limitations, and release readiness.
- Cleanup of unresolved test placeholders where they describe v1 contracts.

Out of scope:
- draw.io/mxGraph XML export, Mermaid export/import, ASCII/Unicode export, browser preview, visual editor UI, rich style API, full CAD-grade shape intersection, and complex grid/A* routing.
- Reworking the existing architecture. Phase 6 validates the prepare/solve/export boundary; it does not replace it.

</domain>

<decisions>
## Implementation Decisions

### Release Readiness Bar

- **D-01:** Treat Phase 6 as a strict release-candidate readiness phase, not a minimal smoke-test pass. All Phase 6 requirements must have explicit test, fixture, or documentation evidence.
- **D-02:** `rtk npm run verify` is the final hard gate. Phase 6 is not complete unless typecheck, build, full Vitest suite, and Biome lint pass together.
- **D-03:** Planning should prefer small, reviewable verification plans over broad refactors. Phase 6 should harden existing behavior, not redesign core modules.

### Golden Fixture Scope

- **D-04:** Golden coverage should use the five Phase 5 DSL example families as the release-readiness surface: architecture, flowchart, edge labels, groups, and hybrid layout.
- **D-05:** For VER-02, coordinated IR goldens should cover all five main diagram families where practical, generated from the public DSL/normalize/solve path rather than hand-built unrelated objects.
- **D-06:** For VER-03, SVG and Excalidraw goldens should be generated from the same coordinated IR. The planner may split the exporter golden set to control fixture size, but architecture, groups, and hybrid layout must be represented because they stress text, containers, constraints, routing, and editability.
- **D-07:** Golden fixtures should remain deterministic and canonical. JSON goldens use `stringifyCanonical`; SVG goldens may be exact strings when stable.

### Remaining Test Placeholders

- **D-08:** Existing `it.todo` entries that describe v1 diagnostic or exporter contracts should be resolved in Phase 6. Convert them into real tests when they match current v1 scope.
- **D-09:** If a todo turns out to describe a future capability outside v1, do not leave it as a vague todo. Either remove it after equivalent coverage exists, or replace it with explicit deferred documentation in README/summary.
- **D-10:** Phase 6 completion should leave the test suite with no unresolved todo tests for v1 release contracts.

### README And User-Facing Limits

- **D-11:** README should clearly position DGE as a deterministic geometry engine, not a renderer, visual editor, draw.io replacement, or style system.
- **D-12:** README must document the public package API at a practical level: DSL parse/normalize/render surface, solver/exporter flow, CLI examples, and where examples live.
- **D-13:** README must explicitly list current v1 limitations: no draw.io/Mermaid/ASCII export yet, no browser preview, no rich style API, limited orthogonal routing, practical shape-boundary approximations, and TypeScript-first package scope.
- **D-14:** README should keep Pretext appreciation and MIT attribution, and should not imply DGE reimplements Pretext's text algorithms.

### Architecture Guardrails

- **D-15:** Preserve the source-of-truth chain: DSL examples -> parse/normalize -> solveDiagram -> coordinated IR -> SVG/Excalidraw exporters.
- **D-16:** Keep static no-recompute guards. Exporters must not call solver/layout/text measurement/routing/geometry internals. DSL/CLI may call allowed pipeline APIs but must not bypass into layout/routing/geometry internals directly.
- **D-17:** Excalidraw remains an attachment/export adapter. Neutral SVG and coordinated IR remain the default engineering verification surfaces.

### the agent's Discretion

- The planner may decide exact fixture file names and whether generated goldens live under `test/fixtures/phase-06/` or extend prior fixture folders, provided Phase 6 ownership is clear.
- The planner may decide whether to add helper scripts for fixture generation or keep fixture generation inside tests, provided committed goldens are deterministic and reviewable.
- The planner may decide exact README section ordering and wording, provided the limitations and API/CLI examples are clear for a new developer.
- The planner may choose exact test grouping across existing test files or new Phase 6 test files, provided VER-01 through VER-04 are all directly evidenced.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope And Release Requirements

- `.planning/PROJECT.md` — Project positioning, architecture constraints, and v1 scope boundaries.
- `.planning/REQUIREMENTS.md` — VER-01 through VER-04 plus completed DSL/CLI/export requirements that Phase 6 must preserve.
- `.planning/ROADMAP.md` — Phase 6 goal, success criteria, and dependency notes.
- `.planning/STATE.md` — Current phase status and preserved decisions after Phase 5.

### Prior Phase Decisions

- `.planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md` — Pretext reuse, renderer-neutral label layout, shape geometry, container geometry, and numeric verification boundary.
- `.planning/phases/03-layout-constraints-and-routing/03-CONTEXT.md` — Dagre boundary, fixed/hybrid layout, constraint precedence, routing scope, diagnostics, and renderer-neutral solver verification.
- `.planning/phases/04-coordinated-exporters/04-CONTEXT.md` — SVG and Excalidraw exporter responsibilities, shared fixtures, golden output style, and exporter no-recompute guard.
- `.planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md` — DSL shape, CLI behavior, diagnostic layers, format precedence, and deferred future formats.
- `.planning/phases/05-dsl-parser-and-cli/05-06-SUMMARY.md` — Final Phase 5 public API, built binary smoke, deterministic fixture proof, and DSL/CLI no-recompute guard.

### Source Documents

- `diagram-geometry-engine-design.md` — Original DGE product, DSL, CLI, and exporter framing. Supersede with phase contexts where they are more specific.
- `dge-research-report.md` — Pretext source analysis, feasibility review, and TypeScript-first rationale.
- `.planning/research/` — Prior research pack for architecture, stack, pitfalls, and implementation sequence.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `examples/*.yaml` and `test/fixtures/phase-05/*.yaml` — Five DSL example families that should drive Phase 6 coordinated/exporter goldens.
- `test/fixtures/phase-02/*.canonical.json` — Existing numeric/text/shape/container fixture style for VER-01.
- `test/fixtures/phase-03/*.canonical.json` — Existing coordinated solver fixture style for layout, constraints, hybrid layout, and routing.
- `test/fixtures/phase-04/coordinated-export.*` — Existing shared coordinated exporter fixture and exact SVG/Excalidraw golden pattern.
- `stringifyCanonical()` from `src/serialization/index.ts` — Canonical JSON comparison utility for deterministic fixtures.
- `renderDiagramDsl()` from `src/dsl/index.ts` — Public DSL path that Phase 6 should use to prove examples drive the same code users call.

### Established Patterns

- Tests use Vitest, exact fixture reads, and committed golden files under `test/fixtures/phase-XX/`.
- Public APIs are root-only through `src/index.ts`; package `exports` exposes only `"."`.
- `rtk npm run verify` is the project hard gate: typecheck, build, tests, lint.
- Static architecture guards already exist in `test/exporters.test.ts` for exporter no-recompute and DSL/CLI no direct layout/routing/geometry bypass.
- README is intentionally concise today and needs Phase 6 expansion, not a marketing page.

### Integration Points

- Phase 6 tests can connect `test/fixtures/phase-05/*.yaml` to `parseDiagramDsl`, `normalizeDiagramDsl`, `renderDiagramDsl`, `solveDiagram`, `exportSvg`, and `exportExcalidraw`.
- Phase 6 README work connects to package metadata in `package.json`, public exports in `src/index.ts`, and CLI behavior in `src/cli/run.ts`.
- Release readiness checks should avoid generated output drift by committing fixtures and making update behavior explicit in tests or helper scripts.

</code_context>

<specifics>
## Specific Ideas

- User requested continuation; in the unavailable interactive selector fallback, the recommended defaults were used: `1A 2A 3A 4A`.
- Phase 6 should be strict enough to close the milestone confidently, not merely add a few smoke tests.
- Current limitations should be stated plainly so users do not confuse v1 with a full visual editor, draw.io replacement, or complete CAD-quality router.

</specifics>

<deferred>
## Deferred Ideas

- draw.io/mxGraph XML export remains a v2 exporter requirement.
- Mermaid and ASCII/Unicode exports remain future exporter/import work.
- Browser preview and visual review UI remain out of scope for Phase 6.
- Rich style API and theme configuration remain deferred until geometry and release contracts are stable.
- Python package/port remains out of v1 scope.

</deferred>

---
*Phase: 06-verification-and-release-readiness*
*Context gathered: 2026-05-26*
