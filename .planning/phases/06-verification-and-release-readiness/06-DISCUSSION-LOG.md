# Phase 06: Verification And Release Readiness - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-26T00:02:28Z
**Phase:** 06-verification-and-release-readiness
**Areas discussed:** verification bar, golden fixture scope, README limitations, todo tests

---

## Verification Bar

| Option | Description | Selected |
|--------|-------------|----------|
| Release candidate strict bar | All Phase 6 requirements need explicit evidence; `rtk npm run verify` must pass; todo tests are resolved or made explicit. | ✓ |
| Minimum viable bar | Patch only obvious gaps and allow some remaining todos/follow-ups. | |
| the agent decides | Planner decides based on current code risk. | |

**User's choice:** Continue with recommended default.
**Notes:** The workflow selector was unavailable in this runtime, so the fallback prompt presented `1A 2A 3A 4A`. The user said "继续"; this was interpreted as accepting the recommended defaults.

---

## Golden Fixture Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Five Phase 5 example families | Cover architecture, flowchart, edge-labels, groups, and hybrid-layout as the main release surface. | ✓ |
| Core three families | Cover only architecture, flowchart, and hybrid-layout to reduce maintenance. | |
| the agent decides | Planner picks the minimal set that satisfies VER-02 and VER-03. | |

**User's choice:** Continue with recommended default.
**Notes:** This locks the Phase 5 examples as the natural Phase 6 golden source.

---

## README Limitations

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit limitations | Clearly document v1 is not a visual editor, draw.io replacement, full style system, CAD router, or browser preview. | ✓ |
| Short limitations | Only list the highest-risk current limitations. | |
| the agent decides | Keep README clear without overloading new users. | |

**User's choice:** Continue with recommended default.
**Notes:** README should be candid about current v1 scope so users do not infer unsupported capabilities.

---

## Todo Tests

| Option | Description | Selected |
|--------|-------------|----------|
| Clear v1 todos | Convert current `it.todo` entries into real assertions where they describe v1 contracts. | ✓ |
| Keep but document | Leave future-facing todos only if documented as deferred. | |
| the agent decides | Resolve what is in scope and defer what is not. | |

**User's choice:** Continue with recommended default.
**Notes:** Phase 6 should not finish with vague todo tests for v1 release contracts.

---

## the agent's Discretion

- Exact fixture layout and helper script structure.
- Exact README section order and wording.
- Exact test file grouping, provided VER-01 through VER-04 are directly evidenced.

## Deferred Ideas

- draw.io/mxGraph XML export.
- Mermaid and ASCII/Unicode export/import.
- Browser preview and visual review UI.
- Rich style API and theme configuration.
- Python package/port.
