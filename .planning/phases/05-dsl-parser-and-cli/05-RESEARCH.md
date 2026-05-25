# Phase 05: DSL Parser And CLI - Research

**Researched:** 2026-05-25 [VERIFIED: system current_date and init.phase-op]
**Domain:** Node 20 TypeScript YAML/JSON DSL parsing, validation diagnostics, and CLI execution surface [VERIFIED: .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md]
**Confidence:** HIGH for stack and architecture, MEDIUM for exact parser helper names because implementation names are still discretionary [VERIFIED: npm registry, Context7 docs, repo inspection]

<user_constraints>
## User Constraints (from CONTEXT.md)

Source: `.planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md` [VERIFIED: repo inspection]

### Locked Decisions
## Implementation Decisions

### DSL Expression Shape

- **D-01:** Phase 5 should use an agent-friendly shorthand DSL as the primary authoring surface. YAML and JSON are both supported, but examples should primarily use YAML because it is easier for humans and LLMs to write.
- **D-02:** The DSL should normalize into existing IR instead of becoming a second semantic model. Parser output should flow toward `IntentDiagram`/`NormalizedDiagram`, then `solveDiagram()`, then exporters.
- **D-03:** Nodes should be authored as an object map keyed by stable node id, for example `nodes: { api: { label: "API", shape: rectangle } }`.
- **D-04:** Edges may use string shorthand such as `api -> db` and `web -> api: calls`. This shorthand must expand into structured source/target/label data during parsing.
- **D-05:** DSL may include optional output defaults such as `output.format: svg`, but CLI flags override DSL output settings.

### Constraints And Layout Syntax

- **D-06:** Fixed node positions should be expressed inline on nodes, for example `nodes.api.position: { x: 100, y: 80 }`, matching the existing `IntentNode.position` field.
- **D-07:** Relative, alignment, and distribution constraints should use structured objects rather than free-form string expressions. This keeps validation and path-specific diagnostics straightforward.
- **D-08:** Group definitions are the primary containment semantic source, for example `groups.backend.nodes: [api, db]`. Planning may normalize group membership into the existing group and containment behavior as needed.
- **D-09:** Layout and routing should support top-level defaults such as `layout.direction: LR` and `routing.kind: orthogonal`, with per-edge overrides where needed.

### Error Output And Diagnostics

- **D-10:** Default CLI errors should be human-readable on stderr, with a clear summary, relevant DSL path, and repair hint when practical.
- **D-11:** Provide `--json` for machine-readable output of errors and diagnostics so coding agents and automation can consume failures deterministically.
- **D-12:** Use a layered error model: `parse`, `validate`, `solve`, and `export`. This helps users understand whether the problem is syntax, DSL semantics, geometry solving, or output generation.
- **D-13:** Warning diagnostics do not block output. Error diagnostics block output and return a non-zero exit code.

### CLI Command Behavior

- **D-14:** Use `dge` as the package binary and command name.
- **D-15:** Use Unix-friendly IO behavior: no `--input` means read stdin; no `--output` means write output content to stdout; diagnostics go to stderr.
- **D-16:** Output files may be overwritten by default, but implementation must avoid leaving partial or truncated files on failure.
- **D-17:** Default output format is `svg`. DSL `output.format` may set another default, and CLI `--format` takes precedence.

### the agent's Discretion

- The planner may choose exact parser module boundaries and helper names, provided the DSL remains a thin authoring layer over existing IR and solving/exporting APIs.
- The planner may choose a YAML parsing dependency after research, but it should favor maintained, deterministic, Node 20-compatible packages.
- The planner may choose exact exit code numbers if they are documented in tests and distinguish success from failure.
- The planner may decide whether edge shorthand parsing is implemented in the first parser plan or in a separate sugar-focused plan, but Phase 5 must finish with the shorthand supported.

### Claude's Discretion
- The planner may choose exact parser module boundaries and helper names, provided the DSL remains a thin authoring layer over existing IR and solving/exporting APIs.
- The planner may choose a YAML parsing dependency after research, but it should favor maintained, deterministic, Node 20-compatible packages.
- The planner may choose exact exit code numbers if they are documented in tests and distinguish success from failure.
- The planner may decide whether edge shorthand parsing is implemented in the first parser plan or in a separate sugar-focused plan, but Phase 5 must finish with the shorthand supported.

### Deferred Ideas (OUT OF SCOPE)
## Deferred Ideas

- draw.io/mxGraph XML export remains a v2 exporter requirement.
- Mermaid and ASCII/Unicode exports remain future exporter work.
- Browser preview and visual review UI remain out of scope for Phase 5.
- Rich style API and theme configuration remain deferred until the basic DSL/CLI path is stable.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DSL-01 | User can define a diagram in YAML or JSON with title, direction, nodes, edges, groups, constraints, and output settings. [VERIFIED: .planning/REQUIREMENTS.md] | Use `yaml@2.9.0` for YAML and `JSON.parse` for JSON, then validate with `zod@4.4.3` and normalize to existing IR. [VERIFIED: npm registry; Context7 `/eemeli/yaml`; Context7 `/colinhacks/zod`; src/ir/diagram.ts] |
| DSL-02 | User receives actionable validation errors for malformed DSL, missing node references, unsupported shapes, and invalid constraints. [VERIFIED: .planning/REQUIREMENTS.md] | Use YAML parser `errors`/`warnings` with line positions for syntax failures and Zod `issues[].path` plus custom semantic reference checks for DSL validation. [CITED: https://github.com/eemeli/yaml/blob/main/docs/04_documents.md; CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx] |
| DSL-03 | User can express fixed positions, relative offsets, alignment, distribution, and grouped containment in the DSL. [VERIFIED: .planning/REQUIREMENTS.md] | Map DSL fields directly to existing `IntentNode.position` and `Constraint` variants: `exact-position`, `relative-position`, `align`, `distribute`, and `containment`. [VERIFIED: src/ir/elements.ts; src/ir/constraints.ts] |
| CLI-01 | User can run `dge --input diagram.yaml --format svg --output diagram.svg`. [VERIFIED: .planning/REQUIREMENTS.md] | Add package `bin.dge`, a tsup CLI entry, and Commander options for `--input`, `--format`, `--output`, and `--json`. [VERIFIED: package.json; tsup.config.ts; VERIFIED: npm registry commander@14.0.3] |
| CLI-02 | User can pipe DSL into the CLI and write SVG or Excalidraw JSON to stdout. [VERIFIED: .planning/REQUIREMENTS.md] | Implement stdin fallback when `--input` is absent and stdout fallback when `--output` is absent; route diagnostics to stderr. [VERIFIED: .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md] |
| CLI-03 | CLI exits non-zero with readable errors for invalid input, unsatisfied constraints, and unsupported formats. [VERIFIED: .planning/REQUIREMENTS.md] | Use layered diagnostics with blocking `error` severity; document and test exit codes for parse, validate, solve, export, and IO failures. [VERIFIED: src/ir/diagnostics.ts; .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md] |
</phase_requirements>

## Summary

Phase 5 should add a thin authoring and execution layer over the existing DGE pipeline: read YAML or JSON, parse into an untrusted DSL value, validate and normalize toward existing `IntentDiagram` / `NormalizedDiagram`, call `solveDiagram()`, then call `exportSvg()` or `exportExcalidraw()`. [VERIFIED: .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md; src/ir/diagram.ts; src/solver/solve.ts; src/exporters/svg.ts; src/exporters/excalidraw.ts]

Use `yaml@2.9.0`, `zod@4.4.3`, and `commander@14.0.3` as the Phase 5 standard stack. [VERIFIED: npm registry 2026-05-25; Context7 `/eemeli/yaml`; Context7 `/colinhacks/zod`; Context7 `/tj/commander.js`] `yaml` provides parser diagnostics without throwing for valid string/options inputs, `zod` gives TypeScript-native validation issues with paths, and Commander gives small Node CLI option parsing plus controllable output and exit behavior. [CITED: https://github.com/eemeli/yaml/blob/main/docs/04_documents.md; CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx; CITED: https://github.com/tj/commander.js/blob/master/Readme.md]

The planner should split implementation into parser/diagnostics, normalization/semantic validation, CLI IO/export orchestration, examples/fixtures, and verification. [VERIFIED: existing repo module boundaries and tests] The highest-risk mistake is letting the DSL or CLI recompute geometry; Phase 5 should add tests or grep guards proving `src/dsl/` and `src/cli/` call the existing pipeline rather than duplicating solver/exporter logic. [VERIFIED: .planning/research/PITFALLS.md; test/exporters.test.ts]

**Primary recommendation:** Implement `src/dsl/parse.ts`, `src/dsl/schema.ts`, `src/dsl/normalize.ts`, `src/cli/run.ts`, and `src/cli/index.ts`; wire `bin.dge` to the CLI entry; use examples and CLI integration tests as the acceptance proof. [VERIFIED: package.json; tsup.config.ts; src/index.ts]

## Project Constraints (from AGENTS.md)

- Shell commands in this repo must be prefixed with `rtk`. [VERIFIED: AGENTS.md; /home/zhangyangrui/.codex/RTK.md]
- Runtime is TypeScript on Node.js first. [VERIFIED: AGENTS.md; package.json]
- Architecture must preserve prepare/solve/export separation. [VERIFIED: AGENTS.md; .planning/research/ARCHITECTURE.md]
- The same input must produce byte-stable or numerically stable output. [VERIFIED: AGENTS.md; src/serialization/canonical.ts]
- Text measurement must stay abstracted behind an interface. [VERIFIED: AGENTS.md; src/text/types.ts]
- Golden tests must catch overflow, connector misalignment, collisions, non-deterministic output, and malformed exports. [VERIFIED: AGENTS.md; test/fixtures]
- v1 scope is core library, CLI, SVG, Excalidraw, and enough layout/routing for architecture and flow diagrams. [VERIFIED: AGENTS.md; .planning/ROADMAP.md]
- Before file-changing implementation work, use a GSD entrypoint such as `/gsd-quick`, `/gsd-debug`, or `/gsd-execute-phase`; this research file is itself part of the GSD phase workflow requested by the orchestrator. [VERIFIED: AGENTS.md; user objective]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| YAML/JSON DSL parsing | CLI / Node package | Core library | Parsing receives file/stdin text and returns an in-memory DSL value; no browser or renderer tier is involved. [VERIFIED: package.json; .planning/research/ARCHITECTURE.md] |
| DSL validation and semantic reference checks | Core library | CLI | Validation should be reusable by callers that do not use the CLI; CLI only formats diagnostics. [VERIFIED: src/ir/diagnostics.ts; .planning/research/ARCHITECTURE.md] |
| DSL normalization | Core library | Solver | Normalization maps authoring shorthand into existing `IntentDiagram` / `NormalizedDiagram`; final geometry remains solver-owned. [VERIFIED: src/ir/diagram.ts; src/solver/solve.ts] |
| Geometry solving | Solver | Layout / constraints / routing modules | `solveDiagram()` already owns Dagre layout, constraints, group coordination, routing, and diagnostics. [VERIFIED: src/solver/solve.ts] |
| Output serialization | Exporters | CLI | `exportSvg()` and `exportExcalidraw()` already serialize coordinated IR; CLI only selects one and writes content. [VERIFIED: src/exporters/svg.ts; src/exporters/excalidraw.ts] |
| File/stdin/stdout/stderr behavior | CLI | Node filesystem/process APIs | Unix IO behavior belongs at the command boundary and should not leak into core parser or solver functions. [VERIFIED: .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `yaml` | 2.9.0, modified 2026-05-11, ISC license [VERIFIED: npm registry] | YAML parsing with parser errors/warnings and line positions [CITED: https://github.com/eemeli/yaml/blob/main/docs/04_documents.md] | It is the maintained Node YAML package with `parseDocument()` diagnostics, and it supports Node engines `>=14.6`, so it fits Node 20. [VERIFIED: npm registry; Context7 `/eemeli/yaml`] |
| `zod` | 4.4.3, modified 2026-05-04, MIT license [VERIFIED: npm registry] | TypeScript-native DSL shape validation and typed normalized parse output [CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx] | It returns structured `safeParse` issues with paths and avoids maintaining a separate JSON Schema file before the TS API stabilizes. [CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx] |
| `commander` | 14.0.3, modified 2026-05-12, MIT license [VERIFIED: npm registry] | CLI option parsing for `dge` [CITED: https://github.com/tj/commander.js/blob/master/Readme.md] | It supports Node `>=20`, custom output streams, and `exitOverride()`, which fits tested CLI error handling. [VERIFIED: npm registry; CITED: https://github.com/tj/commander.js/blob/master/Readme.md] |
| Node `fs/promises` | Node runtime API, available in current environment Node v24.13.0 [VERIFIED: command `node --version`; CITED: https://nodejs.org/api/fs.html] | File input, atomic output, and temp-file rename behavior [CITED: https://nodejs.org/api/fs.html] | Promise filesystem APIs work with ESM and expose `writeFile()` and `rename()` for temp-file-then-rename output. [CITED: https://nodejs.org/api/fs.html] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing `@chenglou/pretext` | 0.0.7 in current dependencies [VERIFIED: package.json] | Label measurement during normalization/prepare if parser creates `NormalizedDiagram` with fitted labels [VERIFIED: src/labels/fit.ts; src/text/pretext.ts] | Use through existing text/label abstractions only; do not call it from CLI formatting. [VERIFIED: .planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md] |
| Existing `@dagrejs/dagre` | 3.0.0 in current dependencies [VERIFIED: package.json] | Initial layout inside `solveDiagram()` [VERIFIED: src/layout/dagre.ts; src/solver/solve.ts] | Do not expose Dagre settings in Phase 5 beyond existing `direction` and simple routing defaults. [VERIFIED: .planning/phases/03-layout-constraints-and-routing/03-CONTEXT.md] |
| Existing Vitest | 4.1.7 in current dev dependencies and CLI reports `vitest/4.1.7` [VERIFIED: package.json; command `npm exec vitest -- --version`] | Unit, fixture, and CLI integration tests [VERIFIED: package.json; test/*.test.ts] | Use for parser negative fixtures, CLI spawn tests, stdout/stderr tests, and deterministic golden output checks. [VERIFIED: repo test patterns] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `yaml` | `js-yaml` | `js-yaml` is a common YAML parser, but this phase needs source-position-rich parser diagnostics; `yaml` docs expose `Document.errors`, `Document.warnings`, `pos`, and `linePos`. [CITED: https://github.com/eemeli/yaml/blob/main/docs/08_errors.md; LOW for js-yaml comparison because not deeply researched] |
| `zod` | `ajv@8.20.0` | Ajv is current and MIT-licensed, but it makes sense when the project wants JSON Schema as a public artifact; Phase 5 needs TypeScript-first internal validation with easy custom semantic checks. [VERIFIED: npm registry; ASSUMED: project does not yet need public JSON Schema artifact] |
| `commander` | `yargs` or `cac` | Commander is enough for one binary with a small option surface and has official support for custom output and exit override. [CITED: https://github.com/tj/commander.js/blob/master/Readme.md; ASSUMED: no subcommand tree is needed in Phase 5] |

**Installation:**

```bash
rtk npm install yaml zod commander
```

**Version verification commands used:**

```bash
rtk npm view yaml version license time.modified description homepage repository.url
rtk npm view commander version license time.modified description homepage repository.url
rtk npm view zod version license time.modified description homepage repository.url
rtk npm view ajv version license time.modified description homepage repository.url
```

## Architecture Patterns

### System Architecture Diagram

```text
File path / stdin text
        |
        v
parse source kind
  |-- YAML -> yaml.parseDocument() -> parse diagnostics
  |-- JSON -> JSON.parse()         -> parse diagnostics
        |
        v
Zod DSL schema validation
        |
        v
semantic validation
  |-- node id map
  |-- edge source/target refs
  |-- group child refs
  |-- constraint refs
  |-- format/routing support
        |
        v
normalize DSL shorthand
  |-- node object map -> IntentNode[]
  |-- edge string shorthand -> IntentEdge[]
  |-- group map -> IntentGroup[]
  |-- structured constraints -> Constraint[]
        |
        v
prepare / normalize to NormalizedDiagram
        |
        v
solveDiagram()
        |
        v
diagnostic gate: any error?
  |-- yes -> stderr or --json error payload, non-zero exit
  |-- no  -> exportSvg() / exportExcalidraw()
        |
        v
stdout or temp-file -> rename output
```

This data flow matches the project architecture rule that DSL owns parsing/validation, solver owns geometry, and exporters own format serialization. [VERIFIED: .planning/research/ARCHITECTURE.md; src/solver/solve.ts; src/exporters/types.ts]

### Recommended Project Structure

```text
src/
├── dsl/
│   ├── index.ts          # public parser/normalizer exports
│   ├── parse.ts          # YAML/JSON source parsing into unknown data
│   ├── schema.ts         # zod schemas for authoring DSL
│   ├── normalize.ts      # DSL -> IntentDiagram / NormalizedDiagram
│   ├── edges.ts          # edge shorthand parser
│   └── diagnostics.ts    # diagnostic conversion and formatting helpers
├── cli/
│   ├── index.ts          # shebang entry for dge
│   ├── run.ts            # testable CLI orchestration
│   └── io.ts             # stdin/readFile/stdout/stderr/atomic write helpers
└── examples/
    └── optional only if planner chooses source examples under src; otherwise use examples/ at repo root
```

Keep examples outside `src/` if they are user-facing files rather than package code. [ASSUMED: existing repo has no examples convention yet]

### Pattern 1: Parse YAML Without Throw-Driven Control Flow

**What:** Use `parseDocument()` and convert `doc.errors`/`doc.warnings` into DGE diagnostics before reading `doc.toJSON()` or equivalent plain data. [CITED: https://github.com/eemeli/yaml/blob/main/docs/04_documents.md]

**When to use:** Use for `.yaml`, `.yml`, unknown extension stdin default, and examples. [VERIFIED: Phase 5 context requires YAML and stdin]

**Example:**

```typescript
// Source: Context7 /eemeli/yaml, docs/04_documents.md and docs/08_errors.md
import { parseDocument } from "yaml";

const doc = parseDocument(source, { prettyErrors: true });
const diagnostics = doc.errors.map((error) => ({
  severity: "error" as const,
  code: `parse.yaml.${error.code}`,
  message: error.message,
  path: [],
  detail: { linePos: error.linePos },
}));
```

### Pattern 2: Validate Shape With Zod, Then Validate References Separately

**What:** Use Zod for structural validation and custom DGE semantic checks for cross-reference validation. [CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx; VERIFIED: src/ir/elements.ts]

**When to use:** Use Zod for local field constraints like shape enums and finite numbers; use semantic passes for missing nodes, duplicated ids, invalid group children, and constraints that reference unknown ids. [VERIFIED: .planning/REQUIREMENTS.md; src/ir/constraints.ts]

**Example:**

```typescript
// Source: Context7 /colinhacks/zod safeParse issue path docs
import { z } from "zod";

const nodeSchema = z.object({
  label: z.union([z.string(), z.object({ text: z.string() })]).optional(),
  shape: z
    .enum([
      "rectangle",
      "rounded-rectangle",
      "ellipse",
      "diamond",
      "parallelogram",
      "hexagon",
      "cylinder",
    ])
    .optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});
```

### Pattern 3: Make CLI Orchestration Injectable

**What:** Implement `runCli(args, env)` as a testable function with injected `stdin`, `stdout`, `stderr`, `readFile`, and `writeFileAtomic` adapters. [ASSUMED: standard Node CLI test pattern]

**When to use:** Use for Vitest integration tests without relying only on spawned child processes. Add at least one built `dge` smoke test after `npm run build`. [VERIFIED: existing Vitest setup; package build script]

**Example:**

```typescript
// Source: Commander docs for parse options and exitOverride
const program = new Command()
  .name("dge")
  .option("--input <path>")
  .option("--format <format>")
  .option("--output <path>")
  .option("--json", "write diagnostics as JSON");

program.exitOverride();
program.configureOutput({
  writeOut: env.stdout.write,
  writeErr: env.stderr.write,
});
program.parse(args, { from: "user" });
```

### Pattern 4: Atomic Output Writes

**What:** Write output to a temporary file in the target directory, then `rename()` it to the requested output path after export succeeds. [CITED: https://nodejs.org/api/fs.html]

**When to use:** Use for `--output` so failed parse/validate/solve/export never truncates or partially replaces the target output file. [VERIFIED: Phase 5 D-16]

**Example:**

```typescript
// Source: Node fs/promises docs for writeFile() and rename()
import { rename, writeFile } from "node:fs/promises";

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
}
```

Planner should add cleanup on failed temp writes. [ASSUMED: cleanup behavior is desired but not explicitly required]

### Anti-Patterns to Avoid

- **DSL as second IR:** Do not create a durable semantic model parallel to `IntentDiagram` / `NormalizedDiagram`; normalize quickly and keep DSL-only structures private. [VERIFIED: Phase 5 D-02]
- **CLI geometry recomputation:** Do not place Dagre, constraint, routing, shape geometry, or exporter fallback logic in `src/cli/`. [VERIFIED: .planning/research/ARCHITECTURE.md; src/solver/solve.ts]
- **String-only validation:** Do not parse edge/constraint strings with broad regexes and skip semantic reference checks; diagnostics must include paths and repair hints. [VERIFIED: DSL-02; Phase 5 D-10]
- **Writing output before diagnostics gate:** Do not open/truncate `--output` until parse, validate, solve, and export have succeeded. [VERIFIED: Phase 5 D-16]
- **JSON diagnostics with unstable order:** Sort diagnostics deterministically by layer, path, and code before JSON output. [VERIFIED: deterministic output requirement; src/serialization/canonical.ts]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML parsing | A custom YAML lexer/parser | `yaml@2.9.0` | YAML syntax, line/column diagnostics, warnings, and scalar/map/sequence handling are already handled by the package. [VERIFIED: npm registry; CITED: https://github.com/eemeli/yaml/blob/main/docs/04_documents.md] |
| CLI option parsing | Manual `process.argv` parsing | `commander@14.0.3` | Commander handles options, help, parse modes, output configuration, and exit override. [VERIFIED: npm registry; CITED: https://github.com/tj/commander.js/blob/master/Readme.md] |
| Schema validation | Ad hoc nested `typeof` checks | `zod@4.4.3` plus semantic validators | Zod gives typed schemas and path-bearing issues; semantic passes can add domain-specific missing-reference diagnostics. [VERIFIED: npm registry; CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx] |
| Geometry normalization | CLI-local node sizing or routing | Existing label/text/solver APIs | Existing modules already own label fitting, layout, constraints, groups, routing, and diagnostics. [VERIFIED: src/labels/fit.ts; src/solver/solve.ts] |
| Export serialization | CLI-local SVG/JSON rendering | `exportSvg()` and `exportExcalidraw()` | Exporters already consume coordinated IR and have Phase 4 golden fixtures. [VERIFIED: src/exporters/svg.ts; src/exporters/excalidraw.ts; test/fixtures/phase-04] |

**Key insight:** Phase 5 is an execution surface, not a geometry phase; every custom parser or CLI shortcut should terminate at existing IR and existing APIs. [VERIFIED: .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Parser Produces Solver-Ready Data Without Measurement

**What goes wrong:** The parser creates `NormalizedNode.size` placeholders that do not reflect labels, padding, or minimum sizes. [VERIFIED: src/ir/elements.ts; src/labels/fit.ts]
**Why it happens:** There is no visible `prepareDiagram()` entrypoint yet, while `solveDiagram()` requires `NormalizedDiagram`. [VERIFIED: src/solver/solve.ts; rg results]
**How to avoid:** Add a normalization/prepare function that fits labels and fills `NormalizedDiagram` defaults before solving. [VERIFIED: current IR contracts]
**Warning signs:** CLI tests pass for explicit sizes but fail for label-only YAML examples. [ASSUMED]

### Pitfall 2: Diagnostics Lose YAML Source Location

**What goes wrong:** Users see `nodes.api.shape invalid` without line/column or DSL path. [VERIFIED: DSL-02]
**Why it happens:** Converting YAML directly to plain JSON can lose AST source ranges. [ASSUMED]
**How to avoid:** Capture parse errors directly from `parseDocument()` and use schema paths for semantic errors; line/column lookup for semantic errors is nice-to-have if implementation keeps node ranges. [CITED: https://github.com/eemeli/yaml/blob/main/docs/08_errors.md; CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx]
**Warning signs:** Negative fixture snapshots contain only generic error text. [ASSUMED]

### Pitfall 3: CLI Flag Precedence Becomes Inconsistent

**What goes wrong:** `output.format` in YAML wins over `--format`, or stdout writes a different format than expected. [VERIFIED: Phase 5 D-05 and D-17]
**Why it happens:** Output settings are resolved in both parser and CLI. [ASSUMED]
**How to avoid:** Resolve final execution options once in CLI orchestration: `cli --format` > DSL `output.format` > default `svg`. [VERIFIED: Phase 5 D-17]
**Warning signs:** Tests need duplicated precedence assertions in parser and CLI files. [ASSUMED]

### Pitfall 4: Machine-Readable Error Output Is Not Deterministic

**What goes wrong:** Agent automation cannot diff failures because diagnostic order changes. [VERIFIED: deterministic output requirement]
**Why it happens:** Diagnostics are appended from parser/schema/solver/exporter in natural traversal order without stable sorting. [VERIFIED: src/solver/solve.ts appends diagnostics]
**How to avoid:** Normalize diagnostic payloads with a stable ordering before `--json` output. [VERIFIED: src/serialization/canonical.ts]
**Warning signs:** Repeated invalid-input tests produce non-identical JSON. [ASSUMED]

### Pitfall 5: Atomic Write Handles Success But Not Cleanup

**What goes wrong:** Failed writes leave stale temp files next to output files. [ASSUMED]
**Why it happens:** Temp-file-then-rename code handles successful rename but not error cleanup. [ASSUMED]
**How to avoid:** Use `try/finally` cleanup for the temp path and test that target file remains unchanged after an invalid DSL run. [VERIFIED: Phase 5 D-16; CITED: https://nodejs.org/api/fs.html]
**Warning signs:** CLI failure tests only assert exit code and do not inspect the preexisting output file. [ASSUMED]

## Plan-Ready Implementation Sequence

1. Add dependencies and build wiring: install `yaml`, `zod`, and `commander`; update `tsup.config.ts` to build `src/cli/index.ts`; add `package.json` `bin: { "dge": "./dist/cli/index.js" }` or equivalent emitted path. [VERIFIED: package.json; tsup.config.ts; npm registry]
2. Define DSL schema and examples: support title/id, `layout.direction`, top-level `direction` alias if desired, node map, edge array with shorthand strings and structured edges, group map, structured constraints, routing defaults, and output defaults. [VERIFIED: Phase 5 context]
3. Implement parser diagnostics: source kind detection, YAML parse diagnostics, JSON parse errors, Zod validation diagnostics, and DGE diagnostic conversion. [CITED: yaml docs; zod docs]
4. Implement semantic normalization: stable node ids from map keys, labels as `{ text }`, default shape/padding/size policy, edge shorthand expansion, group membership, constraints to existing `Constraint[]`, and missing-reference diagnostics. [VERIFIED: src/ir/elements.ts; src/ir/constraints.ts]
5. Add prepare/normalize-to-solver bridge: produce `NormalizedDiagram` with deterministic defaults and label fitting through existing label/text abstractions, then call `solveDiagram()`. [VERIFIED: src/solver/solve.ts; src/labels/fit.ts]
6. Add export dispatcher: map `svg` to `exportSvg()` and `excalidraw` to `exportExcalidraw()`; reject unsupported formats with a validation diagnostic. [VERIFIED: src/exporters/types.ts]
7. Add CLI IO: Commander option parsing, stdin fallback, stdout fallback, stderr diagnostics, `--json`, exit codes, and atomic `--output` writes. [VERIFIED: Phase 5 context; Commander docs; Node fs docs]
8. Add fixtures and tests: parser positive/negative tests, semantic validation tests, CLI stdin/stdout/file tests, format precedence tests, atomic write failure tests, and example DSL smoke tests. [VERIFIED: existing Vitest and fixture patterns]
9. Run final gate with `rtk npm run verify`. [VERIFIED: package.json; AGENTS.md]

## Code Examples

### Edge Shorthand Expansion

```typescript
// Source: Phase 5 D-04, normalized to IntentEdge from src/ir/elements.ts
const edgePattern =
  /^\s*(?<source>[A-Za-z0-9_.:-]+)\s*->\s*(?<target>[A-Za-z0-9_.:-]+)(?:\s*:\s*(?<label>.+))?\s*$/;

function parseEdgeShorthand(value: string) {
  const match = edgePattern.exec(value);
  if (match?.groups === undefined) {
    return { diagnostic: "validate.edge-shorthand.invalid" };
  }
  return {
    sourceId: match.groups.source,
    targetId: match.groups.target,
    ...(match.groups.label === undefined
      ? {}
      : { label: { text: match.groups.label } }),
  };
}
```

Regex is acceptable only for this constrained edge shorthand, not for YAML or constraint object parsing. [VERIFIED: Phase 5 D-04; ASSUMED: id character class is sufficient and should be validated in implementation]

### Diagnostic Payload Shape

```typescript
// Source: src/ir/diagnostics.ts, Phase 5 D-12
interface DslDiagnostic {
  layer: "parse" | "validate" | "solve" | "export" | "io";
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: Array<string | number>;
  hint?: string;
  detail?: Record<string, unknown>;
}
```

Use a wrapper shape for CLI output while preserving compatibility with existing `Diagnostic` fields. [VERIFIED: src/ir/diagnostics.ts]

### Export Dispatcher

```typescript
// Source: src/exporters/types.ts, src/exporters/svg.ts, src/exporters/excalidraw.ts
function exportDiagram(format: "svg" | "excalidraw", diagram: CoordinatedDiagram) {
  switch (format) {
    case "svg":
      return exportSvg(diagram);
    case "excalidraw":
      return exportExcalidraw(diagram);
  }
}
```

Keep unsupported future formats as validation errors, not hidden no-op branches. [VERIFIED: Phase 5 deferred ideas]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual YAML parsing or regex DSL parsing | Use maintained parser with structured parser diagnostics | Current package docs checked 2026-05-25 [VERIFIED: Context7 `/eemeli/yaml`] | Better syntax diagnostics and fewer parser edge cases. [CITED: yaml docs] |
| JSON Schema-first validation | TypeScript schema-first validation with Zod, optional JSON Schema later | Project API still unstable in v1 [VERIFIED: package state and roadmap] | Planner can keep schema near TypeScript IR and add public JSON Schema in a later docs/release phase. [ASSUMED] |
| CLI as direct `process.argv` script | Testable `runCli()` with Commander and injected IO | Current recommendation [VERIFIED: Commander docs] | More reliable stdout/stderr and non-zero exit tests. [CITED: Commander docs] |
| Direct output file write | Temp-file write followed by rename | Current recommendation [VERIFIED: Node fs docs; Phase 5 D-16] | Prevents partial/truncated outputs on failed parse/solve/export. [VERIFIED: Phase 5 D-16] |

**Deprecated/outdated:**
- Do not use the older design doc's array-based node DSL as the primary Phase 5 shape; Phase 5 context locks node object maps keyed by stable node id. [VERIFIED: diagram-geometry-engine-design.md; .planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md]
- Do not expose v2 output formats (`drawio`, `mermaid`, `ascii`) as successful Phase 5 formats; reject them clearly until corresponding exporters exist. [VERIFIED: .planning/REQUIREMENTS.md; src/exporters/types.ts]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The project does not yet need a public JSON Schema artifact in Phase 5. | Standard Stack alternatives | If wrong, use Ajv/JSON Schema or generate JSON Schema from Zod as an additional plan task. |
| A2 | Phase 5 does not need a Commander subcommand tree. | Standard Stack alternatives | If wrong, CLI structure should reserve subcommands like `dge render` and `dge validate`. |
| A3 | User-facing examples can live at repo-root `examples/` because no examples convention exists yet. | Recommended Project Structure | If wrong, planner should move examples to the project-preferred fixture/docs path. |
| A4 | A constrained regex is sufficient for edge shorthand ids after schema validation. | Code Examples | If wrong, implement a small tokenizer for edge shorthand and add negative fixtures. |

## Open Questions (RESOLVED)

1. **Should Phase 5 expose a public `parseDiagramDsl()` API from the root package?**
   - What we know: Existing public APIs are exported through `src/index.ts`. [VERIFIED: src/index.ts; test/public-api.test.ts]
   - Resolution: Expose `parseDiagramDsl()`, `normalizeDiagramDsl()`, `renderDiagramDsl()`, and DSL result/diagnostic types through the root package in Phase 5. Keep low-level Zod schema internals private. This matches existing root-only public API patterns while giving agents and developers a reusable programmatic DSL surface. [RESOLVED: 05-06 plan]

2. **Where should label measurement happen when converting DSL to `NormalizedDiagram`?**
   - What we know: `solveDiagram()` accepts `NormalizedDiagram`, and `NormalizedNode.size` is required. [VERIFIED: src/solver/solve.ts; src/ir/elements.ts]
   - Resolution: Add the prepare bridge inside `normalizeDiagramDsl()` / `src/dsl/normalize.ts`. It must produce solver-ready `NormalizedDiagram` values using existing label/text abstractions and deterministic defaults. CLI orchestration must not measure labels directly. [RESOLVED: 05-03 plan]

3. **Should semantic diagnostics include YAML line/column for non-syntax errors?**
   - What we know: YAML parser errors include `linePos`; Zod issues include paths. [CITED: yaml docs; zod docs]
   - Resolution: Phase 5 requires path-bearing semantic diagnostics with actionable `hint` text. Exact line/column is required for YAML parse errors when the parser provides it, but semantic validation errors may use DSL paths without line/column unless implementation finds a simple AST range mapping. [RESOLVED: 05-02 and 05-03 plans]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Runtime and CLI | Yes [VERIFIED: command] | v24.13.0 [VERIFIED: command] | Project requires Node >=20, so current runtime is sufficient. [VERIFIED: package.json] |
| npm | Dependency install and scripts | Yes [VERIFIED: command] | 10.9.7 [VERIFIED: command] | None needed. |
| Vitest | Parser/CLI tests | Yes [VERIFIED: command] | 4.1.7 [VERIFIED: command] | None needed. |
| tsup | Library and CLI build | Yes via devDependency [VERIFIED: package.json] | 8.5.1 [VERIFIED: package.json] | None needed. |
| `yaml` | YAML parsing | Not installed yet [VERIFIED: package.json] | Recommended 2.9.0 [VERIFIED: npm registry] | Use JSON-only temporarily only if YAML dependency install is blocked. [ASSUMED] |
| `zod` | DSL validation | Not installed yet [VERIFIED: package.json] | Recommended 4.4.3 [VERIFIED: npm registry] | Manual validation is possible but not recommended. [ASSUMED] |
| `commander` | CLI options | Not installed yet [VERIFIED: package.json] | Recommended 14.0.3 [VERIFIED: npm registry] | Manual argv parsing is possible but not recommended. [ASSUMED] |

**Missing dependencies with no fallback:**
- None blocking before planning; implementation must install `yaml`, `zod`, and `commander`. [VERIFIED: package.json; npm registry]

**Missing dependencies with fallback:**
- `yaml`: JSON-only fallback would fail DSL-01 because YAML support is required, so use fallback only for local debugging, not phase completion. [VERIFIED: DSL-01]
- `zod` and `commander`: manual fallbacks exist but would increase implementation risk and should not be planned as the standard path. [ASSUMED]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.7 [VERIFIED: command `npm exec vitest -- --version`] |
| Config file | none detected; package script runs `vitest run` [VERIFIED: package.json; rg files] |
| Quick run command | `rtk npm test -- --runInBand` is not a Vitest standard here; use targeted `rtk npm exec vitest -- test/dsl.test.ts test/cli.test.ts` instead. [VERIFIED: package.json; ASSUMED targeted file names] |
| Full suite command | `rtk npm run verify` [VERIFIED: package.json; AGENTS.md] |

### Phase Requirements To Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DSL-01 | YAML and JSON inputs normalize into the same internal intent/normalized IR. [VERIFIED: REQUIREMENTS.md] | unit + fixture | `rtk npm exec vitest -- test/dsl.test.ts` | No, Wave 0 |
| DSL-02 | Invalid fields, missing references, unsupported shapes, and invalid constraints produce actionable diagnostics. [VERIFIED: REQUIREMENTS.md] | unit negative fixtures | `rtk npm exec vitest -- test/dsl-diagnostics.test.ts` | No, Wave 0 |
| DSL-03 | Fixed positions, relative offsets, alignment, distribution, and grouped containment map to existing constraints. [VERIFIED: REQUIREMENTS.md] | unit + golden normalized fixture | `rtk npm exec vitest -- test/dsl.test.ts` | No, Wave 0 |
| CLI-01 | `dge --input diagram.yaml --format svg --output diagram.svg` writes SVG. [VERIFIED: REQUIREMENTS.md] | CLI integration | `rtk npm exec vitest -- test/cli.test.ts` | No, Wave 0 |
| CLI-02 | stdin input and stdout output work for SVG and Excalidraw JSON. [VERIFIED: REQUIREMENTS.md] | CLI integration | `rtk npm exec vitest -- test/cli.test.ts` | No, Wave 0 |
| CLI-03 | invalid input, unsatisfied constraints, and unsupported formats exit non-zero with readable errors. [VERIFIED: REQUIREMENTS.md] | CLI integration negative fixtures | `rtk npm exec vitest -- test/cli.test.ts test/dsl-diagnostics.test.ts` | No, Wave 0 |

### Sampling Rate

- **Per task commit:** Run the targeted Vitest file for touched behavior, for example `rtk npm exec vitest -- test/dsl.test.ts`. [VERIFIED: package scripts]
- **Per wave merge:** Run `rtk npm test`. [VERIFIED: package.json]
- **Phase gate:** Run `rtk npm run verify`. [VERIFIED: package.json; AGENTS.md]

### Wave 0 Gaps

- [ ] `test/dsl.test.ts` - covers DSL-01 and DSL-03. [VERIFIED: requirements; file absent by rg]
- [ ] `test/dsl-diagnostics.test.ts` - covers DSL-02 and CLI-03 diagnostic payloads. [VERIFIED: requirements; file absent by rg]
- [ ] `test/cli.test.ts` - covers CLI-01, CLI-02, CLI-03, stdout/stderr, and atomic write behavior. [VERIFIED: requirements; file absent by rg]
- [ ] `test/fixtures/phase-05/` - committed YAML/JSON examples for architecture, flowchart, edge labels, groups, and hybrid layout. [VERIFIED: Phase 5 success criteria; file absent by rg]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No | CLI has no authentication surface in Phase 5. [VERIFIED: Phase 5 context] |
| V3 Session Management | No | CLI has no session state in Phase 5. [VERIFIED: Phase 5 context] |
| V4 Access Control | Limited | Do not add network or privileged filesystem behavior; file paths are user-provided local paths. [VERIFIED: Phase 5 context; ASSUMED no sandboxing required inside CLI] |
| V5 Input Validation | Yes | Use `yaml` parser diagnostics, `zod` schema validation, semantic reference checks, finite-number checks, and unsupported-format rejection. [VERIFIED: npm registry; zod docs; yaml docs; src/ir/constraints.ts] |
| V6 Cryptography | No | Phase 5 does not use cryptography. [VERIFIED: Phase 5 context] |

### Known Threat Patterns for Node CLI DSL Tools

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Resource exhaustion through huge stdin/file | Denial of Service | Add an input size limit or document one; use whole-file parsing only for normal diagram-sized files. [ASSUMED] |
| Prototype pollution through parsed plain objects | Tampering | Validate through Zod and create normalized IR objects explicitly rather than spreading untrusted parsed objects into runtime objects. [VERIFIED: zod validation plan; ASSUMED specific prototype-pollution risk] |
| Output path truncation on failed run | Tampering | Use temp-file-then-rename after successful export and test target remains unchanged on failure. [VERIFIED: Phase 5 D-16; Node fs docs] |
| Terminal escape injection in diagnostics | Spoofing | Escape or JSON-encode untrusted values in `--json`; keep human diagnostics plain and avoid echoing arbitrary multiline source chunks by default. [ASSUMED] |
| Unsupported format confusion | Tampering | Validate format against existing `ExportFormat = "svg" | "excalidraw"` and reject deferred formats. [VERIFIED: src/exporters/types.ts; Phase 5 deferred ideas] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/05-dsl-parser-and-cli/05-CONTEXT.md` - locked Phase 5 scope, decisions, CLI behavior, and deferred ideas. [VERIFIED: repo inspection]
- `.planning/REQUIREMENTS.md` - DSL-01, DSL-02, DSL-03, CLI-01, CLI-02, CLI-03. [VERIFIED: repo inspection]
- `.planning/ROADMAP.md` - Phase 5 goal and success criteria. [VERIFIED: repo inspection]
- `.planning/STATE.md` - current project state after Phase 4. [VERIFIED: repo inspection]
- `AGENTS.md` and `/home/zhangyangrui/.codex/RTK.md` - project shell and workflow constraints. [VERIFIED: repo inspection]
- `src/ir/diagram.ts`, `src/ir/elements.ts`, `src/ir/constraints.ts`, `src/ir/diagnostics.ts`, `src/solver/solve.ts`, `src/exporters/*.ts` - current integration contracts. [VERIFIED: repo inspection]
- npm registry checks for `yaml@2.9.0`, `commander@14.0.3`, `zod@4.4.3`, and `ajv@8.20.0`. [VERIFIED: npm registry]
- Context7 `/eemeli/yaml` - `parseDocument()`, document errors/warnings, and parser error location fields. [CITED: https://github.com/eemeli/yaml/blob/main/docs/04_documents.md; CITED: https://github.com/eemeli/yaml/blob/main/docs/08_errors.md]
- Context7 `/tj/commander.js` - `configureOutput()`, `exitOverride()`, and parse modes. [CITED: https://github.com/tj/commander.js/blob/master/Readme.md]
- Context7 `/colinhacks/zod` - `safeParse`, `issues[].path`, refine path, and `treeifyError()`. [CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx; CITED: https://github.com/colinhacks/zod/blob/main/packages/docs/content/error-formatting.mdx]
- Node.js official `fs` docs - `fs/promises`, `writeFile()`, and `rename()`. [CITED: https://nodejs.org/api/fs.html]

### Secondary (MEDIUM confidence)

- `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md`, `.planning/research/STACK.md` - project-level research and pitfalls. [VERIFIED: repo inspection]
- `diagram-geometry-engine-design.md` - original DSL and CLI framing, superseded where Phase 5 context is more specific. [VERIFIED: repo inspection]

### Tertiary (LOW confidence)

- None used as authoritative sources. [VERIFIED: research log]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - versions, licenses, engines, and docs were checked via npm registry and Context7/official docs. [VERIFIED: npm registry; Context7 docs]
- Architecture: HIGH - phase context and repo contracts directly define parser -> IR -> solve -> export flow. [VERIFIED: repo inspection]
- Pitfalls: MEDIUM - major risks are grounded in project docs and current code, but exact implementation failure modes are inferred until Phase 5 code exists. [VERIFIED: repo inspection; ASSUMED for implementation-specific warnings]
- Security: MEDIUM - input validation and file-write risks are clear for a CLI, but no full threat model exists for DGE yet. [ASSUMED]

**Research date:** 2026-05-25 [VERIFIED: system current_date]
**Valid until:** 2026-06-01 for package version recency; architecture findings remain valid until the IR/solver/exporter contracts change. [ASSUMED]

## RESEARCH COMPLETE
