# Phase 2: Text, Labels, And Shape Geometry - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 converts text, labels, shapes, and known child boxes into deterministic geometry primitives that later layout, routing, and exporters can consume. It delivers text measurement interfaces, label fitting, seven v1 shape geometry helpers, collision/obstacle boxes, and container/group geometry from already-known child boxes.

This phase does not implement Dagre layout, automatic child placement inside containers, containment constraint solving, connector routing algorithms, SVG/Excalidraw exporters, DSL parsing, CLI behavior, or visual preview UI.

</domain>

<decisions>
## Implementation Decisions

### Text Measurement And Label Fitting

- **D-01:** Use a Pretext-style two-stage text measurement API: `prepare(text, font)` performs expensive text/font analysis and `layout(prepared, maxWidth, lineHeight)` performs cheap repeated layout calculations.
- **D-02:** Reuse `@chenglou/pretext` directly for text measurement and line breaking. Do not reimplement Pretext's multilingual text algorithms inside DGE unless a thin adapter or deterministic test fallback is needed.
- **D-03:** Provide a renderer-neutral `LabelLayout` result instead of SVG or HTML output. It should carry enough geometry for future SVG, HTML, Excalidraw, and other exporters to render labels without remeasuring text.
- **D-04:** `LabelLayout` should expose the fitted label box, content box, line records, font information, line height, padding, and overflow/truncation diagnostics where applicable.
- **D-05:** `LabelFitter` computes node dimensions from text layout plus padding, minimum size, and optional `maxWidth`. It should not own exporter-specific rendering rules.

### License And Attribution

- **D-06:** Use MIT license for auto-graph / DGE.
- **D-07:** Add README appreciation/credits for Pretext because DGE intentionally reuses Pretext's text measurement work instead of rebuilding it. `@chenglou/pretext` currently reports `MIT` license on npm.

### Shape Geometry Rules

- **D-08:** Phase 2 uses practical deterministic approximations for the seven v1 shapes: `rectangle`, `rounded-rectangle`, `ellipse`, `diamond`, `parallelogram`, `hexagon`, and `cylinder`.
- **D-09:** Every supported shape must compute an outer `Box`, center, standard anchors, expanded obstacle/collision boxes, and deterministic edge entry/exit approximations sufficient for later routing.
- **D-10:** Practical approximation is not the final long-term shape model. Planning should leave clear extension points and explicit design debt for later precise boundary intersection calculations, especially for ellipse, diamond, hexagon, parallelogram, and cylinder.
- **D-11:** Keep shape geometry renderer-neutral. Do not add SVG path strings, Excalidraw element fields, CSS, HTML, Mermaid, or draw.io output fields to Phase 2 geometry APIs.

### Container And Group Geometry

- **D-12:** Container/group geometry is in scope when child boxes are already known. Given child boxes, padding, optional label/header, and minimum size, Phase 2 should compute the container outer box, content box, label layout, anchors, and obstacle/collision box.
- **D-13:** Automatic child placement inside containers is out of scope. Phase 3 owns containment constraint solving, auto-placement, and conflict diagnostics for children that need layout.
- **D-14:** Container geometry should use the same calculation chain as normal nodes: text measurement -> label layout -> intrinsic size / child bounds -> box -> anchors -> obstacle box.

### Verification And Phase Boundary

- **D-15:** Do not generate SVG in Phase 2 just to test labels. Repeated SVG generation would move cost and responsibility into the exporter layer too early.
- **D-16:** Verify Phase 2 with numeric tests and HTML/SVG-safe layout contracts: text line boxes, bounds, padding, min/max width, overflow diagnostics, shape anchors, collision boxes, and container geometry should be asserted directly.
- **D-17:** Real SVG golden tests belong to Phase 4. Phase 2 should produce layout data that an SVG or HTML exporter can consume safely without remeasurement.

### the agent's Discretion

- Exact TypeScript names are flexible if the prepare/layout separation, renderer-neutral label result, and container boundary are preserved.
- The fallback text measurer design is flexible, but it must be deterministic and test-friendly rather than a second full text engine.
- The exact numeric tolerance strategy is flexible, but tests must make drift visible and not rely on visual inspection.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope And Requirements

- `.planning/PROJECT.md` — Project purpose, core value, constraints, and locked positioning as a deterministic geometry engine rather than renderer/UI.
- `.planning/REQUIREMENTS.md` — Phase 2 requirements TXT-01, TXT-02, TXT-03, GEO-01, GEO-02, and GEO-03.
- `.planning/ROADMAP.md` — Phase 2 goal and success criteria.
- `.planning/STATE.md` — Current project state and preserved decisions.

### Prior Phase Contracts

- `.planning/phases/01-project-scaffold-and-core-ir/01-CONTEXT.md` — Locked Phase 1 module boundaries and renderer-free IR/serialization rules.
- `.planning/phases/01-project-scaffold-and-core-ir/01-VERIFICATION.md` — Verified Phase 1 public API and serializer baseline.

### Research And Design

- `.planning/research/STACK.md` — TypeScript and Pretext stack recommendation.
- `.planning/research/ARCHITECTURE.md` — Module boundaries for text, label, shape, layout, routing, and exporters.
- `.planning/research/PITFALLS.md` — Text measurement drift, exporter geometry duplication, and routing-overbuild risks.
- `.planning/research/SUMMARY.md` — Condensed implementation sequence and known risks.
- `dge-research-report.md` — Pretext source analysis, TypeScript rationale, multilingual measurement implications, and direct reuse recommendation.
- `diagram-geometry-engine-design.md` — Original DGE architecture, TextMeasurer/ShapeGeometry/LabelFitter examples, and container/group design context.
- `https://github.com/chenglou/pretext` — Upstream Pretext project to reuse and credit.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/ir/geometry.ts` — Existing `Point`, `Size`, `Box`, `Insets`, `AnchorName`, and `AnchorPoint` contracts.
- `src/ir/elements.ts` — Existing `NodeShape`, label, node, edge, and group contracts covering the seven v1 shapes and coordinated anchors.
- `src/serialization/canonical.ts` — Deterministic serializer for future numeric fixtures.
- `test/public-api.test.ts` and `test/serialization.test.ts` — Existing Vitest style and public-entrypoint import pattern.

### Established Patterns

- Public APIs should be exported through `src/index.ts` and tested through the root entrypoint.
- Core data remains renderer-neutral; exporters map coordinated geometry later.
- Numeric/deterministic behavior should be unit-tested directly and then serialized canonically for fixtures.
- Shell commands in this repository must use the `rtk` prefix.

### Integration Points

- Text and geometry modules should extend the Phase 1 single-package source tree without adding package subpath exports unless planning explicitly decides otherwise.
- Phase 3 layout and routing should consume Phase 2 sizes, anchors, content boxes, and obstacle boxes.
- Phase 4 exporters should consume Phase 2/3 layout data and must not remeasure labels or recompute geometry independently.

</code_context>

<specifics>
## Specific Ideas

- The important reusable product is not SVG output but a renderer-neutral `LabelLayout` that HTML/SVG/Excalidraw can all consume.
- Container is a first-class geometry concern: known child boxes plus padding and optional label/header must produce deterministic container geometry.
- Pretext should be appreciated in README/credits, and DGE should use MIT licensing.
- Practical shape approximations are acceptable now, but the project must preserve a clear route to precise shape boundary math later.

</specifics>

<deferred>
## Deferred Ideas

- Precise mathematical boundary intersection for all non-rectangular shapes belongs after the practical Phase 2 approximation path is stable.
- Automatic child placement inside containers and containment constraint solving belong to Phase 3.
- Real SVG golden output checks belong to Phase 4.

</deferred>

---

*Phase: 02-text-labels-and-shape-geometry*
*Context gathered: 2026-05-24*
