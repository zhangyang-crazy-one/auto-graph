---
phase: 01-project-scaffold-and-core-ir
plan: 03
subsystem: core-serialization
tags: [typescript, serialization, determinism, vitest, canonical-json]
requires:
  - phase: 01-project-scaffold-and-core-ir
    provides: public IR contracts and package entrypoint
provides:
  - canonical JSON serializer with deterministic object and collection ordering
  - documented default 3-decimal numeric precision and invalid-number rejection
  - public serialization exports through the root package entrypoint
  - Vitest coverage for byte-stable output and point route ordering
affects: [phase-01, phase-02, phase-03, phase-04, FND-03, golden-fixtures, coordinated-ir]
tech-stack:
  added: []
  patterns: [canonicalization before JSON.stringify, parent-key-aware array sorting, point-like route preservation]
key-files:
  created: [src/serialization/canonical.ts, src/serialization/index.ts, test/serialization.test.ts]
  modified: [src/index.ts, tsconfig.json]
key-decisions:
  - "Canonical JSON output sorts object keys lexicographically and sorts only known unordered IR collections by identity fields."
  - "Semantic coordinate path arrays, especially edge points, preserve input order instead of falling back to JSON-string sorting."
  - "Finite numbers round to DEFAULT_CANONICAL_PRECISION = 3, -0 normalizes to 0, and non-finite numbers throw before JSON serialization."
patterns-established:
  - "Serialization utilities live under src/serialization and are exposed through src/index.ts via the serialization barrel."
  - "Canonicalization rejects unsupported JavaScript values rather than silently coercing them into JSON."
requirements-completed: [FND-03]
duration: 8min
completed: 2026-05-24
---

# Phase 01 Plan 03: Canonical Serializer Summary

**Canonical JSON serializer with deterministic IR collection ordering, 3-decimal numeric normalization, and preserved edge route point order**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-24T10:47:19Z
- **Completed:** 2026-05-24T10:55:52Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Added RED-first Vitest coverage for canonical serializer determinism, numeric rounding, `-0` normalization, undefined omission, non-finite rejection, and `points` order preservation.
- Implemented `canonicalize` and `stringifyCanonical` with recursive object key sorting, identity-key sorting for unordered IR collections, and point-like coordinate array preservation.
- Exposed serialization APIs from the root package entrypoint and verified the full Phase 1 gate.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add serializer determinism tests** - `3e44633` (test)
2. **Task 2: Implement canonical serializer** - `43b42fe` (feat)
3. **Task 3: Export serializer publicly and run phase gate** - `551d991` (feat)

## Files Created/Modified

- `test/serialization.test.ts` - Serializer behavior tests for deterministic output, numeric integrity, undefined omission, unsupported numbers, and route point order.
- `src/serialization/canonical.ts` - Canonicalization implementation and public serializer contracts.
- `src/serialization/index.ts` - Serialization barrel export.
- `src/index.ts` - Root package entrypoint re-exporting IR and serialization APIs.
- `tsconfig.json` - Added TypeScript 6 deprecation silencing required for tsup declaration output.

## Decisions Made

- Used parent-key-aware sorting so known unordered collections like `nodes`, `edges`, `groups`, `constraints`, `diagnostics`, and `anchors` sort deterministically.
- Preserved `points` and point-like `{ x, y }` coordinate arrays in authored/solved sequence to avoid corrupting routes.
- Kept serializer behavior JSON-like and strict: unsupported JavaScript values throw, prototypes are ignored through own enumerable `Object.keys`, and `undefined` object fields are omitted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Temporarily exposed serializer functions for Task 2 verification**
- **Found during:** Task 2 (Implement canonical serializer)
- **Issue:** Task 2 verification runs `rtk npm test -- serialization`, but the tests import from `../src/index.js` and Task 3 was originally responsible for the root public export.
- **Fix:** Added a direct root export in Task 2 so the serializer tests could pass through the public entrypoint, then replaced it with the planned `export * from "./serialization/index.js";` barrel export in Task 3.
- **Files modified:** `src/index.ts`
- **Verification:** `rtk npm test -- serialization` passed after Task 2 and after Task 3.
- **Committed in:** `43b42fe`, then normalized in `551d991`

**2. [Rule 3 - Blocking] Silenced TypeScript 6 deprecation diagnostic for tsup DTS output**
- **Found during:** Task 3 (Export serializer publicly and run phase gate)
- **Issue:** `rtk npm run verify` failed during `tsup` declaration generation because TypeScript 6 reported `baseUrl` deprecation from the dts build path and required `ignoreDeprecations`.
- **Fix:** Added `"ignoreDeprecations": "6.0"` to `tsconfig.json`, preserving output behavior while allowing declaration generation to complete.
- **Files modified:** `tsconfig.json`
- **Verification:** `rtk npm run verify` passed.
- **Committed in:** `551d991`

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both fixes were required to satisfy the plan's verification gates. No Phase 2+ dependencies, rendering behavior, CLI behavior, or exporter logic was added.

## Issues Encountered

- The Task 1 RED test failed as expected because serializer exports did not exist yet.
- Task 2 surfaced a plan-order dependency between public-entrypoint imports in tests and Task 3's planned export work; resolved with the temporary direct export noted above.
- Full verify initially failed at `tsup` DTS generation under TypeScript 6; resolved with the `ignoreDeprecations` compiler option.
- `gsd-sdk query state.advance-plan` and `state.update-progress` did not parse this project's current `STATE.md` shape, so STATE was updated manually while ROADMAP and REQUIREMENTS were updated through their GSD handlers.

## Verification

Passed:

- `rtk rg 'stringifyCanonical|DEFAULT_CANONICAL_PRECISION|Non-finite number|2\.124' test/serialization.test.ts`
- `rtk rg 'from "../src/index\.js"' test/serialization.test.ts`
- `rtk npm test -- serialization`
- `rtk rg 'export const DEFAULT_CANONICAL_PRECISION = 3|Number\.isFinite|Object\.is\(value, -0\)|Object\.keys\(value\)\.sort\(\)|rawValue === undefined|points|Unsupported value cannot be canonicalized|x.*y|isPointLikeRecord' src/serialization/canonical.ts`
- `rtk rg 'export \* from "\./canonical\.js";' src/serialization/index.ts`
- `rtk rg 'export \* from "\./ir/index\.js";|export \* from "\./serialization/index\.js";' src/index.ts`
- `rtk rg '@chenglou/pretext|@dagrejs/dagre|commander|react|excalidraw|mermaid|svg|drawio' package.json src test` returned no matches.
- `rtk npm run typecheck`
- `rtk npm run lint`
- `rtk npm run verify`

Expected RED failure:

- Before implementation, `rtk npm test -- serialization` failed because `stringifyCanonical`, `canonicalize`, and `DEFAULT_CANONICAL_PRECISION` were not exported yet.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None.

## Next Phase Readiness

Phase 1 is complete. Later phases can use `stringifyCanonical` for byte-stable normalized/coordinated IR fixtures without adding exporter-specific ordering logic.

## Self-Check: PASSED

- Verified created source/test files exist.
- Verified task commits `3e44633`, `43b42fe`, and `551d991` exist in git history.
- Verified plan-level commands `rtk npm test -- serialization` and `rtk npm run verify` pass.
- Scanned created/modified source and test files for common stub markers; none found.
- Scanned created/modified source and test files for new network, file access, and auth surfaces; none found.

---
*Phase: 01-project-scaffold-and-core-ir*
*Completed: 2026-05-24*
