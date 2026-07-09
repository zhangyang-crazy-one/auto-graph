# Phase 16: Page Policy Rails, Gutters, And Bundles - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning
**Source:** #75 Slice C

<domain>
## Phase Boundary

This phase adds page-level policy execution before per-edge search. It should allocate route capacity for dependency, resource-flow, lane-behavior, and IBD/high-fan-in pages instead of relying only on local A* route search.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** Use explicit hints when provided and deterministic classification otherwise.
- **D-02:** Dependency pages get top/bottom rails and rail occupancy scoring.
- **D-03:** Resource-flow and IBD/high-fan-in pages get side gutters and fan-in/fan-out bundles.
- **D-04:** Lane-behavior pages reserve lane-aware corridors and avoid header/title bands.
- **D-05:** If capacity is exceeded, return a split plan with counts and affected edge/node subsets.
</decisions>

<canonical_refs>
## Canonical References

- `src/solver/solve.ts` - current rail allocation and route coordination.
- `src/routing/bus-router.ts` - existing `computeFanOutPorts` primitive.
- `src/routing/routes.ts` - route quality and hard/soft obstacle scoring.
- `src/ir/diagram.ts` - routing allocation output and remediation plan contract.
- `test/dense-acceptance.test.ts` - dense fixture acceptance.
- `test/bus-router.test.ts` - bus/fan-out primitive tests.
</canonical_refs>

<specifics>
## Specific Ideas

#75 page policies:
- dependency / CV pages: top/bottom rails plus keyed labels
- resource-flow / OV-SV pages: side gutters plus bundles
- activity / state / sequence: lane-aware corridors
- IBD / high fan-in: anchor-capacity-aware node growth before routing
</specifics>

<deferred>
## Deferred Ideas

- Full automatic semantic page split is deferred; this phase returns machine-readable split plans.
</deferred>
