---
phase: 03
slug: layout-constraints-and-routing
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-25
---

# Phase 03 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.7 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `rtk npm test -- layout constraints routing solver determinism` |
| **Full suite command** | `rtk npm run verify` |
| **Estimated runtime** | ~10-20 seconds for focused tests; full verify depends on build/lint runtime |

---

## Sampling Rate

- **After every task commit:** Run `rtk npm test -- layout constraints routing solver determinism` once the relevant test files exist.
- **After every plan wave:** Run `rtk npm run typecheck && rtk npm test -- layout constraints routing solver determinism && rtk npm run lint`.
- **Before `$gsd-verify-work`:** `rtk npm run verify` must be green.
- **Max feedback latency:** 20 seconds for focused Phase 3 tests after Wave 0 test files exist.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | LAY-01 | T-03-01 | Validate finite Dagre input dimensions before layout. | unit | `rtk npm test -- layout` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | LAY-01 | — | Convert Dagre center coordinates to DGE top-left boxes. | unit | `rtk npm test -- layout` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | LAY-03, LAY-04 | T-03-02 | Missing refs and non-finite positions emit diagnostics instead of corrupting output. | unit | `rtk npm test -- constraints` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 1 | LAY-03, LAY-04 | T-03-02 | Constraint precedence preserves fixed/exact locks. | unit | `rtk npm test -- constraints` | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 1 | RTE-01, RTE-02, RTE-03 | T-03-03 | Routing remains bounded and avoids unbounded pathfinding. | unit | `rtk npm test -- routing` | ❌ W0 | ⬜ pending |
| 03-04-01 | 04 | 2 | LAY-02, LAY-04, RTE-01, RTE-02 | T-03-01, T-03-02, T-03-03 | Integrated solver returns coordinated IR plus diagnostics without renderer dependency. | integration + fixture | `rtk npm test -- solver determinism` | ❌ W0 | ⬜ pending |
| 03-05-01 | 05 | 3 | LAY-01, LAY-02, LAY-03, LAY-04, RTE-01, RTE-02, RTE-03 | T-03-01, T-03-02, T-03-03 | Phase gate proves all Phase 3 outputs are deterministic and renderer-neutral. | full gate | `rtk npm run verify` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/layout.test.ts` — stubs and initial expectations for LAY-01 Dagre direction mapping and center-to-box conversion.
- [ ] `test/constraints.test.ts` — stubs and initial expectations for LAY-03 precedence and LAY-04 diagnostics.
- [ ] `test/routing.test.ts` — stubs and initial expectations for RTE-01, RTE-02, and RTE-03.
- [ ] `test/solver.test.ts` — stubs and initial expectations for LAY-02 integrated hybrid layout.
- [ ] `test/determinism.test.ts` — repeated solve canonical equality checks.
- [ ] `test/fixtures/phase-03/` — canonical coordinated IR fixture directory.
- [ ] `@dagrejs/dagre@3.0.0` dependency installed and represented in `package.json` / lockfile.

---

## Manual-Only Verifications

All Phase 3 behaviors have automated verification. Visual SVG/Excalidraw inspection is explicitly deferred to Phase 4.

---

## Threat References

| Threat ID | Pattern | Mitigation |
|-----------|---------|------------|
| T-03-01 | Non-finite numeric input creates NaN/Infinity coordinated geometry. | Validate finite dimensions/positions and emit `error` diagnostics before trusting coordinated output. |
| T-03-02 | Malformed node, edge, group, or constraint references corrupt output. | Emit stable missing-reference diagnostics and avoid unsafe geometry mutation. |
| T-03-03 | Extremely large or obstacle-heavy diagrams cause slow layout/routing. | Keep routing to deterministic candidate paths and defer full grid A* beyond Phase 3. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Feedback latency target < 20s for focused tests after Wave 0.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending
