# Phase 05: dsl-parser-and-cli - Pattern Map

**Mapped:** 2026-05-25  
**Files analyzed:** 19 likely new/modified files  
**Analogs found:** 16 / 19

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/dsl/index.ts` | config / barrel | transform | `src/index.ts`, `src/exporters/index.ts` | exact |
| `src/dsl/parse.ts` | utility | transform | `src/serialization/canonical.ts` | partial |
| `src/dsl/schema.ts` | config / validation | transform | `src/ir/elements.ts`, `src/ir/constraints.ts` | role-match |
| `src/dsl/normalize.ts` | service / utility | transform | `src/solver/solve.ts`, `test/solver.test.ts` | role-match |
| `src/dsl/edges.ts` | utility | transform | `src/solver/solve.ts` edge mapping | partial |
| `src/dsl/diagnostics.ts` | utility | transform | `src/ir/diagnostics.ts`, `src/solver/solve.ts` diagnostics | exact |
| `src/cli/index.ts` | route / CLI entry | request-response | `tsup.config.ts`, `package.json` | partial |
| `src/cli/run.ts` | controller / service | file-I/O + request-response | `src/solver/solve.ts`, `src/exporters/index.ts` | role-match |
| `src/cli/io.ts` | utility | file-I/O | `test/determinism.test.ts`, `test/exporters.test.ts` | partial |
| `src/index.ts` | config / public API barrel | transform | existing `src/index.ts` | exact |
| `package.json` | config | build/package | existing `package.json` | exact |
| `package-lock.json` | config | build/package | existing npm lockfile | exact |
| `tsup.config.ts` | config | build/package | existing `tsup.config.ts` | exact |
| `examples/*.yaml` | fixture / example | file-I/O | `test/fixtures/phase-03/*.json`, `test/fixtures/phase-04/*` | role-match |
| `test/fixtures/phase-05/*` | fixture | file-I/O | `test/fixtures/phase-03/*`, `test/fixtures/phase-04/*` | exact |
| `test/dsl.test.ts` | test | transform | `test/solver.test.ts`, `test/determinism.test.ts` | exact |
| `test/dsl-diagnostics.test.ts` | test | transform | `test/solver.test.ts`, `test/serialization.test.ts` | role-match |
| `test/cli.test.ts` | test | file-I/O + request-response | `test/determinism.test.ts`, `test/exporters.test.ts` | role-match |
| `test/public-api.test.ts` | test | transform | existing `test/public-api.test.ts` | exact |

## Pattern Assignments

### `src/dsl/index.ts` (config / barrel, transform)

**Analog:** `src/exporters/index.ts` and `src/index.ts`

**Barrel export pattern** (`src/exporters/index.ts` lines 1-4):

```typescript
export * from "./arrow.js";
export * from "./excalidraw.js";
export * from "./svg.js";
export * from "./types.js";
```

**Root export pattern** (`src/index.ts` lines 1-10):

```typescript
export * from "./constraints/index.js";
export * from "./exporters/index.js";
export * from "./geometry/index.js";
export * from "./ir/index.js";
export * from "./labels/index.js";
export * from "./layout/index.js";
export * from "./routing/index.js";
export * from "./serialization/index.js";
export * from "./solver/index.js";
export * from "./text/index.js";
```

**Apply:** Add `export * from "./dsl/index.js";` to the root only if Phase 05 chooses a public parser API. Keep `.js` ESM specifiers.

---

### `src/dsl/parse.ts` (utility, transform)

**Analog:** `src/serialization/canonical.ts`

**Pure function and options pattern** (lines 1-5, 36-55):

```typescript
export const DEFAULT_CANONICAL_PRECISION = 3;

export interface CanonicalizeOptions {
	precision?: number;
}

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

**Validation/error style** (lines 58-64, 79-82, 102):

```typescript
function resolvePrecision(precision: number): number {
	if (!Number.isInteger(precision) || precision < 0) {
		throw new TypeError("Canonical precision must be a non-negative integer");
	}

	return precision;
}

if (typeof value === "number") {
	if (!Number.isFinite(value)) {
		throw new TypeError("Non-finite number cannot be canonicalized");
	}
}

throw new TypeError("Unsupported value cannot be canonicalized");
```

**Apply:** Parser should expose typed options/results, keep parsing side-effect-free, and return diagnostics for user DSL errors. Reserve thrown `TypeError` for programmer misuse or impossible states.

---

### `src/dsl/schema.ts` (config / validation, transform)

**Analog:** `src/ir/elements.ts`, `src/ir/constraints.ts`, `src/ir/diagram.ts`

**IR target shape** (`src/ir/diagram.ts` lines 20-43):

```typescript
// Authoring intent consumed by the future prepare stage.
export interface IntentDiagram {
	id?: string;
	title?: string;
	direction?: DiagramDirection;
	nodes: IntentNode[];
	edges?: IntentEdge[];
	groups?: IntentGroup[];
	constraints?: Constraint[];
	metadata?: DiagramMetadata;
}

// Prepare output consumed by the future solve stage.
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
```

**Supported node and edge fields** (`src/ir/elements.ts` lines 12-19, 21-40, 64-70):

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

export interface IntentNode extends NodeBase {
	parentId?: string;
	position?: Point;
	size?: Size;
	padding?: Insets;
}

export interface IntentEdge {
	id?: string;
	sourceId: string;
	targetId: string;
	label?: Label;
	metadata?: JsonObject;
}
```

**Supported groups** (`src/ir/elements.ts` lines 85-102):

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
	labelLayout?: LabelLayout;
}
```

**Supported constraints** (`src/ir/constraints.ts` lines 16-72):

```typescript
export interface ExactPositionConstraint extends ConstraintBase {
	kind: "exact-position";
	position: Point;
}

export type RelativePositionRelation =
	| "above"
	| "right-of"
	| "below"
	| "left-of";

export interface RelativePositionConstraint extends ConstraintBase {
	kind: "relative-position";
	sourceId: string;
	referenceId: string;
	relation: RelativePositionRelation;
	offset?: Point;
}

export interface AlignConstraint extends ConstraintBase {
	kind: "align";
	axis: AlignmentAxis;
	targetIds: string[];
}

export interface DistributeConstraint extends ConstraintBase {
	kind: "distribute";
	axis: DistributionAxis;
	targetIds: string[];
	spacing?: number;
}

export interface ContainmentConstraint extends ConstraintBase {
	kind: "containment";
	containerId: string;
	childIds: string[];
	padding?: Insets;
}
```

**Apply:** Zod schemas should accept the agent-friendly DSL, then normalize into these existing IR fields. Do not introduce a second long-lived semantic model.

---

### `src/dsl/normalize.ts` (service / utility, transform)

**Analog:** `src/solver/solve.ts` and `test/solver.test.ts`

**Solver input contract to produce** (`test/solver.test.ts` lines 99-135):

```typescript
function sampleDiagram(): NormalizedDiagram {
	return {
		id: "sample",
		title: "Sample",
		direction: "LR",
		nodes: [node("a", { x: 10, y: 20 }), node("b"), node("c")],
		edges: [
			{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
			{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
		],
		groups: [
			{
				id: "group",
				nodeIds: ["a", "b"],
				groupIds: [],
				padding: { top: 8, right: 8, bottom: 8, left: 8 },
			},
		],
		constraints: [
			{
				kind: "relative-position",
				sourceId: "b",
				referenceId: "a",
				relation: "right-of",
				offset: { x: 80, y: 0 },
			},
		],
		diagnostics: [],
		metadata: { fixture: "solver" },
	};
}
```

**Default node helper pattern** (`test/solver.test.ts` lines 138-146):

```typescript
function node(id: string, position?: { x: number; y: number }) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		...(position === undefined ? {} : { position }),
	};
}
```

**Stable ordering pattern** (`src/solver/solve.ts` lines 31-35, 278-288):

```typescript
const diagnostics: Diagnostic[] = [...diagram.diagnostics];
const nodes = stableById(diagram.nodes);
const edges = stableById(diagram.edges);
const groups = stableById(diagram.groups);
const constraints = stableByConstraintId(diagram.constraints);

function stableById<T extends { id: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function stableByConstraintId<T extends { id?: string; kind: string }>(
	items: readonly T[],
): T[] {
	return [...items].sort((a, b) =>
		`${a.id ?? a.kind}`.localeCompare(`${b.id ?? b.kind}`),
	);
}
```

**Apply:** Normalize node maps, group maps, edge shorthand, and constraints into stable arrays before solving. Use deterministic defaults for `id`, `direction`, `shape`, `size`, `padding`, `edges`, `groups`, `constraints`, and `diagnostics`.

---

### `src/dsl/edges.ts` (utility, transform)

**Analog:** `src/solver/solve.ts` edge conversion and `test/determinism.test.ts` edge fixtures

**Normalized edge shape expected by solver** (`src/solver/solve.ts` lines 36-43):

```typescript
const layout = runDagreInitialLayout({
	direction: diagram.direction,
	nodes: nodes.map((node) => ({ id: node.id, size: node.size })),
	edges: edges.map((edge) => ({
		id: edge.id,
		sourceId: edge.source.nodeId,
		targetId: edge.target.nodeId,
	})),
});
```

**Edge fixture style** (`test/determinism.test.ts` lines 14-17):

```typescript
edges: [
	{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
	{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
],
```

**Apply:** Parse `api -> db` into `{ id: "api-db", source: { nodeId: "api" }, target: { nodeId: "db" } }` unless an explicit id is present. Parse `web -> api: calls` into the same edge shape with `label: { text: "calls" }`. Validate missing references before solve when possible.

---

### `src/dsl/diagnostics.ts` (utility, transform)

**Analog:** `src/ir/diagnostics.ts`, `src/solver/solve.ts`

**Base diagnostic contract** (`src/ir/diagnostics.ts` lines 3-13):

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

**Diagnostic creation pattern** (`src/solver/solve.ts` lines 123-131):

```typescript
if (box === undefined) {
	diagnostics.push({
		severity: "error",
		code: "solver.node-box.missing",
		message: `Node ${node.id} has no solved box.`,
		path: ["nodes", node.id],
		detail: { nodeId: node.id },
	});
	continue;
}
```

**Reference error helper pattern** (`src/solver/solve.ts` lines 290-302):

```typescript
function groupReferenceMissing(
	groupId: string,
	referenceKind: string,
	id: string | undefined,
): Diagnostic {
	return {
		severity: "error",
		code: "solver.group-reference.missing",
		message: `Group ${groupId} references a missing ${referenceKind}.`,
		path: ["groups", groupId],
		detail: id === undefined ? { groupId } : { groupId, id },
	};
}
```

**Apply:** Add layer-aware DSL/CLI diagnostics by extending or wrapping the existing shape, but keep `severity`, `code`, `message`, `path`, and `detail` compatible with `Diagnostic`. For human output, include path and repair hint. For `--json`, canonicalize ordering.

---

### `src/cli/index.ts` (route / CLI entry, request-response)

**Analog:** `package.json` and `tsup.config.ts`

**Package module conventions** (`package.json` lines 5-19):

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
}
```

**Build entry convention** (`tsup.config.ts` lines 3-12):

```typescript
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "node20",
	treeshake: true,
	splitting: false,
});
```

**Apply:** Add a CLI entry to tsup, and add `bin: { "dge": "./dist/cli/index.js" }` to `package.json`. Keep the CLI entry thin: parse process args, call testable `runCli()`, set `process.exitCode`.

---

### `src/cli/run.ts` (controller / service, file-I/O + request-response)

**Analog:** `src/solver/solve.ts`, `src/exporters/index.ts`, `src/exporters/types.ts`

**Pipeline entry pattern** (`src/solver/solve.ts` lines 27-31, 97-110):

```typescript
export function solveDiagram(
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions = {},
): CoordinatedDiagram {
	const diagnostics: Diagnostic[] = [...diagram.diagnostics];

	return {
		id: diagram.id,
		...(diagram.title === undefined ? {} : { title: diagram.title }),
		direction: diagram.direction,
		nodes: coordinatedNodes,
		edges: coordinatedEdges,
		groups: coordinatedGroups,
		diagnostics,
		bounds:
			allBoxes.length === 0
				? { x: 0, y: 0, width: 0, height: 0 }
				: unionBoxes(allBoxes),
		...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
	};
}
```

**Exporter selection surface** (`src/exporters/index.ts` lines 1-4, `src/exporters/types.ts` lines 3-13):

```typescript
export * from "./arrow.js";
export * from "./excalidraw.js";
export * from "./svg.js";
export * from "./types.js";

export type ExportFormat = "svg" | "excalidraw";

export interface ExportResult {
	format: ExportFormat;
	content: string;
	diagnostics: Diagnostic[];
}

export interface ExportOptions {
	title?: string;
}
```

**Exporter functions to call** (`src/exporters/svg.ts` lines 18-23, `src/exporters/excalidraw.ts` lines 93-97):

```typescript
export function exportSvg(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const title = options.title ?? diagram.title;
```

```typescript
export function exportExcalidraw(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const elements: ExcalidrawElement[] = [];
```

**Apply:** CLI orchestration should resolve final format once with precedence `--format` > DSL `output.format` > `svg`, call parser/normalizer, call `solveDiagram()`, block on error diagnostics, then call `exportSvg()` or `exportExcalidraw()`.

---

### `src/cli/io.ts` (utility, file-I/O)

**Analog:** fixture IO in tests

**Fixture read pattern** (`test/determinism.test.ts` lines 49-55):

```typescript
const fixture = readFileSync(
	new URL(`./fixtures/phase-03/${fixtureName}`, import.meta.url),
	"utf8",
);

expect(stringifyCanonical(solveDiagram(input))).toBe(fixture);
```

**Directory scan pattern** (`test/exporters.test.ts` lines 121-128):

```typescript
const exporterDir = new URL("../src/exporters", import.meta.url);
const sourceFiles = readdirSync(exporterDir)
	.filter((fileName) => fileName.endsWith(".ts"))
	.map((fileName) => join(exporterDir.pathname, fileName));

for (const filePath of sourceFiles) {
	const content = readFileSync(filePath, "utf8");
```

**No production analog found:** There is no existing CLI stdin/stdout/stderr or atomic write helper in `src/`. Use Node `fs/promises` for implementation, and test temp-file-then-rename behavior in `test/cli.test.ts`.

---

### `src/index.ts` (config / public API barrel, transform)

**Analog:** existing `src/index.ts`

**Public API export pattern** (lines 1-10):

```typescript
export * from "./constraints/index.js";
export * from "./exporters/index.js";
export * from "./geometry/index.js";
export * from "./ir/index.js";
export * from "./labels/index.js";
export * from "./layout/index.js";
export * from "./routing/index.js";
export * from "./serialization/index.js";
export * from "./solver/index.js";
export * from "./text/index.js";
```

**Public API test guard** (`test/public-api.test.ts` lines 252-258):

```typescript
it("keeps package exports root-only", () => {
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { exports: Record<string, unknown> };

	expect(Object.keys(packageJson.exports)).toEqual(["."]);
});
```

**Apply:** Add public DSL exports through the root barrel only. Do not add subpath exports unless the package export policy changes and the test is updated intentionally.

---

### `package.json` and `package-lock.json` (config, build/package)

**Analog:** existing `package.json`

**Dependency sections** (lines 34-44):

```json
"devDependencies": {
	"@biomejs/biome": "2.4.15",
	"@types/node": "25.9.1",
	"tsup": "8.5.1",
	"typescript": "6.0.3",
	"vitest": "4.1.7"
},
"dependencies": {
	"@chenglou/pretext": "^0.0.7",
	"@dagrejs/dagre": "^3.0.0"
}
```

**Scripts and gate** (lines 26-32):

```json
"scripts": {
	"build": "tsup",
	"typecheck": "tsc --noEmit",
	"test": "vitest run",
	"lint": "biome ci .",
	"format": "biome check --write .",
	"verify": "npm run typecheck && npm run build && npm test && npm run lint"
}
```

**Apply:** Add runtime dependencies `yaml`, `zod`, and `commander` with `rtk npm install yaml zod commander`. This updates `package-lock.json`; do not hand-edit the lockfile.

---

### `tsup.config.ts` (config, build/package)

**Analog:** existing `tsup.config.ts`

**Current build config** (lines 1-12):

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "node20",
	treeshake: true,
	splitting: false,
});
```

**Apply:** Add `src/cli/index.ts` to `entry`. Keep Node 20 target, source maps, DTS generation, clean build, and no splitting unless the CLI shebang requires a targeted tsup option.

---

### `examples/*.yaml` and `test/fixtures/phase-05/*` (fixture / example, file-I/O)

**Analog:** committed fixture usage in `test/determinism.test.ts`

**Fixture table pattern** (lines 43-55):

```typescript
it.each([
	["dagre-directions.canonical.json", dagreDirectionsDiagram()],
	["hybrid-layout.canonical.json", hybridLayoutDiagram()],
	["constraints.canonical.json", constraintDiagnosticsDiagram()],
	["routing.canonical.json", routingDiagram()],
])("matches committed Phase 3 fixture %s", (fixtureName, input) => {
	const fixture = readFileSync(
		new URL(`./fixtures/phase-03/${fixtureName}`, import.meta.url),
		"utf8",
	);

	expect(stringifyCanonical(solveDiagram(input))).toBe(fixture);
});
```

**Phase 4 multi-format fixture pattern** (`test/determinism.test.ts` lines 57-85):

```typescript
const fixture = JSON.parse(
	readFileSync(
		new URL(
			"./fixtures/phase-04/coordinated-export.canonical.json",
			import.meta.url,
		),
		"utf8",
	),
) as CoordinatedDiagram;
const svgGolden = readFileSync(
	new URL("./fixtures/phase-04/coordinated-export.svg", import.meta.url),
	"utf8",
);
const excalidrawGolden = readFileSync(
	new URL(
		"./fixtures/phase-04/coordinated-export.excalidraw.json",
		import.meta.url,
	),
	"utf8",
);

expect(exportSvg(fixture, { title: "Coordinated Export" })).toBe(svgGolden);
```

**Apply:** Add Phase 05 YAML/JSON examples for architecture, flowchart, edge labels, groups, and hybrid layout. Tests should read these files with `new URL(..., import.meta.url)` and compare normalized/canonical or exported output.

---

### `test/dsl.test.ts` (test, transform)

**Analog:** `test/solver.test.ts`, `test/determinism.test.ts`

**Vitest import and describe style** (`test/solver.test.ts` lines 1-7):

```typescript
import { describe, expect, it } from "vitest";
import type { NormalizedDiagram } from "../src/ir/index.js";
import { solveDiagram } from "../src/solver/index.js";

describe("solveDiagram", () => {
	it("returns coordinated nodes, routed edges, groups, bounds, and diagnostics", () => {
		const result = solveDiagram(sampleDiagram());
```

**Determinism assertion pattern** (`test/determinism.test.ts` lines 8-40):

```typescript
describe("solver determinism", () => {
	it("serializes repeated solveDiagram output byte-identically", () => {
		const input: NormalizedDiagram = {
			id: "deterministic",
			direction: "TB",
			nodes: [node("b"), node("a", { x: 0, y: 0 }), node("c")],
			edges: [
				{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
				{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		};

		expect(stringifyCanonical(solveDiagram(input))).toBe(
			stringifyCanonical(solveDiagram(input)),
		);
	});
```

**Apply:** Assert YAML and JSON normalize into equivalent canonical IR, map node object keys to stable node ids, support fixed positions, structured constraints, groups, top-level layout/routing defaults, and edge shorthand labels.

---

### `test/dsl-diagnostics.test.ts` (test, transform)

**Analog:** `test/solver.test.ts`, `test/serialization.test.ts`

**Diagnostic assertion pattern** (`test/solver.test.ts` lines 54-96):

```typescript
it("returns a partial diagram plus error diagnostics for malformed input", () => {
	const result = solveDiagram({
		...sampleDiagram(),
		edges: [
			{
				id: "bad-edge",
				source: { nodeId: "a" },
				target: { nodeId: "missing" },
			},
		],
		groups: [
			{
				id: "bad-group",
				nodeIds: ["missing"],
				groupIds: [],
				padding: { top: 4, right: 4, bottom: 4, left: 4 },
			},
		],
	});

	expect(result.nodes.length).toBeGreaterThan(0);
	expect(result.edges).toHaveLength(0);
	expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		expect.arrayContaining([
			"solver.edge-reference.missing",
			"solver.group-reference.missing",
			"constraints.containment.impossible",
		]),
	);
});
```

**Non-finite rejection pattern** (`test/serialization.test.ts` lines 109-119):

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

**Apply:** Cover parse, validate, solve, export, and IO diagnostic layers. Invalid DSL, missing node references, unsupported shapes, invalid constraints, and unsupported formats should produce stable error codes, paths, and hints.

---

### `test/cli.test.ts` (test, file-I/O + request-response)

**Analog:** fixture IO from `test/determinism.test.ts`, source scan from `test/exporters.test.ts`

**Golden read/write comparison style** (`test/determinism.test.ts` lines 67-84):

```typescript
const svgGolden = readFileSync(
	new URL("./fixtures/phase-04/coordinated-export.svg", import.meta.url),
	"utf8",
);
const excalidrawGolden = readFileSync(
	new URL(
		"./fixtures/phase-04/coordinated-export.excalidraw.json",
		import.meta.url,
	),
	"utf8",
);

expect(exportSvg(fixture, { title: "Coordinated Export" })).toBe(svgGolden);
expect(
	stringifyCanonical(
		JSON.parse(exportExcalidraw(fixture, { title: "Coordinated Export" })),
	),
).toBe(excalidrawGolden);
```

**Architecture guard pattern** (`test/exporters.test.ts` lines 110-134):

```typescript
it("blocks exporter geometry recomputation imports and calls", () => {
	const forbiddenTerms = [
		"solveDiagram",
		"runDagreInitialLayout",
		"applyLayoutConstraints",
		"routeEdge",
		"fitLabel",
		"TextMeasurer",
		"computeShapeGeometry",
		"computeContainerGeometry",
	];
	const exporterDir = new URL("../src/exporters", import.meta.url);
	const sourceFiles = readdirSync(exporterDir)
		.filter((fileName) => fileName.endsWith(".ts"))
		.map((fileName) => join(exporterDir.pathname, fileName));

	for (const filePath of sourceFiles) {
		const content = readFileSync(filePath, "utf8");
		for (const term of forbiddenTerms) {
			expect(content, `${filePath} must not contain ${term}`).not.toContain(
				term,
			);
		}
	}
});
```

**Apply:** Test CLI by invoking the built or source CLI with Node, covering `--input`, stdin fallback, stdout fallback, `--output`, `--format`, `--json`, stderr diagnostics, non-zero exits, and atomic write preservation. Add a guard that `src/cli/` orchestrates existing parser/solve/export functions and does not recompute geometry.

---

### `test/public-api.test.ts` (test, transform)

**Analog:** existing `test/public-api.test.ts`

**Root import pattern** (lines 3-32):

```typescript
import type {
	Box,
	Constraint,
	CoordinatedDiagram,
	Diagnostic,
	IntentDiagram,
	IntentEdge,
	IntentNode,
	Label,
	LabelLayout,
	NormalizedDiagram,
	Point,
	ShapeGeometry,
	TextMeasurer,
} from "../src/index.js";
import {
	applyLayoutConstraints,
	computeArrowhead,
	computeContainerGeometry,
	computeShapeGeometry,
	DeterministicTextMeasurer,
	expandBox,
	exportExcalidraw,
	exportSvg,
	fitLabel,
	routeEdge,
	runDagreInitialLayout,
	simplifyRoute,
	solveDiagram,
} from "../src/index.js";
```

**Phase API addition pattern** (lines 205-249):

```typescript
it("imports Phase 4 exporter APIs from the package entrypoint", () => {
	const diagram: CoordinatedDiagram = {
		id: "phase-4-public",
		direction: "LR",
		nodes: [
			{
				id: "a",
				shape: "rectangle",
				label: { text: "A" },
				box: { x: 0, y: 0, width: 80, height: 40 },
				anchors: [],
			},
		],
		edges: [],
		groups: [],
		diagnostics: [],
		bounds: { x: 0, y: 0, width: 220, height: 40 },
	};

	const svg = exportSvg(diagram);
	const excalidraw = JSON.parse(exportExcalidraw(diagram)) as {
		type: string;
	};

	expect(svg).toContain("<svg");
	expect(excalidraw.type).toBe("excalidraw");
});
```

**Apply:** If DSL APIs become public, add a Phase 05 public API test that imports them from `../src/index.js`, not from subpaths. Keep the root-only package export assertion unless intentionally changing package policy.

## Shared Patterns

### ESM Imports And Barrels

**Source:** `src/index.ts`, `src/exporters/index.ts`  
**Apply to:** All new `src/dsl/*`, `src/cli/*`, and tests

Use `.js` specifiers in TypeScript source and tests. Expose modules through local `index.ts` barrels and the root barrel only when the API is public.

### Existing IR Is The Target

**Source:** `src/ir/diagram.ts`, `src/ir/elements.ts`, `src/ir/constraints.ts`  
**Apply to:** `src/dsl/schema.ts`, `src/dsl/normalize.ts`, `src/dsl/edges.ts`

DSL parsing must normalize into `IntentDiagram` / `NormalizedDiagram` shapes. Do not create a second geometry or diagram model that exporters consume directly.

### Diagnostics

**Source:** `src/ir/diagnostics.ts`, `src/solver/solve.ts`  
**Apply to:** DSL parser, semantic validation, CLI error output

Use `severity`, `code`, `message`, optional `path`, and optional `detail`. Prefer stable codes such as `dsl.parse.yaml`, `dsl.validate.shape.unsupported`, `cli.format.unsupported`, and preserve solver diagnostics from `solveDiagram()`.

### Determinism

**Source:** `src/serialization/canonical.ts`, `src/solver/solve.ts`  
**Apply to:** DSL normalization, machine-readable diagnostics, golden tests

Sort unordered collections by stable ids before solving or snapshotting. Use `stringifyCanonical()` for JSON golden comparisons and `--json` diagnostic snapshots.

### Prepare/Solve/Export Separation

**Source:** `src/solver/solve.ts`, `src/exporters/svg.ts`, `src/exporters/excalidraw.ts`, `test/exporters.test.ts`
**Apply to:** `src/dsl/*`, `src/cli/*`, CLI tests

DSL and CLI modules may validate and normalize. They should not call layout, routing, shape geometry, or text measurement directly unless adding a clearly named prepare stage. CLI should call `solveDiagram()` and exporter functions.

### Fixture Layout

**Source:** `test/determinism.test.ts`  
**Apply to:** `examples/`, `test/fixtures/phase-05/`, `test/dsl.test.ts`, `test/cli.test.ts`

Use committed phase-specific fixtures and read them with `new URL(..., import.meta.url)`. Keep golden outputs byte-stable and checked into `test/fixtures/phase-05/`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/cli/index.ts` | route / CLI entry | request-response | No existing binary entrypoint or shebang script exists. Use Commander research and keep entry thin. |
| `src/cli/io.ts` | utility | file-I/O | No production stdin/stdout/stderr or atomic write helper exists. Use Node `fs/promises` and test thoroughly. |
| `src/dsl/parse.ts` YAML/JSON handling | utility | transform | No existing YAML/JSON parser exists. Use `yaml`, `JSON.parse`, and Zod research patterns. |

## Metadata

**Analog search scope:** `src/`, `test/`, `test/fixtures/`, package/build config files  
**Files scanned:** 40+ project files via `rg --files`, targeted reads for core analogs  
**Pattern extraction date:** 2026-05-25  
**Project instructions:** `AGENTS.md` and `/home/zhangyangrui/.codex/RTK.md` read; no repo-local `.codex/skills`, `.claude/skills`, or `.agents/skills` directories found.

## PATTERN MAPPING COMPLETE

**Phase:** 05 - dsl-parser-and-cli  
**Files classified:** 19  
**Analogs found:** 16 / 19

### Coverage

- Files with exact analog: 8
- Files with role-match analog: 6
- Files with partial analog: 5
- Files with no production analog: 3

### Key Patterns Identified

- Public APIs flow through root `src/index.ts` and package root export only.
- Solver/export pipeline is already established: normalized IR -> `solveDiagram()` -> `exportSvg()` / `exportExcalidraw()`.
- Diagnostics use stable `severity`, `code`, `message`, `path`, and `detail` fields.
- Deterministic tests use committed fixtures and `stringifyCanonical()`.
- CLI and DSL must not duplicate geometry solving or exporter logic.

### File Created

`.planning/phases/05-dsl-parser-and-cli/05-PATTERNS.md`

### Ready for Planning

Pattern mapping complete. Planner can now reference analog patterns in PLAN.md files.
