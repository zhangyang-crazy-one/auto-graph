# Phase 11: Rails, Gutters, And Post-growth Repair - Context

**Gathered:** 2026-07-08
**Status:** Ready for execution
**Mode:** Autonomous recommended path

<domain>
PR #72 Codex review identified remaining solver-contract risks around rail validation, framed title avoidance, anchor-capacity timing, mutation, and post-growth overlap reporting.
</domain>

<decisions>
- Rail validation must exclude only the current edge endpoints by node identity.
- Framed LR/RL rails must avoid the title/header band.
- Rail fast paths should not be rejected by speculative edge-label estimates.
- Anchor-capacity growth belongs after swimlane contract movement.
- Any new overlap introduced by post-constraint growth must be reported as deliverability-blocking.
</decisions>

<code_context>
- `coordinateEdges` owns rail fast path and node obstacle filtering.
- `railRoutePoints` owns rail lane geometry.
- `expandNodeBoxesForAnchorCapacity` sizes high fan-in/out endpoints.
- `routeEdge` owns final hard-obstacle fallback behavior.
</code_context>
