---
phase: 01
slug: project-scaffold-and-core-ir
status: draft
nyquist_compliant: true
wave_0_complete: not_applicable
created: 2026-05-24
---

# Phase 01 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` (created in Plan 01, Wave 1) |
| **Quick run command** | `rtk npm run typecheck && rtk npm test` |
| **Full suite command** | `rtk npm run verify` |
| **Estimated runtime** | ~30 seconds after dependencies install |

---

## Sampling Rate

- **After every task commit:** Run `rtk npm run typecheck && rtk npm test`
- **After every plan wave:** Run `rtk npm run verify`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds for quick feedback once dependencies are installed

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | FND-01 | T-01-01 | Package public surface is explicit and not accidentally publish-broad | smoke/tooling | `rtk npm run verify` | no - Plan 01 creates | pending |
| 01-02-01 | 02 | 2 | FND-02 | — | Public import path exposes IR types without renderer-native fields | type/unit | `rtk npm run typecheck && rtk npm test -- public-api` | no - Plan 02 creates | pending |
| 01-03-01 | 03 | 3 | FND-03 | T-01-02 | Canonical serializer rejects invalid numbers and produces stable output | unit | `rtk npm test -- serialization` | no - Plan 03 creates | pending |

*Status: pending / green / red / flaky*

---

## Plan-Created Requirements

- [ ] Plan 01 / Wave 1: `package.json` and `package-lock.json` - npm scaffold with build/typecheck/test/lint/verify scripts.
- [ ] Plan 01 / Wave 1: `tsconfig.json` and `tsconfig.build.json` - strict TypeScript configuration.
- [ ] Plan 01 / Wave 1: `tsup.config.ts` - distributable package build configuration.
- [ ] Plan 01 / Wave 1: `vitest.config.ts` - test runner configuration.
- [ ] Plan 01 / Wave 1: `biome.json` or equivalent lint configuration - lint command backend.
- [ ] Plan 03 / Wave 3: `test/serialization.test.ts` - deterministic serializer proof.
- [ ] Plan 02 / Wave 2: `test/public-api.test.ts` or type-focused equivalent - public entrypoint proof.

---

## Manual-Only Verifications

All Phase 1 behaviors have automated verification. Manual review is limited to checking that Phase 1 did not implement out-of-scope renderer, layout, DSL, CLI, or text measurement behavior.

---

## Validation Sign-Off

- [x] All tasks have automated verify commands or declared plan-created dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Plans 01-03 cover all missing test infrastructure references
- [x] No watch-mode flags
- [x] Feedback latency target < 30s after install
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-24
