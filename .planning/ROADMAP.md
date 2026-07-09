# Roadmap: v1.2 Dense MBSE Remediation Execution

**Created:** 2026-07-09
**Phase numbering:** Continued from completed v1.1 Phases 8-12
**Epic:** #75

## Milestone Goal

Resolve the current non-polar open issue set by implementing dense-diagram remediation execution. The solver must not stop at degraded diagnostics for dense MBSE pages; it must execute external labels, rails/gutters, growth, or return machine-applicable split/unsat plans.

## Issue Routing

| Issue | Role In v1.2 | Decision |
|-------|--------------|----------|
| #75 | Active epic | Primary tracking issue for this milestone. |
| #73 | Folded design context | Weak closed loop exists; remaining work is executable remediation. |
| #71 | Folded evidence context | Dense route/label portion moves to #75; position/container side is historical. |
| #69 | Folded root-cause context | Iteration, text vertices, compact obstacles, and tolerance are local primitives, not enough by themselves. |
| #74 | Regression guard | Add test then close or mark superseded by #75. |
| #15 | Excluded | Polar/geographic coordinates are not part of dense MBSE deliverability. |

## Phases

| Phase | Name | Goal | Requirements |
|-------|------|------|--------------|
| 13 | Unified Issue Research And Regression Guards | Consolidate #69/#71/#73/#74 into #75, exclude #15, and lock #74 regression behavior. | EPIC-01, EPIC-02, REG-74-01, REG-74-02 |
| 14 | Remediation Contract And Dense Fixtures | Add public remediation contract and dense evidence fixtures for CV, OV/SV, and IBD shapes. | CONTRACT-01, CONTRACT-02, CONTRACT-03, CONTRACT-04, FIXTURE-01, FIXTURE-02, FIXTURE-03, FIXTURE-04 |
| 15 | External Label Execution | Convert congested inline edge labels into deterministic keyed external callouts. | EXT-01, EXT-02, EXT-03, EXT-04 |
| 16 | Page Policy Rails, Gutters, And Bundles | Add page-level policies for dependency rails, side gutters, lane corridors, bundles, and growth/split capacity. | POLICY-01, POLICY-02, POLICY-03, POLICY-04, POLICY-05, POLICY-06 |
| 17 | Strict Remediation Loop And Issue Closure | Make exhausted feedback execute/stage remediations, enforce strict closure, document the contract, and prepare issue hygiene. | LOOP-01, LOOP-02, LOOP-03, DIAG-01, STRICT-01, STRICT-02, DOC-01 |

## Phase Details

### Phase 13: Unified Issue Research And Regression Guards

**Status:** Complete, 2026-07-09.

**Goal:** Consolidate all active non-polar issue evidence under #75 and lock #74 so future remediation changes cannot reintroduce fatal evidence-crossing regression.

**Success criteria:**
1. Research file maps #69/#71/#73/#74/#75 into one issue-resolution matrix and marks #15 excluded.
2. Tests prove text hard obstacles from route-label feedback are not emitted as `routing.evidence.crossing_forbidden`.
3. Feedback candidate scoring still prioritizes hard-route diagnostics ahead of route/text count improvements.
4. Planning state points to #75 as the active epic.

### Phase 14: Remediation Contract And Dense Fixtures

**Goal:** Define the public contract and fixtures before implementing remediation execution.

**Success criteria:**
1. `SolveDiagramOptions` or equivalent exposes dense deliverability mode and remediation policy.
2. `CoordinatedDiagram` can carry remediation plan objects with deterministic IDs and machine-applicable details.
3. Dense CV, OV/SV, and IBD fixtures encode #75's capacity failure families.
4. Stage 5-style evidence includes deliverability and remediation-plan counts.

### Phase 15: External Label Execution

**Goal:** Turn edge-label congestion into executed keyed callouts rather than advisory `external-label-or-split` diagnostics.

**Success criteria:**
1. Congested inline edge labels get deterministic keys.
2. Long label text moves to a reserved external shelf/legend.
3. Local route field only contains short keys or no local label box, so routes no longer collide with long inline labels.
4. Solver output preserves edge-to-callout mapping for downstream exporters.

### Phase 16: Page Policy Rails, Gutters, And Bundles

**Goal:** Solve the correct page-level capacity problem before per-edge search.

**Success criteria:**
1. Dependency pages allocate top/bottom rails with occupancy scoring.
2. Resource-flow and IBD pages allocate side gutters and fan-in/fan-out bundles.
3. Lane-behavior pages reserve lane-aware corridors and avoid title/header bands.
4. Anchor capacity triggers growth or exact growth plans.
5. Rail/lane overload returns split plans with concrete capacity numbers.

### Phase 17: Strict Remediation Loop And Issue Closure

**Goal:** Integrate remediation execution into the route-label loop and finish the public/documented strict contract.

**Success criteria:**
1. `routing.route-label-loop.exhausted` transitions into remediation planning.
2. Auto policies execute remediations and re-solve affected subgraphs.
3. Suggest-only policies return machine-applicable unsat/split/grow plans.
4. Strict dense mode returns clean Stage 5-style output or structured unsat; it does not return unplanned visual collisions as normal output.
5. README documents dense remediation mode and #74/#73/#71 closure recommendations are ready.

## Traceability Summary

| Phase | Requirement Count |
|-------|-------------------|
| Phase 13 | 4 |
| Phase 14 | 8 |
| Phase 15 | 4 |
| Phase 16 | 6 |
| Phase 17 | 7 |

**Coverage:** 29 / 29 v1.2 requirements mapped.

---
*Roadmap created: 2026-07-09 for Issue #75 capability epic*
