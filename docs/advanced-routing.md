[中文](./advanced-routing.zh-CN.md) · [Back to README](../README.md)

# Dense Routing Controls

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

## Short-orthogonal-jumps contract (#84)

| Constraint | Severity |
|---|---|
| Route may not enter foreign node / title / evidence hard boxes | **hard** |
| Prefer minimal length among 0–2 bend orthogonal candidates between attach slots (25%/50%/75% per side) | **objective** |
| Edge–edge crossings allowed when marked in `edgeCrossings` (`jump` / `gap` / `bridge`) | **soft / visualized** |
| Detour ratio `routeLength/direct > maxDetourRatio` (default **3**) | **reject candidate** |
| 2-point `route_obstacle_fallback` through hard obstacles | **never deliverable** |

Public helpers: `attachSlotFractions(3) → [0.25, 0.5, 0.75]`, `attachSlotsForBox(box, side, 3)`.
`attachSlotFractions(2) → [0.25, 0.75]` (not 1/3–2/3).

## Named port equal-division docking (#91)

| Ports on one side | Fractions |
|---|---|
| 1 | `{0.5}` |
| 2 | `{0.25, 0.75}` |
| 3 | `{0.25, 0.5, 0.75}` |
| n > 3 | `(i+1)/(n+1)` |

Named `portId` endpoints pin to `port.anchor`. Spacing below `minPortSpacing` grows the node before layout (info `port_capacity_overflow`) — never silent mid-stack; `portShifting: { enabled: false }` keeps every port at its side's middle. `portGeometry` only pins the matching side (other cardinals stay on node geometry).

## Readable Short-Orthogonal Pipeline (RSOP, #86 / #92–#95)

For `short-orthogonal-jumps`:

1. Pre-route same-side slots for anonymous endpoints, ordered by where the other end lies and placed between the side's named ports (never on a port's fraction).
2. 0–2 bend candidates per slot pair: the midline, escape stubs, and middle channels swept past neighbouring obstacles; soft-text micro-clear (node hard / text soft); an end that runs along its node's border instead of leaving along the side's normal costs more than a text hit.
3. A slot whose side is walled off (nodes in between, port labels) is retried on the node's other sides at a free fraction.
4. Accepted geometry never enters a foreign node, zone or hard text (#95). If no 0–2 bend route clears, `degraded-ok` pages take an obstacle-avoiding route within `maxDetourRatio` (≤6 bends, `routing.short-orthogonal.obstacle-fallback`); `strict` pages report `routing.obstacle.unavoidable` / unsatisfiable.
5. Edge separation spreads collinear interior segments into parallel tracks before labels are placed, keeping clear of every route's end segments (overlapping parallels and shared endpoints are 0 on the dense MBSE pages).
6. Refresh `edgeCrossings` for exporters.

`rsopChannelNudge: true` additionally runs the greedy Left-Edge channel track assignment + nudge (`idealNudgingDistance`, default **10**; MLCM / metro-line LP deferred). Track/slot/port exhaustion emits `routing.channel.capacity_exhausted` or `routing.port.capacity_exhausted` → rail/page-split / grow remediation — never `route_obstacle_fallback` flyers.

## External label shelves (#93)

Without `pageBounds` external label callouts stack in a column right of the drawing. With `pageBounds` they are packed in reading order into columns inside the page: a callout never overlaps another callout, a key, a node, a group, a table/matrix or an evidence panel, and a row is never reused. Callouts that find no free spot stay on their edge and `routing.label-shelf.capacity_exhausted` reports how many (the `external-label` plan's `detail.unplacedCount`). Keys of crowded labels move along their own edge until they clear the other keys and routes.

Solved diagrams may include `edgeCrossings: [{ x, y, underEdgeId, overEdgeId, style }]`. SVG, Excalidraw, and draw.io (`exportDrawio` / `--format drawio`) render hops from that IR.

## Edge distribution defaults

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

## Pretext sizing + semantic roles (#84 A/D)

- Node boxes grow from Pretext measurement + padding. Caller `size` is a **floor**, not a truncate cap. `label.maxWidth` only controls wrapping.
- Pretext measures with the canvas fonts it is given. Pass the font files the diagram is drawn with (`--font NotoSansSC.otf`, repeatable, `Family=file` to name one; `fonts` in `renderDiagramDsl`, or `registerFonts()`) and labels are measured exactly; a registered CJK family goes first in the CJK font stack. Without the real fonts (a Node canvas falls back to whatever is installed, which measured ideographs about 25% narrow here), full-width CJK characters count exactly 1 em — true of every mainstream CJK font — and Latin inside a CJK font stack gets a 6% allowance, so labels still fit. Line breaks follow the kinsoku rules (no line starts with `，。）」…`, none ends with `（「…`). The default CJK stack is `'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', sans-serif`.
- Under `deliverabilityMode`, `prefitLabelSize` defaults on (opt out with `prefitLabelSize: false`).
- Ellipse / `role: start|end` boxes become circles with `diameter = max(textWidth, textHeight) + padding`.
- Optional node `role` maps to fixed shapes (`start`/`end`→ellipse, `decision`→diamond, `process`→rounded-rectangle, `data`→cylinder, `concept`→rectangle). Explicit `shape` wins. Omit `role` on SysML blocks.

Use `fixedSwimlaneGeometry` with authored `box` values on swimlanes or lanes when downstream consumers need preserved container geometry. Use `anchorCapacity` for high fan-in/out nodes, `railRouting: dependency` for dense same-rank dependency pages, and `externalLabels` when downstream renderers should turn congested edge labels into keyed callouts.

`deliverabilityMode: strict` (equivalent to `strict: true`) requires clean geometry or structured `unsatisfiable` output with `remediationPlans`. `deliverabilityMode: degraded-ok` keeps advisory degraded output.

After the local route/label feedback loop exhausts, residual conflicts enter a bounded remediation pass (default 2 iterations). Apply order is grow → rails → external-label. With `pageSplit: auto`, a page that is still not clean afterwards is split into pages (see below).

## `remediationPolicy` apply matrix

| Key | `suggest` / `off` | `auto` |
|-----|-------------------|--------|
| `externalLabels` | Stage keyed-callout plans only | Apply deterministic keyed callouts and re-check clearance |
| `routeRails` | Stage dependency-rail plans only | Force dependency rails, re-route, mark `applied` or `blocked` |
| `growFixedGeometry` | Stage growth plans only | Apply growth deltas / expand nodes, re-route, mark `applied` or `blocked` |
| `pageSplit` | Stage machine-readable `required`/`available` plans | Split the page into 2–6 pages, solve each on its own, mark `applied` (with `pages` and `crossPageEdgeIds`) or `blocked` |

### Page split (`pageSplit: auto`)

A page is split when it stays over capacity after the other remedies (any residual deliverability conflict), or when `--page` fitting would draw its labels below 8px. Nodes that belong together stay on one page: a group with everything nested in it, a node with its children. Pages are runs of these units in the order the single-page solve placed them (along the flow, or across it when that cuts fewer edges), with unconnected parts kept apart so a boundary between them cuts nothing; the run boundaries cut as few edges as possible while keeping pages even. Each page is then solved on its own; swimlane pools keep all their lanes; frame title tabs and titles get "(2/3)". A cut edge is drawn on both pages and ends at an **off-page connector** naming the page and node on the other side ("→ P2 · Billing", "P1 · Orders →"; `metadata.offPageConnector`, `remotePage`, `remoteNodeId`).

The split is kept only if it leaves fewer conflicts (or larger readable text) than the single page; otherwise the plan is `blocked` with the reason and a `remediation.page-split.blocked` warning. The result is page 1 with `pages` (every page solved), a merged `deliverability` whose plans come with their page (`page-2-remediation-01-…`), and every page's diagnostics tagged with `detail.page`. Under `deliverabilityMode: strict`, conflicts left on any page are still errors (`routing.deliverability.unsatisfiable` with its page). Exporters draw every page: SVG stacks them (one nested `<svg class="page">` each, fitted to the paper on its own), draw.io writes one `<diagram>` tab per page, Excalidraw stacks them with `page-N:` id prefixes, and the geometry document carries `pages`.

Plan statuses are `suggested`, `applied`, or `blocked`. Under full-auto strict dense acceptance, auto-capable types must be `applied` or `blocked` (not left as `suggested`).

Solved diagrams keep the legacy `degraded`, `deliverability.status`, and `deliverability.remediationTypes` fields. They also expose deterministic `deliverability.remediationPlans` objects with stable IDs, type, status, diagnostic codes, edge/node IDs, and type-specific details so strict consumers can apply or stage remediation without parsing free-form diagnostic text.
