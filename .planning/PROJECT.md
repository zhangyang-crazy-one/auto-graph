# Diagram Geometry Engine

## What This Is

Diagram Geometry Engine (DGE), code name "Pretext for Graphics", is a deterministic geometry computation engine that translates high-level diagram intent into precise numeric coordinates. It is for LLMs, coding agents, and developers who need to generate accurate architecture diagrams, flowcharts, and editable diagram files without hand-guessing x/y positions or relying on visual feedback.

DGE is not a renderer or a visual editor. It is the missing geometry solving layer between automatic graph layout engines and render/export formats such as SVG, Excalidraw JSON, draw.io XML, Mermaid, and ASCII.

## Core Value

Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

## Current Milestone: v1.1 Closed-loop Route/Label Clearance

**Goal:** Build a closed-loop route and label clearance pipeline so dense MBSE diagrams either pass strict route/text/layout gates or return structured unsatisfiable remediation diagnostics.

**Target features:**
- Final edge-label placement participates in route selection and rerouting instead of remaining a post-hoc diagnostic surface.
- Strict deliverable mode distinguishes clean output, degraded output, and unsatisfiable output.
- Label congestion diagnostics identify page, edge set, occupied rail/corridor, label count, and proposed remediation.
- Rail/gutter routing becomes first-class for CV dependency, OV/SV resource-flow, activity/state, and sequence pages.
- Acceptance tests assert hard downstream invariants for final routes against final node labels, final edge labels, unrelated node interiors, and hard obstacles.

## Requirements

### Validated

- Complete: DSL, IR, solver, and SVG support for fixed evidence blocks, matrices, tables, and evidence panels - Phase 07
- Complete: Dense routing heuristics now include route cost ranking, endpoint interior protection, excessive-backtracking avoidance, and lower-conflict label fallback - PR #72 / quick task 260708-hz4

### Active

- [ ] Final route and final edge-label placement are solved in a bounded feedback loop.
- [ ] Strict/deliverable layouts fail closed with structured unsatisfiable diagnostics when clearance cannot be achieved.
- [ ] Dense page routing uses explicit rail/gutter capacity instead of ad hoc fallback routes.
- [ ] Framed diagrams, grown anchor capacity, rail endpoint filtering, and side-anchor fast paths honor final collision contracts.
- [ ] Acceptance tests cover downstream Stage 5 hard-gate invariants on representative dense MBSE pages.

### Out of Scope

- Full libavoid/yFiles-equivalent global router rewrite - the milestone integrates closed-loop behavior into the existing TypeScript solver first.
- Browser UI or visual editor - the package remains a headless TypeScript library and `agh` CLI.
- Graphviz subprocess routing - it adds installation and determinism risks outside the current Node-first architecture.
- Downstream drawio-mbse pipeline changes as the primary fix - downstream failures should be addressed in auto-graph geometry contracts first.

## Context

- Latest issue: #73, opened 2026-07-08, reports `@crazyhappyone/auto-graph@0.2.15` still failing downstream `drawio-mbse` Stage 5 with 224 critical findings: 204 `edge_route_text_intersection` and 20 `edge_route_obstacle_intersection`.
- Version trend shows real but incomplete progress: `0.2.13` had 472 criticals, `0.2.14` had 277, and `0.2.15` has 224.
- The architectural gap is a linear pipeline: initial layout -> constraints -> route edges using estimated labels -> final edge-label placement -> post-hoc diagnostics.
- The needed pipeline is closed-loop: route candidates -> final label placement -> route/text validation -> reroute or externalize labels -> structured unsatisfiable diagnostics when still blocked.
- PR #72 Codex review on commit `6a94940fec` identified four P2 rail/constraint risks that belong in this milestone:
  - rerun overlap/containment repair after `anchorCapacity.grow`;
  - keep framed rails clear of frame title obstacles;
  - exclude only actual endpoint nodes from rail validation;
  - skip or repair rail fast paths for anchors that jog through endpoint interiors.

## Constraints

- **Runtime**: TypeScript on Node.js 20+ - required by the package and CLI.
- **Architecture**: Preserve prepare/solve/export separation - measurement and validation happen before or around solver loops, exporters consume coordinated geometry.
- **Determinism**: Same input must produce byte-stable or numerically stable output.
- **Measurement**: Text measurement remains abstracted behind the existing text measurer interface; Pretext is the default backend.
- **Quality**: Golden and acceptance tests must catch text overflow, connector misalignment, collisions, non-deterministic output, and malformed exports.
- **Scope**: No server, database, browser UI, or external service dependency.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Treat Issue #73 as an architectural milestone rather than another route heuristic patch | Remaining failures come from final label placement and routing being disconnected | Pending |
| Continue from Phase 8 rather than resetting phase numbers | Existing Phase 07 artifacts are present and previous milestone numbering should remain traceable | Pending |
| Skip extra research for this milestone | Issue #73 includes codebase analysis, and PR #72 review provides immediate implementation targets | Pending |
| Keep strict mode fail-closed | MBSE downstream gates need deliverable geometry or actionable unsat, not silent degraded output | Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-08 after starting milestone v1.1*
