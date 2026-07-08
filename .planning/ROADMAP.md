# Roadmap: v1.1 Closed-loop Route/Label Clearance

**Created:** 2026-07-08
**Phase numbering:** Continued from existing Phase 07 artifacts

## Milestone Goal

Build a closed-loop route and label clearance pipeline so dense MBSE diagrams either pass strict route/text/layout gates or return structured unsatisfiable remediation diagnostics.

## Phases

| Phase | Name | Goal | Requirements |
|-------|------|------|--------------|
| 8 | Route/Label Feedback Loop | Route final edges against final label geometry with bounded deterministic rerouting. | LOOP-01, LOOP-02, LOOP-03, LOOP-04 |
| 9 | Strict Deliverability Contract | Add strict/degraded/unsatisfiable layout semantics and remediation diagnostics. | STRICT-01, STRICT-02, STRICT-03, STRICT-04 |
| 10 | Label Congestion And External Labels | Make failed edge-label placement actionable and support external-callout-required outcomes. | LABEL-01, LABEL-02, LABEL-03, LABEL-04 |
| 11 | Rails, Gutters, And Post-growth Repair | Promote page-level routing capacity and PR #72 Codex review fixes into solver contracts. | RAIL-01, RAIL-02, RAIL-03, RAIL-04, RAIL-05, CONS-01, CONS-02, CONS-03 |
| 12 | Dense MBSE Acceptance Gate | Add Stage 5-style invariant tests and evidence for representative dense MBSE pages. | ACC-01, ACC-02, ACC-03, ACC-04, ACC-05 |

## Phase Details

### Phase 8: Route/Label Feedback Loop

**Goal:** Route final edges against final label geometry with bounded deterministic rerouting.

**Requirements:** LOOP-01, LOOP-02, LOOP-03, LOOP-04

**Success criteria:**
1. Solver can place edge labels, build final label boxes, and revalidate routes against those boxes.
2. Conflicting edges can be rerouted with final label boxes as obstacles within a deterministic iteration limit.
3. Repeated runs on the same input produce stable coordinated edges, labels, diagnostics, and snapshots.
4. If bounded rerouting cannot clear conflicts, the solver returns an unsatisfiable diagnostic instead of only a post-hoc warning.

**Notes:**
- Start from `src/solver/solve.ts::coordinateEdges`, `coordinateEdgeTextAnnotations`, `edgeLabelAnchor`, and `reportRouteTextClearance`.
- Preserve existing non-strict behavior until Phase 9 defines the public contract.

### Phase 9: Strict Deliverability Contract

**Goal:** Add strict/degraded/unsatisfiable layout semantics and remediation diagnostics.

**Requirements:** STRICT-01, STRICT-02, STRICT-03, STRICT-04

**Success criteria:**
1. Public solver options can request strict/deliverable clearance semantics.
2. Solver output includes a clear clean/degraded/unsatisfiable status or equivalent structured diagnostics.
3. Strict mode does not treat `routing.text-clearance.unresolved` or unsafe `routing.obstacle.unavoidable` output as deliverable.
4. Non-strict callers retain current degraded-output behavior.

**Notes:**
- Diagnostic payloads must include enough detail for downstream drawio-mbse remediation.
- Keep status naming compatible with existing `Diagnostic` conventions.

### Phase 10: Label Congestion And External Labels

**Goal:** Make failed edge-label placement actionable and support external-callout-required outcomes.

**Requirements:** LABEL-01, LABEL-02, LABEL-03, LABEL-04

**Success criteria:**
1. `edgeLabelAnchor` or its replacement returns structured congestion data when all local candidates collide.
2. Diagnostics include page, edge ids, corridor/rail details, candidate counts, and label counts.
3. Solver can mark labels as external-callout-required instead of placing them into collisions.
4. Route/text reporting distinguishes node-label, edge-label, and externalized-label clearance cases.

**Notes:**
- This phase should not build full downstream callout rendering; it should establish solver semantics and exportable metadata.

### Phase 11: Rails, Gutters, And Post-growth Repair

**Goal:** Promote page-level routing capacity and PR #72 Codex review fixes into solver contracts.

**Requirements:** RAIL-01, RAIL-02, RAIL-03, RAIL-04, RAIL-05, CONS-01, CONS-02, CONS-03

**Success criteria:**
1. CV dependency and OV/SV resource-flow pages can reserve page-level rails/gutters as first-class solver output.
2. Framed LR/RL rail lanes avoid title/header obstacles.
3. Rail validation excludes only actual endpoint nodes by identity.
4. Rail fast paths skip or correct anchors that would jog through endpoint interiors.
5. Anchor-capacity growth cannot leave unreported overlaps or stale locked-conflict diagnostics.

**Notes:**
- Directly addresses PR #72 Codex review comments on `src/solver/solve.ts`.
- Activity, state, and sequence lane-aware corridors can be implemented conservatively as reserved corridor metadata plus validation.

### Phase 12: Dense MBSE Acceptance Gate

**Goal:** Add Stage 5-style invariant tests and evidence for representative dense MBSE pages.

**Requirements:** ACC-01, ACC-02, ACC-03, ACC-04, ACC-05

**Success criteria:**
1. Tests fail if a final route intersects a final edge label.
2. Tests fail if a final route intersects a final node label, unrelated node interior, or hard obstacle.
3. Fixtures include at least one dense CV dependency page and one OV/SV resource-flow page.
4. Evidence records Stage 5-style counts for text intersections, obstacle intersections, backtracking, page overflow, and unsat diagnostics.
5. `npm run verify` passes after the milestone test suite is integrated.

**Notes:**
- The target is not merely lower counts; the gate must assert deliverable invariants or structured unsat output.

## Traceability Summary

| Phase | Requirement Count |
|-------|-------------------|
| Phase 8 | 4 |
| Phase 9 | 4 |
| Phase 10 | 4 |
| Phase 11 | 8 |
| Phase 12 | 5 |

**Coverage:** 25 / 25 v1.1 requirements mapped.

---
*Roadmap created: 2026-07-08 for milestone v1.1*
