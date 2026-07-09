# Phase 8: Route/Label Feedback Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-08
**Phase:** 8-Route/Label Feedback Loop
**Areas discussed:** Conflict scope, Loop state shape, Failure boundary, Determinism budget

---

## Conflict Scope

| Option | Description | Selected |
|--------|-------------|----------|
| All route-text conflicts | Cover all final `isRouteClearanceText` surfaces, including edge-label and node-label conflicts. | yes |
| Edge-label first | Only handle final edge-label conflicts; smallest change but misses Issue #73 node-label intersections. | |
| Two-tier loop | Handle edge labels first, then node and other labels in a second tier. | |

**User's choice:** Selected option 1 directly.
**Notes:** User later authorized all recommended choices. The obstacle-set recommendation is all final route-clearance text boxes except connected own labels. Phase 8 should not introduce Phase 9 hard/soft deliverability semantics.

---

## Loop State Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Private feedback state | Track current edges, labels, diagnostics, conflicts, iteration, and changed ids in a private solver state. | yes |
| Keep local mutations | Continue mutating `coordinatedEdges`, `edgeTextAnnotations`, and diagnostics directly. | |
| Public attempt model | Export a reusable route-label attempt model now. | |

**User's choice:** All recommended choices.
**Notes:** Keep the state private in Phase 8 and preserve prepare/solve/export separation.

---

## Failure Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Add loop-exhausted diagnostic | Emit a structured diagnostic summarizing conflicts left after bounded rerouting, while preserving compatibility diagnostics. | yes |
| Existing diagnostics only | Only leave `routing.text-clearance.unresolved` after loop exhaustion. | |
| Full strict contract now | Define public clean/degraded/unsatisfiable semantics in Phase 8. | |

**User's choice:** All recommended choices.
**Notes:** Phase 8 should report structured loop exhaustion but leave public strict/deliverable contract to Phase 9.

---

## Determinism Budget

| Option | Description | Selected |
|--------|-------------|----------|
| Stable fixed-budget improvements | Fixed iteration budget, stable edge-id order, accept only deterministic score improvements, stop when no changes. | yes |
| Current conflict-set reroute | Keep rerouting the conflict set without explicit improvement acceptance. | |
| Per-edge exhaustive search | Try deeper local search per edge until each edge is clean or impossible. | |

**User's choice:** All recommended choices.
**Notes:** The loop should process conflicts in stable edge-id order and reject reroutes that make route/text conflicts, obstacle diagnostics, or backtracking worse.

---

## the agent's Discretion

- Planner may choose exact helper-module boundaries.
- Planner may choose exact diagnostic code name if detail fields remain structured and compatible.
- Planner may add focused tests first.

## Deferred Ideas

- Phase 9: public strict/deliverable/unsatisfiable contract.
- Phase 10: external labels and structured congestion placement failure.
- Phase 11: rails/gutters and PR #72 Codex review rail/repair fixes.
- Phase 12: dense MBSE acceptance gate.
