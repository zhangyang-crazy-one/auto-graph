# Requirements: Diagram Geometry Engine

**Defined:** 2026-05-24
**Core Value:** Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

## v1 Requirements

Requirements for the initial release. Each maps to roadmap phases.

### Foundation

- [x] **FND-01**: Developer can install project dependencies and run TypeScript build, tests, and lint commands locally.
- [ ] **FND-02**: Developer can import stable public types for diagram intent, normalized IR, coordinated IR, points, boxes, nodes, edges, labels, and constraints.
- [ ] **FND-03**: The engine serializes numeric output deterministically with stable ordering and documented rounding rules.

### DSL

- [ ] **DSL-01**: User can define a diagram in YAML or JSON with title, direction, nodes, edges, groups, constraints, and output settings.
- [ ] **DSL-02**: User receives actionable validation errors for malformed DSL, missing node references, unsupported shapes, and invalid constraints.
- [ ] **DSL-03**: User can express fixed positions, relative offsets, alignment, distribution, and grouped containment in the DSL.

### Text And Labels

- [ ] **TXT-01**: Developer can measure labels through a `TextMeasurer` interface with a Pretext-backed default implementation.
- [ ] **TXT-02**: User can rely on label fitting to compute node width and height from text, font options, padding, minimum size, and optional max width.
- [ ] **TXT-03**: The engine handles multiline and non-English labels well enough that SVG output does not visibly overflow normal node bounds in fixture tests.

### Geometry

- [ ] **GEO-01**: Developer can compute bounds, center, cardinal anchors, and diagonal anchors for rectangle, rounded rectangle, ellipse, diamond, parallelogram, hexagon, and cylinder nodes.
- [ ] **GEO-02**: Developer can detect AABB collisions and expanded obstacle boxes with configurable margins.
- [ ] **GEO-03**: Developer can compute edge entry and exit points from shape geometry without manually guessing coordinates.

### Layout And Constraints

- [ ] **LAY-01**: User can produce an automatic directed graph layout using Dagre-backed placement with TB, LR, BT, and RL directions.
- [ ] **LAY-02**: User can mix fixed nodes with automatic layout for remaining nodes.
- [ ] **LAY-03**: User can apply exact, relative, align, distribute, and containment padding constraints after initial layout.
- [ ] **LAY-04**: User receives diagnostics when constraints conflict or cannot be satisfied without overlap.

### Routing

- [ ] **RTE-01**: User can generate straight and orthogonal connector paths between node anchors.
- [ ] **RTE-02**: Orthogonal connector paths avoid source and target interiors and simple rectangular obstacles in fixture diagrams.
- [ ] **RTE-03**: Connector output is simplified by merging collinear segments and removing redundant points.

### Export

- [ ] **EXP-01**: User can export coordinated diagrams to standalone SVG with shapes, labels, edges, arrowheads, and groups.
- [ ] **EXP-02**: User can export coordinated diagrams to Excalidraw-compatible JSON with editable shapes, text, and connectors.
- [ ] **EXP-03**: Exporters consume coordinated IR only and do not independently recompute layout geometry.

### CLI

- [ ] **CLI-01**: User can run `dge --input diagram.yaml --format svg --output diagram.svg`.
- [ ] **CLI-02**: User can pipe DSL into the CLI and write SVG or Excalidraw JSON to stdout.
- [ ] **CLI-03**: CLI exits non-zero with readable errors for invalid input, unsatisfied constraints, and unsupported formats.

### Verification

- [ ] **VER-01**: Test suite includes numeric unit tests for shape geometry, labels, constraints, and routing.
- [ ] **VER-02**: Test suite includes golden coordinated IR fixtures for architecture diagrams, flowcharts, edge labels, and hybrid layout.
- [ ] **VER-03**: Test suite includes golden SVG and Excalidraw exports generated from the same coordinated IR.
- [ ] **VER-04**: Test suite includes determinism checks that repeated runs produce identical normalized outputs.

## v2 Requirements

### Additional Exporters

- **V2-EXP-01**: User can export draw.io/mxGraph XML from coordinated IR.
- **V2-EXP-02**: User can export ASCII/Unicode diagrams for terminal and chat use.
- **V2-EXP-03**: User can export or import Mermaid flowchart syntax where coordinate precision is not required.

### Preview And Ecosystem

- **V2-PRV-01**: User can generate a local HTML preview for visual review of DSL output.
- **V2-INT-01**: Existing diagram skills can call DGE instead of hard-coding coordinates.
- **V2-INT-02**: A future MCP or skill wrapper can expose DGE to coding agents.

### Python

- **V2-PY-01**: Python users can consume stable JSON coordinated IR or a future `py-dge` port after the TypeScript contract stabilizes.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full visual editor | DGE is the geometry computation layer, not a drawing application |
| Real-time collaboration | Not needed to validate coordinate solving |
| Non-deterministic force-directed layout | Breaks reproducibility and golden tests |
| Full CSS/SVG styling engine | Aesthetics belong to caller skills and exporters |
| Python implementation in v1 | Would duplicate work before the TypeScript API is stable |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Pending |
| FND-03 | Phase 1 | Pending |
| DSL-01 | Phase 5 | Pending |
| DSL-02 | Phase 5 | Pending |
| DSL-03 | Phase 5 | Pending |
| TXT-01 | Phase 2 | Pending |
| TXT-02 | Phase 2 | Pending |
| TXT-03 | Phase 2 | Pending |
| GEO-01 | Phase 2 | Pending |
| GEO-02 | Phase 2 | Pending |
| GEO-03 | Phase 2 | Pending |
| LAY-01 | Phase 3 | Pending |
| LAY-02 | Phase 3 | Pending |
| LAY-03 | Phase 3 | Pending |
| LAY-04 | Phase 3 | Pending |
| RTE-01 | Phase 3 | Pending |
| RTE-02 | Phase 3 | Pending |
| RTE-03 | Phase 3 | Pending |
| EXP-01 | Phase 4 | Pending |
| EXP-02 | Phase 4 | Pending |
| EXP-03 | Phase 4 | Pending |
| CLI-01 | Phase 5 | Pending |
| CLI-02 | Phase 5 | Pending |
| CLI-03 | Phase 5 | Pending |
| VER-01 | Phase 6 | Pending |
| VER-02 | Phase 6 | Pending |
| VER-03 | Phase 6 | Pending |
| VER-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 29 total
- Mapped to phases: 29
- Unmapped: 0

---
*Requirements defined: 2026-05-24*
*Last updated: 2026-05-24 after initial definition*
