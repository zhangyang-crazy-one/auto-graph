# Phase 14 Research: Remediation Contract And Dense Fixtures

## Research Complete

## Contract Shape

The existing `DeliverabilityReport` has `status`, `strict`, `degraded`, `diagnosticCodes`, and `remediationTypes`. #75 needs this to become actionable. The minimal next step is adding stable remediation plan objects while preserving the old fields for compatibility.

Recommended model:

- `DeliverabilityMode = "strict" | "degraded-ok"`
- `RemediationPolicyMode = "off" | "suggest" | "auto"`
- `RemediationPolicy` fields: `externalLabels`, `routeRails`, `growFixedGeometry`, `pageSplit`
- `RemediationPlan` fields: deterministic `id`, `type`, `status`, `reason`, `edgeIds`, `nodeIds`, `diagnosticCodes`, and type-specific details such as capacity numbers, label keys, growth deltas, or split subsets.

## Fixture Strategy

Local tests should represent the shape of the live case without depending on downstream artifacts:

- CV dependency: small node count, at least 20 labeled edges, top/bottom rail pressure.
- OV/SV resource-flow: 12-ish nodes, long cross-zone flows, side-gutter pressure, node-label route pressure.
- IBD/high-fan-in: high same-side fan-in/out, anchor capacity and bundle pressure.

## Validation Architecture

Stage 5-style evidence should continue to count:

- edge-label intersections
- node-label intersections
- unrelated-node intersections
- route/obstacle intersections
- backtracking diagnostics
- page overflow
- deliverability status
- remediation plan count and types

## Risk

The public contract must be additive. Existing callers using `strict`, `degraded`, and `deliverability.remediationTypes` should keep working.
