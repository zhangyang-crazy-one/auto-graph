# Phase 17 Research: Strict Remediation Loop And Issue Closure

## Research Complete

## Integration Target

The route-label loop currently can stop with unresolved conflicts. After Phases 14-16, that stop condition should feed remediation execution:

```text
route -> label -> validate -> local reroute exhausted
-> build remediation plan
-> execute auto remediations or stage suggest plans
-> re-solve affected subgraph
-> final clean or structured unsat
```

## Diagnostic Taxonomy

Recommended strict-facing categories:

- `route.node-label.strike`
- `route.edge-label.pileup`
- `route.label.bbox-graze`
- `route.fixed-geometry.blocked`
- `route.rail-capacity.exceeded`
- `route.evidence.crossing`

These can be added as new diagnostic codes or as structured detail classes on existing compatibility diagnostics. Preserve existing codes where downstream compatibility requires them.

## Issue Hygiene

- #74 can close after regression guard is merged.
- #73 and #71 can be marked superseded by #75 after remediation loop work lands.
- #69 can be marked folded into #75 after tests show local primitives remain covered.
- #75 remains open until strict dense acceptance is clean or unsat/machine-applicable by contract.
