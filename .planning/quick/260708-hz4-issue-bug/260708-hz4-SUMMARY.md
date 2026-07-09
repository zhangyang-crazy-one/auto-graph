---
status: complete
quick_id: 260708-hz4
slug: issue-bug
date: 2026-07-08
code_commit: 7c99e51
---

# Quick Task 260708-hz4 Summary: Issue #71 Dense Routing Algorithm Follow-up

## Outcome

Completed the Issue #71 follow-up on PR #72 with an algorithmic routing fix rather than a sample-specific bypass.

## Research Applied

The implementation direction was based on object-avoiding orthogonal connector routing, visibility/A* routing, monotonic/backtracking penalties, space-driven candidate costs, label-aware routing, and dense graph rail/bundle practices.

Research notes are in `260708-hz4-RESEARCH.md`.

## Changes

- Added a shared route quality model in `src/routing/routes.ts`.
- Ranked route candidates by hard obstacle crossings, endpoint interior crossings, soft/text obstacle crossings and overlap length, excessive length, backtracking distance, anchor preference, bends, and path length.
- Applied endpoint interior protection to explicit anchors and ports, not only automatic anchors.
- Added endpoint escape candidates for large endpoint boxes and far-side explicit anchors.
- Reused the same cost model for A*/visibility rejected fallbacks and heuristic fallbacks.
- Preserved structured diagnostics when all bounded candidates still require soft obstacle crossings, hard obstacle crossings, or excessive backtracking.
- Added regression coverage for explicit far-side anchors and large soft-obstacle cost ranking.
- Updated the routing canonical fixture for the new deterministic best path.
- Preserved the existing local `package.json` version bump to `0.2.14`, matching the Issue #71 retest version.

## Verification

- `npm test -- test/routing.test.ts`: passed
- `npm test -- test/solver.test.ts`: passed
- `npm run verify`: passed
  - `tsc --noEmit`: passed
  - `tsup`: passed
  - `vitest run`: 25 files, 378 tests passed
  - `biome ci .`: passed with 68 existing warnings

## Commits

- `7c99e51 fix(260708-hz4): rank dense routes by obstacle cost`
