---
phase: 01-project-scaffold-and-core-ir
reviewed: 2026-05-24T11:06:39Z
depth: standard
files_reviewed: 18
files_reviewed_list:
  - package.json
  - .gitignore
  - tsconfig.json
  - tsconfig.build.json
  - tsup.config.ts
  - vitest.config.ts
  - biome.json
  - src/index.ts
  - src/ir/geometry.ts
  - src/ir/elements.ts
  - src/ir/constraints.ts
  - src/ir/diagnostics.ts
  - src/ir/diagram.ts
  - src/ir/index.ts
  - src/serialization/canonical.ts
  - src/serialization/index.ts
  - test/public-api.test.ts
  - test/serialization.test.ts
findings:
  critical: 0
  warning: 2
  info: 0
  total: 2
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-05-24T11:06:39Z
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found

## Summary

Reviewed the Phase 01 package scaffold, TypeScript/Vitest/Biome configs, public IR contracts, canonical serializer, and tests. `package-lock.json` was read as dependency context but excluded from source review per lockfile filtering rules.

The scaffold and type-only IR are clean at this stage. The actionable issues are both in canonical serialization: unordered anchor collections are not actually canonical for legal `AnchorPoint` data, and invalid precision values can turn finite numbers into JSON `null`.

Verification performed during review:

- `rtk npm run typecheck` passed.
- `rtk npm test` passed: 2 files, 8 tests.
- `rtk npm run build` passed.

## Warnings

### WR-01: Anchor Arrays Are Marked Unordered But Do Not Sort By Anchor Identity

**File:** `src/serialization/canonical.ts:21`

**Issue:** `anchors` is listed in `UNORDERED_COLLECTION_KEYS`, so the serializer intends to canonicalize anchor arrays independent of input order. However, `itemSortKey` only considers `id`, `sourceId`, `targetId`, `nodeId`, `groupId`, and `kind` (`src/serialization/canonical.ts:24-31`). The public IR defines `AnchorPoint` with `name` and `point`, not `id` (`src/ir/geometry.ts:41-44`). For valid coordinated nodes, two equivalent anchor sets with reversed `name` order serialize differently because every anchor gets an empty sort key and stable sort preserves input order. This violates the Phase 01 determinism goal for a public coordinated IR collection.

**Fix:** Add `name` to the identity key list or special-case `anchors` to sort by `name` after canonicalization. Add a regression test using valid `CoordinatedNode.anchors` with reversed `name` order.

```ts
const IDENTITY_KEYS = [
  "id",
  "name",
  "sourceId",
  "targetId",
  "nodeId",
  "groupId",
  "kind",
] as const;
```

### WR-02: Invalid Precision Can Produce Non-Canonical JSON Null For Finite Numbers

**File:** `src/serialization/canonical.ts:39`

**Issue:** `canonicalize` accepts any `number` for `precision` and uses it directly in `10 ** precision` (`src/serialization/canonical.ts:73`). If a caller passes `NaN`, `Infinity`, or a non-integer precision, rounding can produce `NaN` or surprising output. `canonicalize({ x: 1.23 }, { precision: Number.NaN })` returns `{ x: NaN }`, and `stringifyCanonical({ x: 1.23 }, Number.NaN)` serializes that as `"x": null`, bypassing the non-finite number rejection that exists for input values. This can silently corrupt numeric geometry fixtures.

**Fix:** Validate precision once at the public boundary and reject unsupported values before recursion. A conservative policy is a finite, non-negative integer.

```ts
function resolvePrecision(precision: number): number {
  if (!Number.isInteger(precision) || precision < 0) {
    throw new TypeError("Canonical precision must be a non-negative integer");
  }

  return precision;
}
```

Then call it from both `canonicalize` and `stringifyCanonical`, and add tests for `NaN`, `Infinity`, negative, and fractional precision.

---

_Reviewed: 2026-05-24T11:06:39Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
