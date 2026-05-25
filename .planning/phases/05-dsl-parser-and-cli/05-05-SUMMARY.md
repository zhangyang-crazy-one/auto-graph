---
phase: 05-dsl-parser-and-cli
plan: 05
subsystem: examples
tags: [dsl, yaml, json, fixtures, cli-smoke]
requires:
  - phase: 05-dsl-parser-and-cli
    provides: 05-04 dge CLI execution path
provides:
  - YAML-first DSL examples for architecture, flowchart, edge labels, groups, and hybrid layout
  - Phase 5 fixture copies for parser and CLI smoke tests
  - JSON parity fixture for architecture DSL normalization
  - table-driven parse, solve, SVG export, and Excalidraw CLI smoke coverage
affects: [public-api, README, verification]
tech-stack:
  added: []
  patterns: [YAML-first example fixtures, canonical YAML/JSON parity, table-driven CLI fixture smoke tests]
key-files:
  created:
    - examples/architecture.yaml
    - examples/flowchart.yaml
    - examples/edge-labels.yaml
    - examples/groups.yaml
    - examples/hybrid-layout.yaml
    - test/fixtures/phase-05/architecture.yaml
    - test/fixtures/phase-05/flowchart.yaml
    - test/fixtures/phase-05/edge-labels.yaml
    - test/fixtures/phase-05/groups.yaml
    - test/fixtures/phase-05/hybrid-layout.yaml
    - test/fixtures/phase-05/architecture.json
  modified:
    - test/dsl.test.ts
    - test/cli.test.ts
key-decisions:
  - "Examples remain concise YAML authoring surfaces and avoid deferred draw.io, Mermaid, ASCII, browser preview, or rich styling fields."
  - "Group containment examples use the DSL group model rather than containment constraints that require node container IDs."
  - "Fixture smoke tests exercise the same public render and CLI paths users will run."
patterns-established:
  - "Example fixtures live in both examples/ for users and test/fixtures/phase-05/ for stable tests."
  - "YAML/JSON parity compares canonical normalized nodes, edges, groups, and constraints."
requirements-completed: []
duration: 10 min
completed: 2026-05-25
---

# Phase 05 Plan 05: DSL Parser And CLI Summary

**YAML-first DSL examples with fixture smoke tests through parser, solver, SVG export, and Excalidraw CLI output**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-25T04:43:37Z
- **Completed:** 2026-05-25T04:52:50Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments

- Added five user-facing YAML examples for architecture, flowchart, edge labels, groups, and hybrid fixed/relative layout.
- Added matching Phase 5 test fixtures plus a JSON architecture fixture proving YAML and JSON normalize equivalently.
- Extended DSL and CLI tests so every example parses, solves, exports SVG, and one fixture exports Excalidraw JSON through stdout.

## Task Commits

Each task was committed atomically:

1. **Task 1 and Task 2: DSL examples and fixture smoke tests** - `9e86c10`

## Files Created/Modified

- `examples/architecture.yaml` - Architecture example with client, API, database, queue, and worker nodes.
- `examples/flowchart.yaml` - Flowchart example using top-to-bottom layout.
- `examples/edge-labels.yaml` - Edge shorthand and structured edge label example.
- `examples/groups.yaml` - Backend group containment example using `groups.backend.nodes`.
- `examples/hybrid-layout.yaml` - Hybrid layout example with fixed `position` and relative-position constraints.
- `test/fixtures/phase-05/*` - Stable fixture copies plus architecture JSON parity input.
- `test/dsl.test.ts` - Table-driven fixture render tests and YAML/JSON canonical normalization parity.
- `test/cli.test.ts` - Table-driven CLI SVG smoke tests and Excalidraw stdout JSON smoke coverage.

## Decisions Made

- Kept examples YAML-first and intentionally small so agents and users can copy them without inheriting unnecessary styling or exporter-specific fields.
- Removed a group-file containment constraint because containment constraints reference node IDs, while this plan's purpose is to demonstrate DSL group membership through `groups.backend.nodes`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `biome` does not process YAML fixture paths, so YAML formatting was left as hand-formatted two-space YAML.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for `05-06`: public root exports, package binary build proof, static anti-recompute guards, README CLI notes, and full verification can now rely on real Phase 5 examples.

---
*Phase: 05-dsl-parser-and-cli*
*Completed: 2026-05-25*
