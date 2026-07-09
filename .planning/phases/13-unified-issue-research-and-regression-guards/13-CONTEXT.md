# Phase 13: Unified Issue Research And Regression Guards - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning
**Source:** Issue #75 consolidation after latest downstream experiments

<domain>
## Phase Boundary

This phase does not implement the full remediation engine. It locks the issue routing and regression guard foundation so later phases can safely change route-label feedback and strict deliverability behavior.

It consolidates #69, #71, #73, #74, and #75 into one dense MBSE deliverability track and explicitly excludes #15 polar/geographic coordinate support.
</domain>

<decisions>
## Implementation Decisions

### Epic Routing
- **D-01:** Treat #75 as the active capability epic for all current non-polar dense-deliverability work.
- **D-02:** Fold #69, #71, and #73 into #75 as historical/root-cause/design evidence.
- **D-03:** Treat #74 as fixed in 0.2.17 but incomplete until a regression guard is present.
- **D-04:** Exclude #15 from v1.2. Do not touch projection, polar, geo, or coordinate-system IR in this milestone.

### Regression Guard
- **D-05:** Preserve the 0.2.17 behavior where route-label feedback text congestion does not surface as fatal `routing.evidence.crossing_forbidden`.
- **D-06:** Hard-route diagnostics must dominate route-label feedback candidate scoring. A candidate that introduces a hard-route error must be rejected even if it reduces route/text conflicts.

### the agent's Discretion
- The executor may choose exact fixture geometry for regression tests as long as it deterministically exercises text hard obstacles and hard-route score dominance.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Issue Evidence
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/75` - Active capability epic and remediation execution requirements.
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/74` - Fixed Stage 3 fatal regression that needs a guard.
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/73` - Closed-loop route/label design context superseded by #75.
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/71` - Dense route/label evidence and position-preserving history.
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/69` - Early route/text root-cause taxonomy.
- `https://github.com/zhangyang-crazy-one/auto-graph/issues/15` - Explicitly excluded polar/geographic coordinate issue.

### Code
- `src/solver/solve.ts` - route-label feedback, deliverability report, rail allocation, text clearance.
- `src/routing/routes.ts` - route quality, hard-obstacle diagnostics, text/evidence hard obstacle metadata.
- `src/routing/types.ts` - `RouteHardObstacleMetadata` source typing.
- `test/solver.test.ts` - existing #74-style regression and route-label feedback tests.
- `test/dense-acceptance.test.ts` - Stage 5-style acceptance scaffold.
</canonical_refs>

<specifics>
## Specific Evidence

- 0.2.17 live case reaches Stage 5 and fails with 132 critical / 179 warnings.
- #74 is no longer active for 0.2.17, but text congestion must not regress to fatal evidence crossing.
- Current open non-polar issue set is #69, #71, #73, #74, #75.
</specifics>

<deferred>
## Deferred Ideas

- Implementing external labels, rails/gutters, growth, and strict closure is deferred to Phases 14-17.
- #15 coordinate-system work is out of scope.
</deferred>

---
*Phase: 13-unified-issue-research-and-regression-guards*
*Context gathered: 2026-07-09*
