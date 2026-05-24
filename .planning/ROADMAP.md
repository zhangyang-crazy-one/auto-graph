# Roadmap: Diagram Geometry Engine

**Created:** 2026-05-24
**Granularity:** Standard
**Mode:** YOLO

## Summary

6 phases | 29 v1 requirements mapped | All v1 requirements covered

| # | Phase | Goal | Requirements | UI hint |
|---|-------|------|--------------|---------|
| 1 | Project Scaffold And Core IR | 3/3 | Complete    | 2026-05-24 |
| 2 | Text, Labels, And Shape Geometry | Implement measurement, label fitting, and core shape math required before layout | TXT-01, TXT-02, TXT-03, GEO-01, GEO-02, GEO-03 | no |
| 3 | Layout, Constraints, And Routing | Produce coordinated node placement and connector paths from measured geometry | LAY-01, LAY-02, LAY-03, LAY-04, RTE-01, RTE-02, RTE-03 | no |
| 4 | Coordinated Exporters | Export the same solved diagram to SVG and Excalidraw without duplicating geometry logic | EXP-01, EXP-02, EXP-03 | no |
| 5 | DSL Parser And CLI | Let users and agents run DGE from YAML/JSON files, stdin, and command-line format flags | DSL-01, DSL-02, DSL-03, CLI-01, CLI-02, CLI-03 | no |
| 6 | Verification And Release Readiness | Lock correctness with numeric, golden, exporter, and determinism tests | VER-01, VER-02, VER-03, VER-04 | no |

## Phase Details

### Phase 1: Project Scaffold And Core IR

**Goal:** Establish the minimal TypeScript project structure and data contracts that every later phase depends on.

**Requirements:** FND-01, FND-02, FND-03

**Plans:** 3/3 plans complete

Plans:
- [x] 01-01-PLAN.md — Create npm, TypeScript, tsup, Vitest, and Biome scaffold.
- [x] 01-02-PLAN.md — Create public IR type contracts and entrypoint proof.
- [x] 01-03-PLAN.md — Create canonical serializer and determinism tests.

**Success criteria:**
1. `npm` scripts or equivalent commands can build, test, and lint the project.
2. Public TypeScript types exist for intent IR, normalized IR, coordinated IR, geometry primitives, and constraints.
3. A deterministic serializer normalizes ordering and numeric precision for tests and snapshots.
4. A minimal unit test proves stable serialization across repeated runs.

### Phase 2: Text, Labels, And Shape Geometry

**Goal:** Convert text and shape intent into precise sizes, boxes, anchors, and obstacle geometry.

**Requirements:** TXT-01, TXT-02, TXT-03, GEO-01, GEO-02, GEO-03

**Plans:** 5 plans

Plans:
- [ ] 02-01-PLAN.md — Add Pretext dependency, MIT license/credits, and text measurement contracts/adapters.
- [ ] 02-02-PLAN.md — Implement renderer-neutral label fitting and multiline/non-English numeric tests.
- [ ] 02-03-PLAN.md — Implement box utilities and seven-shape geometry with edge-port approximations.
- [ ] 02-04-PLAN.md — Implement container geometry from known child boxes and optional label layout.
- [ ] 02-05-PLAN.md — Wire public exports, canonical fixtures, renderer-creep checks, and full verification.

**Success criteria:**
1. `TextMeasurer` has a Pretext-backed implementation and a test-friendly fallback.
2. `LabelFitter` computes dimensions from label text, font settings, padding, min sizes, and max width.
3. Shape geometry supports the seven v1 shapes with bounds and anchor calculations.
4. Collision and obstacle expansion utilities have numeric unit coverage.
5. Multilingual label fixtures fit inside expected SVG-safe bounds.

### Phase 3: Layout, Constraints, And Routing

**Goal:** Produce full coordinated geometry from measured nodes, edges, layout direction, constraints, and routing options.

**Requirements:** LAY-01, LAY-02, LAY-03, LAY-04, RTE-01, RTE-02, RTE-03

**Success criteria:**
1. Dagre-backed automatic layout handles TB, LR, BT, and RL directions.
2. Fixed nodes can coexist with automatically placed nodes.
3. Exact, relative, align, distribute, and containment padding constraints apply in deterministic precedence order.
4. Conflicting constraints produce diagnostics instead of silent geometry corruption.
5. Straight and orthogonal routes connect shape anchors and avoid simple rectangular obstacles in fixtures.

### Phase 4: Coordinated Exporters

**Goal:** Prove the coordinated IR can drive multiple output formats consistently.

**Requirements:** EXP-01, EXP-02, EXP-03

**Success criteria:**
1. SVG exporter writes standalone SVG with node shapes, wrapped labels, groups, edges, and arrowheads.
2. Excalidraw exporter writes editable JSON elements for shapes, text, and connectors.
3. A shared fixture exports to both SVG and Excalidraw from the same coordinated IR.
4. Exporter tests fail if an exporter attempts to recompute layout-only geometry.

### Phase 5: DSL Parser And CLI

**Goal:** Provide the agent-facing and developer-facing execution surface.

**Requirements:** DSL-01, DSL-02, DSL-03, CLI-01, CLI-02, CLI-03

**Success criteria:**
1. YAML and JSON DSL inputs normalize into the same internal intent IR.
2. Validation reports invalid fields, missing references, unsupported shapes, and bad constraints with actionable paths.
3. CLI supports `--input`, stdin, `--format`, and `--output`.
4. CLI exits with non-zero status and readable errors for invalid input or unsatisfied constraints.
5. Example DSL files cover architecture, flowchart, edge labels, groups, and hybrid layout.

### Phase 6: Verification And Release Readiness

**Goal:** Make the project reliable enough for phase-by-phase implementation and future package release.

**Requirements:** VER-01, VER-02, VER-03, VER-04

**Success criteria:**
1. Numeric unit tests cover text adapters, label fitting, shape geometry, constraints, and routing.
2. Golden coordinated IR fixtures cover the main supported diagram types.
3. Golden SVG and Excalidraw fixtures are generated from the same coordinated IR.
4. Determinism tests prove repeated runs produce identical normalized output.
5. README documents the positioning, core API, CLI examples, and current limitations.

## Dependency Notes

- Phase 1 blocks all later phases.
- Phase 2 blocks meaningful layout and routing because node dimensions and anchors must exist first.
- Phase 3 blocks exporter correctness because exporters must consume coordinated IR.
- Phase 4 and Phase 5 can be partially parallel after Phase 3 if write scopes are kept separate.
- Phase 6 should run throughout but closes the milestone after all feature phases exist.

## Coverage

All v1 requirements in `.planning/REQUIREMENTS.md` are mapped to exactly one phase.

---
*Roadmap created: 2026-05-24*
*Last updated: 2026-05-24 after initialization*
