# Phase 04: Coordinated Exporters - Context

**Gathered:** 2026-05-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 exports the same solved `CoordinatedDiagram` to standalone SVG and Excalidraw-compatible JSON. It proves that exporters consume coordinated IR only and do not independently recompute layout geometry, text measurement, routing, anchors, or container placement.

In scope:
- Standalone SVG export with shapes, labels, groups, edges, and arrowheads.
- Excalidraw JSON export with editable shapes, text, connectors, and group relationships.
- Shared coordinated fixtures that export to both formats.
- Automated gates that fail if exporters depend on layout/solver/text/routing modules.

Out of scope:
- YAML/JSON DSL parsing and CLI behavior.
- draw.io, Mermaid, ASCII/Unicode, TikZ, or preview UI.
- Rich styling systems or public style API design.
- Rerunning Dagre, Pretext, label fitting, shape geometry, or edge routing inside exporters.

</domain>

<decisions>
## Implementation Decisions

### SVG Output Baseline
- **D-01:** SVG must map all seven existing node shapes: `rectangle`, `rounded-rectangle`, `ellipse`, `diamond`, `parallelogram`, `hexagon`, and `cylinder`.
- **D-02:** SVG text must render from existing label layout data, using line boxes and baselines to generate `text`/`tspan` output. The SVG exporter must not remeasure text.
- **D-03:** SVG edges must render from `CoordinatedEdge.points` as path output with arrowheads.
- **D-04:** Arrowheads require explicit vector-aware geometry: calculate the final segment direction and arrowhead/tip placement from the edge points rather than relying only on generic browser marker behavior.

### Excalidraw Exporter Adapter
- **D-05:** Excalidraw is one recommended Phase 4 export target, but it is only an exporter adapter. It must not become the semantic model for DGE and must not influence core IR or solver design.
- **D-06:** Excalidraw nodes should export as editable shape elements plus separate editable text elements.
- **D-07:** Excalidraw arrows should include `startBinding` and `endBinding` while still deriving geometry from coordinated edge points.
- **D-08:** Excalidraw groups should preserve both visible group boundaries and editable child grouping relationships.
- **D-09:** Planning should isolate the Excalidraw attachment/adapter work into its own wave so SVG/default exporter correctness can be established first and Excalidraw-specific JSON semantics do not contaminate shared exporter foundations.

### Shared Fixtures And Verification Gates
- **D-10:** Exporter tests should use committed `CoordinatedDiagram` JSON fixtures as the source of truth. The same fixture must generate both SVG and Excalidraw outputs.
- **D-11:** SVG output should be compared as stable golden strings. Excalidraw output should be compared as canonical JSON.
- **D-12:** Add automated tests or grep gates proving exporters do not import or call solver, layout, text measurement, label fitting, or routing modules. Exporters may use renderer-local serialization helpers, but geometry must already be present in the coordinated IR.

### Style Boundary
- **D-13:** Phase 4 should use minimal default styles and must not introduce a public style API.
- **D-14:** The default visual style is a neutral engineering diagram: white background, black/gray strokes, readable font defaults, and light node fills. This default is shared across exporters where possible and is not Excalidraw-hand-drawn styling.
- **D-15:** Style tests should check necessary default attributes exist, such as `stroke`, `fill`, `font`, and SVG arrow markers. Do not over-lock aesthetic details in brittle snapshots.

### the agent's Discretion
- The planner may choose exact file names and helper boundaries for `src/exporters/*`, provided public exports stay root-only unless a later phase explicitly changes package exports.
- The planner may choose exact SVG path serialization and Excalidraw element ID generation strategy, provided output is deterministic.
- The planner may decide whether Phase 4 fixtures are hand-authored coordinated JSON or generated once from existing solver tests, but exporter tests must consume committed coordinated fixtures directly.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/ROADMAP.md` — Phase 4 goal, success criteria, and dependency notes.
- `.planning/REQUIREMENTS.md` — EXP-01, EXP-02, and EXP-03 acceptance requirements.
- `.planning/PROJECT.md` — Project positioning as a deterministic geometry engine, not a renderer or visual editor.
- `.planning/STATE.md` — Current phase focus and Phase 3 completion state.

### Prior Locked Decisions
- `.planning/phases/01-project-scaffold-and-core-ir/01-CONTEXT.md` — Renderer-free IR, prepare/solve/export separation, and canonical serializer decisions.
- `.planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md` — Label layout and shape geometry must stay renderer-neutral; real SVG golden tests belong to Phase 4.
- `.planning/phases/03-layout-constraints-and-routing/03-CONTEXT.md` — Exporters must consume coordinated IR and must not rerun Dagre, Pretext, routing, or constraints.
- `.planning/phases/03-layout-constraints-and-routing/03-VERIFICATION.md` — Verified coordinated solver outputs and Phase 3 fixture coverage.

### Research And Design References
- `.planning/research/ARCHITECTURE.md` — Exporters receive fully coordinated diagrams and must never guess geometry.
- `.planning/research/PITFALLS.md` — Risk: exporters duplicating geometry logic and diverging across formats.
- `.planning/research/SUMMARY.md` — v1 needs SVG and Excalidraw export after coordinated IR stabilizes.
- `diagram-geometry-engine-design.md` §5.6 — Format exporter responsibility and initial exporter interface framing.
- `diagram-geometry-engine-design.md` §8.1-8.3 — SVG and Excalidraw export expectations, text handling, and Excalidraw coordinate mapping notes.
- `.planning/research/STACK.md` — Excalidraw docs reference and stack guidance for JSON/SVG output.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/ir/diagram.ts` — Defines `CoordinatedDiagram`, the only input contract exporters should consume.
- `src/ir/elements.ts` — Defines coordinated nodes, edges, groups, labels, points, and boxes exporters need.
- `src/labels/types.ts` — Defines `LabelLayout` and line/baseline information that SVG text output should use when available through coordinated data or fixture metadata.
- `src/serialization/canonical.ts` — Existing canonical serializer for deterministic Excalidraw JSON fixtures.
- `src/geometry/shapes.ts` — Useful only as a reference for shape names and prior geometry behavior; exporters must not call geometry recomputation as part of export.
- `test/fixtures/phase-03/*.canonical.json` — Examples of committed canonical coordinated fixtures.

### Established Patterns
- Public APIs are exported through `src/index.ts`; tests import from the root package entrypoint.
- Canonical fixtures live under `test/fixtures/phase-XX` and are compared against deterministic output.
- Core modules use `.js` ESM specifiers in TypeScript source.
- Diagnostic and verification style favors explicit stable strings over implicit behavior.

### Integration Points
- Add exporter modules under a new exporter boundary such as `src/exporters/`.
- Add SVG and Excalidraw exporter APIs to the root package entrypoint.
- Add public API tests proving exporter functions/classes are importable from `../src/index.js`.
- Add fixture tests that load one coordinated fixture and compare both SVG and Excalidraw golden outputs.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly emphasized that Excalidraw is only one export mode. DGE should support similar future formats such as draw.io by solving geometry once and adapting coordinated IR into each target format.
- The user wants Excalidraw handled as a dedicated attachment/exporter adapter wave within this phase.
- The user wants default output to be neutral engineering-diagram style, not Excalidraw-specific visual styling.
- SVG arrowheads need precise vector calculations for direction and tip placement.

</specifics>

<deferred>
## Deferred Ideas

- draw.io/mxGraph XML export remains out of scope for Phase 4 and is tracked in v2 requirements.
- Mermaid and ASCII/Unicode exports remain out of scope for Phase 4.
- Rich public style APIs should wait until DSL/CLI or a later style-focused phase.
- Browser preview/UI remains out of scope.

</deferred>

---

*Phase: 04-coordinated-exporters*
*Context gathered: 2026-05-25*
