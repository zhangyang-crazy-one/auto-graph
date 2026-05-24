# Phase 02: Text, Labels, And Shape Geometry - Pattern Map

**Mapped:** 2026-05-24  
**Files analyzed:** 22 new/modified targets  
**Analogs found:** 18 / 22

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/text/types.ts` | model | transform | `src/ir/geometry.ts`, `src/ir/elements.ts` | role-match |
| `src/text/fallback.ts` | service | transform | `src/serialization/canonical.ts` | partial |
| `src/text/pretext.ts` | service | request-response | None | no analog |
| `src/text/index.ts` | config | transform | `src/ir/index.ts`, `src/serialization/index.ts` | exact |
| `src/labels/types.ts` | model | transform | `src/ir/elements.ts`, `src/ir/diagnostics.ts` | role-match |
| `src/labels/fit.ts` | service | transform | `src/serialization/canonical.ts` | partial |
| `src/labels/index.ts` | config | transform | `src/serialization/index.ts` | exact |
| `src/geometry/boxes.ts` | utility | transform | `src/serialization/canonical.ts`, `src/ir/geometry.ts` | partial |
| `src/geometry/shapes.ts` | service | transform | `src/ir/elements.ts`, `src/ir/geometry.ts` | role-match |
| `src/geometry/containers.ts` | service | transform | `src/ir/elements.ts`, `src/ir/diagram.ts` | role-match |
| `src/geometry/index.ts` | config | transform | `src/ir/index.ts` | exact |
| `src/index.ts` | config | transform | `src/index.ts` | exact |
| `package.json` | config | batch | `package.json` | exact |
| `README.md` | documentation | batch | None | no analog |
| `LICENSE` | documentation | batch | None | no analog |
| `test/text-measurer.test.ts` | test | request-response | `test/public-api.test.ts`, `test/serialization.test.ts` | role-match |
| `test/label-fitting.test.ts` | test | transform | `test/serialization.test.ts` | role-match |
| `test/box-geometry.test.ts` | test | transform | `test/serialization.test.ts` | role-match |
| `test/shape-geometry.test.ts` | test | transform | `test/public-api.test.ts`, `test/serialization.test.ts` | role-match |
| `test/container-geometry.test.ts` | test | transform | `test/public-api.test.ts`, `test/serialization.test.ts` | role-match |
| `test/fixtures/phase-02/labels.canonical.json` | test | batch | `test/serialization.test.ts` | partial |
| `test/fixtures/phase-02/shapes.canonical.json`, `containers.canonical.json` | test | batch | `test/serialization.test.ts` | partial |

## Pattern Assignments

### `src/text/types.ts` (model, transform)

**Analog:** `src/ir/geometry.ts` and `src/ir/elements.ts`

**Imports pattern:** none for primitive type files where possible.

**Public type shape pattern** (`src/ir/geometry.ts` lines 1-28):
```typescript
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Box extends Point, Size {}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}
```

**Union/type contract pattern** (`src/ir/elements.ts` lines 11-25):
```typescript
export type NodeShape =
	| "rectangle"
	| "rounded-rectangle"
	| "ellipse"
	| "diamond"
	| "parallelogram"
	| "hexagon"
	| "cylinder";

export interface Label {
	text: string;
	id?: string;
	maxWidth?: number;
	metadata?: JsonObject;
}
```

**Guidance:** define DGE-owned `TextStyleOptions`, `PreparedText`, `TextLayout`, `TextLayoutLine`, and `TextMeasurer` interfaces here. Keep upstream Pretext types out of this public model file. Use renderer-neutral fields only: numeric widths/heights/cursors/text, no SVG/HTML/CSS/Canvas output fields.

---

### `src/text/fallback.ts` (service, transform)

**Analog:** `src/serialization/canonical.ts`

**Imports pattern:** import DGE-owned types from sibling modules with `.js` extension and `import type` for type-only dependencies, mirroring `src/ir/elements.ts` lines 1-9:
```typescript
import type {
	AnchorName,
	AnchorPoint,
	Box,
	Insets,
	JsonObject,
	Point,
	Size,
} from "./geometry.js";
```

**Pure exported function/class pattern** (`src/serialization/canonical.ts` lines 36-56):
```typescript
export function canonicalize(
	value: unknown,
	options: CanonicalizeOptions = {},
): CanonicalJson {
	const precision = resolvePrecision(
		options.precision ?? DEFAULT_CANONICAL_PRECISION,
	);

	return canonicalizeValue(value, precision);
}

export function stringifyCanonical(
	value: unknown,
	precision = DEFAULT_CANONICAL_PRECISION,
): string {
	return `${JSON.stringify(
		canonicalize(value, { precision: resolvePrecision(precision) }),
		null,
		2,
	)}\n`;
}
```

**Validation/error pattern** (`src/serialization/canonical.ts` lines 58-63 and 79-91):
```typescript
function resolvePrecision(precision: number): number {
	if (!Number.isInteger(precision) || precision < 0) {
		throw new TypeError("Canonical precision must be a non-negative integer");
	}

	return precision;
}
```

```typescript
if (typeof value === "number") {
	if (!Number.isFinite(value)) {
		throw new TypeError("Non-finite number cannot be canonicalized");
	}

	if (Object.is(value, -0)) {
		return 0;
	}

	const factor = 10 ** precision;
	const rounded = Math.round(value * factor) / factor;

	return Object.is(rounded, -0) ? 0 : rounded;
}
```

**Guidance:** deterministic fallback measurement should be pure, byte-stable, and explicit about constants. Validate finite `fontSize`, `lineHeight`, `maxWidth`, and reject impossible numeric input with `TypeError`, or return structured diagnostics where the public contract calls for diagnostics.

---

### `src/text/pretext.ts` (service, request-response)

**Analog:** None in codebase. Use `02-RESEARCH.md` dependency guidance and keep the adapter isolated.

**Research-backed import pattern** (`02-RESEARCH.md` lines 176-185):
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

**Adapter boundary guidance:** implement `PretextTextMeasurer` behind the public `TextMeasurer` interface from `src/text/types.ts`. Do not expose `PreparedTextWithSegments` in root public API. Add an availability guard such as `isPretextRuntimeAvailable()` or guarded constructor behavior because research found current Node has `Intl.Segmenter` but no Canvas 2D.

**Runtime failure pattern:** use the serializer's explicit `TypeError` style for programmer-invalid inputs, but for unavailable Pretext runtime prefer a deterministic diagnostic code such as `text.pretext.runtime-unavailable` when fitting labels can continue via fallback.

---

### `src/text/index.ts` (config, transform)

**Analog:** `src/serialization/index.ts`

**Barrel pattern** (`src/serialization/index.ts` line 1):
```typescript
export * from "./canonical.js";
```

**Guidance:** add one-line re-exports for text modules, using `.js` extensions:
```typescript
export * from "./fallback.js";
export * from "./pretext.js";
export * from "./types.js";
```

---

### `src/labels/types.ts` (model, transform)

**Analog:** `src/ir/elements.ts`, `src/ir/diagnostics.ts`, `src/ir/geometry.ts`

**Type-only imports pattern** (`src/ir/diagnostics.ts` lines 1-12):
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

**Existing label intent pattern** (`src/ir/elements.ts` lines 20-25):
```typescript
export interface Label {
	text: string;
	id?: string;
	maxWidth?: number;
	metadata?: JsonObject;
}
```

**Guidance:** `LabelLayout` should carry fitted label box, content box, line records, font/style information, line height, padding, overflow/truncation diagnostics, and source text. Keep it as layout data, not renderer data. Reuse `Box`, `Insets`, and `Diagnostic` rather than inventing parallel geometry/diagnostic shapes.

---

### `src/labels/fit.ts` (service, transform)

**Analog:** `src/serialization/canonical.ts`

**Core pure-transform pattern** (`src/serialization/canonical.ts` lines 66-103):
```typescript
function canonicalizeValue(
	value: unknown,
	precision: number,
	parentKey?: string,
): CanonicalJson {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return value;
	}

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("Non-finite number cannot be canonicalized");
		}
```

**Guidance:** `fitLabel()` should be a pure deterministic transform from `LabelFitOptions + TextMeasurer` to `LabelLayout`. Keep a class wrapper only if useful for dependency injection (`new LabelFitter(measurer)`). Do not import Pretext directly; accept `TextMeasurer`.

**Error/diagnostic guidance:** reject programmer-invalid geometry such as negative padding, negative min size, non-finite widths, or non-positive line height. Represent content overflow/truncation as `Diagnostic[]` on `LabelLayout` when fitting can still produce a result.

---

### `src/labels/index.ts` (config, transform)

**Analog:** `src/serialization/index.ts`

**Barrel pattern** (`src/serialization/index.ts` line 1):
```typescript
export * from "./canonical.js";
```

**Guidance:** use root-compatible `.js` re-exports:
```typescript
export * from "./fit.js";
export * from "./types.js";
```

---

### `src/geometry/boxes.ts` (utility, transform)

**Analog:** `src/ir/geometry.ts` and `src/serialization/canonical.ts`

**Geometry primitive pattern** (`src/ir/geometry.ts` lines 11-28):
```typescript
export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Box extends Point, Size {}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}
```

**Finite numeric validation pattern** (`src/serialization/canonical.ts` lines 79-82):
```typescript
if (typeof value === "number") {
	if (!Number.isFinite(value)) {
		throw new TypeError("Non-finite number cannot be canonicalized");
	}
```

**Guidance:** implement `normalizeInsets`, `boxCenter`, `expandBox`, `unionBoxes`, `intersectsAabb`, and validation helpers as pure functions. Preserve point order where functions return routes/points. Do not use renderer names or exporter-specific coordinates.

---

### `src/geometry/shapes.ts` (service, transform)

**Analog:** `src/ir/elements.ts` and `src/ir/geometry.ts`

**Shape contract pattern** (`src/ir/elements.ts` lines 11-18):
```typescript
export type NodeShape =
	| "rectangle"
	| "rounded-rectangle"
	| "ellipse"
	| "diamond"
	| "parallelogram"
	| "hexagon"
	| "cylinder";
```

**Anchor contract pattern** (`src/ir/geometry.ts` lines 30-44):
```typescript
export type AnchorName =
	| "center"
	| "top"
	| "right"
	| "bottom"
	| "left"
	| "top-left"
	| "top-right"
	| "bottom-right"
	| "bottom-left";

export interface AnchorPoint {
	name: AnchorName;
	point: Point;
}
```

**Coordinated node handoff pattern** (`src/ir/elements.ts` lines 48-53):
```typescript
export interface CoordinatedNode extends NodeBase {
	shape: NodeShape;
	box: Box;
	anchors: AnchorPoint[];
	parentId?: string;
}
```

**Guidance:** return a renderer-neutral shape geometry record containing `shape`, `box`, `center`, `anchors`, `obstacleBox`, and deterministic edge entry/exit approximations. Keep practical approximation debt documented in type or function comments if needed, but do not add SVG path strings, CSS radius fields, Excalidraw shape names, Mermaid syntax, or draw.io XML.

---

### `src/geometry/containers.ts` (service, transform)

**Analog:** `src/ir/elements.ts`, `src/ir/diagram.ts`

**Group contract pattern** (`src/ir/elements.ts` lines 81-101):
```typescript
export interface IntentGroup {
	id: string;
	label?: Label;
	nodeIds?: string[];
	groupIds?: string[];
	padding?: Insets;
	metadata?: JsonObject;
}

export interface NormalizedGroup {
	id: string;
	label?: Label;
	nodeIds: string[];
	groupIds: string[];
	padding: Insets;
	metadata?: JsonObject;
}

export interface CoordinatedGroup extends NormalizedGroup {
	box: Box;
}
```

**Prepare/solve/export comment pattern** (`src/ir/diagram.ts` lines 20-46):
```typescript
// Authoring intent consumed by the future prepare stage.
export interface IntentDiagram {
	id?: string;
	title?: string;
	direction?: DiagramDirection;
	nodes: IntentNode[];
```

```typescript
// Solve output consumed by future exporters.
export interface CoordinatedDiagram {
	id: string;
	title?: string;
	direction: DiagramDirection;
	nodes: CoordinatedNode[];
```

**Guidance:** container geometry must consume already-known child `Box[]`; it must not move children, place children, invoke Dagre, or solve containment. Compute child bounds, padding, optional label/header layout, outer box, content box, anchors, and obstacle box using the same box utilities and label fitting chain.

---

### `src/geometry/index.ts` (config, transform)

**Analog:** `src/ir/index.ts`

**Barrel pattern** (`src/ir/index.ts` lines 1-5):
```typescript
export * from "./constraints.js";
export * from "./diagnostics.js";
export * from "./diagram.js";
export * from "./elements.js";
export * from "./geometry.js";
```

**Guidance:** export `boxes.js`, `shapes.js`, and `containers.js` from this barrel.

---

### `src/index.ts` (config, transform)

**Analog:** current `src/index.ts`

**Root public export pattern** (`src/index.ts` lines 1-2):
```typescript
export * from "./ir/index.js";
export * from "./serialization/index.js";
```

**Guidance:** add Phase 2 barrels here and keep root-only public package exports:
```typescript
export * from "./geometry/index.js";
export * from "./ir/index.js";
export * from "./labels/index.js";
export * from "./serialization/index.js";
export * from "./text/index.js";
```

Do not add package subpath exports unless a later plan explicitly changes the public API strategy. Phase 1 verification established root-only exports as a verified contract.

---

### `package.json` (config, batch)

**Analog:** current `package.json`

**Package/export/script pattern** (`package.json` lines 5-20 and 26-33):
```json
	"type": "module",
	"private": true,
	"sideEffects": false,
	"engines": {
		"node": ">=20"
	},
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
```

```json
	"scripts": {
		"build": "tsup",
		"typecheck": "tsc --noEmit",
		"test": "vitest run",
		"lint": "biome ci .",
		"format": "biome check --write .",
		"verify": "npm run typecheck && npm run build && npm test && npm run lint"
	},
```

**Guidance:** add `@chenglou/pretext` as a dependency, not a dev-only test dependency, because it is the default real text backend. Preserve root-only `exports["."]`; do not add `./text`, `./labels`, or `./geometry` subpaths in Phase 2.

---

### `test/text-measurer.test.ts` (test, request-response)

**Analog:** `test/public-api.test.ts`, `test/serialization.test.ts`

**Vitest import pattern** (`test/public-api.test.ts` lines 1-13):
```typescript
import { describe, expect, it } from "vitest";
import type {
	Box,
	Constraint,
	CoordinatedDiagram,
	Diagnostic,
	IntentDiagram,
	IntentEdge,
	IntentNode,
	Label,
	NormalizedDiagram,
	Point,
} from "../src/index.js";
```

**Root-entry import pattern** (`test/serialization.test.ts` lines 1-6):
```typescript
import { describe, expect, it } from "vitest";
import {
	canonicalize,
	DEFAULT_CANONICAL_PRECISION,
	stringifyCanonical,
} from "../src/index.js";
```

**Test style pattern** (`test/serialization.test.ts` lines 109-119):
```typescript
it("rejects non-finite numbers", () => {
	expect(() => stringifyCanonical({ x: Number.NaN })).toThrow(
		/Non-finite number/,
	);
	expect(() => stringifyCanonical({ x: Number.POSITIVE_INFINITY })).toThrow(
		/Non-finite number/,
	);
	expect(() => stringifyCanonical({ x: Number.NEGATIVE_INFINITY })).toThrow(
		/Non-finite number/,
	);
});
```

**Guidance:** test `DeterministicTextMeasurer` as the default stable CI path. Pretext tests must be guarded/skipped when Canvas 2D is unavailable. Import all public types and implementations from `../src/index.js`, not internal module paths, unless testing a deliberately private helper.

---

### `test/label-fitting.test.ts` (test, transform)

**Analog:** `test/serialization.test.ts`

**Numeric assertion pattern** (`test/serialization.test.ts` lines 91-98):
```typescript
it("rounds finite numbers to the default precision", () => {
	expect(DEFAULT_CANONICAL_PRECISION).toBe(3);
	expect(stringifyCanonical({ x: 2.1239 })).toContain('"x": 2.124');
});

it("normalizes negative zero", () => {
	expect(stringifyCanonical({ x: -0 })).toContain('"x": 0');
});
```

**Guidance:** assert label `box`, `contentBox`, `lineHeight`, line count, per-line widths, padding, min size, `maxWidth`, and diagnostics directly. Do not generate SVG/HTML output in Phase 2 tests.

---

### `test/box-geometry.test.ts` (test, transform)

**Analog:** `test/serialization.test.ts`

**Invalid input pattern** (`test/serialization.test.ts` lines 180-189):
```typescript
it("rejects invalid precision values", () => {
	for (const precision of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
		expect(() => canonicalize({ x: 1.23 }, { precision })).toThrow(
			/Canonical precision/,
		);
		expect(() => stringifyCanonical({ x: 1.23 }, precision)).toThrow(
			/Canonical precision/,
		);
	}
});
```

**Guidance:** cover finite validation, negative width/height rejection, box center, expansion by number and insets, union of multiple boxes, touching/non-touching AABB collision behavior, and deterministic output for repeated calls.

---

### `test/shape-geometry.test.ts` (test, transform)

**Analog:** `test/public-api.test.ts`, `test/serialization.test.ts`

**Coordinated geometry sample pattern** (`test/public-api.test.ts` lines 57-92):
```typescript
it("type-checks a coordinated diagram sample", () => {
	const sample: CoordinatedDiagram = {
		id: "coordinated-sample",
		direction: "LR",
		nodes: [
			{
				id: "node-a",
				shape: "rectangle",
				label: { text: "A" },
				box: { x: 0, y: 0, width: 120, height: 60 },
				anchors: [
					{
						name: "center",
						point: { x: 60, y: 30 },
					},
				],
			},
		],
```

**Anchor sorting fixture pattern** (`test/serialization.test.ts` lines 151-178):
```typescript
it("sorts unordered anchors by anchor name", () => {
	const first = {
		nodes: [
			{
				id: "node-a",
				anchors: [
					{ name: "right", point: { x: 80, y: 20 } },
					{ name: "left", point: { x: 0, y: 20 } },
				],
			},
		],
	};
```

**Guidance:** table-drive tests across all seven `NodeShape` values. Assert center, cardinal anchors, diagonal anchors, obstacle boxes, and practical edge ports. Use exact equality for pure geometry where possible.

---

### `test/container-geometry.test.ts` (test, transform)

**Analog:** `test/public-api.test.ts`, `test/serialization.test.ts`

**Group/coordinated diagram pattern** (`src/ir/elements.ts` lines 90-101):
```typescript
export interface NormalizedGroup {
	id: string;
	label?: Label;
	nodeIds: string[];
	groupIds: string[];
	padding: Insets;
	metadata?: JsonObject;
}

export interface CoordinatedGroup extends NormalizedGroup {
	box: Box;
}
```

**Point order preservation pattern** (`test/serialization.test.ts` lines 121-149):
```typescript
it("preserves semantic point sequence order", () => {
	const route = {
		edges: [
			{
				id: "edge-a-b",
				sourceId: "node-a",
				targetId: "node-b",
				points: [
					{ x: 10, y: 0 },
					{ x: 0, y: 0 },
				],
			},
		],
	};
```

**Guidance:** test containers from known child boxes only. Assert child boxes are not mutated or moved. Assert padding, label/header fit, content box, outer box, anchors, and obstacle box. Do not test automatic child placement here.

---

### `test/fixtures/phase-02/*.canonical.json` (test, batch)

**Analog:** `test/serialization.test.ts`

**Canonical fixture generation pattern** (`test/serialization.test.ts` lines 79-89):
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

**Serializer behavior to rely on** (`src/serialization/canonical.ts` lines 15-32):
```typescript
const UNORDERED_COLLECTION_KEYS = new Set([
	"nodes",
	"edges",
	"groups",
	"constraints",
	"diagnostics",
	"anchors",
]);

const IDENTITY_KEYS = [
	"id",
	"name",
	"sourceId",
	"targetId",
	"nodeId",
	"groupId",
	"kind",
] as const;
```

**Guidance:** produce fixtures by `stringifyCanonical()` with default precision 3. Keep fixture files as canonical output records for labels, shapes, and containers. Do not hand-order object keys or rely on raw `JSON.stringify()` output.

## Shared Patterns

### Root Public Exports

**Source:** `src/index.ts` lines 1-2; `src/ir/index.ts` lines 1-5; `package.json` lines 14-20  
**Apply to:** all Phase 2 public modules and tests

```typescript
export * from "./ir/index.js";
export * from "./serialization/index.js";
```

```json
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"require": "./dist/index.cjs"
		}
	},
```

Planner guidance: add `text`, `labels`, and `geometry` to `src/index.ts`; keep all tests importing from `../src/index.js`; do not add subpath package exports in Phase 2.

### ESM And TypeScript Import Style

**Source:** `src/ir/elements.ts` lines 1-9; `tsconfig.json` lines 4-15  
**Apply to:** all new TypeScript files

```typescript
import type {
	AnchorName,
	AnchorPoint,
	Box,
	Insets,
	JsonObject,
	Point,
	Size,
} from "./geometry.js";
```

```json
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"noUncheckedIndexedAccess": true,
		"verbatimModuleSyntax": true,
```

Planner guidance: use `.js` extensions in local imports and `import type` for type-only imports. Keep strict optional property behavior in mind: avoid assigning explicit `undefined` to optional fields.

### Renderer-Neutral API Constraint

**Source:** `src/ir/diagram.ts` lines 20-55; `02-CONTEXT.md` lines 31-37 and 44-48  
**Apply to:** `src/text/*`, `src/labels/*`, `src/geometry/*`, tests

```typescript
// Authoring intent consumed by the future prepare stage.
export interface IntentDiagram {
```

```typescript
// Prepare output consumed by the future solve stage.
export interface NormalizedDiagram {
```

```typescript
// Solve output consumed by future exporters.
export interface CoordinatedDiagram {
```

Planner guidance: Phase 2 APIs produce numeric layout contracts. They must not contain SVG, HTML, CSS, Excalidraw, Mermaid, draw.io, Canvas rendering output, or exporter-native fields.

### Diagnostics And Recoverable Conditions

**Source:** `src/ir/diagnostics.ts` lines 3-12  
**Apply to:** label overflow/truncation, Pretext runtime unavailability when fallback can continue

```typescript
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

Planner guidance: use diagnostics for layout results that are valid but notable. Use thrown `TypeError` for invalid programmer inputs such as non-finite coordinates or negative dimensions.

### Numeric Validation And Determinism

**Source:** `src/serialization/canonical.ts` lines 58-63, 79-91, 127-135  
**Apply to:** measurement, label fitting, box utilities, shape/container geometry

```typescript
function resolvePrecision(precision: number): number {
	if (!Number.isInteger(precision) || precision < 0) {
		throw new TypeError("Canonical precision must be a non-negative integer");
	}

	return precision;
}
```

```typescript
for (const key of Object.keys(value).sort()) {
	const rawValue = (value as Record<string, unknown>)[key];

	if (rawValue === undefined) {
		continue;
	}

	result[key] = canonicalizeValue(rawValue, precision, key);
}
```

Planner guidance: public geometry functions should validate finite numbers and stable option normalization. Outputs should be deterministic across equivalent object orderings.

### Vitest Naming And Test Commands

**Source:** `vitest.config.ts` lines 3-12; `package.json` lines 26-33; `02-VALIDATION.md` lines 20-23  
**Apply to:** all Phase 2 tests

```typescript
export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		include: ["test/**/*.test.ts"],
		coverage: {
			reporter: ["text", "json"],
			reportsDirectory: "coverage",
		},
	},
});
```

```json
	"scripts": {
		"build": "tsup",
		"typecheck": "tsc --noEmit",
		"test": "vitest run",
		"lint": "biome ci .",
		"format": "biome check --write .",
		"verify": "npm run typecheck && npm run build && npm test && npm run lint"
	},
```

Planner guidance: name tests `test/text-measurer.test.ts`, `test/label-fitting.test.ts`, `test/box-geometry.test.ts`, `test/shape-geometry.test.ts`, and `test/container-geometry.test.ts`. Focused commands should be written as `rtk npm test -- text-measurer`, etc.

### Deterministic Serializer Fixture Style

**Source:** `src/serialization/canonical.ts` lines 47-56; `test/serialization.test.ts` lines 79-89  
**Apply to:** `test/fixtures/phase-02/*.canonical.json`

```typescript
export function stringifyCanonical(
	value: unknown,
	precision = DEFAULT_CANONICAL_PRECISION,
): string {
	return `${JSON.stringify(
		canonicalize(value, { precision: resolvePrecision(precision) }),
		null,
		2,
	)}\n`;
}
```

Planner guidance: compare generated canonical strings to committed fixture contents. Default precision is 3. Canonical serializer sorts unordered collections and preserves semantic point sequences.

### RTK Command Usage

**Source:** `/home/zhangyangrui/.codex/RTK.md` lines 5-16; `02-VALIDATION.md` lines 20-23  
**Apply to:** every plan verify command and shell command

```bash
rtk npm test -- text-measurer label-fitting box-geometry shape-geometry container-geometry
rtk npm run verify
```

Planner guidance: all shell commands in PLAN.md and execution notes must use `rtk` prefix, including installs such as `rtk npm install @chenglou/pretext`, focused tests, typecheck, lint, and full verify.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/text/pretext.ts` | service | request-response | No existing external dependency adapter or runtime availability guard exists in the codebase. Use research-backed Pretext API and isolate upstream types. |
| `README.md` | documentation | batch | Repository has no existing README despite `package.json` listing it in package files. Create minimal project README plus Pretext appreciation/credits. |
| `LICENSE` | documentation | batch | Repository has no existing license file. Use MIT license per Phase 2 decisions. |
| `test/fixtures/phase-02/*.canonical.json` | test | batch | No fixture directory exists yet; use `stringifyCanonical()` behavior from serializer tests as the fixture generation pattern. |

## Metadata

**Analog search scope:** `src`, `test`, `.planning/phases/02-text-labels-and-shape-geometry`, Phase 1 verification artifacts, `package.json`, `tsconfig.json`, `vitest.config.ts`  
**Files scanned:** 12 source/test files, 5 config/phase files, 0 project skill files  
**Project skills:** none found under `.codex/skills`, `.claude/skills`, or `.agents/skills`  
**Pattern extraction date:** 2026-05-24  
**Primary commands used:** `rtk nl -ba ...`, `rtk rg --files ...`, `rtk find ...`

## PATTERN MAPPING COMPLETE

**Phase:** 02 - text-labels-and-shape-geometry  
**Files classified:** 22  
**Analogs found:** 18 / 22

### Coverage

- Files with exact analog: 5
- Files with role-match analog: 8
- Files with partial analog: 5
- Files with no analog: 4

### Key Patterns Identified

- Public APIs are root-entrypoint only: add barrels and re-export through `src/index.ts`, then test via `../src/index.js`.
- Geometry, text, and label APIs must remain renderer-neutral and produce numeric contracts for future layout/routing/exporters.
- Pure transforms validate finite numeric input with explicit `TypeError` behavior and use diagnostics for recoverable layout conditions.
- Vitest files use `test/**/*.test.ts`, explicit `describe/expect/it` imports, and focused `rtk npm test -- <name>` commands.
- Stable fixtures should be generated and compared through `stringifyCanonical()` with default precision 3.

### File Created

`.planning/phases/02-text-labels-and-shape-geometry/02-PATTERNS.md`

### Ready for Planning

Pattern mapping complete. Planner can now reference analog patterns in PLAN.md files.
