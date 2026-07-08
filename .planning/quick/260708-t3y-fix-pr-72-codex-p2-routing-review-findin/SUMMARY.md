---
quick_id: 260708-t3y
description: Fix PR 72 Codex P2 routing review findings
status: complete
completed: 2026-07-08T21:20:35+08:00
---

# Summary

Fixed the latest PR #72 Codex P2 routing review findings posted after the Issue #74 regression fix.

## Changes

- External edge callouts no longer reserve local label boxes or route/text obstacles.
- Forced external labels skip dry-run local edge-label estimates.
- Rail validation now checks non-connected local edge-label obstacles before accepting dependency rails.
- Routing allocation reports now come from accepted rail routes, not ordinary route extents.
- Hard-obstacle fallback routes now diagnose endpoint-interior violations.

## Verification

- `npm test -- test/solver.test.ts test/routing.test.ts`
- `npm test -- test/dense-acceptance.test.ts test/solver.test.ts test/routing.test.ts`
- `npm run verify`
