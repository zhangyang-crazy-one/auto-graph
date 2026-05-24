# Phase 1: Project Scaffold And Core IR - Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 19
**Analogs found:** 0 / 19

## File Classification

The repository currently has no source scaffold. `rtk rg --files -uu` found planning documents, root design documents, and git metadata only; no `src/`, `test/`, package config, or existing TypeScript implementation files exist to copy from.

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `package.json` | config | batch/tooling | none | no source analog |
| `package-lock.json` | config | batch/tooling | none | no source analog |
| `tsconfig.json` | config | batch/tooling | none | no source analog |
| `tsconfig.build.json` | config | batch/tooling | none | no source analog |
| `tsup.config.ts` | config | batch/tooling | none | no source analog |
| `vitest.config.ts` | config | batch/tooling | none | no source analog |
| `biome.json` | config | batch/tooling | none | no source analog |
| `src/index.ts` | provider | transform/public-api | none | no source analog |
| `src/ir/geometry.ts` | model | transform/type-contract | none | no source analog |
| `src/ir/diagram.ts` | model | transform/type-contract | none | no source analog |
| `src/ir/elements.ts` | model | transform/type-contract | none | no source analog |
| `src/ir/constraints.ts` | model | transform/type-contract | none | no source analog |
| `src/ir/diagnostics.ts` | model | transform/type-contract | none | no source analog |
| `src/ir/index.ts` | provider | transform/public-api | none | no source analog |
| `src/serialization/canonical.ts` | utility | transform/deterministic-serialization | none | no source analog |
| `src/serialization/index.ts` | provider | transform/public-api | none | no source analog |
| `test/serialization.test.ts` | test | batch/determinism | none | no source analog |
| `test/public-api.test.ts` | test | batch/type-api | none | no source analog |
| `.gitignore` | config | file-I/O/tooling | none | implied, no source analog |

## Pattern Assignments

### `package.json` and `package-lock.json` (config, batch/tooling)

**Analog:** none. Use planning guidance only.

**Toolchain decisions** (`01-CONTEXT.md` lines 18-22):

```markdown
- D-01: Use a single TypeScript package for v1 rather than a monorepo.
- D-02: Use npm for the initial lockfile and scripts unless dependency installation strongly favors pnpm.
- D-03: Use `tsup` for distributable library/CLI bundling and keep `tsc --noEmit` as the explicit typecheck gate.
- D-04: Use Vitest for the first test suite.
- D-05: Use Biome or oxlint for linting; Phase 1 must expose a runnable lint command.
```

**Package scripts pattern** (`01-RESEARCH.md` lines 324-335):

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --sourcemap --clean",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "biome ci .",
    "format": "biome check --write .",
    "verify": "npm run typecheck && npm run build && npm test && npm run lint"
  }
}
```

**Package exports pattern** (`01-RESEARCH.md` lines 341-355):

```json
{
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE"]
}
```

**Dependency pattern** (`01-RESEARCH.md` lines 99-105, 124-128): use local devDependencies for `typescript`, `tsup`, `vitest`, `@biomejs/biome`, and `@types/node`. Do not install future algorithm dependencies in Phase 1.

### `tsconfig.json` and `tsconfig.build.json` (config, batch/tooling)

**Analog:** none. Use planning guidance only.

**Strict TypeScript baseline** (`01-RESEARCH.md` lines 362-377):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "*.config.ts"]
}
```

**Typecheck gate pattern** (`01-RESEARCH.md` lines 285-290): `tsup` emit is not enough; keep `typecheck: "tsc --noEmit"` as a separate command and include it in `verify`.

### `tsup.config.ts` (config, batch/tooling)

**Analog:** none. Use planning guidance only.

**Build responsibility** (`01-RESEARCH.md` lines 62, 101-102, 120): use `tsup` for ESM/CJS plus declaration output, while `tsc --noEmit` remains the correctness gate.

**Boundary:** no CLI behavior in Phase 1 except minimal stubs if required for scaffold validation (`01-CONTEXT.md` line 9).

### `vitest.config.ts` (config, batch/tooling)

**Analog:** none. Use planning guidance only.

**Test framework pattern** (`01-RESEARCH.md` lines 458-465):

```markdown
| Framework | Vitest 4.1.7 |
| Config file | none currently; create `vitest.config.ts` in Wave 0 |
| Quick run command | `npm test -- --runInBand` or `npm test` for small suite |
| Full suite command | `npm run verify` |
```

### `biome.json` (config, batch/tooling)

**Analog:** none. Use planning guidance only.

**Lint tool pattern** (`01-CONTEXT.md` lines 21-22; `01-RESEARCH.md` lines 103-105, 119-122): prefer Biome for a single lint/format/check CLI unless it causes friction; Phase 1 needs one runnable lint command, not both Biome and oxlint.

### `src/index.ts` (provider, transform/public-api)

**Analog:** none. Use planning guidance only.

**Public entrypoint pattern** (`01-RESEARCH.md` lines 181-199):

```typescript
export * from "./ir/index.js";
export {
  DEFAULT_CANONICAL_PRECISION,
  canonicalize,
  stringifyCanonical,
} from "./serialization/index.js";
```

**API boundary rule** (`01-RESEARCH.md` lines 155-159): package consumer imports through package `exports`; `src/index.ts` re-exports only stable IR and serialization APIs; internal modules remain unreachable unless intentionally exported.

### `src/ir/*.ts` and `src/ir/index.ts` (model/provider, transform/type-contract)

**Analog:** none. Use planning guidance only.

**Required module structure** (`01-RESEARCH.md` lines 161-179):

```text
src/
├── index.ts
├── ir/
│   ├── geometry.ts
│   ├── diagram.ts
│   ├── elements.ts
│   ├── constraints.ts
│   ├── diagnostics.ts
│   └── index.ts
└── serialization/
    ├── canonical.ts
    └── index.ts
test/
├── serialization.test.ts
└── public-api.test.ts
```

**IR type requirements** (`01-CONTEXT.md` lines 30-34):

```markdown
- Define minimal but extensible TypeScript interfaces for diagram intent, normalized diagram, coordinated diagram, nodes, edges, groups, labels, constraints, diagnostics, points, sizes, and boxes.
- Keep rendering-specific details out of the core IR.
- Preserve the prepare/solve/export architecture in naming and type comments.
```

**Type-only IR example** (`01-RESEARCH.md` lines 209-241):

```typescript
export type DiagramDirection = "TB" | "LR" | "BT" | "RL";

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

export interface IntentDiagram {
  id?: string;
  title?: string;
  direction?: DiagramDirection;
  nodes: IntentNode[];
  edges?: IntentEdge[];
  groups?: IntentGroup[];
  constraints?: Constraint[];
}

export interface CoordinatedDiagram {
  id?: string;
  title?: string;
  nodes: CoordinatedNode[];
  edges: CoordinatedEdge[];
  groups?: CoordinatedGroup[];
  diagnostics?: Diagnostic[];
  bounds: Box;
}
```

**Scope guard** (`01-CONTEXT.md` lines 26-28): keep future concerns separated by names, but do not implement text measurement, layout, routing, exporters, preview UI, or CLI behavior in Phase 1.

### `src/serialization/canonical.ts` and `src/serialization/index.ts` (utility/provider, transform/deterministic-serialization)

**Analog:** none. Use planning guidance only.

**Serializer requirements** (`01-CONTEXT.md` lines 36-40):

```markdown
- Stable-sort arrays by ids or deterministic sequence keys.
- Normalize object key ordering.
- Omit `undefined`.
- Make repeated runs byte-stable for equivalent input.
- Round geometry numbers to a documented default precision, initially 3 decimal places.
- Add at least one Phase 1 test proving repeated serialization of equivalent objects produces identical output.
```

**Canonical serializer pattern** (`01-RESEARCH.md` lines 244-258):

```typescript
export const DEFAULT_CANONICAL_PRECISION = 3;

export function stringifyCanonical(value: unknown, precision = DEFAULT_CANONICAL_PRECISION): string {
  return `${JSON.stringify(canonicalize(value, { precision }), null, 2)}\n`;
}
```

**Numeric and JSON edge cases** (`01-RESEARCH.md` lines 292-304, 502-508): recursively canonicalize equivalent objects, reject `NaN` and infinite values, normalize `-0` to `0`, round finite numbers, and operate on JSON-like own enumerable properties only.

### `test/serialization.test.ts` (test, batch/determinism)

**Analog:** none. Use planning guidance only.

**Determinism test pattern** (`01-RESEARCH.md` lines 382-399):

```typescript
import { describe, expect, it } from "vitest";
import { stringifyCanonical } from "../src/index.js";

describe("stringifyCanonical", () => {
  it("sorts equivalent diagram content and rounds geometry", () => {
    const a = {
      nodes: [{ id: "b", box: { x: 2.1239, y: -0, width: 10, height: 4 } }, { id: "a" }],
    };
    const b = {
      nodes: [{ id: "a" }, { id: "b", box: { height: 4, width: 10, y: 0, x: 2.124 } }],
    };

    expect(stringifyCanonical(a)).toBe(stringifyCanonical(b));
  });
});
```

**Requirement mapping** (`01-RESEARCH.md` lines 467-473): this test covers FND-03 and should be runnable through `npm test` and `npm run verify`.

### `test/public-api.test.ts` (test, batch/type-api)

**Analog:** none. Use planning guidance only.

**Public API requirement** (`.planning/REQUIREMENTS.md` lines 12-14): developer can import stable public types for diagram intent, normalized IR, coordinated IR, points, boxes, nodes, edges, labels, and constraints.

**Public API boundary** (`01-RESEARCH.md` lines 181-199, 306-311): test imports should use the public entrypoint, not `src/...`, to avoid consumers depending on internal paths.

### `.gitignore` (config, file-I/O/tooling)

**Analog:** none. This file is implied by generated TypeScript/npm artifacts, not explicitly required in research.

Use it only for scaffold outputs such as `node_modules/`, `dist/`, and coverage if the implementation creates those outputs. Do not use it to hide source or planning artifacts.

## Shared Patterns

### Phase Scope Guard

**Source:** `01-CONTEXT.md` lines 7-9 and `01-RESEARCH.md` lines 69-73.

Apply to all files: Phase 1 is scaffold, public type contracts, serializer, and proof tests only. Do not implement text measurement, shape geometry, Dagre layout, routing, DSL parsing, CLI behavior, SVG, Excalidraw, draw.io, Mermaid, ASCII, UI preview, or renderer logic.

### Prepare/Solve/Export Separation

**Source:** `AGENTS.md` lines 18-23 and `01-RESEARCH.md` lines 147-159.

Apply to IR naming and comments:

```text
Public authoring intent types
  -> normalization-ready IR types
     -> future prepare stage consumes IntentDiagram and emits NormalizedDiagram
        -> future solve stage consumes NormalizedDiagram and emits CoordinatedDiagram
           -> canonical serializer sorts ids/keys and rounds numbers
```

### Renderer-Free Core IR

**Source:** `01-CONTEXT.md` lines 32-34 and `01-RESEARCH.md` lines 263-269.

Apply to all `src/ir/*` files: no SVG attributes, Excalidraw element fields, CSS strings, draw.io XML concepts, Mermaid syntax, HTML fields, or exporter-native geometry. Exporters later map from coordinated IR.

### Verification Commands

**Source:** `01-RESEARCH.md` lines 475-479.

Apply to package scripts and implementation plans:

```markdown
- Per task commit: `npm run typecheck && npm test`
- Per wave merge: `npm run verify`
- Phase gate: full `npm run verify` green and deterministic serializer test present.
```

### Local Shell Rule

**Source:** `AGENTS.md` lines 1-3 and `01-RESEARCH.md` lines 75-78.

Apply to planner and executor shell commands: prefix repo commands with `rtk`.

## No Analog Found

There are no close source-code analogs in this codebase. The planner should use `01-RESEARCH.md`, `01-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `AGENTS.md` as the pattern sources.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `package.json` | config | batch/tooling | No package scaffold exists. |
| `package-lock.json` | config | batch/tooling | No npm lockfile exists. |
| `tsconfig.json` | config | batch/tooling | No TypeScript config exists. |
| `tsconfig.build.json` | config | batch/tooling | No TypeScript config exists. |
| `tsup.config.ts` | config | batch/tooling | No build config exists. |
| `vitest.config.ts` | config | batch/tooling | No test config exists. |
| `biome.json` | config | batch/tooling | No lint config exists. |
| `src/index.ts` | provider | transform/public-api | No source tree exists. |
| `src/ir/geometry.ts` | model | transform/type-contract | No source tree exists. |
| `src/ir/diagram.ts` | model | transform/type-contract | No source tree exists. |
| `src/ir/elements.ts` | model | transform/type-contract | No source tree exists. |
| `src/ir/constraints.ts` | model | transform/type-contract | No source tree exists. |
| `src/ir/diagnostics.ts` | model | transform/type-contract | No source tree exists. |
| `src/ir/index.ts` | provider | transform/public-api | No source tree exists. |
| `src/serialization/canonical.ts` | utility | transform/deterministic-serialization | No source tree exists. |
| `src/serialization/index.ts` | provider | transform/public-api | No source tree exists. |
| `test/serialization.test.ts` | test | batch/determinism | No test tree exists. |
| `test/public-api.test.ts` | test | batch/type-api | No test tree exists. |
| `.gitignore` | config | file-I/O/tooling | No existing ignore file exists; file is implied by scaffold outputs. |

## Metadata

**Analog search scope:** repository root, including hidden files via `rtk rg --files -uu`; local project skill directories `.codex`, `.claude`, and `.agents`.

**Files scanned:** 15 non-git workspace files visible through `rtk rg --files -uu`.

**Project skills:** none found locally; `AGENTS.md` says no project skills are present.

**Pattern extraction date:** 2026-05-24
