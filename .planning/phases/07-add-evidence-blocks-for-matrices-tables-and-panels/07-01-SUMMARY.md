---
phase: 07-add-evidence-blocks-for-matrices-tables-and-panels
plan: 01
subsystem: dsl
tags: [typescript, zod, dsl, ir, canonicalization, fixtures]

requires:
  - phase: 06-verification-and-release-readiness
    provides: deterministic tests and canonical serialization baseline
provides:
  - First-class DSL and IR contracts for matrices, tables, and evidence panels
  - Deterministic canonical handling for evidence block collections
  - Methodology-split evidence block fixture skeletons with normalized count tests
affects: [phase-07, dsl, ir, serialization, solver, exporters]

tech-stack:
  added: []
  patterns:
    - Array-based evidence block DSL with stable item ids
    - Author-order-preserving normalized evidence block internals
    - Canonical top-level collection sorting with semantic internal order retention

key-files:
  created:
    - test/fixtures/evidence-blocks/01-method-chain.yaml
    - test/fixtures/evidence-blocks/04-traceability-spine.yaml
    - test/fixtures/evidence-blocks/05-structure-parameter-extraction.yaml
  modified:
    - src/dsl/schema.ts
    - src/dsl/normalize.ts
    - src/ir/elements.ts
    - src/ir/diagram.ts
    - src/serialization/canonical.ts
    - test/dsl.test.ts
    - test/serialization.test.ts

key-decisions:
  - "Evidence block DSL uses top-level arrays with explicit stable ids so author-declared order can be preserved."
  - "Canonical serialization sorts top-level evidence block collections while preserving matrix rows, columns, cells, table columns, table rows, and panel item order."
  - "07-01 stops at DSL/IR/canonical/fixture readiness; solver and exporter behavior remains for 07-02 and 07-03."

patterns-established:
  - "Evidence block cells normalize strings and styled objects into EvidenceCell records."
  - "Fixture acceptance tests assert normalized intent counts instead of only checking file existence."

requirements-completed: [V2-INT-01]

duration: 20min
completed: 2026-05-31
---

# Phase 07 Plan 01: Evidence Block DSL And IR Summary

**Matrices, tables, and evidence panels are now valid normalized diagram intent with deterministic canonical serialization and methodology-split fixture coverage.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-05-31T13:38:06Z
- **Completed:** 2026-05-31T13:58:28Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Added `matrices`, `tables`, and `evidencePanels` to the DSL schema and normalized diagram contract.
- Added `MatrixBlock`, `TableBlock`, `EvidencePanel`, and supporting cell/row/column/item contracts.
- Extended canonical serialization so top-level evidence block collections are deterministic while internal semantic order is preserved.
- Added three PR-B methodology-split fixtures and DSL tests that assert required content counts on normalized intent.

## Task Commits

1. **Task 1: Add evidence block DSL schema and IR contracts** - `6859cc9` (feat)
2. **Task 2: Lock evidence block serialization stability** - `b79f46c` (feat)
3. **Task 3: Prepare methodology-split acceptance fixtures** - `803dad7` (test)

## Files Created/Modified

- `src/dsl/schema.ts` - Adds schema validation for matrix, table, and evidence panel DSL arrays.
- `src/dsl/normalize.ts` - Normalizes evidence block arrays, cells, table rows, columns, panel items, positions, sizes, and styles.
- `src/ir/elements.ts` - Defines evidence block IR contracts.
- `src/ir/diagram.ts` - Adds evidence block arrays to intent, normalized, and coordinated diagrams.
- `src/serialization/canonical.ts` - Adds evidence block collection canonicalization rules.
- `test/dsl.test.ts` - Covers evidence block parsing, normalization, and fixture content counts.
- `test/serialization.test.ts` - Covers evidence block canonical stability.
- `test/fixtures/evidence-blocks/01-method-chain.yaml` - Adds 3 x 5 method-chain grid fixture with legend and note panels.
- `test/fixtures/evidence-blocks/04-traceability-spine.yaml` - Adds traceability spine fixture with two matrices and rule panel.
- `test/fixtures/evidence-blocks/05-structure-parameter-extraction.yaml` - Adds structure/parameter fixture with two tables, two matrices, and note panel.

## Verification

- `rtk npm test -- test/dsl.test.ts` - PASS, 25 tests.
- `rtk npm test -- test/serialization.test.ts` - PASS, 9 tests.
- `rtk npm test -- test/dsl.test.ts test/serialization.test.ts` - PASS, 2 files / 34 tests.
- `rtk rg -n "matrices|tables|evidencePanels" src/dsl src/ir src/serialization` - PASS, schema, normalize, IR, and canonical references found.
- `rtk rg -n "method-chain|traceability-spine|structure-parameter-extraction" test/fixtures/evidence-blocks test/dsl.test.ts` - PASS, fixture ids and tests found.

## Decisions Made

- Evidence blocks use arrays rather than id-keyed maps because row, column, item, and block order are semantic authoring data.
- Empty matrix cells are represented as empty strings in fixture YAML and normalize into `{ text: "" }`.
- PR-A lane contracts and PR-C semantic port routing remain explicitly out of scope for this plan.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None. Stub scan only matched normal default parameters, empty local accumulator construction, and null/object guards in existing implementation style.

## Threat Flags

None. The plan added DSL shape validation and local serialization behavior only; it did not add network endpoints, authentication paths, new file access patterns, or runtime trust-boundary changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

07-02 can consume normalized `matrices`, `tables`, and `evidencePanels` as stable block collections for geometry solving, bounds inclusion, and routing obstacle handling. 07-03 can consume the same contracts for SVG and Excalidraw rendering.

## Self-Check: PASSED

- Summary file created at `.planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/07-01-SUMMARY.md`.
- Task commits exist: `6859cc9`, `b79f46c`, `803dad7`.
- Plan-level verification commands passed.

---
*Phase: 07-add-evidence-blocks-for-matrices-tables-and-panels*
*Completed: 2026-05-31*
