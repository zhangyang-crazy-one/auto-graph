# Diagram Geometry Engine

## What This Is

Diagram Geometry Engine (DGE), code name "Pretext for Graphics", is a deterministic geometry computation engine that translates high-level diagram intent into precise numeric coordinates. It is for LLMs, coding agents, and developers who need to generate accurate architecture diagrams, flowcharts, and editable diagram files without hand-guessing x/y positions or relying on visual feedback.

DGE is not a renderer or a visual editor. It is the missing geometry solving layer between automatic graph layout engines and render/export formats such as SVG, Excalidraw JSON, draw.io XML, Mermaid, and ASCII.

## Core Value

Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

## Current Milestone: v1.2 Dense MBSE Remediation Execution

**Goal:** Resolve the current non-polar open issue set by treating #75 as the capability epic: the solver must execute or machine-stage dense-diagram remediations instead of only diagnosing degraded output.

**Issue scope:**
- **Active epic:** #75 `feat(capability): dense MBSE deliverability - execute remediations, not only diagnose them`.
- **Fold into #75:** #69, #71, and #73. Their route/text, label, rail, fixed-geometry, and closed-loop findings are historical evidence and implementation inputs.
- **Regression guard / close candidate:** #74. 0.2.17 fixed the Stage 3 fatal regression; v1.2 must add a stable regression test before closing or superseding it.
- **Explicitly excluded:** #15 polar/geographic coordinate support. It is a coordinate-system feature, not part of dense MBSE deliverability.

**Target features:**
- Public dense-deliverability options such as `deliverabilityMode` and `remediationPolicy`.
- Machine-readable remediation plans, not only string remediation names.
- Automatic keyed external labels for congested long inline edge labels.
- Page-level policies before edge search: dependency rails, resource-flow side gutters, lane-aware corridors, and IBD/high-fan-in anchor capacity.
- `routing.route-label-loop.exhausted` becomes a transition into remediation execution or a structured unsatisfiable state.
- Strict consumers can rely on stable `deliverability`, `degraded`, `bounds`, routing allocations, and remediation plan objects.

## Requirements

### Validated

- Complete: DSL, IR, solver, and SVG support for fixed evidence blocks, matrices, tables, and evidence panels - Phase 07.
- Complete: Local route-label feedback loop, strict/degraded status, external-label-required diagnostics, rails/gutters, and Stage 5-style dense acceptance scaffolding - v1.1 / Phases 8-12.
- Complete: #74 P0 symptom is fixed in 0.2.17: the live downstream case no longer aborts Stage 3 with fatal `routing.evidence.crossing_forbidden` from text congestion.
- Complete: #71 position-preserving/container-collapse side is no longer the active blocker after downstream mitigations and upstream fixes; the remaining #71 scope is dense route/label congestion, now folded into #75.

### Active

- [ ] #69/#71/#73/#74/#75 are represented in one issue-resolution matrix, with #15 excluded.
- [ ] #74 has a targeted regression guard proving feedback text obstacles cannot surface as fatal evidence crossing.
- [ ] The solver exposes a stable remediation contract: `deliverabilityMode`, `remediationPolicy`, and remediation plan objects.
- [ ] Dense fixtures encode #75's live failure shape: CV dependency page with at least 20 labeled edges, OV/SV resource-flow page, and IBD/high-fan-in interface page.
- [ ] External label execution converts congested inline labels into deterministic keyed callouts and removes the long label box from the route field.
- [ ] Page policy execution allocates top/bottom rails, side gutters, fan-out/bundle lanes, lane-aware corridors, and anchor-capacity growth or growth plans.
- [ ] Exhausted local route-label feedback triggers remediation execution or returns a structured unsatisfiable plan with capacity numbers.
- [ ] Strict dense mode returns clean geometry or a machine-applicable remediation/unsat result; it must not silently return visually colliding degraded output as a normal solve.
- [ ] Docs explain the difference between degraded diagnosis and deliverable remediation execution.

### Out of Scope

- #15 polar/geographic coordinate support.
- Full replacement with libavoid, yFiles, Graphviz, or another external routing engine.
- Browser UI or visual editor.
- Loosening downstream hard gates or changing Stage 5 semantics so colliding diagrams pass.
- Fully automatic semantic page splitting in v1.2; v1.2 must produce a machine-readable split plan and may leave actual multi-page materialization to a later milestone.

## Context

- #69 established the early root causes: edge-label chicken-and-egg, text-surface routing vertices, compact text obstacles, and tolerance. Much of this became local solver capability, but it could only reduce failures.
- #71 recorded the 0.2.10 to 0.2.14 downstream trend and separated solved container/position problems from remaining dense route/label congestion.
- #73 asked for a closed loop. v1.1 implemented a weak loop, but 0.2.17 still exhausts on dense pages and returns advisory remediations.
- #74 caught and validated the 0.2.16 regression where text congestion became fatal evidence crossing; #75 says it can close after a guard.
- #75 reframes the foundation problem: the diagnosis layer now names the missing actions, but the execution layer does not apply them. The next release must execute or machine-stage external labels, rails/gutters, growth, and split plans.
- Latest live case result on 0.2.17: Stage 5 fails with 132 critical / 179 warnings, including 129 route/text intersections and 3 route/obstacle intersections. Ten pages are degraded and one page is clean.

## Constraints

- **Runtime**: TypeScript on Node.js 20+.
- **Architecture**: Preserve prepare/solve/export separation; v1.2 extends solver contracts and output metadata without turning the package into a renderer.
- **Determinism**: Same input must produce byte-stable or numerically stable output, diagnostics, routing allocations, and remediation plans.
- **Measurement**: Text measurement remains abstracted behind the existing text measurer interface.
- **Quality**: Tests must catch text overflow, route/text collisions, route/obstacle collisions, excessive backtracking, non-determinism, and regression of #74.
- **Workflow**: Continue on PR #72 branch unless redirected. Do not stage or revert the unrelated local `package.json` version bump.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Use #75 as the active epic | #75 correctly identifies the foundational issue: remediation execution, not another local heuristic | Accepted |
| Fold #69/#71/#73 into #75 | Their findings are implementation inputs, but none should remain a separate competing milestone scope | Accepted |
| Treat #74 as fixed-but-guarded | 0.2.17 fixed the live regression; v1.2 adds a regression test before closure | Accepted |
| Exclude #15 | Polar/geographic coordinates are unrelated to dense MBSE deliverability | Accepted |
| Keep v1.2 TS-native | Current solver has enough primitives to execute the first remediation layer without external router dependencies | Accepted |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? Move to Out of Scope with reason.
2. Requirements validated? Move to Validated with phase reference.
3. New requirements emerged? Add to Active.
4. Decisions to log? Add to Key Decisions.
5. "What This Is" still accurate? Update if drifted.

---
*Last updated: 2026-07-09 after adopting Issue #75 as v1.2 epic*
