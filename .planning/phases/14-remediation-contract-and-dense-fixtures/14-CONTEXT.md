# Phase 14: Remediation Contract And Dense Fixtures - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning
**Source:** #75 Slice A

<domain>
## Phase Boundary

This phase defines the public contract and test evidence for remediation execution. It may build remediation plan objects and dense fixtures, but it should not yet implement full external label or rail/gutter execution.
</domain>

<decisions>
## Implementation Decisions

### Contract
- **D-01:** Add a public dense deliverability mode, using `deliverabilityMode: "strict" | "degraded-ok"` or an equivalent shape that preserves existing `strict` behavior.
- **D-02:** Add `remediationPolicy` with `externalLabels`, `routeRails`, `growFixedGeometry`, and `pageSplit`.
- **D-03:** Add deterministic remediation plan objects to `CoordinatedDiagram`; do not rely only on `remediationTypes: string[]`.

### Fixtures
- **D-04:** Dense fixtures must model #75 page shapes: CV dependency, OV/SV resource-flow, and IBD/high-fan-in.
- **D-05:** Stage 5-style evidence must count both raw critical geometry findings and structured remediation plans.

### the agent's Discretion
- Exact type names may be adjusted to fit existing IR style, but public names must be documented and exported.
</decisions>

<canonical_refs>
## Canonical References

- `src/solver/solve.ts` - `SolveDiagramOptions`, `buildDeliverabilityReport`, route-label feedback.
- `src/ir/diagram.ts` - `CoordinatedDiagram`, `DeliverabilityReport`, routing allocation output.
- `src/ir/index.ts` - Public IR exports.
- `src/dsl/schema.ts`, `src/dsl/normalize.ts`, `src/dsl/render.ts` - Option forwarding if DSL metadata supports dense policies.
- `test/dense-acceptance.test.ts` - Stage 5-style evidence and dense fixtures.
- `README.md`, `README.zh-CN.md` - Public contract documentation.
</canonical_refs>

<specifics>
## Specific Ideas

#75 suggested options:
- `deliverabilityMode: "strict" | "degraded-ok"`
- `remediationPolicy.externalLabels: "off" | "suggest" | "auto"`
- `remediationPolicy.routeRails: "off" | "suggest" | "auto"`
- `remediationPolicy.growFixedGeometry: "off" | "suggest" | "auto"`
- `remediationPolicy.pageSplit: "off" | "suggest"`
</specifics>

<deferred>
## Deferred Ideas

- Actually executing external labels is Phase 15.
- Actually executing page policies and rails/gutters is Phase 16.
- Strict loop integration is Phase 17.
</deferred>
