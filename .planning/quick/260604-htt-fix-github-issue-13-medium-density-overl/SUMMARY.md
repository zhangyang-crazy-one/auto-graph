---
quick_id: 260604-htt
slug: fix-github-issue-13-medium-density-overl
status: complete
completed_at: 2026-06-04T05:06:00Z
---

# Summary

Implemented a solver-scope fix for GitHub issue #13.

## Changes

- Added the issue #13 microservice YAML as a regression fixture.
- Made unlocked overlap repair deterministic across both axes: unlocked dense
  nodes first try secondary-axis separation, then primary-axis repair.
- Expanded orthogonal routing with alternate automatic side anchors and outer
  dogleg candidates, while preserving explicit anchor behavior.
- Made edge label placement try deterministic offset candidates that avoid
  crossing other routes.
- Updated routing and DSL regression tests for the new dense-layout behavior.

## Verification

- `npm run verify` passed:
  - `tsc --noEmit`
  - `tsup`
  - `vitest run`: 17 test files, 232 tests
  - `biome ci .`
- CLI probe passed without diagnostics:
  - `node dist/cli/index.js --input test/fixtures/issue-13/microservice.auto-graph.yaml --format svg --json --output /tmp/issue13.svg`

## Review Fixes

Addressed Codex review feedback on PR #14:

- Edge label candidate selection now preserves the original `labelOffset`
  placement first and rejects candidates that intersect the owning edge.
- Automatic routing candidates now reject middle segments that cross endpoint
  interiors, preventing back-side auto anchors or doglegs from routing through
  source/target nodes while preserving explicit anchor behavior.
- The issue #13 regression test now checks each forbidden diagnostic
  individually instead of relying on `arrayContaining` against the full set.

Review-fix verification:

- `npm run verify` passed: 17 test files, 233 tests.

Second Codex review fix:

- Single-endpoint explicit anchors now keep the omitted endpoint automatic, so
  a pinned source can still try alternate target anchors.
- Automatic endpoint-interior validation now rejects terminal segment crossings
  through source/target node interiors instead of skipping those segments.
- Added routing regressions for both Codex review examples.

Second review-fix verification:

- `npm run verify` passed: 17 test files, 235 tests.
