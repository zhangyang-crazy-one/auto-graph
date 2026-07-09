# Phase 12: Dense MBSE Acceptance Gate - Context

**Gathered:** 2026-07-08
**Status:** Ready for execution
**Mode:** Autonomous recommended path

<domain>
Issue #73 downstream Stage 5 validation fails on route/text and route/obstacle intersections. The milestone needs an automated local gate that asserts final invariants or verifies structured unsatisfiable output.
</domain>

<decisions>
- Acceptance tests use final solved routes and final text annotations, not pre-route estimates.
- Clean strict outputs must have zero route/edge-label, route/node-label, and route/unrelated-node intersections.
- If any critical remains, the result must be `unsatisfiable` with structured remediation diagnostics.
- Fixtures cover a CV dependency page and an OV/SV-style resource-flow page.
</decisions>

<code_context>
- `test/dense-acceptance.test.ts` implements Stage 5-style evidence counters.
- The test suite validates both deliverable invariants and unsat remediation semantics.
</code_context>
