# Phase 02: Text, Labels, And Shape Geometry - Research

**Researched:** 2026-05-24 [VERIFIED: system date]
**Domain:** TypeScript text measurement, label fitting, deterministic shape geometry, container geometry [VERIFIED: .planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md]
**Confidence:** HIGH for module boundaries and geometry strategy; MEDIUM for real Pretext runtime behavior until a Canvas-capable Node/browser smoke environment is added [VERIFIED: npm registry + local Node smoke test]

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

## Implementation Decisions

### Text Measurement And Label Fitting

- **D-01:** Use a Pretext-style two-stage text measurement API: `prepare(text, font)` performs expensive text/font analysis and `layout(prepared, maxWidth, lineHeight)` performs cheap repeated layout calculations.
- **D-02:** Reuse `@chenglou/pretext` directly for text measurement and line breaking. Do not reimplement Pretext's multilingual text algorithms inside DGE unless a thin adapter or deterministic test fallback is needed.
- **D-03:** Provide a renderer-neutral `LabelLayout` result instead of SVG or HTML output. It should carry enough geometry for future SVG, HTML, Excalidraw, and other exporters to render labels without remeasuring text.
- **D-04:** `LabelLayout` should expose the fitted label box, content box, line records, font information, line height, padding, and overflow/truncation diagnostics where applicable.
- **D-05:** `LabelFitter` computes node dimensions from text layout plus padding, minimum size, and optional `maxWidth`. It should not own exporter-specific rendering rules.

### License And Attribution

- **D-06:** Use MIT license for auto-graph / DGE.
- **D-07:** Add README appreciation/credits for Pretext because DGE intentionally reuses Pretext's text measurement work instead of rebuilding it. `@chenglou/pretext` currently reports `MIT` license on npm.

### Shape Geometry Rules

- **D-08:** Phase 2 uses practical deterministic approximations for the seven v1 shapes: `rectangle`, `rounded-rectangle`, `ellipse`, `diamond`, `parallelogram`, `hexagon`, and `cylinder`.
- **D-09:** Every supported shape must compute an outer `Box`, center, standard anchors, expanded obstacle/collision boxes, and deterministic edge entry/exit approximations sufficient for later routing.
- **D-10:** Practical approximation is not the final long-term shape model. Planning should leave clear extension points and explicit design debt for later precise boundary intersection calculations, especially for ellipse, diamond, hexagon, parallelogram, and cylinder.
- **D-11:** Keep shape geometry renderer-neutral. Do not add SVG path strings, Excalidraw element fields, CSS, HTML, Mermaid, or draw.io output fields to Phase 2 geometry APIs.

### Container And Group Geometry

- **D-12:** Container/group geometry is in scope when child boxes are already known. Given child boxes, padding, optional label/header, and minimum size, Phase 2 should compute the container outer box, content box, label layout, anchors, and obstacle/collision box.
- **D-13:** Automatic child placement inside containers is out of scope. Phase 3 owns containment constraint solving, auto-placement, and conflict diagnostics for children that need layout.
- **D-14:** Container geometry should use the same calculation chain as normal nodes: text measurement -> label layout -> intrinsic size / child bounds -> box -> anchors -> obstacle box.

### Verification And Phase Boundary

- **D-15:** Do not generate SVG in Phase 2 just to test labels. Repeated SVG generation would move cost and responsibility into the exporter layer too early.
- **D-16:** Verify Phase 2 with numeric tests and HTML/SVG-safe layout contracts: text line boxes, bounds, padding, min/max width, overflow diagnostics, shape anchors, collision boxes, and container geometry should be asserted directly.
- **D-17:** Real SVG golden tests belong to Phase 4. Phase 2 should produce layout data that an SVG or HTML exporter can consume safely without remeasurement.

### Claude's Discretion

- Exact TypeScript names are flexible if the prepare/layout separation, renderer-neutral label result, and container boundary are preserved.
- The fallback text measurer design is flexible, but it must be deterministic and test-friendly rather than a second full text engine.
- The exact numeric tolerance strategy is flexible, but tests must make drift visible and not rely on visual inspection.

### Deferred Ideas (OUT OF SCOPE)

- Precise mathematical boundary intersection for all non-rectangular shapes belongs after the practical Phase 2 approximation path is stable.
- Automatic child placement inside containers and containment constraint solving belong to Phase 3.
- Real SVG golden output checks belong to Phase 4.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TXT-01 | Developer can measure labels through a `TextMeasurer` interface with a Pretext-backed default implementation. [VERIFIED: .planning/REQUIREMENTS.md] | Use `src/text/` with a two-stage `TextMeasurer` interface, `PretextTextMeasurer`, and `DeterministicTextMeasurer` fallback. [VERIFIED: npm registry + package tarball d.ts] |
| TXT-02 | User can rely on label fitting to compute node width and height from text, font options, padding, minimum size, and optional max width. [VERIFIED: .planning/REQUIREMENTS.md] | Use `LabelFitter.fit()` to compose text layout, padding, min size, `maxWidth`, `contentBox`, fitted `box`, line records, and diagnostics. [VERIFIED: .planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md] |
| TXT-03 | The engine handles multiline and non-English labels well enough that SVG output does not visibly overflow normal node bounds in fixture tests. [VERIFIED: .planning/REQUIREMENTS.md] | Use Pretext for real multilingual line breaking where Canvas exists, and use numeric multilingual fixtures with bounded fallback tolerance in default CI. [VERIFIED: npm readme + local Node smoke test] |
| GEO-01 | Developer can compute bounds, center, cardinal anchors, and diagonal anchors for rectangle, rounded rectangle, ellipse, diamond, parallelogram, hexagon, and cylinder nodes. [VERIFIED: .planning/REQUIREMENTS.md] | Implement `src/geometry/shapes.ts` around existing `Box`, `Point`, `AnchorName`, and `AnchorPoint` contracts. [VERIFIED: src/ir/geometry.ts + src/ir/elements.ts] |
| GEO-02 | Developer can detect AABB collisions and expanded obstacle boxes with configurable margins. [VERIFIED: .planning/REQUIREMENTS.md] | Implement `src/geometry/boxes.ts` with `expandBox`, `intersectsAabb`, `unionBoxes`, and deterministic margin handling. [VERIFIED: .planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md] |
| GEO-03 | Developer can compute edge entry and exit points from shape geometry without manually guessing coordinates. [VERIFIED: .planning/REQUIREMENTS.md] | Implement practical edge-port approximations using anchor names, direction vectors, and deterministic ray-to-AABB/shape approximations without full routing. [VERIFIED: .planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md] |
</phase_requirements>

## Summary

Phase 2 should be planned as a prepare-layer geometry package, not as a renderer or layout solver. [VERIFIED: .planning/PROJECT.md + 02-CONTEXT.md] The concrete implementation path is: add text measurement contracts and adapters, add label fitting around `LabelLayout`, add reusable box utilities, add seven-shape geometry helpers, then add container geometry from already-known child boxes. [VERIFIED: existing `src/ir/*` contracts + 02-CONTEXT.md]

The highest-risk dependency is `@chenglou/pretext`: the package is current at `0.0.7`, MIT licensed, ESM-only, and exposes the exact `prepareWithSegments()` / `layoutWithLines()` / `measureLineStats()` / `measureNaturalWidth()` APIs Phase 2 needs. [VERIFIED: npm registry + package tarball d.ts] However, the current local Node `v24.13.0` runtime has `Intl.Segmenter` but no global `OffscreenCanvas`, and a direct Pretext `prepareWithSegments()` smoke test fails with `Text measurement requires OffscreenCanvas or a DOM canvas context.` [VERIFIED: local Node smoke test] Therefore the plan must include a deterministic fallback measurer for default CI and a separate Pretext adapter smoke/integration path that is skipped or guarded when Canvas 2D is unavailable. [VERIFIED: local Node smoke test]

**Primary recommendation:** Plan three implementation slices: `text + labels`, `box + shape geometry`, and `container geometry + fixture validation`; keep all APIs renderer-neutral and export them only through `src/index.ts`. [VERIFIED: Phase 1 verification + 02-CONTEXT.md]

## Project Constraints (from AGENTS.md)

| Directive | Planning Impact |
|-----------|-----------------|
| Shell commands must use `rtk`. [VERIFIED: AGENTS.md + /home/zhangyangrui/.codex/RTK.md] | All verification commands in plans should be written as `rtk npm test -- ...`, `rtk npm run typecheck`, and `rtk npm run verify`. [VERIFIED: /home/zhangyangrui/.codex/RTK.md] |
| Runtime is TypeScript on Node.js first. [VERIFIED: AGENTS.md] | Do not plan Python subprocess measurement or browser-only tests for Phase 2 default path. [VERIFIED: AGENTS.md + .planning/research/STACK.md] |
| Prepare/solve/export separation is mandatory. [VERIFIED: AGENTS.md] | Text measurement and label/shape geometry belong before Phase 3 layout/routing and before Phase 4 exporters. [VERIFIED: ROADMAP.md] |
| Text measurement must be abstracted behind an interface. [VERIFIED: AGENTS.md] | `@chenglou/pretext` must be an adapter, not a hard-coded call inside label fitting. [VERIFIED: 02-CONTEXT.md] |
| Golden tests must catch text overflow, connector misalignment, collisions, non-deterministic output, and malformed exports. [VERIFIED: AGENTS.md] | Phase 2 should create numeric fixtures for labels/shapes/collisions and leave exporter golden tests to Phase 4. [VERIFIED: 02-CONTEXT.md] |
| Do not make direct repo edits outside GSD workflow unless explicitly bypassed. [VERIFIED: AGENTS.md] | Plan tasks should be small, verifiable, and compatible with `$gsd-execute-phase`. [VERIFIED: AGENTS.md] |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Text measurement abstraction | Core library prepare tier | External Pretext adapter | Phase 2 owns label measurement contracts; Pretext provides measurement and line breaking where runtime supports Canvas. [VERIFIED: 02-CONTEXT.md + npm readme] |
| Label fitting | Core library prepare tier | Future exporters consume output | Label boxes and line records must be computed before layout and must not be recomputed by SVG/Excalidraw exporters. [VERIFIED: 02-CONTEXT.md + .planning/research/ARCHITECTURE.md] |
| Shape anchors and obstacles | Core geometry tier | Future routing consumes output | Phase 3 routing needs anchors and obstacle boxes; Phase 2 should provide deterministic geometry primitives only. [VERIFIED: ROADMAP.md + 02-CONTEXT.md] |
| Container geometry from known child boxes | Core geometry tier | Future constraint solver | Known child-box aggregation is Phase 2; automatic child placement and containment solving are Phase 3. [VERIFIED: 02-CONTEXT.md] |
| Numeric fixture serialization | Test/serialization support tier | Canonical serializer | Existing `stringifyCanonical()` gives stable numeric fixture output with 3-decimal rounding. [VERIFIED: src/serialization/canonical.ts + 01-VERIFICATION.md] |

## Recommended Module/File Breakdown

```text
src/
├── text/
│   ├── types.ts              # TextOptions, PreparedTextLayout, TextMeasurer
│   ├── fallback.ts           # deterministic CI-safe fallback measurer
│   ├── pretext.ts            # @chenglou/pretext adapter behind availability checks
│   └── index.ts              # public text barrel
├── labels/
│   ├── types.ts              # LabelLayout, LabelLine, LabelFitOptions, diagnostics
│   ├── fit.ts                # LabelFitter and pure fitLabel helper
│   └── index.ts
├── geometry/
│   ├── boxes.ts              # AABB, expand, union, center, normalize insets
│   ├── shapes.ts             # seven v1 shape geometry helpers
│   ├── containers.ts         # container/group geometry from child boxes
│   └── index.ts
└── index.ts                  # re-export ir, serialization, text, labels, geometry

test/
├── text-measurer.test.ts
├── label-fitting.test.ts
├── shape-geometry.test.ts
├── box-geometry.test.ts
├── container-geometry.test.ts
└── fixtures/
    └── phase-02/
        ├── labels.canonical.json
        ├── shapes.canonical.json
        └── containers.canonical.json
```

This structure extends the Phase 1 single-package layout and keeps root-only public exports. [VERIFIED: package.json + src/index.ts + 01-VERIFICATION.md]

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 6.0.3 in project devDependencies [VERIFIED: package.json] | Strict public contracts for geometry, text, and layout records. [VERIFIED: package.json + tsconfig from 01-VERIFICATION.md] | Existing project scaffold already uses strict TypeScript and root entrypoint exports. [VERIFIED: 01-VERIFICATION.md] |
| Node.js | Project engine `>=20`; local runtime `v24.13.0` [VERIFIED: package.json + local `node --version`] | Runtime for tests and package code. [VERIFIED: package.json] | Project is Node-first and Pretext/Dagre are npm-native. [VERIFIED: AGENTS.md + .planning/research/STACK.md] |
| `@chenglou/pretext` | `0.0.7`, published 2026-05-10, MIT [VERIFIED: npm registry] | Default real text measurement and line breaking adapter. [VERIFIED: npm readme + tarball d.ts] | Exposes `prepareWithSegments`, `layoutWithLines`, `measureLineStats`, and `measureNaturalWidth`, matching Phase 2 needs. [VERIFIED: package tarball d.ts] |
| Vitest | 4.1.7 in project devDependencies [VERIFIED: package.json + `npx vitest --version`] | Numeric unit tests and canonical fixture checks. [VERIFIED: vitest.config.ts + 01-VERIFICATION.md] | Existing test suite uses Vitest with Node environment. [VERIFIED: vitest.config.ts + test/*.test.ts] |
| Existing canonical serializer | `DEFAULT_CANONICAL_PRECISION = 3` [VERIFIED: src/serialization/canonical.ts] | Stable JSON fixtures for numeric geometry output. [VERIFIED: 01-VERIFICATION.md] | Existing tests prove stable sorting, numeric rounding, anchor sorting, and point-order preservation. [VERIFIED: test/serialization.test.ts] |

### Supporting

| Library/Tool | Version | Purpose | When to Use |
|--------------|---------|---------|-------------|
| `@dagrejs/dagre` | `3.0.0`, MIT, modified 2026-03-22 [VERIFIED: npm registry] | Phase 3 directed graph layout. [VERIFIED: ROADMAP.md] | Do not add in Phase 2 unless a plan explicitly needs forward type compatibility; it is not required for label/shape geometry. [VERIFIED: 02-CONTEXT.md] |
| Biome | 2.4.15 [VERIFIED: package.json] | Lint and formatting gate. [VERIFIED: package.json] | Run through `rtk npm run lint` and full `rtk npm run verify`. [VERIFIED: package.json + RTK.md] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Pretext adapter | Browser DOM/SVG measurement | Violates Node-first and renderer-neutral Phase 2 constraints. [VERIFIED: AGENTS.md + 02-CONTEXT.md] |
| Pretext in default CI only | Deterministic fallback as default test path plus guarded Pretext smoke | Current local Node lacks `OffscreenCanvas`, so unconditional Pretext tests fail. [VERIFIED: local Node smoke test] |
| Exact analytic shape boundary intersections | Practical deterministic approximation | Exact non-rectangular math is explicitly deferred; practical approximations satisfy Phase 2 routing handoff. [VERIFIED: 02-CONTEXT.md] |
| SVG snapshot tests | Numeric `LabelLayout` and geometry fixtures | Phase 2 is explicitly forbidden from generating SVG just to test labels. [VERIFIED: 02-CONTEXT.md] |

**Installation:**

```bash
rtk npm install @chenglou/pretext
```

Add `README.md` and `LICENSE` tasks if they do not already exist, because `package.json` lists both files but local `rtk ls README.md LICENSE` reported neither file. [VERIFIED: package.json + local file check]

## Dependency Guidance: `@chenglou/pretext`

Use the root ESM import only. [VERIFIED: npm exports]

```typescript
import {
  layoutWithLines,
  measureLineStats,
  measureNaturalWidth,
  prepareWithSegments,
  type LayoutLine,
  type PreparedTextWithSegments,
} from "@chenglou/pretext";
```

Plan around these upstream facts:

| Fact | Planning Consequence |
|------|----------------------|
| `@chenglou/pretext` exports only ESM/default import paths for the root package; no CJS `require` export is listed. [VERIFIED: npm registry + package.json tarball] | DGE source is ESM and tsup can build CJS output, but implementation should keep Pretext isolated in `src/text/pretext.ts` so CJS packaging can be verified separately. [VERIFIED: package.json] |
| Upstream type entry is `./dist/layout.d.ts`. [VERIFIED: npm registry + package tarball] | Do not invent local Pretext types; import upstream types where useful, but hide them behind DGE-owned public interfaces. [VERIFIED: package tarball d.ts] |
| Upstream `prepareWithSegments(text, font, options?)` returns `PreparedTextWithSegments`; `layoutWithLines(prepared, maxWidth, lineHeight)` returns line text, width, start cursor, and end cursor. [VERIFIED: package tarball d.ts] | DGE `PreparedTextLayout` can store the upstream opaque handle internally while public `LabelLayout` stores renderer-neutral line records. [VERIFIED: package tarball d.ts] |
| Upstream `measureNaturalWidth()` and `measureLineStats()` exist. [VERIFIED: package tarball d.ts] | `LabelFitter` can compute shrink-wrap width and line count without materializing lines during candidate-width checks. [VERIFIED: npm readme] |
| Upstream README states runtime requires `Intl.Segmenter` and Canvas 2D text measurement. [VERIFIED: npm readme] | Add `isPretextRuntimeAvailable()` or a guarded constructor failure with diagnostic `text.pretext.runtime-unavailable`. [VERIFIED: local Node smoke test] |
| Local Node has `Intl.Segmenter` but no global `OffscreenCanvas`, and direct Pretext measurement fails. [VERIFIED: local Node smoke test] | Default unit tests should use `DeterministicTextMeasurer`; Pretext tests should skip when Canvas is unavailable or run under a future Canvas-capable harness. [VERIFIED: local Node smoke test] |
| Pretext license is MIT with copyright notice for Pretext contributors. [VERIFIED: package tarball LICENSE] | Add DGE MIT `LICENSE`, keep dependency license attribution in README/credits, and do not paste Pretext source. [VERIFIED: 02-CONTEXT.md + tarball LICENSE] |

## Architecture Patterns

### System Architecture Diagram

```text
Label intent + font options + sizing constraints
  -> TextMeasurer.prepare(text, font)
       -> Pretext adapter when Canvas 2D is available
       -> deterministic fallback for default tests
  -> TextMeasurer.layout(prepared, maxWidth, lineHeight)
  -> LabelFitter.fit(...)
       -> contentBox
       -> fitted label box
       -> line records
       -> overflow diagnostics
  -> ShapeGeometry.compute(shape, box)
       -> center + anchors
       -> obstacle box + edge ports
  -> ContainerGeometry.compute(childBoxes, padding, optional label)
       -> union child bounds
       -> label/header reservation
       -> outer/content boxes + anchors + obstacle
  -> Phase 3 layout/routing consumes measured sizes, anchors, and obstacles
  -> Phase 4 exporters render without remeasurement
```

This data flow matches prepare/solve/export separation and keeps Phase 2 before Dagre layout and exporters. [VERIFIED: .planning/research/ARCHITECTURE.md + ROADMAP.md]

### Pattern 1: Two-Stage TextMeasurer

**What:** Split expensive text/font analysis from repeated width-constrained layout. [VERIFIED: npm readme + 02-CONTEXT.md]

**When to use:** Use `prepare()` once per text/font/options tuple and `layout()` for each max-width candidate during label fitting. [VERIFIED: npm readme]

```typescript
export interface TextStyleOptions {
  fontFamily: string;
  fontSize: number;
  fontWeight?: number | string;
  fontStyle?: "normal" | "italic";
  lineHeight?: number;
  letterSpacing?: number;
  whiteSpace?: "normal" | "pre-wrap";
  wordBreak?: "normal" | "keep-all";
}

export interface PreparedText {
  text: string;
  font: string;
  style: TextStyleOptions;
  backend: "pretext" | "deterministic";
}

export interface TextLayoutLine {
  text: string;
  width: number;
  start: { segmentIndex: number; graphemeIndex: number };
  end: { segmentIndex: number; graphemeIndex: number };
}

export interface TextLayout {
  width: number;
  height: number;
  lineHeight: number;
  lineCount: number;
  lines: TextLayoutLine[];
}

export interface TextMeasurer {
  prepare(text: string, style: TextStyleOptions): PreparedText;
  layout(prepared: PreparedText, maxWidth: number, lineHeight?: number): TextLayout;
  naturalWidth(prepared: PreparedText): number;
}
```

The public interface is DGE-owned so upstream Pretext type changes do not leak into coordinated IR. [VERIFIED: package tarball d.ts + Phase 1 public API pattern]

### Pattern 2: Renderer-Neutral LabelLayout

**What:** Return text geometry, not markup. [VERIFIED: 02-CONTEXT.md]

**When to use:** Use it as the handoff from label fitting to shape sizing, future coordinated IR, and future exporters. [VERIFIED: .planning/research/ARCHITECTURE.md]

```typescript
export interface LabelFitOptions {
  font: TextStyleOptions;
  padding: Insets | number;
  minSize?: Partial<Size>;
  maxWidth?: number;
  overflow?: "allow" | "diagnose" | "truncate";
}

export interface LabelLineLayout {
  text: string;
  box: Box;
  baselineY: number;
  width: number;
  lineIndex: number;
  sourceStart?: { segmentIndex: number; graphemeIndex: number };
  sourceEnd?: { segmentIndex: number; graphemeIndex: number };
}

export interface LabelLayout {
  text: string;
  box: Box;
  contentBox: Box;
  naturalSize: Size;
  fittedSize: Size;
  padding: Insets;
  font: TextStyleOptions;
  lineHeight: number;
  lines: LabelLineLayout[];
  overflow: {
    horizontal: boolean;
    vertical: boolean;
    truncated: boolean;
  };
  diagnostics: Diagnostic[];
}
```

`LabelLayout.box` should use local coordinates with `x = 0` and `y = 0` during fitting; later placement can translate it into coordinated space. [VERIFIED: existing `Box` contract + 02-CONTEXT.md]

### Pattern 3: Label Fitting Math

**What:** Compose text layout, padding, min size, and optional max width deterministically. [VERIFIED: 02-CONTEXT.md]

**Recommended formula:**

```text
resolvedPadding = normalizeInsets(options.padding)
textMaxWidth = max(0, options.maxWidth - resolvedPadding.left - resolvedPadding.right)
textLayout = measurer.layout(prepared, textMaxWidth, lineHeight)
contentWidth = textLayout.width
contentHeight = textLayout.height
rawWidth = contentWidth + padding.left + padding.right
rawHeight = contentHeight + padding.top + padding.bottom
fittedWidth = max(rawWidth, minWidth)
fittedHeight = max(rawHeight, minHeight)
contentBox.x = padding.left + horizontalAlignmentOffset
contentBox.y = padding.top + verticalAlignmentOffset
```

This keeps line records relative to `contentBox` and leaves renderer-specific alignment to future exporters. [VERIFIED: 02-CONTEXT.md]

### Pattern 4: Practical Shape Geometry

**What:** Use deterministic box-based and simple polygon approximations for v1. [VERIFIED: 02-CONTEXT.md]

**Anchor baseline:** Every shape returns `center`, `top`, `right`, `bottom`, `left`, `top-left`, `top-right`, `bottom-right`, and `bottom-left`. [VERIFIED: src/ir/geometry.ts + 02-CONTEXT.md]

| Shape | Anchors | Obstacle | Edge Entry/Exit Approximation |
|-------|---------|----------|-------------------------------|
| rectangle | AABB corners and side midpoints. [VERIFIED: geometry convention in design doc] | Outer box expanded by margin. [VERIFIED: 02-CONTEXT.md] | Ray from center to target clipped to AABB. [ASSUMED] |
| rounded-rectangle | Same as rectangle for v1. [VERIFIED: 02-CONTEXT.md practical approximation] | Same AABB; corner radius does not shrink obstacle. [ASSUMED] | Same as rectangle; record design debt for future corner-aware math. [VERIFIED: 02-CONTEXT.md] |
| ellipse | Cardinal points on ellipse; diagonal anchors use 45-degree parametric points. [ASSUMED] | AABB expanded by margin. [VERIFIED: 02-CONTEXT.md] | Ray/ellipse intersection when cheap; fallback to AABB if not implemented in first task. [ASSUMED] |
| diamond | Cardinal vertices and AABB corners as diagonal anchor names. [ASSUMED] | AABB expanded by margin. [VERIFIED: 02-CONTEXT.md] | Ray/diamond intersection using `abs(dx)/(w/2) + abs(dy)/(h/2) = 1`, or nearest cardinal anchor fallback. [ASSUMED] |
| parallelogram | AABB side midpoints plus skewed polygon corners. [ASSUMED] | AABB expanded by margin. [VERIFIED: 02-CONTEXT.md] | Polygon ray intersection if simple helper exists; otherwise nearest anchor approximation. [ASSUMED] |
| hexagon | Six-side polygon inside AABB; cardinal anchors remain stable. [ASSUMED] | AABB expanded by margin. [VERIFIED: 02-CONTEXT.md] | Polygon ray intersection if simple helper exists; otherwise nearest anchor approximation. [ASSUMED] |
| cylinder | AABB plus top/bottom ellipse visual approximation only in later exporters. [VERIFIED: 02-CONTEXT.md renderer-neutral rule] | AABB expanded by margin. [VERIFIED: 02-CONTEXT.md] | Rectangle-like ports for v1; precise cylinder cap entry is deferred. [ASSUMED] |

The planner should add a `GeometryDebt` or documented comment for non-rectangular exact-boundary work so Phase 3/4 do not assume the approximation is final. [VERIFIED: 02-CONTEXT.md]

### Pattern 5: Container Geometry From Known Child Boxes

**What:** Compute group/container geometry by unioning existing child boxes and adding padding plus optional label/header. [VERIFIED: 02-CONTEXT.md]

**Recommended formula:**

```text
childUnion = unionBoxes(childBoxes)
label = optional label layout
headerHeight = label ? label.fittedSize.height : 0
innerX = childUnion.x - padding.left
innerY = childUnion.y - padding.top - headerHeight
innerRight = childUnion.x + childUnion.width + padding.right
innerBottom = childUnion.y + childUnion.height + padding.bottom
outerWidth = max(innerRight - innerX, minWidth)
outerHeight = max(innerBottom - innerY, minHeight)
contentBox = box containing children after padding/header reservation
anchors = rectangle-like anchors from outer box
obstacle = expandBox(outerBox, margin)
```

Do not place children, move children, or solve containment conflicts in Phase 2. [VERIFIED: 02-CONTEXT.md]

## API Contracts To Plan Around

```typescript
export function normalizeInsets(input?: Insets | number): Insets;
export function boxCenter(box: Box): Point;
export function expandBox(box: Box, margin: number | Insets): Box;
export function unionBoxes(boxes: readonly Box[]): Box;
export function intersectsAabb(a: Box, b: Box): boolean;
```

These utilities should be pure, deterministic, and throw or diagnose empty/invalid input explicitly. [VERIFIED: deterministic project constraints + 01-VERIFICATION.md]

```typescript
export interface ShapeGeometryInput {
  shape: NodeShape;
  box: Box;
  obstacleMargin?: number | Insets;
}

export interface ShapeGeometry {
  shape: NodeShape;
  box: Box;
  center: Point;
  anchors: AnchorPoint[];
  obstacleBox: Box;
}

export function computeShapeGeometry(input: ShapeGeometryInput): ShapeGeometry;

export function getEdgePort(
  geometry: ShapeGeometry,
  toward: Point,
  preferredAnchor?: AnchorName,
): Point;
```

Use `NodeShape`, `AnchorName`, `AnchorPoint`, `Box`, `Point`, `Insets`, and `Size` from the existing IR rather than duplicating type aliases. [VERIFIED: src/ir/geometry.ts + src/ir/elements.ts]

```typescript
export interface ContainerGeometryInput {
  id: string;
  childBoxes: readonly Box[];
  padding: Insets | number;
  label?: Label;
  labelLayout?: LabelLayout;
  minSize?: Partial<Size>;
  obstacleMargin?: number | Insets;
}

export interface ContainerGeometry {
  id: string;
  box: Box;
  contentBox: Box;
  childBounds: Box;
  labelLayout?: LabelLayout;
  anchors: AnchorPoint[];
  obstacleBox: Box;
  diagnostics: Diagnostic[];
}
```

Container geometry should accept an already-computed `labelLayout` or a label plus fitter dependency; planning should avoid circular imports between `labels` and `geometry`. [ASSUMED]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Multilingual segmentation and line breaking | Custom CJK/Arabic/emoji/grapheme line breaker | `@chenglou/pretext` adapter where runtime supports it | Pretext already implements multiline measurement APIs and multilingual line-breaking support. [VERIFIED: npm readme] |
| Renderer output in Phase 2 | SVG text, Excalidraw text elements, draw.io styles | Renderer-neutral `LabelLayout` | Phase 2 must not generate SVG and future exporters must not remeasure. [VERIFIED: 02-CONTEXT.md] |
| Full non-rectangular computational geometry | Exact intersections for every shape edge | Practical deterministic v1 approximations plus documented debt | Exact shape math is deferred by Phase 2 decisions. [VERIFIED: 02-CONTEXT.md] |
| Layout/containment solver | Moving children to fit groups | Container geometry from known child boxes only | Phase 3 owns auto placement and containment solving. [VERIFIED: 02-CONTEXT.md] |
| Routing engine | Orthogonal/A* routing | Edge entry/exit port approximations only | Phase 3 owns routing. [VERIFIED: ROADMAP.md + 02-CONTEXT.md] |

**Key insight:** Phase 2's value is stable geometry contracts; overbuilding renderers, routing, or exact shape math will make Phase 3/4 less clear rather than more capable. [VERIFIED: 02-CONTEXT.md + .planning/research/PITFALLS.md]

## Common Pitfalls

### Pitfall 1: Pretext Import Works But Measurement Fails

**What goes wrong:** Tests import `@chenglou/pretext` successfully, then fail at `prepare()` in Node without Canvas 2D. [VERIFIED: local Node smoke test]

**Why it happens:** Pretext requires `Intl.Segmenter` and Canvas 2D text measurement; local Node has `Intl.Segmenter` but no global `OffscreenCanvas`. [VERIFIED: npm readme + local Node runtime probe]

**How to avoid:** Implement `DeterministicTextMeasurer` first, then `PretextTextMeasurer` with runtime availability guard and skipped smoke tests when Canvas is missing. [VERIFIED: local Node smoke test]

**Warning signs:** `Text measurement requires OffscreenCanvas or a DOM canvas context.` [VERIFIED: local Node smoke test]

### Pitfall 2: LabelLayout Leaks Renderer Semantics

**What goes wrong:** Label APIs start exposing SVG `<tspan>`, CSS, HTML, or Excalidraw-specific fields. [VERIFIED: 02-CONTEXT.md]

**Why it happens:** It is tempting to test labels by generating SVG in Phase 2. [VERIFIED: 02-CONTEXT.md]

**How to avoid:** Assert `LabelLayout` numeric boxes and line records directly and add grep checks against renderer terms in `src/text`, `src/labels`, and `src/geometry`. [VERIFIED: 01-VERIFICATION.md renderer creep scan pattern]

**Warning signs:** `svg`, `html`, `css`, `excalidraw`, `drawio`, or `mermaid` appears in Phase 2 core modules. [VERIFIED: 01-VERIFICATION.md]

### Pitfall 3: Fallback Measurer Becomes A Second Text Engine

**What goes wrong:** The fallback tries to recreate multilingual line breaking and drifts from Pretext behavior. [VERIFIED: 02-CONTEXT.md]

**Why it happens:** TXT-03 creates pressure to pass multilingual fixtures even without Canvas. [VERIFIED: .planning/REQUIREMENTS.md + local Node smoke test]

**How to avoid:** Make fallback deterministic and conservative, document that it is a test/backend fallback, and keep real multilingual behavior delegated to Pretext when runtime supports it. [VERIFIED: 02-CONTEXT.md + npm readme]

**Warning signs:** Fallback code grows language-specific rules or large Unicode tables. [ASSUMED]

### Pitfall 4: Shape Approximation Debt Becomes Invisible

**What goes wrong:** Later routing/export phases assume v1 approximation equals exact visual boundary. [VERIFIED: 02-CONTEXT.md]

**Why it happens:** AABB obstacles are enough for collisions but not exact for ellipses, diamonds, hexagons, parallelograms, or cylinders. [VERIFIED: 02-CONTEXT.md]

**How to avoid:** Name functions as practical approximations where appropriate and test anchor/port contract rather than pixel-perfect shape boundary. [VERIFIED: 02-CONTEXT.md]

**Warning signs:** Tests assert SVG path-level boundary behavior in Phase 2. [VERIFIED: 02-CONTEXT.md]

### Pitfall 5: Container Geometry Slips Into Layout Solving

**What goes wrong:** Container code starts moving children, resolving conflicts, or applying containment constraints. [VERIFIED: 02-CONTEXT.md]

**Why it happens:** Group bounds and containment are conceptually close but belong to different phases. [VERIFIED: ROADMAP.md + 02-CONTEXT.md]

**How to avoid:** Container geometry takes child boxes as input and returns only aggregate boxes, anchors, and diagnostics. [VERIFIED: 02-CONTEXT.md]

**Warning signs:** Container module imports Dagre, constraints solver code, or routing code. [VERIFIED: ROADMAP.md]

## Code Examples

### Pretext Adapter Shape

```typescript
import {
  layoutWithLines,
  measureNaturalWidth,
  prepareWithSegments,
  type PreparedTextWithSegments,
} from "@chenglou/pretext";

type PretextPreparedText = PreparedText & {
  backend: "pretext";
  handle: PreparedTextWithSegments;
};

export class PretextTextMeasurer implements TextMeasurer {
  prepare(text: string, style: TextStyleOptions): PretextPreparedText {
    const font = toCanvasFont(style);
    const handle = prepareWithSegments(text, font, {
      letterSpacing: style.letterSpacing,
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
    });

    return { text, font, style, backend: "pretext", handle };
  }

  layout(prepared: PretextPreparedText, maxWidth: number, lineHeight = resolveLineHeight(prepared.style)): TextLayout {
    const result = layoutWithLines(prepared.handle, maxWidth, lineHeight);
    return {
      width: Math.max(0, ...result.lines.map((line) => line.width)),
      height: result.height,
      lineHeight,
      lineCount: result.lineCount,
      lines: result.lines,
    };
  }

  naturalWidth(prepared: PretextPreparedText): number {
    return measureNaturalWidth(prepared.handle);
  }
}
```

Source: Pretext root README API and tarball `layout.d.ts`. [VERIFIED: npm readme + package tarball d.ts]

### Deterministic Fallback Contract

```typescript
export class DeterministicTextMeasurer implements TextMeasurer {
  prepare(text: string, style: TextStyleOptions): PreparedText {
    return {
      text,
      font: toCanvasFont(style),
      style,
      backend: "deterministic",
    };
  }

  layout(prepared: PreparedText, maxWidth: number, lineHeight = resolveLineHeight(prepared.style)): TextLayout {
    const widthPerGrapheme = prepared.style.fontSize * 0.6;
    const segments = splitFallbackSegments(prepared.text);
    const lines = wrapFallbackSegments(segments, maxWidth, widthPerGrapheme);

    return materializeFallbackLayout(lines, lineHeight);
  }

  naturalWidth(prepared: PreparedText): number {
    return splitFallbackHardLines(prepared.text)
      .reduce((max, line) => Math.max(max, fallbackLineWidth(line, prepared.style)), 0);
  }
}
```

The numeric constants must be documented as deterministic fallback behavior, not as typographic truth. [VERIFIED: 02-CONTEXT.md]

### Shape Geometry Helper

```typescript
export function computeShapeGeometry(input: ShapeGeometryInput): ShapeGeometry {
  const { shape, box } = input;
  const center = boxCenter(box);
  const anchors = computeStandardAnchors(shape, box);

  return {
    shape,
    box,
    center,
    anchors,
    obstacleBox: expandBox(box, input.obstacleMargin ?? 0),
  };
}
```

Source: Existing `NodeShape`, `Box`, `AnchorPoint` contracts and Phase 2 shape decisions. [VERIFIED: src/ir/elements.ts + src/ir/geometry.ts + 02-CONTEXT.md]

## State Of The Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| DOM measurement via `getBoundingClientRect` / layout reflow [CITED: https://github.com/chenglou/pretext README via npm readme] | Pretext `prepare()` + `layout()` using Canvas measurement and arithmetic line layout [VERIFIED: npm readme] | Pretext package line has releases from 2026-03-27 through 2026-05-10. [VERIFIED: npm registry] | DGE can mirror the two-stage API while keeping exporter layout independent. [VERIFIED: 02-CONTEXT.md] |
| Exporter-specific text wrapping [VERIFIED: design doc risk discussion] | Renderer-neutral `LabelLayout` consumed by future exporters [VERIFIED: 02-CONTEXT.md] | Locked during Phase 2 discussion on 2026-05-24. [VERIFIED: 02-CONTEXT.md] | SVG/Excalidraw should render from the same line records without remeasurement. [VERIFIED: 02-CONTEXT.md] |
| Exact shape math first [VERIFIED: design doc early shape interface] | Practical approximations with explicit design debt [VERIFIED: 02-CONTEXT.md] | Locked during Phase 2 discussion on 2026-05-24. [VERIFIED: 02-CONTEXT.md] | Phase 2 stays small enough to unblock layout/routing. [VERIFIED: ROADMAP.md] |

**Deprecated/outdated for this phase:**

- The old design doc's one-call `measure(text, options, maxWidth?)` interface should be treated as a historical sketch, because Phase 2 locked a two-stage API. [VERIFIED: diagram-geometry-engine-design.md + 02-CONTEXT.md]
- The old design doc's SVG exporter sections are out of scope for Phase 2. [VERIFIED: diagram-geometry-engine-design.md + 02-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Rectangle-like ray clipping is sufficient for first edge-port tests. | Practical Shape Geometry | Phase 3 routing may need more precise ports sooner. |
| A2 | Rounded rectangle obstacle should remain full AABB in v1. | Practical Shape Geometry | Connectors may appear less tight near rounded corners. |
| A3 | Ellipse diagonal anchors should use 45-degree parametric points. | Practical Shape Geometry | Future exporters may expect visual diagonal ports at a different convention. |
| A4 | Diamond/parallelogram/hexagon can start with nearest-anchor or simple polygon ray intersections. | Practical Shape Geometry | Edge entry/exit may be visibly crude in Phase 4. |
| A5 | Cylinder can use rectangle-like ports in v1. | Practical Shape Geometry | Database-shaped nodes may need cap-aware ports later. |
| A6 | Container geometry can accept either precomputed label layout or a label plus fitter dependency without circular-import issues. | API Contracts | Planner may need to split modules differently if import graph becomes awkward. |
| A7 | Fallback language-specific growth is a warning sign. | Common Pitfalls | Some minimal language-specific fixtures may still be justified. |

## Open Questions

1. **Should Phase 2 add a Canvas polyfill dependency for Pretext tests?**
   - What we know: Current Node runtime lacks `OffscreenCanvas`, and Pretext measurement fails without Canvas 2D. [VERIFIED: local Node smoke test]
   - What's unclear: Whether the project wants a native/build dependency for CI this early. [ASSUMED]
   - Recommendation: Do not add a Canvas polyfill in Phase 2 planning unless the user explicitly accepts the dependency; use deterministic fallback for default tests and guard Pretext integration. [VERIFIED: 02-CONTEXT.md + local Node smoke test]

2. **Should `LabelLayout` be added to existing IR types or kept in `labels/` only?**
   - What we know: Existing `Label` is intent metadata only and `CoordinatedNode` currently has `box` and `anchors` but no label layout. [VERIFIED: src/ir/elements.ts]
   - What's unclear: Whether Phase 2 should extend coordinated IR now or leave it as a helper result until Phase 3. [ASSUMED]
   - Recommendation: Export `LabelLayout` from `labels/` in Phase 2 and avoid changing `CoordinatedNode` unless a plan specifically needs the public handoff type there. [VERIFIED: 01-VERIFICATION.md root public API pattern]

3. **How strict should numeric tolerances be?**
   - What we know: Canonical serializer rounds to 3 decimals; Phase 2 context allows flexible tolerance but requires drift visibility. [VERIFIED: src/serialization/canonical.ts + 02-CONTEXT.md]
   - What's unclear: Whether Pretext real measurements will be stable across future Canvas/font environments. [VERIFIED: npm readme caveats]
   - Recommendation: Use exact equality for fallback geometry and shape math, `toBeCloseTo(..., 3)` for real Pretext adapter tests, and canonical snapshots for stable fixture records. [VERIFIED: 01-VERIFICATION.md + 02-CONTEXT.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Runtime and tests | Yes [VERIFIED: local `node --version`] | v24.13.0 [VERIFIED: local `node --version`] | Project supports `>=20`; no fallback needed. [VERIFIED: package.json] |
| npm | Dependency installation | Yes [VERIFIED: local `npm --version`] | 10.9.7 [VERIFIED: local `npm --version`] | None needed. [VERIFIED: package-lock presence from 01-VERIFICATION.md] |
| Vitest | Unit tests | Yes [VERIFIED: local `npx vitest --version`] | 4.1.7 [VERIFIED: package.json + local command] | None needed. [VERIFIED: vitest.config.ts] |
| TypeScript | Typecheck | Yes [VERIFIED: package.json] | 6.0.3 [VERIFIED: package.json] | None needed. [VERIFIED: 01-VERIFICATION.md] |
| `Intl.Segmenter` | Pretext analysis | Yes [VERIFIED: local Node runtime probe] | built into Node runtime [VERIFIED: local Node runtime probe] | Deterministic fallback if unavailable. [VERIFIED: npm readme] |
| `OffscreenCanvas` / Canvas 2D | Pretext measurement | No in current local Node [VERIFIED: local Node runtime probe] | N/A [VERIFIED: local Node runtime probe] | Deterministic fallback and guarded Pretext smoke. [VERIFIED: local Node smoke test] |
| `@chenglou/pretext` | Default real text adapter | Not installed in project yet [VERIFIED: package.json] | latest 0.0.7 [VERIFIED: npm registry] | Add dependency; use fallback tests if runtime lacks Canvas. [VERIFIED: local Node smoke test] |

**Missing dependencies with no fallback:**

- None for planning and default Phase 2 numeric unit tests. [VERIFIED: package.json + local tool probes]

**Missing dependencies with fallback:**

- Canvas 2D for real Pretext measurement is missing in current local Node; use deterministic fallback for default CI and skip/guard Pretext smoke tests. [VERIFIED: local Node runtime probe + smoke test]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.7 [VERIFIED: package.json + local `npx vitest --version`] |
| Config file | `vitest.config.ts` with Node environment and `test/**/*.test.ts` include. [VERIFIED: vitest.config.ts] |
| Quick run command | `rtk npm test -- label-fitting shape-geometry box-geometry container-geometry` [VERIFIED: package.json test script + existing test naming pattern] |
| Full suite command | `rtk npm run verify` [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| TXT-01 | `TextMeasurer` interface, deterministic fallback, guarded Pretext adapter availability. [VERIFIED: REQUIREMENTS.md + local Node smoke] | unit + guarded integration | `rtk npm test -- text-measurer` | No; Wave 0 create `test/text-measurer.test.ts`. [VERIFIED: local file list] |
| TXT-02 | `LabelFitter` computes dimensions from text layout, padding, min size, and max width. [VERIFIED: REQUIREMENTS.md] | unit | `rtk npm test -- label-fitting` | No; Wave 0 create `test/label-fitting.test.ts`. [VERIFIED: local file list] |
| TXT-03 | Multiline and non-English labels produce bounded line records and no content overflow diagnostics for normal fixtures. [VERIFIED: REQUIREMENTS.md] | numeric fixture | `rtk npm test -- label-fitting` | No; Wave 0 create multilingual fixture cases. [VERIFIED: local file list] |
| GEO-01 | Seven v1 shapes compute boxes, center, cardinal anchors, and diagonal anchors. [VERIFIED: REQUIREMENTS.md] | unit | `rtk npm test -- shape-geometry` | No; Wave 0 create `test/shape-geometry.test.ts`. [VERIFIED: local file list] |
| GEO-02 | AABB collisions and expanded obstacle boxes are deterministic with configurable margins. [VERIFIED: REQUIREMENTS.md] | unit | `rtk npm test -- box-geometry` | No; Wave 0 create `test/box-geometry.test.ts`. [VERIFIED: local file list] |
| GEO-03 | Edge entry/exit ports are computed from shape geometry and preferred anchors. [VERIFIED: REQUIREMENTS.md] | unit | `rtk npm test -- shape-geometry` | No; covered in `test/shape-geometry.test.ts`. [VERIFIED: local file list] |

### Sampling Rate

- **Per task commit:** Run the focused Vitest file for the module being touched. [VERIFIED: package.json test script]
- **Per wave merge:** Run `rtk npm run typecheck` and relevant `rtk npm test -- ...` commands. [VERIFIED: package.json scripts]
- **Phase gate:** Run `rtk npm run verify` before `/gsd-verify-work`. [VERIFIED: package.json + 01-VERIFICATION.md]

### Wave 0 Gaps

- [ ] `test/text-measurer.test.ts` — covers TXT-01 fallback behavior and guarded Pretext availability. [VERIFIED: local file list]
- [ ] `test/label-fitting.test.ts` — covers TXT-02/TXT-03 padding, max width, min size, line records, diagnostics. [VERIFIED: local file list]
- [ ] `test/box-geometry.test.ts` — covers GEO-02 box center, expansion, union, AABB collision. [VERIFIED: local file list]
- [ ] `test/shape-geometry.test.ts` — covers GEO-01/GEO-03 anchors and edge ports for seven shapes. [VERIFIED: local file list]
- [ ] `test/container-geometry.test.ts` — covers container geometry from known child boxes. [VERIFIED: local file list]
- [ ] `test/fixtures/phase-02/*.canonical.json` — stable numeric fixtures using `stringifyCanonical()`. [VERIFIED: src/serialization/canonical.ts]

### Validation Notes

- Do not generate SVG in Phase 2 tests. [VERIFIED: 02-CONTEXT.md]
- Use exact numeric assertions for deterministic fallback and pure geometry. [VERIFIED: deterministic project constraints]
- Use `stringifyCanonical()` for fixture snapshots so key ordering and 3-decimal rounding remain stable. [VERIFIED: src/serialization/canonical.ts + test/serialization.test.ts]
- Guard Pretext real measurement tests with runtime availability because current local Node fails measurement. [VERIFIED: local Node smoke test]

## Security Domain

Security enforcement is enabled in `.planning/config.json`. [VERIFIED: .planning/config.json]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No [VERIFIED: Phase 2 scope] | No auth surface in this phase. [VERIFIED: 02-CONTEXT.md] |
| V3 Session Management | No [VERIFIED: Phase 2 scope] | No session surface in this phase. [VERIFIED: 02-CONTEXT.md] |
| V4 Access Control | No [VERIFIED: Phase 2 scope] | No user/resource authorization surface in this phase. [VERIFIED: 02-CONTEXT.md] |
| V5 Input Validation | Yes [VERIFIED: public geometry API accepts numeric boxes/options] | Validate finite numeric geometry inputs and reject or diagnose invalid boxes, negative sizes, negative line heights, and non-finite values. [VERIFIED: src/serialization/canonical.ts non-finite rejection pattern] |
| V6 Cryptography | No [VERIFIED: Phase 2 scope] | No cryptographic behavior in this phase. [VERIFIED: 02-CONTEXT.md] |

### Known Threat Patterns for TypeScript Geometry Library

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Non-finite numeric input corrupts geometry output. [VERIFIED: existing serializer rejects non-finite numbers] | Tampering | Reject `NaN`, `Infinity`, negative dimensions, and invalid line heights at public geometry boundaries. [VERIFIED: src/serialization/canonical.ts] |
| Prototype pollution through caller-supplied objects. [VERIFIED: serializer already limits own enumerable properties] | Tampering | Use typed plain data and avoid merging untrusted metadata into control options. [VERIFIED: src/serialization/canonical.ts pattern] |
| Dependency runtime failure hidden as successful label fit. [VERIFIED: local Pretext smoke test] | Denial of Service | Preflight Pretext runtime availability and return deterministic diagnostics instead of crashing inside label fitting. [VERIFIED: local Node smoke test] |

## Sources

### Primary (HIGH confidence)

- `AGENTS.md` and `/home/zhangyangrui/.codex/RTK.md` — project and shell command constraints. [VERIFIED: local file read]
- `.planning/phases/02-text-labels-and-shape-geometry/02-CONTEXT.md` — locked Phase 2 decisions and out-of-scope boundaries. [VERIFIED: local file read]
- `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md` — requirement IDs, phase goal, project state, and constraints. [VERIFIED: local file read]
- Phase 1 verification and source files: `01-VERIFICATION.md`, `src/index.ts`, `src/ir/*.ts`, `src/serialization/canonical.ts`, `test/*.test.ts`. [VERIFIED: local file read]
- npm registry for `@chenglou/pretext` and `@dagrejs/dagre` — versions, license, exports, type entry, publish dates. [VERIFIED: `npm view`]
- `@chenglou/pretext` tarball `dist/layout.d.ts`, `package.json`, and `LICENSE` — API shape and license text. [VERIFIED: `npm pack` + `tar -xOf`]

### Secondary (MEDIUM confidence)

- `diagram-geometry-engine-design.md` — historical product architecture and early API sketches. [VERIFIED: local file read]
- `dge-research-report.md` — local Pretext source analysis and DGE feasibility rationale. [VERIFIED: local file read]
- npm readme for `@chenglou/pretext` — official package README API and caveats. [VERIFIED: `npm view readme`]

### Tertiary (LOW confidence)

- Assumed practical anchor/port formulas for non-rectangular shapes where Phase 2 context permits approximation but does not lock exact math. [ASSUMED]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — package versions and Pretext exports were verified from npm registry and tarball contents. [VERIFIED: npm registry + tarball]
- Architecture: HIGH — module boundaries are locked by Phase 2 context and Phase 1 source structure. [VERIFIED: 02-CONTEXT.md + 01-VERIFICATION.md]
- Pretext runtime behavior: MEDIUM — API and package metadata are verified, but real measurement fails in the current Node runtime without Canvas 2D. [VERIFIED: local Node smoke test]
- Shape math: MEDIUM — seven-shape responsibilities are locked, while several exact non-rectangular formulas remain practical approximations. [VERIFIED: 02-CONTEXT.md + ASSUMED formulas]
- Pitfalls: HIGH — main pitfalls are directly grounded in Phase 2 decisions, current Node smoke behavior, and project research. [VERIFIED: 02-CONTEXT.md + local Node smoke test + PITFALLS.md]

**Research date:** 2026-05-24 [VERIFIED: system date]
**Valid until:** 2026-06-23 for project architecture; 2026-05-31 for `@chenglou/pretext` version/runtime guidance because the package is new and recently modified. [VERIFIED: npm registry time.modified]
