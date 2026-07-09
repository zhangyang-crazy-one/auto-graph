---
quick_id: 260708-t3y
description: Fix PR 72 Codex P2 routing review findings
status: in_progress
created: 2026-07-08
---

# Quick Task: Fix PR 72 Codex P2 Routing Review Findings

## Scope

Address the latest PR #72 Codex P2 comments posted on 2026-07-08 after the Issue #74 fix:

1. Do not reserve labels marked `external-callout-required` as local label boxes.
2. Exclude external callout annotations from reroute and route/rail text obstacles.
3. Keep non-connected local edge-label obstacles in rail route validation.
4. Report endpoint-interior fallback violations when no accepted route can avoid endpoint interiors.
5. Build `result.routing` only from rail routes actually accepted by `coordinateEdges`.

## Implementation Plan

- Add a shared local-text-obstacle predicate so externalized labels are ignored consistently by route obstacles, rail validation, and feedback hard text obstacles.
- Update edge-label placement to reserve `placedLabelBoxes` only for labels that remain local.
- Track accepted rail allocations inside `coordinateEdges` and build `RoutingAllocationReport` from that allocation state rather than inferring rails from arbitrary route extents.
- Add endpoint-interior fallback diagnostics in the hard-obstacle fallback path and include the new code in deliverability remediation.
- Add focused regression tests for the five P2s and run the full verification suite.

## Verification

- `npm test`
- `npm run verify`
