---
status: complete
quick_id: 260708-s5e
slug: fix-issue-74-route-label-feedback-hard-o
commit: 7ac272c
---

# Quick Task 260708-s5e Summary

## Completed

- Added source-aware hard-obstacle metadata to route edges so feedback-created text obstacles no longer report evidence-specific fatal diagnostics.
- Added `routing.label-hard-obstacle.unavoidable` as a deliverability warning for direct text hard-obstacle failures.
- Kept route-label feedback text hard-obstacle diagnostics local to the reroute attempt; final outputs report text clearance / loop exhaustion instead of leaking feedback-local hard diagnostics.
- Changed route-label feedback candidate scoring so real hard-route errors dominate route/text conflict reductions.
- Added regression coverage for issue #74 at routing and solver levels.

## Verification

- `npm test -- test/routing.test.ts test/solver.test.ts`: 2 files, 142 tests passed
- `npm run typecheck`: passed
- `npm run verify`: passed
  - Typecheck: passed
  - Build: passed
  - Tests: 26 files, 390 tests passed
  - Lint: passed with existing non-blocking warnings

## Commit

- `7ac272c fix: keep label feedback text congestion nonfatal`
