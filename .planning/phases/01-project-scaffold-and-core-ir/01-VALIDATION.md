---
phase: 01
slug: project-scaffold-and-core-ir
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-24
---

# Phase 01 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` (created in Wave 0) |
| **Quick run command** | `npm run typecheck && npm test` |
| **Full suite command** | `npm run verify` |
| **Estimated runtime** | ~30 seconds after dependencies install |

---

## Sampling Rate

- **After every task commit:** Run `npm run typecheck && npm test`
- **After every plan wave:** Run `npm run verify`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds for quick feedback once dependencies are installed

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 0 | FND-01 | T-01-01 | Package public surface is explicit and not accidentally publish-broad | smoke/tooling | `npm run verify` | no - Wave 0 creates | pending |
| 01-01-02 | 01 | 0 | FND-02 | — | Public import path exposes IR types without renderer-native fields | type/unit | `npm run typecheck && npm test -- public-api` | no - Wave 0 creates | pending |
| 01-01-03 | 01 | 0 | FND-03 | T-01-02 | Canonical serializer rejects invalid numbers and produces stable output | unit | `npm test -- serialization` | no - Wave 0 creates | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `package.json` and `package-lock.json` - npm scaffold with build/typecheck/test/lint/verify scripts.
- [ ] `tsconfig.json` and `tsconfig.build.json` - strict TypeScript configuration.
- [ ] `tsup.config.ts` - distributable package build configuration.
- [ ] `vitest.config.ts` - test runner configuration.
- [ ] `biome.json` or equivalent lint configuration - lint command backend.
- [ ] `test/serialization.test.ts` - deterministic serializer proof.
- [ ] `test/public-api.test.ts` or type-focused equivalent - public entrypoint proof.

---

## Manual-Only Verifications

All Phase 1 behaviors have automated verification. Manual review is limited to checking that Phase 1 did not implement out-of-scope renderer, layout, DSL, CLI, or text measurement behavior.

---

## Validation Sign-Off

- [x] All tasks have automated verify commands or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all missing test infrastructure references
- [x] No watch-mode flags
- [x] Feedback latency target < 30s after install
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-24
