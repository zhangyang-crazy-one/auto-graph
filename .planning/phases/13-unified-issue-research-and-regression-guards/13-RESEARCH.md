# Phase 13 Research: Unified Issue Research And Regression Guards

## Research Complete

## Issue Matrix

| Issue | Current State | v1.2 Treatment | Concrete Carry-forward |
|-------|---------------|----------------|------------------------|
| #75 | Open, active capability epic | Primary milestone driver | Execute or machine-stage remediations: external labels, rails/gutters, growth, split plans. |
| #73 | Open, superseded design scope | Fold into #75 | Weak route-label feedback exists but exhausts; exhausted loop must transition into remediation execution. |
| #71 | Open, historical evidence | Fold into #75 | Position/container collapse is no longer active; dense route/label congestion remains. |
| #69 | Open, early root-cause taxonomy | Fold into #75 | Text vertices, tolerance, compact obstacles, and iterative rerouting are useful local primitives, not final capability. |
| #74 | Open, fixed in 0.2.17 | Guard and close/supersede | Add regression proving text hard obstacles do not emit fatal evidence crossing. |
| #15 | Open, polar/geographic coordinates | Exclude | Do not touch coordinate-system work in v1.2. |

## Key Finding

#75 correctly reframes the foundation problem. The solver can now name degradation and remediation types, but those remediations are advisory. For strict dense MBSE delivery, advisory diagnostics are insufficient because downstream validates rendered geometry before export.

The active gap is:

```text
diagnose degraded page -> emit remediation names -> return colliding layout
```

The needed behavior is:

```text
diagnose degraded page -> build remediation plan -> execute or machine-stage plan -> re-solve or return structured unsat
```

## Codebase Surfaces

| Surface | Current Role | Risk |
|---------|--------------|------|
| `src/solver/solve.ts::routeLabelFeedback*` | Runs local route/text feedback loop | Can exhaust and only report advice. |
| `src/solver/solve.ts::buildDeliverabilityReport` | Maps diagnostics to remediation type strings | Needs plan objects usable by execution and consumers. |
| `src/routing/types.ts::RouteHardObstacleMetadata` | Distinguishes evidence vs text hard obstacles | Regression guard must keep this distinction meaningful. |
| `src/routing/routes.ts::routeEdge` | Emits route diagnostics | Hard-route diagnostics must not be accepted by feedback scoring. |
| `test/solver.test.ts` | Contains targeted feedback tests | Add explicit #74 and hard-score dominance guards. |
| `test/dense-acceptance.test.ts` | Dense Stage 5-style scaffold | Later phases should extend it rather than create a parallel gate. |

## Validation Architecture

- Targeted tests in `test/solver.test.ts` should assert #74 semantics without requiring live downstream artifacts.
- Dense acceptance tests should stay in `test/dense-acceptance.test.ts`.
- The issue matrix should be reflected in `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and this phase's summary after execution.

## Implementation Implication

Phase 13 should be small and protective. It should not implement remediation execution. Its job is to make later phases safe by preventing regression of #74 and by documenting that #75 supersedes the older route/text issues.
