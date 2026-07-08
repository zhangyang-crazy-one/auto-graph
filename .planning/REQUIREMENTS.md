# Requirements: Diagram Geometry Engine

**Defined:** 2026-07-08
**Core Value:** Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

## v1.1 Requirements

### Closed-loop Route/Label Solver

- [ ] **LOOP-01**: Solver can validate final edge routes against final node-label and edge-label boxes after edge-label placement.
- [ ] **LOOP-02**: Solver can reroute conflicting edges using final label boxes as obstacles within a bounded iteration budget.
- [ ] **LOOP-03**: Solver can preserve deterministic output when route/label feedback loops have multiple equivalent candidate choices.
- [ ] **LOOP-04**: Solver can stop the loop with a structured unsatisfiable result when all bounded candidates still violate strict clearance.

### Strict Deliverability

- [ ] **STRICT-01**: Caller can request strict/deliverable clearance semantics that do not silently accept `routing.text-clearance.unresolved` output as deliverable.
- [ ] **STRICT-02**: Strict mode reports whether the layout is clean, degraded, or unsatisfiable.
- [ ] **STRICT-03**: Strict unsatisfiable diagnostics identify the blocking page, edge ids, obstacle/text surfaces, and required remediation type.
- [ ] **STRICT-04**: Existing non-strict behavior remains available for exploratory or degraded layouts.

### Label Congestion And Externalization

- [ ] **LABEL-01**: Edge-label placement returns structured congestion data when every candidate collides.
- [ ] **LABEL-02**: Congestion diagnostics include page, edge set, occupied corridor/rail, candidate count, and label count.
- [ ] **LABEL-03**: Solver can mark labels as external-callout-required when local placement cannot satisfy strict clearance.
- [ ] **LABEL-04**: Route/text clearance reporting distinguishes node-label, edge-label, and externalized-label cases.

### Rails And Gutters

- [ ] **RAIL-01**: Solver exposes page-level rail/gutter allocation for CV dependency and OV/SV resource-flow pages.
- [ ] **RAIL-02**: Framed LR/RL rail lanes avoid frame title/header obstacles.
- [ ] **RAIL-03**: Rail validation excludes only the actual source and target nodes, not unrelated nodes whose expanded obstacles touch endpoint boxes.
- [ ] **RAIL-04**: Rail fast paths are skipped or corrected when explicit anchors would jog through endpoint interiors.
- [ ] **RAIL-05**: Activity, state, and sequence pages can reserve lane-aware corridors for route bundles.

### Constraint Repair Integration

- [ ] **CONS-01**: Anchor-capacity growth happens before final overlap/containment repair or triggers a second repair pass afterward.
- [ ] **CONS-02**: Locked-conflict diagnostics are recalculated after any solver mutation that changes node boxes.
- [ ] **CONS-03**: Strict mode treats post-growth overlaps as blocking layout errors unless they are explicitly unsatisfiable.

### Acceptance Evidence

- [ ] **ACC-01**: Acceptance tests fail when any final edge route intersects a final edge label.
- [ ] **ACC-02**: Acceptance tests fail when any final edge route intersects a final node label or unrelated node interior.
- [ ] **ACC-03**: Acceptance tests cover at least one dense CV dependency page and one OV/SV resource-flow page.
- [ ] **ACC-04**: Acceptance evidence records Stage 5-style counts for text intersections, obstacle intersections, backtracking, page overflow, and unsat diagnostics.
- [ ] **ACC-05**: Local `npm run verify` remains the required all-in-one verification gate.

## v2 Requirements

### Global Routing Architecture

- **GLOBAL-01**: Solver can perform full ordered-bundle or bus-routing optimization across all page edges.
- **GLOBAL-02**: Solver can split pages automatically when route/label capacity is provably insufficient.
- **GLOBAL-03**: Solver can export structured rail/gutter plans for downstream editors as first-class artifacts.

### Downstream Integration

- **DOWN-01**: drawio-mbse can consume auto-graph unsatisfiable diagnostics to propose page splits or external labels.
- **DOWN-02**: CLI can emit a machine-readable strict-delivery report compatible with downstream Stage 5 validation.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full router replacement with an external engine | Too broad for this milestone; first close the current solver feedback loop. |
| Browser visual editor | The package remains headless and one-shot. |
| Graphviz subprocess fallback | Adds non-Node dependency and different layout semantics. |
| Automatic page splitting implementation | This milestone should diagnose split-required cases; full auto-split is v2. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| LOOP-01 | Phase 8 | Pending |
| LOOP-02 | Phase 8 | Pending |
| LOOP-03 | Phase 8 | Pending |
| LOOP-04 | Phase 8 | Pending |
| STRICT-01 | Phase 9 | Pending |
| STRICT-02 | Phase 9 | Pending |
| STRICT-03 | Phase 9 | Pending |
| STRICT-04 | Phase 9 | Pending |
| LABEL-01 | Phase 10 | Pending |
| LABEL-02 | Phase 10 | Pending |
| LABEL-03 | Phase 10 | Pending |
| LABEL-04 | Phase 10 | Pending |
| RAIL-01 | Phase 11 | Pending |
| RAIL-02 | Phase 11 | Pending |
| RAIL-03 | Phase 11 | Pending |
| RAIL-04 | Phase 11 | Pending |
| RAIL-05 | Phase 11 | Pending |
| CONS-01 | Phase 11 | Pending |
| CONS-02 | Phase 11 | Pending |
| CONS-03 | Phase 11 | Pending |
| ACC-01 | Phase 12 | Pending |
| ACC-02 | Phase 12 | Pending |
| ACC-03 | Phase 12 | Pending |
| ACC-04 | Phase 12 | Pending |
| ACC-05 | Phase 12 | Pending |

**Coverage:**
- v1.1 requirements: 25 total
- Mapped to phases: 25
- Unmapped: 0

---
*Requirements defined: 2026-07-08*
*Last updated: 2026-07-08 after milestone v1.1 definition*
