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
  kind: obstacle-avoiding
  edgeLabelRerouting: { maxIterations: 2 }
  compactTextObstacles: labels-only
  textIntersectionTolerance: 2
  textObstacleVertices: true
  fixedSwimlaneGeometry: diagnose-overflow
  anchorCapacity: { minSpacing: 16, grow: true }
  railRouting: dependency
```

Use `fixedSwimlaneGeometry` with authored `box` values on swimlanes or lanes when downstream consumers need preserved container geometry. Use `anchorCapacity` for high fan-in/out nodes, and `railRouting: dependency` for dense same-rank dependency pages.

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
- Straight, orthogonal, obstacle-avoiding, and dense dependency rail routing
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
