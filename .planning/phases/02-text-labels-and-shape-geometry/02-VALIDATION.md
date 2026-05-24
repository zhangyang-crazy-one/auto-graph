---
phase: 02
slug: text-labels-and-shape-geometry
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-24
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.7 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `rtk npm test -- text-measurer label-fitting box-geometry shape-geometry container-geometry` |
| **Full suite command** | `rtk npm run verify` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run the focused `rtk npm test -- <test-name>` command for the module changed by that task.
- **After every plan wave:** Run `rtk npm run typecheck` plus the relevant focused Vitest commands for completed modules.
- **Before `$gsd-verify-work`:** `rtk npm run verify` must be green.
- **Max feedback latency:** 10 seconds.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | TXT-01 | T-02-01 | Reject or diagnose invalid text/font/layout numeric inputs | unit | `rtk npm test -- text-measurer` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | TXT-01 | T-02-02 | Guard Pretext runtime availability instead of crashing when Canvas 2D is unavailable | guarded integration | `rtk npm test -- text-measurer` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | TXT-02, TXT-03 | T-02-03 | Reject or diagnose invalid label sizing options and keep layout renderer-neutral | unit + fixture | `rtk npm test -- label-fitting` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 1 | GEO-02 | T-02-04 | Reject invalid boxes and non-finite dimensions before collision math | unit | `rtk npm test -- box-geometry` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 1 | GEO-01, GEO-03 | T-02-05 | Keep shape geometry renderer-neutral and deterministic for all seven v1 shapes | unit | `rtk npm test -- shape-geometry` | ❌ W0 | ⬜ pending |
| 02-04-01 | 04 | 3 | TXT-02, GEO-01, GEO-02 | T-02-06 | Compute container geometry from known child boxes only; do not move children or solve constraints | unit + fixture | `rtk npm test -- container-geometry` | ❌ W0 | ⬜ pending |
| 02-05-01 | 05 | 4 | TXT-01, TXT-02, TXT-03, GEO-01, GEO-02, GEO-03 | — | N/A | full gate | `rtk npm run verify` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/text-measurer.test.ts` — stubs and RED tests for TXT-01, deterministic fallback, and guarded Pretext availability.
- [ ] `test/label-fitting.test.ts` — stubs and RED tests for TXT-02/TXT-03 padding, `maxWidth`, `minSize`, line records, multilingual fixtures, and overflow diagnostics.
- [ ] `test/box-geometry.test.ts` — stubs and RED tests for GEO-02 box center, expansion, union, finite validation, and AABB collision.
- [ ] `test/shape-geometry.test.ts` — stubs and RED tests for GEO-01/GEO-03 seven-shape anchors and edge ports.
- [ ] `test/container-geometry.test.ts` — stubs and RED tests for known-child container geometry.
- [ ] `test/fixtures/phase-02/` — canonical numeric fixture directory for labels, shapes, and containers using `stringifyCanonical()`.

---

## Manual-Only Verifications

All Phase 02 behaviors have automated verification. Real SVG visual inspection is intentionally deferred to Phase 04.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all MISSING references.
- [x] No watch-mode flags.
- [x] Feedback latency < 10s.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-05-24
