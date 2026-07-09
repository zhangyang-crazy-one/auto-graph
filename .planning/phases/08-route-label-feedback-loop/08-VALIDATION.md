---
phase: 08
slug: route-label-feedback-loop
status: ready
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-08
---

# Phase 08 - Validation Strategy

Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `package.json` scripts |
| Quick run command | `npm test -- test/solver.test.ts test/determinism.test.ts` |
| Full suite command | `npm run verify` |
| Estimated runtime | Focused tests under 60 seconds; full verify depends on build and lint |

## Sampling Rate

- After every implementation task commit: run `npm test -- test/solver.test.ts test/determinism.test.ts`
- After every plan wave: run `npm run verify`
- Before `$gsd-verify-work`: `npm run verify` must be green
- Max feedback latency: one task

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 08-01 | 1 | LOOP-01 | T-08-01 | N/A - headless geometry library, no external input side effects | source + unit | `npm test -- test/solver.test.ts` | yes | pending |
| 08-01-02 | 08-01 | 1 | LOOP-02 | T-08-02 | N/A - bounded in-memory loop only | unit | `npm test -- test/solver.test.ts` | yes | pending |
| 08-01-03 | 08-01 | 1 | LOOP-04 | T-08-03 | N/A - structured diagnostics only | unit | `npm test -- test/solver.test.ts` | yes | pending |
| 08-02-01 | 08-02 | 2 | LOOP-03 | T-08-04 | N/A - deterministic output stability | determinism | `npm test -- test/solver.test.ts test/determinism.test.ts` | yes | pending |
| 08-02-02 | 08-02 | 2 | LOOP-02, LOOP-04 | T-08-05 | N/A - strict mode promotion only | unit + full | `npm run verify` | yes | pending |

## Wave 0 Requirements

Existing infrastructure covers all phase requirements:

- `test/solver.test.ts` already covers text clearance, label congestion, strict promotion, routing diagnostics, rails, and helper fixtures.
- `test/determinism.test.ts` already covers canonical repeated solve stability.
- `package.json` already exposes `npm test` and `npm run verify`.

## Manual-Only Verifications

All Phase 8 behaviors have automated verification.

## Required Automated Assertions

- A final `node-label` route/text conflict can trigger feedback rerouting and disappear from final diagnostics.
- A final `edge-label` route/text conflict can trigger the same feedback loop and disappear from final diagnostics.
- If bounded rerouting cannot clear conflicts, final diagnostics include `routing.route-label-loop.exhausted` and keep compatibility `routing.text-clearance.unresolved` entries.
- `DELIVERABILITY_DIAGNOSTIC_CODES` includes `routing.route-label-loop.exhausted` if strict mode must promote it.
- Repeated solves of a feedback-loop fixture serialize byte-identically with `stringifyCanonical`.
- Explicit `edgeLabelRerouting: true` is honored for supported non-`obstacle-avoiding` routes, or a diagnostic proves it is intentionally unsupported. The Phase 8 recommendation is to honor it for orthogonal routing.

## Validation Sign-Off

- [x] All tasks have automated verify commands or existing test infrastructure.
- [x] Sampling continuity: no three consecutive tasks without automated verify.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Feedback latency target documented.

**Approval:** pending execution
