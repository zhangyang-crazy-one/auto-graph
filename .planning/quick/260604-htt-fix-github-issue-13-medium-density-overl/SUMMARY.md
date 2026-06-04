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
