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

## Global Layout

`layout.mode: global` replaces the Dagre seed with a whole-canvas solver for diagrams with groups and swimlanes. Swimlane diagrams and long flows (a chain of at least 6 steps) use it by default, unless they pin geometry with lane boxes, `fixedSwimlaneGeometry` or node positions; set `layout.mode: dagre` to opt out (`layout.mode: auto` is the default).

```yaml
layout:
  mode: global
  direction: LR
```

- **Layering**: cycles are broken in declaration order (a "retry" edge written last is the one reversed), and sibling groups linked one way become tiers (e.g. services → data read left to right). In swimlanes, a hand-off between lanes does not advance the flow: it is drawn straight across the lanes, so a process that zig-zags between lanes stays compact instead of growing one step per hand-off.
- **Ordering**: groups and lanes stay contiguous with one consistent order across layers, so every container is a single rectangle; long edges travel inside the containers they start and end in.
- **Coordinates**: a separation-constrained quadratic program (VPSC projection) straightens edges and keeps containers tight, with node, container, lane and padding gaps as hard constraints. Lanes come out as abutting, equally thick bands and are used as-is instead of re-stacking them.
- **Spacing between layers** is sized from what must fit there: one track per bending edge, edge labels, and container borders.
- **Folding**: a flow much longer than `layout.targetAspectRatio` (default 1.6) — at least 6 layers and more than about a page along the flow — is cut into bands stacked in reading order, like wrapped text. Cuts avoid edges where possible and never split a group; swimlane diagrams are not folded (their lanes span every layer). `layout.fold: false` turns it off.
- **Label backdrops**: edge labels, group titles and port labels are drawn on a white box fitted to their text, so lines passing underneath do not run through the glyphs.

Explicit `constraints` still apply after the layout. `test/fixtures/benchmark/layout-baseline.md` compares both modes on the benchmark set.

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

### Edge distribution defaults

With the default `orthogonal` router:

- Edges sharing a node side get evenly spaced attach points, ordered by where the other node sits, projected onto the real shape outline. Nodes with many edges on one flow side grow before layout to keep the ports readable.
- After routing, edges that share a corridor are nudged into parallel tracks (`routing.edgeSeparation: false` disables it, `{ spacing: 16 }` tunes the gap).
- `relative-position` accepts `align: center` so `below` / `right-of` place a node directly under / beside its reference regardless of size.

```yaml
routing:
  edgeSeparation: { spacing: 12 }
constraints:
  - { kind: relative-position, source: b, reference: a, relation: below, offset: { x: 0, y: 80 }, align: center }
```

### Pretext sizing + semantic roles (#84 A/D)

- Node boxes grow from Pretext measurement + padding. Caller `size` is a **floor**, not a truncate cap. `label.maxWidth` only controls wrapping.
- CJK text is measured independently of the installed fonts: ideographs, kana, Hangul and full-width punctuation are exactly 1 em (as in Microsoft YaHei, PingFang, Noto/Source Han Sans, SimSun), Latin inside a CJK font stack gets a 6% allowance, and lines follow the kinsoku rules (no line starts with `，。）」…`, none ends with `（「…`). A Node canvas without a CJK font would otherwise measure ideographs about 25% narrow. The default CJK stack is `'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', sans-serif`.
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

`--metrics <path>` also writes whole-canvas layout quality metrics (overlaps, group overlap, label overflow, crossings, shared endpoints, whitespace, lane fill, …) as JSON, so agents can check a layout numerically without looking at it:

```bash
agh --input diagram.yaml --output diagram.svg --metrics diagram.metrics.json
```

Supported output formats:

- `svg`
- `excalidraw`
- `geometry` — the solved geometry contract (below)

Format precedence is CLI `--format`, then DSL `output.format`, then `svg`.

## Geometry Contract

`--format geometry` (or `exportGeometry(diagram)` in TypeScript) returns the solved diagram as plain numbers, so an agent or app can draw it with any renderer instead of writing another SVG layout routine. The format is versioned (`"format": "dge-geometry", "version": 1`) and described by a JSON Schema in [`schema/dge-geometry.v1.schema.json`](schema/dge-geometry.v1.schema.json) (also `geometryJsonSchema()`).

One coordinate system (px, origin top left, y down), every number rounded to 3 decimals, byte-stable for the same input:

- `nodes`: box, outline as a primitive (`rect` + corner radius, `ellipse`, `polygon`, `cylinder`) **and** as path commands (`M`/`L`/`A`/`Z`), ports.
- `containers`: groups, swimlanes and lanes with their boxes, lane headers, parent and children.
- `edges`: source/target point and side, the route `points`, the stroke `path` (shortened to the arrowhead base, with jump arcs or gaps cut in where it passes under another edge), arrowhead triangles, crossings, label reference.
- `texts`: every label with its box, font, lines (left `x`, baseline `y`, width, line box), the backdrop box to paint behind it and its rotation.
- `zOrder`: back-to-front paint list; `metrics`: layout quality; `diagnostics`.

Rendering is a loop over `zOrder`; `renderGeometrySvg(document)` is a ~100-line reference renderer that uses nothing but the document.

```ts
import { exportGeometry, renderDiagramDsl } from "@crazyhappyone/auto-graph";

const { diagram } = renderDiagramDsl(source);
const geometry = exportGeometry(diagram!);
for (const paint of geometry.zOrder) {
  // draw paint.kind ("container" | "edge" | "node" | "port" | "backdrop" | "text") by id
}
```

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
