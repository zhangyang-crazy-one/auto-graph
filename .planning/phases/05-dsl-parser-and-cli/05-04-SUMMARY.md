---
phase: 05-dsl-parser-and-cli
plan: 04
subsystem: cli
tags: [typescript, commander, cli, stdin, stdout, atomic-writes]
requires:
  - phase: 05-dsl-parser-and-cli
    provides: 05-03 renderDiagramDsl pipeline
provides:
  - Commander-based dge CLI orchestration
  - stdin/file input and stdout/file output behavior
  - human and JSON diagnostics on stderr
  - atomic output writes and input byte guard
affects: [examples, public-api, verification]
tech-stack:
  added: []
  patterns: [injectable CLI environment, temp-file-then-rename output, stderr-only diagnostics]
key-files:
  created:
    - src/cli/run.ts
    - src/cli/io.ts
  modified:
    - src/cli/index.ts
    - test/cli.test.ts
key-decisions:
  - "runCli is injectable and testable; src/cli/index.ts only adapts process argv and exitCode."
  - "No output file is opened until render succeeds; successful file output uses temp-file then rename in the target directory."
  - "CLI diagnostics go to stderr in either human-readable or JSON form, while generated content goes to stdout or output file."
patterns-established:
  - "CLI IO remains outside DSL/parser modules."
  - "Exit codes are 0 for success, 1 for parse/validate/solve/export/IO errors, and 2 for Commander usage errors."
requirements-completed:
  - CLI-01
  - CLI-02
  - CLI-03
duration: 9 min
completed: 2026-05-25
---

# Phase 05 Plan 04: DSL Parser And CLI Summary

**Unix-friendly `dge` CLI with stdin/file input, stdout/file output, diagnostics, and atomic writes**

## Performance

- **Duration:** 9 min
- **Started:** 2026-05-25T04:34:09Z
- **Completed:** 2026-05-25T04:43:37Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Implemented `runCli()` using Commander with `--input`, `--output`, `--format`, and `--json`.
- Added stdin fallback, stdout fallback, stderr-only diagnostics, JSON diagnostic payloads, exit code handling, and warning passthrough.
- Added filesystem helpers with 1 MB input guards and `writeFileAtomic()` temp-file-then-rename behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1 and Task 2: Commander CLI plus filesystem IO** - `55ade11`

## Files Created/Modified

- `src/cli/run.ts` - Testable CLI orchestration over `renderDiagramDsl()`.
- `src/cli/io.ts` - Stdin/file/stdout/stderr helpers plus atomic output writes.
- `src/cli/index.ts` - Executable entrypoint that calls `runCli()` and sets `process.exitCode`.
- `test/cli.test.ts` - Covers file input, stdin input, stdout/file output, JSON diagnostics, unknown options, warnings, byte guards, and failure-preserved output files.

## Decisions Made

- Kept CLI output format validation inside the existing DSL render path so CLI flags use the same `validate.output-format.unsupported` diagnostic as library calls.
- Used injectable streams in tests instead of spawning a child process, while still verifying the built CLI artifact exists through `rtk npm run build`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The CLI entry initially used top-level await, which broke the CJS build target. It now uses a promise chain so tsup can emit both ESM and CJS bundles.
- A shell-builtin `test -f` check through `rtk` returned bash help output; the build log and `rtk ls dist/cli/index.js` confirmed the CLI artifact exists.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for `05-05`: examples and fixture smoke tests can now exercise the real `dge` CLI path.

---
*Phase: 05-dsl-parser-and-cli*
*Completed: 2026-05-25*
