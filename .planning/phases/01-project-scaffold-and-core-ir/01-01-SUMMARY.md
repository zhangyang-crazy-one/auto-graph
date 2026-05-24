---
phase: 01-project-scaffold-and-core-ir
plan: 01
subsystem: tooling
tags: [typescript, npm, tsup, vitest, biome]
requires: []
provides:
  - npm package scaffold with exact devDependency lockfile
  - strict TypeScript baseline
  - tsup ESM/CJS declaration build configuration
  - Vitest and Biome command backends
affects: [phase-01, FND-01, package-tooling]
tech-stack:
  added: [typescript, tsup, vitest, "@biomejs/biome", "@types/node"]
  patterns: [single-package npm scaffold, explicit package exports, non-watch verification scripts]
key-files:
  created: [package.json, package-lock.json, .gitignore, tsconfig.json, tsconfig.build.json, tsup.config.ts, vitest.config.ts, biome.json]
  modified: []
key-decisions:
  - "Use npm lockfile and exact devDependency versions for the initial TypeScript scaffold."
  - "Keep the package public surface explicit through package exports and files while private remains true."
  - "Use Biome for lint and format checks, scoped away from GSD planning artifacts."
patterns-established:
  - "Package scripts expose build, typecheck, test, lint, format, and verify as stable local commands."
  - "Build output is ESM/CJS with declarations from src/index.ts, leaving source API creation to later plans."
requirements-completed: [FND-01]
duration: 9min
completed: 2026-05-24
---

# Phase 01 Plan 01: Project Scaffold Summary

**Single-package npm and TypeScript tooling scaffold with explicit exports, strict checks, tsup build config, Vitest tests, and Biome lint/format commands**

## Performance

- **Duration:** 9 min
- **Started:** 2026-05-24T10:18:01Z
- **Completed:** 2026-05-24T10:27:17Z
- **Tasks:** 3
- **Files modified:** 8 scaffold files

## Accomplishments

- Created `package.json` with exact scripts, explicit exports, private package metadata, and no future algorithm/runtime dependencies.
- Generated `package-lock.json` from `npm install` using the planned devDependency versions.
- Added strict TypeScript, tsup, Vitest, and Biome configuration for later source and test plans.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create npm package metadata and lockfile** - `ea34664` (chore)
2. **Task 2: Create strict TypeScript and build configs** - `90e1e0a` (chore)
3. **Task 3: Create Vitest and Biome configs** - `8ea864b` (chore)
4. **Task 3 follow-up: Align scaffold with Biome formatting** - `388538a` (style)

## Files Created/Modified

- `package.json` - npm metadata, explicit package exports/files, exact scripts, and exact devDependencies.
- `package-lock.json` - npm lockfile for the scaffold dependency set.
- `.gitignore` - ignores only `node_modules/`, `dist/`, `coverage/`, and `.DS_Store`.
- `tsconfig.json` - strict TypeScript baseline for source, tests, and config files.
- `tsconfig.build.json` - build-specific TypeScript include/exclude wrapper.
- `tsup.config.ts` - ESM/CJS declaration build target for future `src/index.ts`.
- `vitest.config.ts` - node test runner config with explicit test include and coverage output.
- `biome.json` - Biome lint/format configuration scoped to source scaffold files.

## Decisions Made

- Followed D-01 and D-02 with a single npm package and `package-lock.json`.
- Followed D-03 through `tsup` for distributable output and `tsc --noEmit` for typecheck.
- Followed D-04 and D-05 with Vitest and Biome as the test/lint backends.
- Kept Phase 2+ dependencies out of `package.json`; no Pretext, Dagre, parser, CLI, renderer, SVG, React, or Excalidraw dependency was installed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Biome lint scope and schema mismatch**
- **Found during:** Plan-level verification after Task 3
- **Issue:** `biome ci .` failed because the schema URL used `2.4.0` while the installed CLI is `2.4.15`, and Biome attempted to format GSD planning artifacts outside the scaffold scope.
- **Fix:** Updated the schema URL to `2.4.15`, excluded `.planning` from Biome file includes, and ran `npm run format` to align created scaffold files with the configured formatter.
- **Files modified:** `biome.json`, `package.json`, `tsconfig.json`, `tsconfig.build.json`, `tsup.config.ts`, `vitest.config.ts`
- **Verification:** `rtk npm run lint` passed.
- **Committed in:** `388538a`

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** The fix keeps lint focused on this package scaffold and avoids scope creep into GSD planning files.

## Issues Encountered

- `rtk test -f package-lock.json` did not execute cleanly through the RTK wrapper, so the lockfile existence check was verified with `rtk bash -lc 'test -f package-lock.json'` and a Node lockfileVersion check.
- `rtk npm run build` currently fails with `Cannot find src/index.ts`, and `rtk npm test` currently fails with no test files found. This matches the plan note that full `rtk npm run verify` is expected to pass after Plans 02 and 03 add the source entrypoint and tests.

## Verification

Passed:

- `rtk node -e "const p=require('./package.json'); for (const s of ['build','typecheck','test','lint','format','verify']) if (!p.scripts[s]) throw new Error('missing '+s); if (!p.private || p.type !== 'module') throw new Error('bad package metadata'); if (!p.exports['.'].import || !p.exports['.'].require || !p.exports['.'].types) throw new Error('bad exports');"`
- `rtk bash -lc 'test -f package-lock.json'`
- `rtk node -e "const l=require('./package-lock.json'); if (!l.lockfileVersion) throw new Error('missing lockfileVersion');"`
- `rtk node -e "const ts=require('./tsconfig.json'); if (!ts.compilerOptions.strict || !ts.compilerOptions.exactOptionalPropertyTypes || !ts.compilerOptions.noUncheckedIndexedAccess) throw new Error('strict options missing'); const build=require('./tsconfig.build.json'); if (!build.extends || !build.include.includes('src')) throw new Error('bad build config');"`
- `rtk rg 'format: \\[\"esm\", \"cjs\"\\]|target: \"node20\"|entry: \\[\"src/index.ts\"\\]' tsup.config.ts`
- `rtk node -e "const b=require('./biome.json'); if (!b.formatter.enabled || !b.linter.enabled) throw new Error('biome check not enabled');"`
- `rtk rg 'globals: false|environment: \"node\"|include: \\[\"test/\\*\\*/\\*.test.ts\"\\]' vitest.config.ts`
- `rtk node -e "const p=require('./package.json'); if (p.scripts.test !== 'vitest run') throw new Error('bad test script');"`
- `rtk npm run typecheck`
- `rtk npm run lint`

Deferred until later Phase 1 plans:

- `rtk npm run build` needs Plan 02 to create `src/index.ts`.
- `rtk npm test` needs Plan 03 or related test plans to create `test/**/*.test.ts`.
- Full `rtk npm run verify` needs both of the above.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None.

## Next Phase Readiness

Plan 02 can add public IR modules and `src/index.ts` against the committed package exports and tsup entrypoint. Plan 03 can add tests and serializer code against the committed Vitest configuration.

## Self-Check: PASSED

- Verified all created scaffold and summary files exist.
- Verified task commits `ea34664`, `90e1e0a`, `8ea864b`, and `388538a` exist in git history.
- Scanned created scaffold files for common stub markers; none found.

---
*Phase: 01-project-scaffold-and-core-ir*
*Completed: 2026-05-24*
