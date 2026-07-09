# Requirements: Diagram Geometry Engine

**Defined:** 2026-07-08
**Updated:** 2026-07-09
**Core Value:** Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

## v1.2 Requirements: Dense MBSE Remediation Execution

### Issue Consolidation And Regression Guards

- [ ] **EPIC-01**: Open non-polar issues are consolidated under #75, with #69/#71/#73 as folded evidence, #74 as fixed-with-regression-guard, and #15 explicitly excluded.
- [ ] **EPIC-02**: Planning artifacts record the 0.2.13 -> 0.2.17 evidence trend and the live 0.2.17 Stage 5 result: 132 critical / 179 warnings.
- [ ] **REG-74-01**: A targeted regression test proves route-label feedback text obstacles do not emit fatal `routing.evidence.crossing_forbidden`.
- [ ] **REG-74-02**: Candidate scoring continues to reject reroutes that introduce hard-route diagnostics, even if they reduce route/text conflict count.

### Public Remediation Contract

- [ ] **CONTRACT-01**: Public options support `deliverabilityMode: "strict" | "degraded-ok"` or equivalent.
- [ ] **CONTRACT-02**: Public options support `remediationPolicy` with `externalLabels`, `routeRails`, `growFixedGeometry`, and `pageSplit` policies using `off | suggest | auto` where applicable.
- [ ] **CONTRACT-03**: `CoordinatedDiagram` exposes stable remediation plan objects, not only string remediation types.
- [ ] **CONTRACT-04**: `deliverability`, `degraded`, `bounds`, `diagnosticCodes`, `remediationTypes`, and remediation plan objects are documented as stable public output for strict consumers.

### Dense Fixture And Evidence Baseline

- [ ] **FIXTURE-01**: Dense CV-style dependency fixture has at least 20 labeled edges over a small node set and reproduces rail/label capacity pressure.
- [ ] **FIXTURE-02**: Dense OV/SV-style resource-flow fixture reproduces side-gutter, node-label, and route/obstacle pressure.
- [ ] **FIXTURE-03**: Dense IBD/high-fan-in fixture reproduces anchor capacity and bundle/fan-out pressure.
- [ ] **FIXTURE-04**: Stage 5-style evidence records route/text, route/obstacle, unrelated-node, backtracking, page-overflow, deliverability, and remediation-plan counts.

### External Label Execution

- [ ] **EXT-01**: Congested inline edge labels can be converted into deterministic keyed callouts.
- [ ] **EXT-02**: Externalized labels reserve a deterministic label shelf/legend outside the saturated route field.
- [ ] **EXT-03**: Only short keys remain near routed edges; long label boxes no longer participate as local route obstacles.
- [ ] **EXT-04**: External label execution preserves source edge identity and enough metadata for downstream draw.io/SVG exporters.

### Page Policy Routing And Capacity

- [ ] **POLICY-01**: Solver can classify or accept page policy hints for dependency, resource-flow, lane-behavior, and IBD/high-fan-in pages.
- [ ] **POLICY-02**: Dependency pages allocate deterministic top/bottom rails and score rail occupancy before route acceptance.
- [ ] **POLICY-03**: Resource-flow and IBD pages allocate side gutters and fan-in/fan-out bundle lanes.
- [ ] **POLICY-04**: Activity/state/sequence pages reserve lane-aware corridors and avoid header/title bands.
- [ ] **POLICY-05**: Anchor-capacity pressure triggers growth when policy allows it, otherwise returns exact growth deltas in a remediation plan.
- [ ] **POLICY-06**: Rail/lane capacity over budget returns a split plan with edge subset, node subset, capacity numbers, and reason.

### Remediation Loop And Strict Closure

- [ ] **LOOP-01**: `routing.route-label-loop.exhausted` transitions into remediation planning instead of terminal advisory failure.
- [ ] **LOOP-02**: When policy can execute a remediation, the solver applies it and re-solves the affected subgraph.
- [ ] **LOOP-03**: When policy cannot execute a remediation, strict mode returns structured unsatisfiable output with machine-applicable remediation plans.
- [ ] **DIAG-01**: Diagnostics distinguish true node-label strike-through, edge-label pileup, label bounding-box graze, fixed-geometry blockage, rail/lane capacity overflow, and true evidence crossing.
- [ ] **STRICT-01**: Strict dense mode returns either zero Stage 5-style critical route/text and route/obstacle findings or an unsatisfiable/degraded result with executed or machine-applicable remediation plans.
- [ ] **STRICT-02**: No deliverable layout emits `routing.text-clearance.unresolved`, `routing.obstacle.unavoidable`, or `routing.route-label-loop.exhausted` without an executed or staged remediation plan.
- [ ] **DOC-01**: README docs describe dense deliverability mode, remediation policy, remediation plans, and issue closure expectations.

## Deferred / Excluded

| Requirement | Reason |
|-------------|--------|
| #15 polar/geographic coordinates | Separate coordinate-system feature; excluded by user request. |
| Full external global router replacement | Too broad and unnecessary for the first executable remediation layer. |
| Automatic semantic page materialization | v1.2 returns machine-readable split plans; full auto-split can follow. |
| Downstream gate relaxation | The problem is real visual invalidity; gates must stay strict. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EPIC-01 | Phase 13 | Planned |
| EPIC-02 | Phase 13 | Planned |
| REG-74-01 | Phase 13 | Planned |
| REG-74-02 | Phase 13 | Planned |
| CONTRACT-01 | Phase 14 | Planned |
| CONTRACT-02 | Phase 14 | Planned |
| CONTRACT-03 | Phase 14 | Planned |
| CONTRACT-04 | Phase 14 | Planned |
| FIXTURE-01 | Phase 14 | Planned |
| FIXTURE-02 | Phase 14 | Planned |
| FIXTURE-03 | Phase 14 | Planned |
| FIXTURE-04 | Phase 14 | Planned |
| EXT-01 | Phase 15 | Planned |
| EXT-02 | Phase 15 | Planned |
| EXT-03 | Phase 15 | Planned |
| EXT-04 | Phase 15 | Planned |
| POLICY-01 | Phase 16 | Planned |
| POLICY-02 | Phase 16 | Planned |
| POLICY-03 | Phase 16 | Planned |
| POLICY-04 | Phase 16 | Planned |
| POLICY-05 | Phase 16 | Planned |
| POLICY-06 | Phase 16 | Planned |
| LOOP-01 | Phase 17 | Planned |
| LOOP-02 | Phase 17 | Planned |
| LOOP-03 | Phase 17 | Planned |
| DIAG-01 | Phase 17 | Planned |
| STRICT-01 | Phase 17 | Planned |
| STRICT-02 | Phase 17 | Planned |
| DOC-01 | Phase 17 | Planned |

**Coverage:**
- v1.2 requirements: 29 total
- Mapped to phases: 29
- Unmapped: 0

---
*Last updated: 2026-07-09 after Issue #75 consolidation*
