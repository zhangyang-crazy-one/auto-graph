# auto-graph

[中文文档](./README.zh-CN.md)

auto-graph is a deterministic geometry engine for diagrams. It turns high-level YAML or JSON diagram intent into stable, collision-aware, text-safe coordinates that can be exported as SVG or editable Excalidraw JSON.

The project is not a visual editor and not a renderer-first diagramming tool. It is the geometry layer between graph intent and downstream formats, built for coding agents, LLM workflows, CLI automation, and developers who need repeatable diagrams without hand-tuning x/y coordinates.

## Install

```bash
npm install @crazyhappyone/auto-graph
```

The CLI command is `agh`.

```bash
agh --input examples/architecture.yaml --format svg --output architecture.svg
cat examples/architecture.yaml | agh --format excalidraw > architecture.excalidraw.json
```

For local development, build before running the compiled CLI directly:

```bash
npm run build
node dist/cli/index.js --input examples/architecture.yaml --format svg --output architecture.svg
```

## Why It Exists

Most diagram generators either rely on a renderer for layout feedback or expose coordinates that humans and agents must tweak by hand. auto-graph keeps geometry solving deterministic and headless:

1. Measure labels before layout through a `TextMeasurer` abstraction.
2. Place nodes with Dagre-backed directed layout plus deterministic constraints.
3. Route straight or orthogonal connectors from resolved shape ports.
4. Export already-coordinated geometry without recomputing layout.

Given the same input, auto-graph is designed to produce stable numeric output that can be snapshot-tested and reused by downstream exporters.

## TypeScript API

```typescript
import {
  exportExcalidraw,
  exportSvg,
  normalizeDiagramDsl,
  parseDiagramDsl,
  solveDiagram,
} from "@crazyhappyone/auto-graph";

const source = `
title: Architecture
layout: { direction: LR }
nodes:
  api: { label: "API Gateway", shape: rounded-rectangle }
  db: { label: "Database", shape: cylinder }
edges:
  - api -> db: "reads"
constraints:
  - kind: relative-position
    source: db
    reference: api
    relation: right-of
    offset: { x: 140, y: 0 }
`;

const parsed = parseDiagramDsl(source);
if (parsed.value === undefined) {
  throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
}

const normalized = normalizeDiagramDsl(parsed.value);
const coordinated = solveDiagram(normalized.diagram, {
  routeKind: "obstacle-avoiding",
  maxRoutingAttempts: 8,
  labelPlacement: "beside",
  labelOffset: 16,
});

const svg = exportSvg(coordinated, { title: "Architecture" });
const excalidraw = exportExcalidraw(coordinated);
```

Solver internals are split by concern (`ports`, `route-edges`, `labels`, `remediation`, …). See [`src/solver/ARCHITECTURE.md`](./src/solver/ARCHITECTURE.md) for module ownership and the default pipeline phase order.

## DSL Example

```yaml
title: Architecture
layout:
  direction: LR
nodes:
  web:
    label: Web App
    shape: rounded-rectangle
  api:
    label: API
    shape: hexagon
  db:
    label: Database
    shape: cylinder
edges:
  - web -> api: calls
  - api -> db: reads
constraints:
  - kind: relative-position
    source: api
    reference: web
    relation: right-of
    offset: { x: 160, y: 0 }
```

## Dense Routing Controls

Dense, position-preserving diagrams can opt into obstacle-aware routing controls through YAML `routing` metadata. These controls are deterministic and headless; impossible layouts return structured diagnostics instead of relying on visual inspection.

```yaml
layout:
  mode: positions
  direction: LR
routing:
  kind: short-orthogonal-jumps   # or obstacle-avoiding
  edgeLabelRerouting: { maxIterations: 2 }
  compactTextObstacles: labels-only
  textIntersectionTolerance: 2
  textObstacleVertices: true
  fixedSwimlaneGeometry: diagnose-overflow
  anchorCapacity: { minSpacing: 16, grow: true }
  railRouting: dependency
  externalLabels: { edgeLabels: true }
  deliverabilityMode: strict
  remediationPolicy:
    externalLabels: auto
    routeRails: auto
    growFixedGeometry: auto
    pageSplit: suggest
```

### Short-orthogonal-jumps contract (#84)

| Constraint | Severity |
|---|---|
| Route may not enter foreign node / title / evidence hard boxes | **hard** |
| Prefer minimal length among 0–2 bend orthogonal candidates between attach slots (25%/50%/75% per side) | **objective** |
| Edge–edge crossings allowed when marked in `edgeCrossings` (`jump` / `gap` / `bridge`) | **soft / visualized** |
| Detour ratio `routeLength/direct > maxDetourRatio` (default **3**) | **reject candidate** |
| 2-point `route_obstacle_fallback` through hard obstacles | **never deliverable** |

Public helpers: `attachSlotFractions(3) → [0.25, 0.5, 0.75]`, `attachSlotsForBox(box, side, 3)`.

Solved diagrams may include `edgeCrossings: [{ x, y, underEdgeId, overEdgeId, style }]`. SVG/Excalidraw render hops; draw.io should consume the same IR downstream (no in-repo draw.io exporter).

### Pretext sizing + semantic roles (#84 A/D)

- Node boxes grow from Pretext measurement + padding. Caller `size` is a **floor**, not a truncate cap. `label.maxWidth` only controls wrapping.
- Under `deliverabilityMode`, `prefitLabelSize` defaults on (opt out with `prefitLabelSize: false`).
- Ellipse / `role: start|end` boxes become circles with `diameter = max(textWidth, textHeight) + padding`.
- Optional node `role` maps to fixed shapes (`start`/`end`→ellipse, `decision`→diamond, `process`→rounded-rectangle, `data`→cylinder, `concept`→rectangle). Explicit `shape` wins. Omit `role` on SysML blocks.

Use `fixedSwimlaneGeometry` with authored `box` values on swimlanes or lanes when downstream consumers need preserved container geometry. Use `anchorCapacity` for high fan-in/out nodes, `railRouting: dependency` for dense same-rank dependency pages, and `externalLabels` when downstream renderers should turn congested edge labels into keyed callouts.

`deliverabilityMode: strict` (equivalent to `strict: true`) requires clean geometry or structured `unsatisfiable` output with `remediationPlans`. `deliverabilityMode: degraded-ok` keeps advisory degraded output.

After the local route/label feedback loop exhausts, residual conflicts enter a bounded remediation pass (default 2 iterations). Apply order is grow → rails → external-label. `pageSplit` is never auto-materialized.

### `remediationPolicy` apply matrix

| Key | `suggest` / `off` | `auto` |
|-----|-------------------|--------|
| `externalLabels` | Stage keyed-callout plans only | Apply deterministic keyed callouts and re-check clearance |
| `routeRails` | Stage dependency-rail plans only | Force dependency rails, re-route, mark `applied` or `blocked` |
| `growFixedGeometry` | Stage growth plans only | Apply growth deltas / expand nodes, re-route, mark `applied` or `blocked` |
| `pageSplit` | Stage machine-readable `required`/`available` plans (`suggest` only; no `auto`) | — page split is **not** auto-materialized |

Plan statuses are `suggested`, `applied`, or `blocked`. Under full-auto strict dense acceptance, auto-capable types must be `applied` or `blocked` (not left as `suggested`).

Solved diagrams keep the legacy `degraded`, `deliverability.status`, and `deliverability.remediationTypes` fields. They also expose deterministic `deliverability.remediationPlans` objects with stable IDs, type, status, diagnostic codes, edge/node IDs, and type-specific details so strict consumers can apply or stage remediation without parsing free-form diagnostic text.

### Issue hygiene (dense MBSE epic)

Recommended operator actions after this contract lands on local fixtures:

- Close [#74](https://github.com/zhangyang-crazy-one/auto-graph/issues/74) — regression guard already present (text hard obstacles must not become evidence crossings).
- Fold [#71](https://github.com/zhangyang-crazy-one/auto-graph/issues/71), [#73](https://github.com/zhangyang-crazy-one/auto-graph/issues/73), and [#69](https://github.com/zhangyang-crazy-one/auto-graph/issues/69) into [#75](https://github.com/zhangyang-crazy-one/auto-graph/issues/75).
- Keep [#75](https://github.com/zhangyang-crazy-one/auto-graph/issues/75) open until the local dense contract (clean or structured unsat with plans) is met — not until live DoDAF Stage 5 criticals hit zero.

## CLI

```bash
agh --input diagram.yaml --format svg --output diagram.svg
agh --input diagram.yaml --format excalidraw --output diagram.excalidraw.json
cat diagram.yaml | agh --json
```

Supported output formats:

- `svg`
- `excalidraw`

Format precedence is CLI `--format`, then DSL `output.format`, then `svg`.

## Current Scope

auto-graph v0.0.1 includes:

- TypeScript public API with ESM and CJS builds
- YAML and JSON DSL parsing
- Layered diagnostics for parse, validation, solve, export, and I/O errors
- Text measurement abstraction with Pretext-backed and fallback measurers
- Label fitting, shape geometry, AABB collision utilities, and edge ports
- Dagre-backed initial layout
- Exact, relative, align, distribute, and containment constraints
- Straight, orthogonal, obstacle-avoiding, short-orthogonal-jumps, and dense dependency rail routing
- Text-aware route clearance, edge-label rerouting, fixed swimlane geometry, and structured congestion diagnostics
- SVG and Excalidraw exporters
- Golden and determinism tests

Out of scope for this first release:

- Browser UI
- draw.io XML export
- Mermaid import/export
- Full styling engine

## Verification

```bash
npm run verify
```

This runs TypeScript type-checking, the dual-format build, Vitest, and Biome checks.

## Credits

auto-graph uses `@chenglou/pretext` for renderer-free text preparation and `@dagrejs/dagre` for directed graph initial layout.
