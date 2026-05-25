---
phase: 05
slug: dsl-parser-and-cli
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-25
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.7 |
| **Config file** | none — package script runs `vitest run` |
| **Quick run command** | `rtk npm exec vitest -- test/dsl.test.ts test/dsl-diagnostics.test.ts test/cli.test.ts` |
| **Full suite command** | `rtk npm run verify` |
| **Estimated runtime** | ~2 seconds targeted, ~3 seconds full suite |

---

## Sampling Rate

- **After every task commit:** Run the targeted Vitest file for touched behavior.
- **After every plan wave:** Run `rtk npm test`.
- **Before `$gsd-verify-work`:** `rtk npm run verify` must be green.
- **Max feedback latency:** 10 seconds.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | DSL-01 | T-05-01 | Dependencies are pinned through package lock and no custom YAML parser is introduced. | build/type | `rtk npm run typecheck` | ✅ | ⬜ pending |
| 05-02-01 | 02 | 2 | DSL-01, DSL-03 | T-05-02 / T-05-03 | Parsed DSL is validated before normalization and normalized objects are explicitly constructed. | unit | `rtk npm exec vitest -- test/dsl.test.ts` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 2 | DSL-02 | T-05-02 / T-05-05 | Malformed YAML/JSON and invalid fields produce path-bearing diagnostics. | unit negative | `rtk npm exec vitest -- test/dsl-diagnostics.test.ts` | ❌ W0 | ⬜ pending |
| 05-03-01 | 03 | 3 | DSL-02, DSL-03 | T-05-02 / T-05-04 | Missing references, unsupported formats, and invalid constraints block before export. | unit | `rtk npm exec vitest -- test/dsl.test.ts test/dsl-diagnostics.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-01 | 04 | 4 | CLI-01, CLI-02, CLI-03 | T-05-03 / T-05-04 | CLI writes output only after successful parse/solve/export and preserves stderr/stdout separation. | CLI integration | `rtk npm exec vitest -- test/cli.test.ts` | ❌ W0 | ⬜ pending |
| 05-05-01 | 05 | 5 | DSL-01, DSL-03, CLI-01, CLI-02 | T-05-01 / T-05-04 | Example DSL files cover required diagram families and round-trip through CLI/exporters. | fixture smoke | `rtk npm exec vitest -- test/dsl.test.ts test/cli.test.ts` | ❌ W0 | ⬜ pending |
| 05-06-01 | 06 | 6 | DSL-01, DSL-02, DSL-03, CLI-01, CLI-02, CLI-03 | T-05-01..T-05-05 | Public API, static recomputation guard, and full verify pass. | full gate | `rtk npm run verify` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/dsl.test.ts` — stubs and then coverage for DSL-01 and DSL-03.
- [ ] `test/dsl-diagnostics.test.ts` — stubs and then coverage for DSL-02 and CLI-03 diagnostic payloads.
- [ ] `test/cli.test.ts` — stubs and then coverage for CLI-01, CLI-02, CLI-03, stdout/stderr, and atomic write behavior.
- [ ] `test/fixtures/phase-05/` — committed YAML/JSON examples for architecture, flowchart, edge labels, groups, and hybrid layout.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Feedback latency < 10s.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-05-25
