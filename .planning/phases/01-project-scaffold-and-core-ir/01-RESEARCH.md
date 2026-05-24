# Phase 1: Project Scaffold And Core IR - Research

**Researched:** 2026-05-24
**Domain:** TypeScript package scaffold, public IR contracts, deterministic serialization
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

## Implementation Decisions

### Toolchain Baseline

- **D-01:** Use a single TypeScript package for v1 rather than a monorepo. The project can split packages later after core IR and CLI boundaries prove stable.
- **D-02:** Use npm for the initial lockfile and scripts unless dependency installation in the environment strongly favors pnpm during planning.
- **D-03:** Use `tsup` for distributable library/CLI bundling and keep `tsc --noEmit` as the explicit typecheck gate.
- **D-04:** Use Vitest for the first test suite because Phase 1 needs fast TypeScript unit tests and deterministic fixture checks.
- **D-05:** Use Biome or oxlint for linting; planner may choose the lower-friction option, but Phase 1 must expose a runnable lint command.

### Source Module Boundaries

- **D-06:** Start with clear module boundaries inside one package: shared IR/types, deterministic serialization utilities, and public entrypoints.
- **D-07:** Keep future concerns separated by module names even if Phase 1 only implements the IR and serializer. Expected future boundaries are DSL parsing, geometry, layout, routing, exporters, and CLI.
- **D-08:** Do not create a UI, preview app, or renderer surface in Phase 1. Export and CLI implementation belong to later phases.

### Public IR Types

- **D-09:** Define minimal but extensible TypeScript interfaces for diagram intent, normalized diagram, coordinated diagram, nodes, edges, groups, labels, constraints, diagnostics, points, sizes, and boxes.
- **D-10:** Keep rendering-specific details out of the core IR. Exporters may later map coordinated IR into SVG, Excalidraw, draw.io, Mermaid, or ASCII formats.
- **D-11:** Preserve the prepare/solve/export architecture in naming and type comments so later phases do not collapse measurement, layout, and serialization into one mixed layer.

### Deterministic Serialization

- **D-12:** Provide a canonical serializer for normalized and coordinated outputs. It must stable-sort arrays by ids or deterministic sequence keys, normalize object key ordering, omit `undefined`, and make repeated runs byte-stable for equivalent input.
- **D-13:** Round geometry numbers to a documented default precision in canonical serialized output. Use 3 decimal places initially; planner may add a named constant so later phases can tune this without touching every call site.
- **D-14:** Add at least one Phase 1 test proving repeated serialization of equivalent objects produces identical output.

### the agent's Discretion

- Exact directory names are flexible if they preserve the boundaries above and expose a clean public import path.
- Exact lint tool is flexible between Biome and oxlint if the chosen tool has a working script and does not slow down Phase 1.
- Exact package metadata fields are flexible, but the package should be clearly positioned as a TypeScript geometry engine rather than a renderer.

### Claude's Discretion

- Exact directory names are flexible if they preserve the boundaries above and expose a clean public import path.
- Exact lint tool is flexible between Biome and oxlint if the chosen tool has a working script and does not slow down Phase 1.
- Exact package metadata fields are flexible, but the package should be clearly positioned as a TypeScript geometry engine rather than a renderer.

### Deferred Ideas (OUT OF SCOPE)

None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | Developer can install project dependencies and run TypeScript build, tests, and lint commands locally. | Use npm single-package scaffold with local devDependencies, `tsup` build, `tsc --noEmit` typecheck, Vitest tests, and Biome lint/check scripts. [VERIFIED: npm registry] [CITED: tsup.egoist.dev] [CITED: vitest.dev] [CITED: biomejs.dev] |
| FND-02 | Developer can import stable public types for diagram intent, normalized IR, coordinated IR, points, boxes, nodes, edges, labels, and constraints. | Use explicit package `exports` and a public `src/index.ts` re-exporting IR/type modules; keep renderer/exporter fields out of core types. [CITED: nodejs.org/api/packages.html] [VERIFIED: .planning/REQUIREMENTS.md] |
| FND-03 | The engine serializes numeric output deterministically with stable ordering and documented rounding rules. | Implement a project-owned canonical serializer that sorts object keys and arrays, omits `undefined`, rejects or documents unsupported JSON values, and rounds finite numbers to `DEFAULT_CANONICAL_PRECISION = 3`. [CITED: developer.mozilla.org JSON.stringify] [VERIFIED: 01-CONTEXT.md] |
</phase_requirements>

## Summary

Phase 1 should create the smallest durable TypeScript package foundation: npm lockfile, strict TypeScript config, tsup distribution build, Vitest test harness, Biome lint/check command, public IR type modules, and a deterministic canonical serializer. The repository currently has no source scaffold or test infrastructure, so Wave 0 must create all package files before feature tasks can be sliced. [VERIFIED: repo scan] [VERIFIED: AGENTS.md]

The main planning risk is scope creep. The type surface must name future boundaries, but Phase 1 must not implement text measurement, Dagre layout, DSL parsing, CLI behavior, geometry math, routing, SVG, Excalidraw, draw.io, Mermaid, ASCII, or UI preview. [VERIFIED: 01-CONTEXT.md] [VERIFIED: .planning/ROADMAP.md]

**Primary recommendation:** Plan one package with `src/ir`, `src/serialization`, `src/index.ts`, `test/`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `tsup.config.ts`, `vitest.config.ts`, and `biome.json`; prove the scaffold through `npm run typecheck`, `npm run build`, `npm test`, and `npm run lint`. [VERIFIED: npm registry] [CITED: npmjs.com package.json docs]

## Project Constraints (from AGENTS.md)

- Prefix shell commands with `rtk`. [VERIFIED: AGENTS.md] [VERIFIED: /home/zhangyangrui/.codex/RTK.md]
- Work through GSD workflow for file-changing work; this research file is part of requested GSD phase research output. [VERIFIED: AGENTS.md]
- Runtime is TypeScript on Node.js first. [VERIFIED: AGENTS.md]
- Architecture must preserve prepare/solve/export separation. [VERIFIED: AGENTS.md]
- Deterministic outputs are required for tests and agent repeatability. [VERIFIED: AGENTS.md]
- Text measurement must be abstracted behind an interface in later phases; Phase 1 should not hardwire Pretext into IR. [VERIFIED: AGENTS.md]
- Golden-quality tests later must catch text overflow, connector misalignment, collisions, non-deterministic output, and malformed exports; Phase 1 only needs the initial deterministic serializer proof. [VERIFIED: AGENTS.md] [VERIFIED: .planning/ROADMAP.md]
- v1 scope focuses on core library, CLI, SVG, Excalidraw, and enough layout/routing for real architecture and flow diagrams, but Phase 1 only creates foundations. [VERIFIED: AGENTS.md] [VERIFIED: 01-CONTEXT.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Package scaffold and scripts | Node.js package/tooling | CI shell | Local npm scripts own build/test/lint entrypoints; no runtime app tier exists yet. [VERIFIED: .planning/ROADMAP.md] |
| Public IR type contracts | Core library | Export adapters later | Core IR is the stable boundary later modules consume; exporters must map from coordinated IR instead of shaping core types around output formats. [VERIFIED: .planning/research/ARCHITECTURE.md] |
| Canonical serialization | Core library | Test fixtures | Serialization defines byte-stable snapshots for normalized/coordinated outputs and should not belong to exporters. [VERIFIED: 01-CONTEXT.md] |
| Verification commands | Tooling/test harness | Core library tests | Phase 1 must expose commands and at least one determinism test; implementation logic remains small. [VERIFIED: .planning/REQUIREMENTS.md] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typescript` | 6.0.3, modified 2026-04-16 | Static typing and declaration generation | Required for public IR contracts and strict geometry types. [VERIFIED: npm registry] |
| `tsup` | 8.5.1, modified 2025-11-12 | Library bundling to ESM/CJS and declarations | tsup supports multiple bundle formats and declaration output; keep `tsc --noEmit` as correctness gate. [VERIFIED: npm registry] [CITED: tsup.egoist.dev] |
| `vitest` | 4.1.7, modified 2026-05-20 | Unit tests and determinism tests | Vitest is TS-native, fast, and documents explicit imports/globals behavior. [VERIFIED: npm registry] [CITED: vitest.dev] |
| `@biomejs/biome` | 2.4.15, modified 2026-05-09 | Lint/format/check command | Biome provides one CLI for format, lint, and check; lower setup friction than pairing multiple tools. [VERIFIED: npm registry] [CITED: biomejs.dev] |
| `@types/node` | 25.9.1, modified 2026-05-19 | Node typings for package/test config | Needed for Node-targeted configs and future CLI foundation. [VERIFIED: npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@chenglou/pretext` | 0.0.7, modified 2026-05-10 | Future default text measurement backend | Do not install in Phase 1 unless needed for type comments; Phase 2 owns measurement. [VERIFIED: npm registry] [VERIFIED: 01-CONTEXT.md] |
| `@dagrejs/dagre` | 3.0.0, modified 2026-03-22 | Future directed graph layout | Do not install in Phase 1; Phase 3 owns layout. [VERIFIED: npm registry] [VERIFIED: .planning/ROADMAP.md] |
| `oxlint` | 1.66.0, modified 2026-05-19 | Alternative lint command | Use only if Biome causes friction; Phase 1 needs one runnable lint command, not both. [VERIFIED: npm registry] [VERIFIED: 01-CONTEXT.md] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| npm | pnpm | pnpm is installed locally, but user decision defaults to npm unless the environment strongly favors pnpm; choose npm for the initial lockfile. [VERIFIED: environment] [VERIFIED: 01-CONTEXT.md] |
| tsup | plain `tsc` emit | `tsc` is still required for `--noEmit`; tsup provides package bundling and future CLI bundling with less config. [CITED: tsup.egoist.dev] |
| Biome | oxlint | oxlint is current and fast, but Biome covers lint plus formatting/check in one dependency. [VERIFIED: npm registry] [CITED: biomejs.dev] |
| Runtime validators | Zod/Ajv/JSON Schema | Defer until DSL phase; Phase 1 public TypeScript types do not need runtime input validation. [VERIFIED: .planning/ROADMAP.md] |

**Installation:**

```bash
npm install -D typescript tsup vitest @biomejs/biome @types/node
```

**Version verification commands run:**

```bash
npm view typescript version time.modified dist-tags.latest
npm view tsup version time.modified dist-tags.latest
npm view vitest version time.modified dist-tags.latest
npm view @biomejs/biome version time.modified dist-tags.latest
npm view @types/node version time.modified dist-tags.latest
npm view @chenglou/pretext version time.modified dist-tags.latest
npm view @dagrejs/dagre version time.modified dist-tags.latest
npm view oxlint version time.modified dist-tags.latest
```

## Architecture Patterns

### System Architecture Diagram

```text
Public authoring intent types
  -> normalization-ready IR types
     -> future prepare stage consumes IntentDiagram and emits NormalizedDiagram
        -> future solve stage consumes NormalizedDiagram and emits CoordinatedDiagram
           -> canonical serializer sorts ids/keys and rounds numbers
              -> byte-stable JSON string for tests, snapshots, and exporter fixtures

Package consumer
  -> package "exports" public entrypoint
     -> src/index.ts re-exports only stable IR and serialization APIs
        -> internal modules remain unreachable unless explicitly exported
```

### Recommended Project Structure

```text
src/
├── index.ts              # public package entrypoint
├── ir/
│   ├── geometry.ts       # Point, Size, Box, Insets, Direction
│   ├── diagram.ts        # IntentDiagram, NormalizedDiagram, CoordinatedDiagram
│   ├── elements.ts       # node, edge, group, label, anchor types
│   ├── constraints.ts    # exact, relative, align, distribute, containment constraint types
│   ├── diagnostics.ts    # Diagnostic severity/code/path/message
│   └── index.ts          # IR barrel
└── serialization/
    ├── canonical.ts      # canonicalize + stringifyCanonical
    └── index.ts
test/
├── serialization.test.ts
└── public-api.test.ts
```

### Pattern 1: Public Entrypoint With Explicit Exports

**What:** Put stable public types behind `src/index.ts` and package `exports`; do not expose internal future folders by accident.

**When to use:** Always in Phase 1, because FND-02 is about stable import boundaries.

**Example:**

```typescript
// Source: Node package exports docs + DGE Phase 1 context
export * from "./ir/index.js";
export {
  DEFAULT_CANONICAL_PRECISION,
  canonicalize,
  stringifyCanonical,
} from "./serialization/index.js";
```

Node and npm document `exports` as the modern way to define public package entrypoints and prevent unlisted subpaths from being imported. [CITED: nodejs.org/api/packages.html] [CITED: docs.npmjs.com package.json]

### Pattern 2: Type-Only IR, No Runtime Geometry

**What:** Define discriminated unions and interfaces for intent, normalized, and coordinated data while keeping algorithms out.

**When to use:** Phase 1 must establish contracts without implementing future solvers.

**Example:**

```typescript
// Source: Phase 1 requirements and architecture docs
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

### Pattern 3: Canonical Serialization As Project Code

**What:** Implement a deterministic canonicalization pass before `JSON.stringify`: recursively omit `undefined`, sort object keys lexicographically, normalize arrays with domain-specific id/sequence sorting, and round finite numbers.

**When to use:** For normalized and coordinated output snapshots and fixture generation.

**Example:**

```typescript
// Source: MDN JSON.stringify behavior + Phase 1 deterministic serializer decision
export const DEFAULT_CANONICAL_PRECISION = 3;

export function stringifyCanonical(value: unknown, precision = DEFAULT_CANONICAL_PRECISION): string {
  return `${JSON.stringify(canonicalize(value, { precision }), null, 2)}\n`;
}
```

`JSON.stringify` has stable behavior for the same object key order, but equivalent objects created with different insertion orders still need an explicit key-sort normalization step. [CITED: developer.mozilla.org JSON.stringify] [VERIFIED: 01-CONTEXT.md]

### Anti-Patterns to Avoid

- **Renderer-shaped IR:** Do not add SVG attributes, Excalidraw element fields, CSS strings, or draw.io XML concepts to core IR. Export adapters own those later. [VERIFIED: .planning/research/PITFALLS.md]
- **Installing future algorithm dependencies now:** Do not add Pretext or Dagre to Phase 1 unless a test genuinely needs them; later phases own them. [VERIFIED: .planning/ROADMAP.md]
- **Plain `JSON.stringify` as the determinism contract:** It is stable for a given object order, but it does not sort equivalent object shapes by itself. Use project-owned canonicalization. [CITED: developer.mozilla.org JSON.stringify]
- **Array order by insertion accident:** Sort known unordered collections such as nodes, edges, groups, constraints, labels, diagnostics, and anchors by explicit identity or sequence rules where semantic order permits; preserve semantic coordinate/path arrays such as edge `points` in authored/solved order. [VERIFIED: 01-CONTEXT.md]
- **One mixed `types.ts` file for everything:** It may be quicker, but it hides future boundaries and encourages measurement/layout/export leakage. [VERIFIED: 01-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TS package bundling | Custom esbuild scripts | `tsup` | Supports multiple formats and declaration output with minimal config. [CITED: tsup.egoist.dev] |
| Test runner | Ad hoc node script | Vitest | Provides standard TS test discovery and assertions. [CITED: vitest.dev] |
| Lint/format command | Custom grep/regex checks | Biome | One maintained CLI handles format/lint/check. [CITED: biomejs.dev] |
| Text measurement | Homemade canvas/text math | Pretext in Phase 2 | Project research identifies multilingual text measurement as complex and already solved by Pretext. [VERIFIED: dge-research-report.md] |
| Directed graph layout | Custom ranker | Dagre in Phase 3 | Project research selected Dagre for directed graph layout. [VERIFIED: .planning/research/STACK.md] |

**Key insight:** Phase 1's custom code should be limited to domain contracts and canonical serialization. Tooling, testing, formatting, text measurement, and graph layout already have standard dependencies or later phase owners. [VERIFIED: 01-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Scaffold Without a Typecheck Gate

**What goes wrong:** `tsup` emits output, but public types still contain errors or declaration problems.
**Why it happens:** Bundlers optimize emit; TypeScript correctness needs an explicit compiler run.
**How to avoid:** Add `typecheck: "tsc --noEmit"` and make `build` either depend on it or document `npm run verify` that runs typecheck/build/test/lint.
**Warning signs:** CI/build passes while editor shows TS errors. [VERIFIED: 01-CONTEXT.md] [CITED: tsup.egoist.dev]

### Pitfall 2: Non-Canonical Deep Equivalence

**What goes wrong:** Two semantically equivalent diagrams produce different snapshots because object insertion order or array order differs.
**Why it happens:** `JSON.stringify` follows object key order rather than imposing domain sorting.
**How to avoid:** Canonicalize recursively; stable-sort recognized arrays by `id`, then `sourceId/targetId`, then explicit `sequence` where present.
**Warning signs:** Tests pass when data is constructed one way but fail after harmless refactors. [CITED: developer.mozilla.org JSON.stringify]

### Pitfall 3: Numeric Edge Cases

**What goes wrong:** `NaN`, `Infinity`, `-0`, or floating residue leak into JSON and confuse fixture diffs.
**Why it happens:** JavaScript number serialization has special cases and geometry math later will produce tiny floating differences.
**How to avoid:** In canonical serializer, reject non-finite numbers, normalize `-0` to `0`, and round finite numbers to 3 decimal places by default.
**Warning signs:** Snapshot contains `null` where a number was expected, or repeated math yields `1.0000000000002`. [VERIFIED: 01-CONTEXT.md]

### Pitfall 4: Public API Too Broad Too Early

**What goes wrong:** Consumers import internal module paths, making later reorganization breaking.
**Why it happens:** Package `exports` is omitted or uses broad wildcard patterns.
**How to avoid:** Export `"."` initially, and only add subpath exports for intentionally stable surfaces.
**Warning signs:** Tests import from `src/...` instead of package entrypoint. [CITED: nodejs.org/api/packages.html]

### Pitfall 5: Renderer Creep

**What goes wrong:** IR includes visual/render details before geometry contracts settle.
**Why it happens:** SVG/Excalidraw examples are tempting during type design.
**How to avoid:** Keep styling as minimal semantic tokens or metadata placeholders; do not model exporter-native fields in Phase 1.
**Warning signs:** Types mention SVG, XML, Excalidraw, Mermaid, HTML, or CSS. [VERIFIED: .planning/research/PITFALLS.md]

## Code Examples

### Package Scripts

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

Source: tsup supports multiple formats and declaration output; Vitest supports `vitest run`; Biome documents `check`/`ci` style validation. [CITED: tsup.egoist.dev] [CITED: vitest.dev] [CITED: biomejs.dev]

### Package Exports

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

Source: Node documents `type`, `exports`, conditional exports, and public entrypoint encapsulation; npm documents `files`, `bin`, `devDependencies`, and `engines`. [CITED: nodejs.org/api/packages.html] [CITED: docs.npmjs.com package.json]

### Strict TypeScript Baseline

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

Source: TypeScript documents strict-related options, declaration maps, and module resolution guidance. [CITED: typescriptlang.org/tsconfig] [CITED: typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options]

### Determinism Test Shape

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

Source: Vitest writing-tests docs and Phase 1 D-14. [CITED: vitest.dev] [VERIFIED: 01-CONTEXT.md]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Unscoped `main` entrypoint only | Package `exports` with explicit public API | Node added modern exports support in Node 12 era and recommends it for new packages | Planner should include `exports` from the initial package. [CITED: nodejs.org/api/packages.html] |
| Bundler-only confidence | Bundler plus `tsc --noEmit` | Current tsup docs warn declaration output should still be type-checked | Planner should make typecheck a separate required command. [CITED: tsup.egoist.dev] |
| Formatting and linting as separate toolchains | Biome single CLI for format/lint/check | Biome current docs position it as one CLI for web project checks | Planner can keep Phase 1 lint setup simple. [CITED: biomejs.dev] |

**Deprecated/outdated:**

- Graphviz subprocess-first layout: out of scope because project stack explicitly chose TypeScript-native Pretext and Dagre first. [VERIFIED: .planning/research/STACK.md]
- Browser-only measurement in core: out of scope because measurement must work in CLI tests and belongs behind an interface later. [VERIFIED: AGENTS.md]
- Monorepo package split in Phase 1: out of scope by D-01. [VERIFIED: 01-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 1 package metadata uses the locked local package name `diagram-geometry-engine`. [RESOLVED] | Standard Stack / Code Examples | A later publishing phase may still decide a scoped npm name, but Phase 1 plans and tests should not treat the local package name as unresolved. |
| A2 | `moduleResolution: "Bundler"` is acceptable for this library because tsup is the build tool and Node runtime execution goes through emitted `dist` files. [ASSUMED] | Code Examples | If direct Node execution of TS source is required, planner may need `NodeNext` instead. |

## Open Questions (RESOLVED)

1. **Final package name**
   - What we know: Project name is Diagram Geometry Engine and code name is Pretext for Graphics. [VERIFIED: AGENTS.md]
   - Resolution: Phase 1 uses package name `diagram-geometry-engine`.
   - Impact on plans: `package.json` must use `"name": "diagram-geometry-engine"` and public import tests should keep using the root package entrypoint shape.

2. **Public subpath exports**
   - What we know: Phase 1 needs clean public import boundaries. [VERIFIED: 01-CONTEXT.md]
   - Resolution: Phase 1 exposes root `"."` only.
   - Impact on plans: Do not add `./ir`, `./serialization`, wildcard, or other public subpath exports in Phase 1.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Runtime/build/test | yes | v24.13.0 | Project supports Node 20+; current environment exceeds baseline. [VERIFIED: environment] |
| npm | Package install/scripts | yes | 10.9.7 | pnpm exists, but user decision prefers npm. [VERIFIED: environment] |
| pnpm | Optional package manager | yes | path found | Do not use unless npm install fails. [VERIFIED: environment] |
| TypeScript CLI | Typecheck after install | globally found | via pnpm shim | Use local devDependency through `npm run typecheck`. [VERIFIED: environment] |
| Vitest CLI | Tests | no global command | — | Install as devDependency and call via npm script. [VERIFIED: environment] |
| tsup CLI | Build | no global command | — | Install as devDependency and call via npm script. [VERIFIED: environment] |

**Missing dependencies with no fallback:**

- None for planning; Phase 1 implementation must install local devDependencies. [VERIFIED: environment]

**Missing dependencies with fallback:**

- Global `vitest` and `tsup` are absent; local devDependency scripts are the correct fallback. [VERIFIED: environment]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.7 [VERIFIED: npm registry] |
| Config file | none currently; create `vitest.config.ts` in Wave 0 [VERIFIED: repo scan] |
| Quick run command | `npm test -- --runInBand` or `npm test` for small suite |
| Full suite command | `npm run verify` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| FND-01 | Build, typecheck, test, and lint scripts run locally | smoke/tooling | `npm run verify` | no, Wave 0 |
| FND-02 | Public package entrypoint exports IR types | type/unit | `npm run typecheck` and optional `test/public-api.test.ts` | no, Wave 0 |
| FND-03 | Canonical serializer is byte-stable and rounds numbers | unit | `npm test -- serialization` | no, Wave 0 |

### Sampling Rate

- **Per task commit:** `npm run typecheck && npm test`
- **Per wave merge:** `npm run verify`
- **Phase gate:** Full `npm run verify` green and deterministic serializer test present.

### Wave 0 Gaps

- [ ] `package.json` and `package-lock.json` for npm single-package scaffold.
- [ ] `tsconfig.json` and `tsconfig.build.json` for strict compile/typecheck.
- [ ] `tsup.config.ts` or package script build definition.
- [ ] `vitest.config.ts` and `test/serialization.test.ts`.
- [ ] `biome.json` and `npm run lint`.
- [ ] `src/index.ts`, `src/ir/*`, and `src/serialization/*`.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | No auth surface in Phase 1. [VERIFIED: phase scope] |
| V3 Session Management | no | No session surface in Phase 1. [VERIFIED: phase scope] |
| V4 Access Control | no | No user/resource access layer in Phase 1. [VERIFIED: phase scope] |
| V5 Input Validation | partial | TypeScript compile-time contracts only; runtime validation deferred to DSL phase. [VERIFIED: .planning/ROADMAP.md] |
| V6 Cryptography | no | No crypto surface in Phase 1. [VERIFIED: phase scope] |

### Known Threat Patterns for TypeScript Package Scaffold

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Dependency confusion or accidental publish surface | Tampering | Use explicit package name, lockfile, `files`, and package `exports`; do not publish during Phase 1. [CITED: docs.npmjs.com package.json] |
| Prototype pollution via serializer input | Tampering | Canonicalizer should operate on JSON-like plain values, ignore prototypes, and use `Object.keys`/own enumerable properties only. [CITED: developer.mozilla.org JSON.stringify] |
| Non-finite numeric output masquerading as valid JSON | Tampering/Integrity | Reject `NaN` and infinite values before JSON serialization. [VERIFIED: Phase 1 requirement FND-03] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/01-project-scaffold-and-core-ir/01-CONTEXT.md` - locked Phase 1 decisions and scope.
- `.planning/REQUIREMENTS.md` - FND-01, FND-02, FND-03.
- `.planning/ROADMAP.md` - Phase 1 goal and success criteria.
- `.planning/STATE.md` - preserved decisions and open Phase 1 questions.
- `.planning/research/STACK.md` - TypeScript, Node, tsup/Vitest/Biome baseline and future Pretext/Dagre positioning.
- `.planning/research/ARCHITECTURE.md` - prepare/solve/export flow and component boundaries.
- `.planning/research/PITFALLS.md` - renderer creep and determinism pitfalls.
- `dge-research-report.md` - Pretext/TypeScript rationale and future dependency rationale.
- `diagram-geometry-engine-design.md` - original IR and architecture framing.
- npm registry via `npm view` - current versions for TypeScript, tsup, Vitest, Biome, Node types, Pretext, Dagre, oxlint.

### Primary Web / Official Docs (HIGH confidence)

- https://nodejs.org/api/packages.html - `type`, `exports`, conditional exports, imports, package entrypoints.
- https://docs.npmjs.com/cli/v11/configuring-npm/package-json/ - `files`, `exports`, `bin`, `devDependencies`, `engines`.
- https://tsup.egoist.dev/ - tsup formats and declaration output.
- https://vitest.dev/guide/learn/writing-tests - Vitest test patterns and global import behavior.
- https://vitest.dev/config/globals - Vitest globals config details.
- https://biomejs.dev/guides/getting-started/ - Biome init/check/lint/format commands and CI note.
- https://www.typescriptlang.org/tsconfig/ - TypeScript strict options, declaration/source map configuration.
- https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options - TypeScript module option guidance.
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify - JSON serialization order and enumerable own property behavior.

### Secondary (MEDIUM confidence)

- None needed.

### Tertiary (LOW confidence)

- None used.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - Current package versions verified with npm registry and constrained by Phase 1 decisions.
- Architecture: HIGH - Project docs and context agree on prepare/solve/export separation and Phase 1 scope.
- Pitfalls: HIGH - Determinism and renderer creep are repeated in AGENTS.md, Phase context, and pitfalls research.

**Research date:** 2026-05-24
**Valid until:** 2026-06-23 for package versions; architectural constraints remain valid until Phase 1 decisions change.
