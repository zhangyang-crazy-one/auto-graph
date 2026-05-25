# Phase 05: DSL Parser And CLI - Context

**Gathered:** 2026-05-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 5 provides the agent-facing and developer-facing execution surface for DGE. It introduces a YAML/JSON DSL parser, validation layer, example DSL files, and a `dge` CLI that reads file or stdin input, solves geometry through the existing prepare/solve pipeline, and writes SVG or Excalidraw output through the existing exporters.

In scope:
- YAML and JSON DSL inputs that normalize into existing intent/normalized IR.
- Validation errors for malformed DSL, missing references, unsupported shapes, invalid constraints, and unsupported output formats.
- DSL expression of fixed positions, relative offsets, alignment, distribution, grouped containment, routing defaults, and edge overrides.
- CLI support for `--input`, stdin, `--format`, `--output`, stdout, diagnostics on stderr, and non-zero exit codes for failures.
- Example DSL files for architecture, flowchart, edge labels, groups, and hybrid layout.

Out of scope:
- New geometry, layout, routing, text, or exporter algorithms.
- draw.io/mxGraph, Mermaid, ASCII/Unicode, TikZ, browser preview, or visual editor features.
- Rich public style API design beyond minimal output defaults already supported by exporters.
- Replacing existing `IntentDiagram`, `NormalizedDiagram`, `solveDiagram()`, `exportSvg()`, or `exportExcalidraw()` contracts.

</domain>

<decisions>
## Implementation Decisions

### DSL Expression Shape

- **D-01:** Phase 5 should use an agent-friendly shorthand DSL as the primary authoring surface. YAML and JSON are both supported, but examples should primarily use YAML because it is easier for humans and LLMs to write.
- **D-02:** The DSL should normalize into existing IR instead of becoming a second semantic model. Parser output should flow toward `IntentDiagram`/`NormalizedDiagram`, then `solveDiagram()`, then exporters.
- **D-03:** Nodes should be authored as an object map keyed by stable node id, for example `nodes: { api: { label: "API", shape: rectangle } }`.
- **D-04:** Edges may use string shorthand such as `api -> db` and `web -> api: calls`. This shorthand must expand into structured source/target/label data during parsing.
- **D-05:** DSL may include optional output defaults such as `output.format: svg`, but CLI flags override DSL output settings.

### Constraints And Layout Syntax

- **D-06:** Fixed node positions should be expressed inline on nodes, for example `nodes.api.position: { x: 100, y: 80 }`, matching the existing `IntentNode.position` field.
- **D-07:** Relative, alignment, and distribution constraints should use structured objects rather than free-form string expressions. This keeps validation and path-specific diagnostics straightforward.
- **D-08:** Group definitions are the primary containment semantic source, for example `groups.backend.nodes: [api, db]`. Planning may normalize group membership into the existing group and containment behavior as needed.
- **D-09:** Layout and routing should support top-level defaults such as `layout.direction: LR` and `routing.kind: orthogonal`, with per-edge overrides where needed.

### Error Output And Diagnostics

- **D-10:** Default CLI errors should be human-readable on stderr, with a clear summary, relevant DSL path, and repair hint when practical.
- **D-11:** Provide `--json` for machine-readable output of errors and diagnostics so coding agents and automation can consume failures deterministically.
- **D-12:** Use a layered error model: `parse`, `validate`, `solve`, and `export`. This helps users understand whether the problem is syntax, DSL semantics, geometry solving, or output generation.
- **D-13:** Warning diagnostics do not block output. Error diagnostics block output and return a non-zero exit code.

### CLI Command Behavior

- **D-14:** Use `dge` as the package binary and command name.
- **D-15:** Use Unix-friendly IO behavior: no `--input` means read stdin; no `--output` means write output content to stdout; diagnostics go to stderr.
- **D-16:** Output files may be overwritten by default, but implementation must avoid leaving partial or truncated files on failure.
- **D-17:** Default output format is `svg`. DSL `output.format` may set another default, and CLI `--format` takes precedence.

### the agent's Discretion

- The planner may choose exact parser module boundaries and helper names, provided the DSL remains a thin authoring layer over existing IR and solving/exporting APIs.
- The planner may choose a YAML parsing dependency after research, but it should favor maintained, deterministic, Node 20-compatible packages.
- The planner may choose exact exit code numbers if they are documented in tests and distinguish success from failure.
- The planner may decide whether edge shorthand parsing is implemented in the first parser plan or in a separate sugar-focused plan, but Phase 5 must finish with the shorthand supported.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements

- `.planning/ROADMAP.md` — Phase 5 goal, success criteria, and dependency notes.
- `.planning/REQUIREMENTS.md` — DSL-01, DSL-02, DSL-03, CLI-01, CLI-02, and CLI-03 acceptance requirements.
- `.planning/PROJECT.md` — Project positioning as a TypeScript-first deterministic geometry engine and v1 scope boundaries.
- `.planning/STATE.md` — Current project state and preserved decisions after Phase 4.

### Prior Locked Decisions

- `.planning/phases/01-project-scaffold-and-core-ir/01-CONTEXT.md` — Single package, root exports, renderer-free IR, and deterministic serializer decisions.
- `.planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md` — Text/label/shape geometry stays renderer-neutral; DSL must not trigger exporter-specific measurement.
- `.planning/phases/03-layout-constraints-and-routing/03-CONTEXT.md` — Dagre, constraints, routing, containers, and diagnostics are owned by solver/coordinator layers, not DSL or exporters.
- `.planning/phases/04-coordinated-exporters/04-CONTEXT.md` — Exporters consume coordinated IR only; SVG is the neutral default export and Excalidraw is an adapter.

### Research And Design References

- `.planning/research/ARCHITECTURE.md` — Prepare/solve/export data flow and DSL/CLI placement in the architecture.
- `.planning/research/PITFALLS.md` — Risks around duplicate geometry logic, hidden validation gaps, and exporter divergence.
- `.planning/research/SUMMARY.md` — v1 implementation sequence including DSL parser and CLI after exporters.
- `.planning/research/STACK.md` — TypeScript/Node stack guidance.
- `diagram-geometry-engine-design.md` — Original DGE DSL, CLI, pipeline, and exporter framing.
- `dge-research-report.md` — TypeScript-first rationale and Pretext/Dagre reuse context.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/ir/diagram.ts` — Existing `IntentDiagram`, `NormalizedDiagram`, and `CoordinatedDiagram` contracts; DSL parser should normalize toward these rather than creating a parallel model.
- `src/ir/elements.ts` — Existing node, edge, group, label, shape, and endpoint contracts for DSL validation and normalization.
- `src/ir/constraints.ts` — Existing constraint kinds and fields for exact position, relative position, align, distribute, and containment.
- `src/solver/solve.ts` — Existing `solveDiagram()` entrypoint that Phase 5 should call after DSL normalization.
- `src/exporters/svg.ts` and `src/exporters/excalidraw.ts` — Existing export functions for CLI output.
- `src/serialization/canonical.ts` — Existing deterministic serialization helper, useful for JSON output and golden CLI tests.
- `test/fixtures/phase-04/coordinated-export.*` — Existing fixture style for deterministic output checks.

### Established Patterns

- Public APIs are exported through `src/index.ts` and tested from the package root.
- Source modules use `.js` ESM specifiers in TypeScript.
- Tests use Vitest and committed fixtures under `test/fixtures/phase-XX`.
- `rtk npm run verify` is the final gate for phase execution.
- Core layers stay renderer-neutral; format-specific behavior belongs in exporters.

### Integration Points

- Add a new DSL/parser module boundary such as `src/dsl/` that outputs existing IR and diagnostics.
- Add a CLI entrypoint and package `bin` for `dge`.
- Add example DSL files under a committed fixture/example path chosen during planning.
- Add CLI tests that exercise file input, stdin input, stdout output, output file writing, format override precedence, human-readable errors, JSON errors, and non-zero exits.

</code_context>

<specifics>
## Specific Ideas

- The user selected all recommended defaults for Phase 5.
- DSL examples should be optimized for coding agents and Chinese/English human users to author reliably, not for mirroring every internal TypeScript field verbatim.
- Edge shorthand is important because users and agents naturally write quick graph relationships as `a -> b`.
- CLI flags override DSL output settings so the same diagram source can be reused for SVG, Excalidraw, and future formats.
- Default output remains neutral SVG; Excalidraw is an available attachment/export format, not the default semantic model.

</specifics>

<deferred>
## Deferred Ideas

- draw.io/mxGraph XML export remains a v2 exporter requirement.
- Mermaid and ASCII/Unicode exports remain future exporter work.
- Browser preview and visual review UI remain out of scope for Phase 5.
- Rich style API and theme configuration remain deferred until the basic DSL/CLI path is stable.

</deferred>

---

*Phase: 05-dsl-parser-and-cli*
*Context gathered: 2026-05-25*
