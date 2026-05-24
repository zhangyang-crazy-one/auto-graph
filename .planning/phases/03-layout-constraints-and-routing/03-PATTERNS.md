# Phase 03: Layout, Constraints, And Routing - Pattern Map

**Mapped:** 2026-05-25
**Files analyzed:** 20 likely new/modified files
**Analogs found:** 20 / 20

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `package.json` / lockfile | config | dependency resolution | `package.json` | exact |
| `src/layout/index.ts` | barrel | transform | `src/geometry/index.ts` | exact |
| `src/layout/dagre.ts` | service | transform | `src/geometry/shapes.ts` | role-match |
| `src/layout/types.ts` | model | transform | `src/ir/geometry.ts`, `src/geometry/shapes.ts` | role-match |
| `src/constraints/index.ts` | barrel | transform | `src/ir/index.ts` | exact |
| `src/constraints/solver.ts` | service | transform + diagnostics | `src/labels/fit.ts` | role-match |
| `src/constraints/types.ts` | model | transform | `src/ir/constraints.ts`, `src/ir/diagnostics.ts` | exact |
| `src/routing/index.ts` | barrel | transform | `src/geometry/index.ts` | exact |
| `src/routing/routes.ts` | service | transform | `src/geometry/shapes.ts`, `src/geometry/boxes.ts` | role-match |
| `src/routing/types.ts` | model | transform | `src/geometry/shapes.ts`, `src/ir/elements.ts` | role-match |
| `src/solver/index.ts` | barrel | request-response transform | `src/geometry/index.ts` | exact |
| `src/solver/solve.ts` | service | request-response transform | `src/geometry/containers.ts`, `src/ir/diagram.ts` | role-match |
| `src/ir/elements.ts` | model | transform | `src/ir/elements.ts` | exact |
| `src/index.ts` | barrel | public API | `src/index.ts` | exact |
| `test/layout.test.ts` | test | transform verification | `test/box-geometry.test.ts`, `test/shape-geometry.test.ts` | role-match |
| `test/constraints.test.ts` | test | diagnostics verification | `test/label-fitting.test.ts`, `test/container-geometry.test.ts` | role-match |
| `test/routing.test.ts` | test | transform + collision verification | `test/shape-geometry.test.ts`, `test/box-geometry.test.ts` | role-match |
| `test/solver.test.ts` | test | integration + fixture | `test/container-geometry.test.ts`, `test/public-api.test.ts` | role-match |
| `test/determinism.test.ts` | test | canonical comparison | `test/serialization.test.ts`, `test/box-geometry.test.ts` | role-match |
| `test/fixtures/phase-03/*.canonical.json` | fixture | file-I/O comparison | `test/fixtures/phase-02/*.canonical.json` via fixture tests | exact |

## Pattern Assignments

### `package.json` / lockfile (config, dependency resolution)

**Analog:** `package.json`

**Dependency style** (lines 1-37):
```json
{
	"type": "module",
	"private": true,
	"sideEffects": false,
	"engines": {
		"node": ">=20"
	},
	"scripts": {
		"build": "tsup",
		"typecheck": "tsc --noEmit",
		"test": "vitest run",
		"lint": "biome ci .",
		"verify": "npm run typecheck && npm run build && npm test && npm run lint"
	},
	"dependencies": {
		"@chenglou/pretext": "^0.0.7"
	}
}
```

**Apply:** Add `@dagrejs/dagre@3.0.0` under `dependencies`, not `devDependencies`, because Phase 3 layout is runtime library behavior.

---

### `src/layout/index.ts` (barrel, transform)

**Analog:** `src/geometry/index.ts`

**Barrel export pattern** (lines 1-3):
```typescript
export * from "./boxes.js";
export * from "./containers.js";
export * from "./shapes.js";
```

**Apply:** Keep layout submodule exports extension-qualified:
```typescript
export * from "./dagre.js";
export * from "./types.js";
```

---

### `src/layout/dagre.ts` (service, transform)

**Analog:** `src/geometry/shapes.ts`

**Imports pattern** (lines 1-9):
```typescript
import type { NodeShape } from "../ir/elements.js";
import type {
	AnchorName,
	AnchorPoint,
	Box,
	Insets,
	Point,
} from "../ir/geometry.js";
import { boxCenter, expandBox, validateBox } from "./boxes.js";
```

**Core pure function pattern** (lines 35-47):
```typescript
export function computeShapeGeometry(input: ShapeGeometryInput): ShapeGeometry {
	validateShape(input.shape);
	validateBox(input.box);

	const box = { ...input.box };

	return {
		shape: input.shape,
		box,
		center: boxCenter(box),
		anchors: createAnchors(box),
		obstacleBox: expandBox(box, input.obstacleMargin ?? 0),
	};
}
```

**Numeric validation pattern** (from `src/geometry/boxes.ts` lines 27-35):
```typescript
export function validateBox(box: Box, label = "box"): void {
	validateFinite(box.x, `${label}.x`);
	validateFinite(box.y, `${label}.y`);
	validateFinite(box.width, `${label}.width`);
	validateFinite(box.height, `${label}.height`);

	if (box.width < 0 || box.height < 0) {
		throw new TypeError(`${label} dimensions must be non-negative`);
	}
}
```

**Apply:** Wrap Dagre behind `runDagreInitialLayout(...)`; validate finite/non-negative node sizes before calling Dagre, map `DiagramDirection` to Dagre `rankdir`, and convert Dagre center points to DGE top-left `Box` records. Do not expose Dagre graph objects in public return types.

---

### `src/layout/types.ts` (model, transform)

**Analog:** `src/ir/geometry.ts` and `src/geometry/shapes.ts`

**IR primitive style** (from `src/ir/geometry.ts` lines 9-23):
```typescript
export type DiagramDirection = "TB" | "LR" | "BT" | "RL";

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Box extends Point, Size {}
```

**Input/output interface style** (from `src/geometry/shapes.ts` lines 21-33):
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
```

**Apply:** Define narrow records such as `DagreLayoutInput`, `DagreLayoutNode`, `DagreLayoutEdge`, and `InitialLayoutResult`. Use `readonly` arrays for input collections where practical, mirroring `ContainerGeometryInput.childBoxes`.

---

### `src/constraints/index.ts` (barrel, transform)

**Analog:** `src/ir/index.ts`

**Barrel export pattern** (lines 1-5):
```typescript
export * from "./constraints.js";
export * from "./diagnostics.js";
export * from "./diagram.js";
export * from "./elements.js";
export * from "./geometry.js";
```

**Apply:** Export only public constraint solver surface:
```typescript
export * from "./solver.js";
export * from "./types.js";
```

---

### `src/constraints/solver.ts` (service, transform + diagnostics)

**Analog:** `src/labels/fit.ts`

**Imports and diagnostic style** (lines 1-6):
```typescript
import { normalizeInsets } from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Insets, Size } from "../ir/geometry.js";
import type { TextLayout, TextMeasurer } from "../text/index.js";
import { assertFiniteNonNegative, resolveLineHeight } from "../text/index.js";
import type { LabelFitOptions, LabelLayout, LabelLineLayout } from "./types.js";
```

**Prepared computation style** (lines 24-33):
```typescript
function computeLabelLayout(
	text: string,
	options: LabelFitOptions,
	measurer: TextMeasurer,
): LabelLayout {
	const padding = normalizeInsets(options.padding);
	const minSize = normalizeMinSize(options.minSize);
	const lineHeight = resolveLineHeight(options.font);
	const maxWidth = normalizeMaxWidth(options.maxWidth);
	const prepared = measurer.prepare(text, options.font);
```

**Diagnostics construction pattern** (lines 157-184):
```typescript
function buildDiagnostics(
	overflow: LabelLayout["overflow"],
	mode: LabelFitOptions["overflow"] = "allow",
): Diagnostic[] {
	if (mode !== "diagnose") {
		return [];
	}

	const diagnostics: Diagnostic[] = [];

	if (overflow.horizontal) {
		diagnostics.push({
			severity: "warning",
			code: "label.overflow.horizontal",
			message: "Label text exceeds the fitted content width.",
		});
	}

	return diagnostics;
}
```

**Constraint model source** (from `src/ir/constraints.ts` lines 16-72):
```typescript
export interface ExactPositionConstraint extends ConstraintBase {
	kind: "exact-position";
	position: Point;
}

export interface RelativePositionConstraint extends ConstraintBase {
	kind: "relative-position";
	sourceId: string;
	referenceId: string;
	relation: RelativePositionRelation;
	offset?: Point;
}

export interface ContainmentConstraint extends ConstraintBase {
	kind: "containment";
	containerId: string;
	childIds: string[];
	padding?: Insets;
}
```

**Apply:** Implement layered solver functions in precedence order: exact/fixed, containment, relative, align, distribute. Return `{ boxes, diagnostics }` instead of throwing for recoverable missing refs/conflicts; reserve `TypeError` for direct invalid helper input.

---

### `src/constraints/types.ts` (model, transform)

**Analog:** `src/ir/diagnostics.ts`

**Diagnostic contract** (lines 1-13):
```typescript
import type { JsonObject } from "./geometry.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticPathSegment = string | number;

export interface Diagnostic {
	severity: DiagnosticSeverity;
	code: string;
	message: string;
	path?: DiagnosticPathSegment[];
	detail?: JsonObject;
}
```

**Apply:** Solver result types should embed existing `Diagnostic[]`; use stable codes like `layout.node-size.invalid`, `constraints.reference.missing`, `constraints.conflict.exact-position`, and include `path`/`detail` for target IDs and constraint IDs.

---

### `src/routing/index.ts` (barrel, transform)

**Analog:** `src/geometry/index.ts`

**Barrel export pattern** (lines 1-3):
```typescript
export * from "./boxes.js";
export * from "./containers.js";
export * from "./shapes.js";
```

**Apply:** Export routing primitives from one submodule entry:
```typescript
export * from "./routes.js";
export * from "./types.js";
```

---

### `src/routing/routes.ts` (service, transform)

**Analog:** `src/geometry/shapes.ts` and `src/geometry/boxes.ts`

**Anchor/port pattern** (from `src/geometry/shapes.ts` lines 50-80):
```typescript
export function getEdgePort(
	geometry: ShapeGeometry,
	toward: Point,
	preferredAnchor?: AnchorName,
): Point {
	validateShape(geometry.shape);
	validateBox(geometry.box);
	validatePoint(toward, "toward");

	if (preferredAnchor !== undefined) {
		const anchor = geometry.anchors.find((candidate) => {
			return candidate.name === preferredAnchor;
		});

		if (anchor === undefined) {
			throw new TypeError(`Unsupported anchor: ${preferredAnchor}`);
		}

		return { ...anchor.point };
	}
```

**Obstacle/collision pattern** (from `src/geometry/boxes.ts` lines 82-91):
```typescript
export function intersectsAabb(a: Box, b: Box): boolean {
	validateBox(a, "a");
	validateBox(b, "b");

	return (
		a.x <= b.x + b.width &&
		a.x + a.width >= b.x &&
		a.y <= b.y + b.height &&
		a.y + a.height >= b.y
	);
}
```

**Deterministic fallback pattern** (from `src/geometry/shapes.ts` lines 128-149):
```typescript
function snapToNearestAnchor(geometry: ShapeGeometry, toward: Point): Point {
	let best = geometry.anchors[0];
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const anchor of geometry.anchors) {
		if (anchor.name === "center") {
			continue;
		}

		const distance = squaredDistance(anchor.point, toward);

		if (distance < bestDistance) {
			best = anchor;
			bestDistance = distance;
		}
	}

	return clampPointToBox(best.point, geometry.box);
}
```

**Apply:** Build route candidates in stable order, score them with simple AABB checks, choose the first/best deterministic candidate, then simplify repeated and collinear points before returning. Use existing `computeShapeGeometry()` + `getEdgePort()` for endpoints.

---

### `src/routing/types.ts` (model, transform)

**Analog:** `src/ir/elements.ts`

**Endpoint and coordinated edge shape** (lines 55-79):
```typescript
export interface EdgeEndpoint {
	nodeId: string;
	anchor?: AnchorName;
}

export interface NormalizedEdge {
	id: string;
	source: EdgeEndpoint;
	target: EdgeEndpoint;
	label?: Label;
	metadata?: JsonObject;
}

export interface CoordinatedEdge extends NormalizedEdge {
	points: Point[];
	labelPosition?: Point;
}
```

**Apply:** If route options are exposed now, keep them renderer-neutral, e.g. `RouteKind = "orthogonal" | "straight"`. Prefer adding options to routing input first; only extend `NormalizedEdge` if tests need public route selection before DSL work.

---

### `src/solver/index.ts` (barrel, request-response transform)

**Analog:** `src/geometry/index.ts`

**Apply:** Keep a shallow barrel:
```typescript
export * from "./solve.js";
export * from "./types.js";
```

---

### `src/solver/solve.ts` (service, request-response transform)

**Analog:** `src/ir/diagram.ts` and `src/geometry/containers.ts`

**Coordinator input/output contract** (from `src/ir/diagram.ts` lines 33-56):
```typescript
export interface NormalizedDiagram {
	id: string;
	title?: string;
	direction: DiagramDirection;
	nodes: NormalizedNode[];
	edges: NormalizedEdge[];
	groups: NormalizedGroup[];
	constraints: Constraint[];
	diagnostics: Diagnostic[];
	metadata?: DiagramMetadata;
}

export interface CoordinatedDiagram {
	id: string;
	title?: string;
	direction: DiagramDirection;
	nodes: CoordinatedNode[];
	edges: CoordinatedEdge[];
	groups: CoordinatedGroup[];
	diagnostics: Diagnostic[];
	bounds: Box;
	metadata?: DiagramMetadata;
}
```

**Container reuse pattern** (from `src/geometry/containers.ts` lines 27-69):
```typescript
export function computeContainerGeometry(
	input: ContainerGeometryInput,
): ContainerGeometry {
	const childBounds = unionBoxes(input.childBoxes);
	const padding = normalizeInsets(input.padding);
	const minSize = normalizeMinSize(input.minSize);
	const headerHeight =
		input.labelLayout?.fittedSize.height ?? input.labelLayout?.box.height ?? 0;
	const intrinsicBox = {
		x: childBounds.x - padding.left,
		y: childBounds.y - padding.top - headerHeight,
		width: childBounds.width + padding.left + padding.right,
		height: childBounds.height + padding.top + padding.bottom + headerHeight,
	};
```

**Apply:** `solveDiagram(normalized: NormalizedDiagram): CoordinatedDiagram` should combine existing diagnostics with Phase 3 diagnostics, compute node boxes, group boxes, anchors, edge points, and final bounds. Keep all outputs as existing IR primitives.

---

### `src/ir/elements.ts` (model, transform)

**Analog:** `src/ir/elements.ts`

**Existing IR extension style** (lines 27-53, 68-79):
```typescript
export interface NodeBase {
	id: string;
	label?: Label;
	shape?: NodeShape;
	metadata?: JsonObject;
}

export interface NormalizedNode extends NodeBase {
	shape: NodeShape;
	parentId?: string;
	size: Size;
	padding: Insets;
}

export interface CoordinatedNode extends NodeBase {
	shape: NodeShape;
	box: Box;
	anchors: AnchorPoint[];
	parentId?: string;
}
```

**Apply:** Keep additions minimal and backwards-compatible. If a route kind is added, use optional fields and string literal unions; do not add exporter-specific fields.

---

### `src/index.ts` (barrel, public API)

**Analog:** `src/index.ts`

**Root-only export style** (lines 1-5):
```typescript
export * from "./geometry/index.js";
export * from "./ir/index.js";
export * from "./labels/index.js";
export * from "./serialization/index.js";
export * from "./text/index.js";
```

**Public API verification** (from `test/public-api.test.ts` lines 132-138):
```typescript
it("keeps package exports root-only", () => {
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { exports: Record<string, unknown> };

	expect(Object.keys(packageJson.exports)).toEqual(["."]);
});
```

**Apply:** Add `export * from "./layout/index.js";`, `constraints`, `routing`, and `solver` barrels here, while keeping `package.json.exports` as only `"."`.

---

### `test/layout.test.ts` (test, transform verification)

**Analog:** `test/box-geometry.test.ts`

**Numeric deterministic test style** (lines 47-58):
```typescript
it("unions boxes and serializes repeated output byte-identically", () => {
	const boxes = [
		{ x: 10, y: 20, width: 80, height: 40 },
		{ x: -5, y: 15, width: 20, height: 20 },
	];
	const output = unionBoxes(boxes);

	expect(output).toEqual({ x: -5, y: 15, width: 95, height: 45 });
	expect(stringifyCanonical(output)).toBe(
		stringifyCanonical(unionBoxes(boxes)),
	);
	expect(() => unionBoxes([])).toThrow(/empty|box/i);
});
```

**Apply:** Cover all four directions, center-to-box conversion, finite dimension rejection, and repeated canonical equality for the same layout input.

---

### `test/constraints.test.ts` (test, diagnostics verification)

**Analog:** `test/label-fitting.test.ts` and `test/container-geometry.test.ts`

**Diagnostic code assertion style** (from `test/label-fitting.test.ts` lines 116-123):
```typescript
expect(layout.overflow.horizontal).toBe(true);
expect(layout.overflow.vertical).toBe(true);
expect(layout.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
	[
		"label.overflow.horizontal",
		"label.overflow.vertical",
	],
);
```

**Invalid input assertion style** (from `test/container-geometry.test.ts` lines 110-131):
```typescript
it("rejects invalid input", () => {
	expect(() =>
		computeContainerGeometry({ id: "empty", childBoxes: [], padding: 0 }),
	).toThrow(TypeError);
	expect(() =>
		computeContainerGeometry({
			id: "bad-box",
			childBoxes: [{ x: Number.NaN, y: 0, width: 10, height: 10 }],
			padding: 0,
		}),
	).toThrow(TypeError);
});
```

**Apply:** For solver-level recoverable problems, assert diagnostics rather than throws. For narrow helper preconditions, use `toThrow(TypeError)`.

---

### `test/routing.test.ts` (test, transform + collision verification)

**Analog:** `test/shape-geometry.test.ts` and `test/box-geometry.test.ts`

**Anchor and deterministic finite route style** (from `test/shape-geometry.test.ts` lines 54-87):
```typescript
it("honors preferred anchors", () => {
	const geometry = computeShapeGeometry({ shape: "ellipse", box });

	expect(getEdgePort(geometry, { x: 200, y: 30 }, "top")).toEqual({
		x: 50,
		y: 0,
	});
});

it("returns finite deterministic ports for non-rectangular shapes", () => {
	const geometry = computeShapeGeometry({ shape, box });
	const first = getEdgePort(geometry, { x: 200, y: -20 });
	const second = getEdgePort(geometry, { x: 200, y: -20 });

	expect(first).toEqual(second);
	expect(Number.isFinite(first.x)).toBe(true);
	expect(Number.isFinite(first.y)).toBe(true);
});
```

**AABB expectation style** (from `test/box-geometry.test.ts` lines 61-72):
```typescript
expect(intersectsAabb(base, { x: 5, y: 5, width: 10, height: 10 })).toBe(
	true,
);
expect(intersectsAabb(base, { x: 11, y: 0, width: 10, height: 10 })).toBe(
	false,
);
```

**Apply:** Assert explicit anchors, default directional ports, straight routes, orthogonal routes, obstacle avoidance for simple rectangles, and route simplification that removes repeated/collinear points while preserving semantic point order.

---

### `test/solver.test.ts` (test, integration + fixture)

**Analog:** `test/container-geometry.test.ts` and `test/public-api.test.ts`

**Fixture comparison pattern** (from `test/container-geometry.test.ts` lines 134-155):
```typescript
it("matches the committed container canonical fixture", () => {
	const geometry = computeContainerGeometry({
		id: "group-a",
		childBoxes,
		padding: 20,
		labelLayout,
		obstacleMargin: 5,
	});
	const fixture = readFileSync(
		new URL("./fixtures/phase-02/containers.canonical.json", import.meta.url),
		"utf8",
	);

	expect(stringifyCanonical(geometry)).toBe(fixture);
});
```

**Coordinated sample shape** (from `test/public-api.test.ts` lines 68-102):
```typescript
const sample: CoordinatedDiagram = {
	id: "coordinated-sample",
	direction: "LR",
	nodes: [
		{
			id: "node-a",
			shape: "rectangle",
			box: { x: 0, y: 0, width: 120, height: 60 },
			anchors: [{ name: "center", point: { x: 60, y: 30 } }],
		},
	],
	edges: [
		{
			id: "edge-a-b",
			source: { nodeId: "node-a" },
			target: { nodeId: "node-b" },
			points: [{ x: 120, y: 30 }, { x: 180, y: 30 }],
		},
	],
	groups: [],
	diagnostics: [],
	bounds: { x: 0, y: 0, width: 120, height: 60 },
};
```

**Apply:** Use committed Phase 3 coordinated fixtures for integrated diagrams: Dagre directions, hybrid fixed/auto, constraints, containers, and routing.

---

### `test/determinism.test.ts` (test, canonical comparison)

**Analog:** `test/serialization.test.ts`

**Byte-stable comparison pattern** (lines 79-88):
```typescript
const output = stringifyCanonical(first);

expect(output).toBe(stringifyCanonical(second));
expect(output.indexOf('"constraints"')).toBeLessThan(
	output.indexOf('"edges"'),
);
expect(output.indexOf('"node-a"')).toBeLessThan(output.indexOf('"node-b"'));
expect(output.indexOf('"edge-a-b"')).toBeLessThan(
	output.indexOf('"edge-b-a"'),
);
```

**Point order preservation pattern** (lines 121-148):
```typescript
expect(canonicalize(route)).toMatchObject({
	edges: [
		{
			points: [
				{ x: 10, y: 0 },
				{ x: 0, y: 0 },
			],
		},
	],
});
expect(stringifyCanonical(route).indexOf('"x": 10')).toBeLessThan(
	stringifyCanonical(route).indexOf('"x": 0'),
);
```

**Apply:** Call `solveDiagram()` multiple times with equivalent but differently ordered unordered collections. Compare `stringifyCanonical()` output exactly, while route `points` order remains meaningful.

---

### `test/fixtures/phase-03/*.canonical.json` (fixture, file-I/O comparison)

**Analog:** `test/fixtures/phase-02/*.canonical.json` via `test/shape-geometry.test.ts`

**Fixture read pattern** (from `test/shape-geometry.test.ts` lines 105-118):
```typescript
const records = supportedShapes.map((shape) =>
	computeShapeGeometry({
		shape,
		box,
		obstacleMargin: 5,
	}),
);
const fixture = readFileSync(
	new URL("./fixtures/phase-02/shapes.canonical.json", import.meta.url),
	"utf8",
);

expect(stringifyCanonical(records)).toBe(fixture);
```

**Apply:** Put Phase 3 expected coordinated IR under `test/fixtures/phase-03/`. Generate fixture text with `stringifyCanonical()` so object keys, unordered collections, numeric precision, negative zero, and point sequence semantics match the existing serializer.

---

## Shared Patterns

### Type And Barrel Export Style

**Source:** `src/index.ts`, `src/geometry/index.ts`, `src/ir/index.ts`

```typescript
export * from "./geometry/index.js";
export * from "./ir/index.js";
export * from "./labels/index.js";
export * from "./serialization/index.js";
export * from "./text/index.js";
```

Apply to all Phase 3 modules. Use `.js` import/export specifiers in TypeScript source and expose new public APIs through `src/index.ts`; keep `package.json.exports` root-only.

### Numeric Validation

**Source:** `src/geometry/boxes.ts`

```typescript
function validateFinite(value: number, label: string): void {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${label} must be finite`);
	}
}
```

Apply to Dagre input dimensions, exact positions, route point calculations, spacing, padding, and bounds. For public solve flow, convert unsafe diagram data into diagnostics where partial output is safe.

### Diagnostics

**Source:** `src/ir/diagnostics.ts`, `src/labels/fit.ts`

```typescript
diagnostics.push({
	severity: "warning",
	code: "label.overflow.horizontal",
	message: "Label text exceeds the fitted content width.",
});
```

Use stable code strings and existing `severity`, `code`, `message`, `path`, `detail` shape. Constraint conflicts and missing refs should be visible in `CoordinatedDiagram.diagnostics`.

### Geometry Helper Style

**Source:** `src/geometry/shapes.ts`, `src/geometry/containers.ts`

```typescript
return {
	id: input.id,
	box,
	contentBox,
	childBounds,
	...(input.labelLayout === undefined
		? {}
		: { labelLayout: input.labelLayout }),
	anchors: shape.anchors,
	obstacleBox,
	diagnostics: [],
};
```

Use pure functions, clone caller-owned records before returning, do not mutate input arrays/boxes, and keep helpers renderer-neutral.

### Canonical Fixture Generation And Comparison

**Source:** `src/serialization/canonical.ts`, `test/container-geometry.test.ts`

```typescript
expect(stringifyCanonical(geometry)).toBe(fixture);
```

Use `stringifyCanonical()` for Phase 3 fixture comparisons. `points` order is semantic and intentionally not sorted by the serializer.

### Root Public API Test

**Source:** `test/public-api.test.ts`

```typescript
import type {
	Box,
	Constraint,
	CoordinatedDiagram,
	Diagnostic,
	NormalizedDiagram,
	Point,
} from "../src/index.js";
```

Add Phase 3 APIs to this test by importing from `../src/index.js`, not subpaths, and assert package exports remain `["."]`.

### Renderer-Neutral Grep Gate

**Source:** `test/label-fitting.test.ts`

```typescript
const forbidden = new Set([
	["s", "vg"].join(""),
	["ht", "ml"].join(""),
	["c", "ss"].join(""),
	["can", "vas"].join(""),
	["excali", "draw"].join(""),
	["mer", "maid"].join(""),
	["draw", "io"].join(""),
]);

expect(hasForbiddenKeys(layout, forbidden)).toBe(false);
```

Apply to coordinated solver outputs and route records. Check keys recursively enough to catch accidental renderer/exporter fields without adding literal renderer terms to normal API names.

## No Analog Found

No Phase 3 file lacks a usable analog. Dagre itself is new, but its wrapper should follow existing pure geometry helper patterns; external API usage comes from `03-RESEARCH.md`.

## Metadata

**Analog search scope:** `src/`, `test/`, `package.json`, `AGENTS.md`, Phase 03 artifacts  
**Files scanned:** 24 source/test/config/context files  
**Pattern extraction date:** 2026-05-25  
**Project skills:** No project-local skills found under `.codex/`, `.claude/`, or `.agents/`  
**Shell convention:** Local commands use `rtk` prefix.
