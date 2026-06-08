import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	NormalizeDiagramDslResult,
	ParseDiagramDslResult,
	RenderDiagramDslResult,
} from "../src/dsl/index.js";
import {
	normalizeDiagramDsl,
	parseDiagramDsl,
	parseEdgeShorthand,
	renderDiagramDsl,
	resolveOutputFormat,
} from "../src/dsl/index.js";
import { stringifyCanonical } from "../src/serialization/index.js";

describe("DSL parser contract", () => {
	it("names the planned public DSL APIs", () => {
		const plannedApis = [
			"parseDiagramDsl",
			"normalizeDiagramDsl",
			"renderDiagramDsl",
		];

		expect(plannedApis).toContain("parseDiagramDsl");
		expect(plannedApis).toContain("normalizeDiagramDsl");
		expect(plannedApis).toContain("renderDiagramDsl");
	});

	it("type-checks Phase 5 parser and render result contracts", () => {
		const parsed: ParseDiagramDslResult = {
			value: { title: "Sample" },
			diagnostics: [],
		};
		const normalized: NormalizeDiagramDslResult = {
			diagnostics: [],
			output: { format: "svg" },
		};
		const rendered: RenderDiagramDslResult = {
			format: "svg",
			content: "<svg></svg>",
			diagnostics: [],
		};

		expect(parsed.diagnostics).toEqual([]);
		expect(normalized.output?.format).toBe("svg");
		expect(rendered.content).toContain("<svg");
	});

	it("parseDiagramDsl accepts YAML nodes as an object map for DSL-01", () => {
		const result = parseDiagramDsl(`
title: System
layout:
  direction: LR
nodes:
  api:
    label: API
    shape: rectangle
    position: { x: 100, y: 80 }
edges:
  - source: api
    target: db
groups:
  backend:
    label: Backend
    nodes: [api, db]
constraints:
  - kind: relative-position
    source: api
    reference: web
    relation: right-of
    offset: { x: 80, y: 0 }
output:
  format: svg
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.value).toMatchObject({
			title: "System",
			layout: { direction: "LR" },
			nodes: {
				api: {
					label: "API",
					shape: "rectangle",
					position: { x: 100, y: 80 },
				},
			},
			output: { format: "svg" },
		});
	});

	it("parseDiagramDsl accepts JSON input equivalent to YAML for DSL-01", () => {
		const yaml = parseDiagramDsl(`
title: System
nodes:
  api: { label: API }
edges:
  - source: api
    target: db
`);
		const json = parseDiagramDsl(
			JSON.stringify({
				title: "System",
				nodes: { api: { label: "API" } },
				edges: [{ source: "api", target: "db" }],
			}),
			{ sourcePath: "diagram.json" },
		);

		expect(yaml.diagnostics).toEqual([]);
		expect(json.diagnostics).toEqual([]);
		expect(json.value).toEqual(yaml.value);
	});

	it("parseEdgeShorthand expands source and target ids", () => {
		const result = parseEdgeShorthand("api -> db", ["edges", 0]);

		expect(result.diagnostics).toEqual([]);
		expect(result.edge).toEqual({
			sourceId: "api",
			targetId: "db",
		});
	});

	it("parseEdgeShorthand preserves labels after the first colon", () => {
		const result = parseEdgeShorthand("web -> api: calls: readonly", [
			"edges",
			1,
		]);

		expect(result.diagnostics).toEqual([]);
		expect(result.edge).toEqual({
			sourceId: "web",
			targetId: "api",
			label: { text: "calls: readonly" },
		});
	});

	it("parseDiagramDsl expands edge shorthand inside parsed values", () => {
		const result = parseDiagramDsl(`
nodes:
  api: { label: API }
  db: { label: DB }
edges:
  - api -> db: reads
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.value).toMatchObject({
			edges: [{ sourceId: "api", targetId: "db", label: { text: "reads" } }],
		});
	});
	it("normalizeDiagramDsl maps sorted nodes, groups, positions, and constraints for DSL-03", () => {
		const parsed = parseDiagramDsl(`
id: system
title: System
layout: { direction: LR }
routing: { kind: straight }
nodes:
  container: { label: Container }
  db: { label: DB }
  api:
    label: API
    position: { x: 100, y: 80 }
edges:
  - api -> db: reads
groups:
  backend:
    nodes: [api, db]
constraints:
  - kind: relative-position
    source: db
    reference: api
    relation: right-of
    offset: { x: 80, y: 0 }
  - kind: align
    axis: center-y
    targets: [api, db]
  - kind: distribute
    axis: horizontal
    targets: [api, db]
    spacing: 120
  - kind: containment
    container: container
    children: [api, db]
output:
  format: excalidraw
`);

		const result = normalizeDiagramDsl(parsed.value);

		expect(result.diagnostics).toEqual([]);
		expect(result.output?.format).toBe("excalidraw");
		expect(result.diagram?.id).toBe("system");
		expect(result.diagram?.direction).toBe("LR");
		expect(result.diagram?.nodes.map((node) => node.id)).toEqual([
			"api",
			"container",
			"db",
		]);
		expect(result.diagram?.nodes[0]).toMatchObject({
			id: "api",
			shape: "rectangle",
			position: { x: 100, y: 80 },
			padding: { top: 12, right: 16, bottom: 12, left: 16 },
		});
		expect(result.diagram?.nodes[0]?.size.width).toBeGreaterThanOrEqual(80);
		expect(result.diagram?.edges[0]).toMatchObject({
			id: "api-db",
			source: { nodeId: "api" },
			target: { nodeId: "db" },
			label: { text: "reads" },
		});
		expect(result.diagram?.groups[0]).toMatchObject({
			id: "backend",
			nodeIds: ["api", "db"],
			padding: { top: 16, right: 16, bottom: 16, left: 16 },
		});
		expect(
			result.diagram?.constraints.map((constraint) => constraint.kind),
		).toEqual(["relative-position", "align", "distribute", "containment"]);
	});

	it("normalizes labels with the default Pretext measurer in Node", () => {
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		globalThis.OffscreenCanvas =
			undefined as unknown as typeof globalThis.OffscreenCanvas;

		try {
			const result = normalizeDiagramDsl({
				nodes: {
					api: { label: "API" },
				},
			});

			expect(result.diagnostics).toEqual([]);
			expect(result.diagram?.nodes[0]?.labelLayout?.textBackend).toBe(
				"pretext",
			);
		} finally {
			globalThis.OffscreenCanvas = originalOffscreenCanvas;
		}
	});

	it("solves the issue #13 medium-density microservice fixture without node overlap warnings", () => {
		const source = readFileSync(
			new URL(
				"./fixtures/issue-13/microservice.auto-graph.yaml",
				import.meta.url,
			),
			"utf8",
		);
		const result = renderDiagramDsl(source, {
			sourcePath: "test/fixtures/issue-13/microservice.auto-graph.yaml",
		});

		expect(result.content).toContain("<svg");
		const diagnosticCodes = result.diagnostics.map(
			(diagnostic) => diagnostic.code,
		);
		for (const code of [
			"constraints.overlap.unresolved",
			"routing.obstacle.unavoidable",
			"routing.text-clearance.unresolved",
		]) {
			expect(diagnosticCodes).not.toContain(code);
		}
	});

	it("preserves author-declared contract swimlane lane order", () => {
		const result = normalizeDiagramDsl({
			nodes: {
				input_node: { label: "Input" },
				process_node: { label: "Process" },
				output_node: { label: "Output" },
			},
			swimlanes: {
				flow: {
					layout: "contract",
					lanes: {
						input: { children: ["input_node"] },
						process: { children: ["process_node"] },
						output: { children: ["output_node"] },
					},
				},
			},
		});

		expect(
			result.diagram?.swimlanes?.[0]?.lanes.map((lane) => lane.id),
		).toEqual(["input", "process", "output"]);
	});

	it("preserves top-to-bottom primary reading direction metadata", () => {
		const result = normalizeDiagramDsl({
			layout: {
				direction: "LR",
				primaryReadingDirection: "top_to_bottom",
			},
			nodes: {
				start: { label: "Start" },
				work: { label: "Work" },
			},
			edges: ["start -> work"],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.diagram?.metadata?.primaryReadingDirection).toBe(
			"top_to_bottom",
		);
	});

	it("rejects negative object frame padding before normalization", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
frame:
  kind: block
  titleTab: System
  padding: { top: -20, right: 16, bottom: 16, left: 16 }
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "validate.schema.invalid",
				path: ["frame", "padding", "top"],
			}),
		);
	});

	it("sizes compartment nodes from their rendered row count", () => {
		const result = normalizeDiagramDsl({
			nodes: {
				block: {
					label: "Processing",
					compartments: {
						stereotype: "«block»",
						name: "Processing",
						properties: [
							"coolingPower_W: Real",
							"heatingPower_W: Real",
							"mass_kg: Real",
							"temperatureEnvelopeUpperLimit_C: Real",
						],
						constraints: [
							"coolingPower_W >= 0",
							"heatingPower_W >= 0",
							"temperature_C < 85",
						],
					},
				},
			},
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.diagram?.nodes[0]?.size.height).toBeGreaterThan(130);
		expect(result.diagram?.nodes[0]?.size.width).toBeGreaterThan(190);
	});

	it("keeps legacy edge IDs and structured endpoints consistent when both are set", () => {
		const result = normalizeDiagramDsl({
			nodes: {
				legacySource: { label: "Legacy Source" },
				legacyTarget: { label: "Legacy Target" },
				structuredSource: {
					label: "Structured Source",
					ports: { out: { side: "right" } },
				},
				structuredTarget: {
					label: "Structured Target",
					ports: { in: { side: "left" } },
				},
			},
			edges: [
				{
					sourceId: "legacySource",
					targetId: "legacyTarget",
					source: { node: "structuredSource", port: "out" },
					target: { node: "structuredTarget", port: "in" },
				},
			],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.diagram?.edges[0]).toMatchObject({
			id: "legacySource-legacyTarget",
			source: { nodeId: "legacySource" },
			target: { nodeId: "legacyTarget" },
		});
		expect(result.diagram?.edges[0]?.source.portId).toBeUndefined();
		expect(result.diagram?.edges[0]?.target.portId).toBeUndefined();
	});

	it("parses and normalizes first-class evidence blocks", () => {
		const parsed = parseDiagramDsl(`
nodes:
  source: { label: Source }
matrices:
  - id: traceability-matrix
    rows: [need-1, need-2]
    cols: [function-1, function-2]
    position: { x: 420, y: 40 }
    cells:
      - ["covered", { text: "gap", fill: "#fff3cd" }]
      - ["", "covered"]
tables:
  - id: value-properties
    columns:
      - { id: property, label: Property }
      - { id: type, label: Type }
    rows:
      - id: mass-row
        cells:
          property: mass_kg
          type: Real
evidencePanels:
  - id: symbol-legend
    kind: legend
    items:
      - id: satisfied
        label: Satisfied
        detail: Trace exists
`);

		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.value).toMatchObject({
			matrices: [{ id: "traceability-matrix" }],
			tables: [{ id: "value-properties" }],
			evidencePanels: [{ id: "symbol-legend", kind: "legend" }],
		});

		const result = normalizeDiagramDsl(parsed.value);

		expect(result.diagnostics).toEqual([]);
		expect(result.diagram?.matrices?.[0]).toMatchObject({
			id: "traceability-matrix",
			rows: ["need-1", "need-2"],
			cols: ["function-1", "function-2"],
			position: { x: 420, y: 40 },
			size: { width: 336, height: 108 },
			cells: [
				[{ text: "covered" }, { text: "gap", style: { fill: "#fff3cd" } }],
				[{ text: "" }, { text: "covered" }],
			],
		});
		expect(result.diagram?.tables?.[0]).toMatchObject({
			id: "value-properties",
			columns: [
				{ id: "property", label: { text: "Property" } },
				{ id: "type", label: { text: "Type" } },
			],
			rows: [
				{
					id: "mass-row",
					cells: {
						property: { text: "mass_kg" },
						type: { text: "Real" },
					},
				},
			],
		});
		expect(result.diagram?.evidencePanels?.[0]).toMatchObject({
			id: "symbol-legend",
			kind: "legend",
			items: [
				{
					id: "satisfied",
					label: { text: "Satisfied" },
					detail: { text: "Trace exists" },
				},
			],
		});
	});

	it("rejects duplicate evidence block ids inside each collection", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
tables:
  - id: duplicate-table
    columns: [{ id: name, label: Name }]
    rows: []
  - id: duplicate-table
    columns: [{ id: name, label: Name }]
    rows: []
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Duplicate evidence block id in tables "duplicate-table".',
				path: ["tables", 1, "id"],
			}),
		);
	});

	it("rejects duplicate evidence block ids across collections", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
matrices:
  - id: duplicate-evidence
    rows: [need]
    cols: [function]
    cells:
      - [covered]
tables:
  - id: duplicate-evidence
    columns: [{ id: name, label: Name }]
    rows: []
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message:
					'Duplicate evidence block id "duplicate-evidence" across matrices and tables.',
				path: ["tables", 0, "id"],
			}),
		);
	});

	it("rejects matrix cell dimensions that do not match declared rows and columns", () => {
		const missingRow = parseDiagramDsl(`
nodes:
  source: { label: Source }
matrices:
  - id: sparse-matrix
    rows: [need-1, need-2]
    cols: [function-1]
    cells:
      - [covered]
`);
		const shortRow = parseDiagramDsl(`
nodes:
  source: { label: Source }
matrices:
  - id: short-matrix
    rows: [need-1]
    cols: [function-1, function-2]
    cells:
      - [covered]
`);

		expect(missingRow.value).toBeUndefined();
		expect(missingRow.diagnostics).toContainEqual(
			expect.objectContaining({
				message: "Matrix cells must contain exactly 2 row(s).",
				path: ["matrices", 0, "cells"],
			}),
		);
		expect(shortRow.value).toBeUndefined();
		expect(shortRow.diagnostics).toContainEqual(
			expect.objectContaining({
				message: "Matrix cell row must contain exactly 2 column(s).",
				path: ["matrices", 0, "cells", 0],
			}),
		);
	});

	it("rejects duplicate matrix row and column ids", () => {
		const duplicateRows = parseDiagramDsl(`
nodes:
  source: { label: Source }
matrices:
  - id: duplicate-row-matrix
    rows: [need, need]
    cols: [function]
    cells:
      - [covered]
      - [gap]
`);
		const duplicateCols = parseDiagramDsl(`
nodes:
  source: { label: Source }
matrices:
  - id: duplicate-column-matrix
    rows: [need]
    cols: [function, function]
    cells:
      - [covered, gap]
`);

		expect(duplicateRows.value).toBeUndefined();
		expect(duplicateRows.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Duplicate matrix row "need".',
				path: ["matrices", 0, "rows", 1],
			}),
		);
		expect(duplicateCols.value).toBeUndefined();
		expect(duplicateCols.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Duplicate matrix column "function".',
				path: ["matrices", 0, "cols", 1],
			}),
		);
	});

	it("rejects duplicate table column ids", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
tables:
  - id: parameters
    columns:
      - { id: parameter, label: Parameter }
      - { id: parameter, label: Duplicate Parameter }
    rows: []
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Duplicate column "parameter".',
				path: ["tables", 0, "columns", 1, "id"],
			}),
		);
	});

	it("rejects duplicate table row ids", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
tables:
  - id: parameters
    columns:
      - { id: parameter, label: Parameter }
    rows:
      - id: mass
        cells:
          parameter: mass_kg
      - id: mass
        cells:
          parameter: duplicate_mass
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Duplicate row "mass".',
				path: ["tables", 0, "rows", 1, "id"],
			}),
		);
	});

	it("rejects duplicate evidence panel item ids", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
evidencePanels:
  - id: legend
    kind: legend
    items:
      - Freeform string item
      - id: repeated
        label: First
      - id: repeated
        label: Second
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Duplicate evidence panel item id "repeated".',
				path: ["evidencePanels", 0, "items", 2, "id"],
			}),
		);
	});

	it("rejects table row cells that reference undeclared columns", () => {
		const result = parseDiagramDsl(`
nodes:
  source: { label: Source }
tables:
  - id: parameters
    columns:
      - { id: parameter, label: Parameter }
    rows:
      - id: row-one
        cells:
          parmeter: mass
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Table row cell references undeclared column "parmeter".',
				path: ["tables", 0, "rows", 0, "cells", "parmeter"],
			}),
		);
	});

	it("resolveOutputFormat defaults to svg and lets CLI format override DSL", () => {
		expect(resolveOutputFormat().format).toBe("svg");
		expect(resolveOutputFormat(undefined, "excalidraw").format).toBe(
			"excalidraw",
		);
		expect(resolveOutputFormat("svg", "excalidraw").format).toBe("svg");
	});

	it("renderDiagramDsl dispatches through solve/export for SVG and Excalidraw", () => {
		const source = `
title: Render
layout: { direction: LR }
nodes:
  api: { label: API, position: { x: 0, y: 0 } }
  db: { label: DB }
edges:
  - api -> db: reads
constraints:
  - kind: relative-position
    source: db
    reference: api
    relation: right-of
    offset: { x: 120, y: 0 }
`;
		const svg = renderDiagramDsl(source, { format: "svg" });
		const excalidraw = renderDiagramDsl(source, { format: "excalidraw" });

		expect(svg.diagnostics).toEqual([]);
		expect(svg.format).toBe("svg");
		expect(svg.content).toContain("<svg");
		expect(excalidraw.diagnostics).toEqual([]);
		expect(excalidraw.format).toBe("excalidraw");
		expect(JSON.parse(excalidraw.content ?? "{}").type).toBe("excalidraw");
	});

	it("locks method-chain fixture evidence block counts", () => {
		const parsed = parseDiagramDsl(
			readEvidenceFixture("01-method-chain.yaml"),
			{
				sourcePath: evidenceFixturePath("01-method-chain.yaml"),
			},
		);
		const normalized = normalizeDiagramDsl(parsed.value);
		const nodes = valueWithNodes(parsed.value).nodes;

		expect(parsed.diagnostics).toEqual([]);
		expect(normalized.diagnostics).toEqual([]);
		expect(nodes === undefined ? [] : Object.keys(nodes)).toHaveLength(15);
		expect(normalized.diagram?.nodes).toHaveLength(15);
		expect(
			normalized.diagram?.evidencePanels?.filter(
				(panel) => panel.kind === "legend",
			),
		).toHaveLength(2);
		expect(
			normalized.diagram?.evidencePanels?.filter(
				(panel) => panel.kind === "note",
			),
		).toHaveLength(1);
		expectStableEvidenceBlockIds(normalized);
	});

	it("locks traceability-spine fixture matrix and row/column evidence counts", () => {
		const parsed = parseDiagramDsl(
			readEvidenceFixture("04-traceability-spine.yaml"),
			{ sourcePath: evidenceFixturePath("04-traceability-spine.yaml") },
		);
		const normalized = normalizeDiagramDsl(parsed.value);
		const nodes = valueWithNodes(parsed.value).nodes;
		const rowPrefixes = [
			"stakeholder-needs",
			"requirements",
			"functions",
			"interactions",
			"states",
			"logical-architecture",
		];
		const columnSuffixes = ["operational", "safety", "performance"];

		expect(parsed.diagnostics).toEqual([]);
		expect(normalized.diagnostics).toEqual([]);
		for (const row of rowPrefixes) {
			for (const column of columnSuffixes) {
				expect(nodes).toHaveProperty(`${row}-${column}`);
			}
		}
		expect(normalized.diagram?.nodes).toHaveLength(18);
		expect(normalized.diagram?.matrices).toHaveLength(2);
		expect(
			normalized.diagram?.evidencePanels?.filter(
				(panel) => panel.kind === "rule",
			),
		).toHaveLength(1);
		expectStableEvidenceBlockIds(normalized);
	});

	it("locks structure-parameter-extraction fixture table and matrix evidence counts", () => {
		const parsed = parseDiagramDsl(
			readEvidenceFixture("05-structure-parameter-extraction.yaml"),
			{
				sourcePath: evidenceFixturePath(
					"05-structure-parameter-extraction.yaml",
				),
			},
		);
		const normalized = normalizeDiagramDsl(parsed.value);
		const structuralBlocks = normalized.diagram?.nodes.filter((node) =>
			node.id.startsWith("structure-block-"),
		);

		expect(parsed.diagnostics).toEqual([]);
		expect(normalized.diagnostics).toEqual([]);
		expect(structuralBlocks?.length).toBeGreaterThanOrEqual(4);
		expect(normalized.diagram?.tables).toHaveLength(2);
		expect(normalized.diagram?.matrices).toHaveLength(2);
		expect(
			normalized.diagram?.evidencePanels?.filter(
				(panel) => panel.kind === "note",
			),
		).toHaveLength(1);
		expectStableEvidenceBlockIds(normalized);
	});

	it.each([
		"architecture",
		"flowchart",
		"edge-labels",
		"groups",
		"hybrid-layout",
	])("renders Phase 5 %s YAML fixture to SVG", (fixtureName) => {
		const sourcePath = fixturePath(`${fixtureName}.yaml`);
		const source = readFixture(`${fixtureName}.yaml`);

		const result = renderDiagramDsl(source, { sourcePath });

		expect(result.diagnostics).toEqual([]);
		expect(result.format).toBe("svg");
		expect(result.content).toMatch(/^<svg/);
		expect(result.diagram?.title).toBeDefined();
	});

	it("normalizes architecture YAML and JSON fixtures equivalently", () => {
		const yaml = normalizeDiagramDsl(
			parseDiagramDsl(readFixture("architecture.yaml"), {
				sourcePath: fixturePath("architecture.yaml"),
			}).value,
		);
		const json = normalizeDiagramDsl(
			parseDiagramDsl(readFixture("architecture.json"), {
				sourcePath: fixturePath("architecture.json"),
			}).value,
		);

		expect(yaml.diagnostics).toEqual([]);
		expect(json.diagnostics).toEqual([]);
		expect(
			stringifyCanonical({
				nodes: yaml.diagram?.nodes,
				edges: yaml.diagram?.edges,
				groups: yaml.diagram?.groups,
				constraints: yaml.diagram?.constraints,
			}),
		).toBe(
			stringifyCanonical({
				nodes: json.diagram?.nodes,
				edges: json.diagram?.edges,
				groups: json.diagram?.groups,
				constraints: json.diagram?.constraints,
			}),
		);
	});

	it("normalizes group and frame semantic fields from DSL", () => {
		const source = `
title: Semantic Fields
direction: LR
nodes:
  a: { label: A }
  b: { label: B }
groups:
  semantic:
    label: Semantic
    nodes: [a, b]
    padding: { top: 4, right: 5, bottom: 6, left: 7 }
    headerHeight: 32
    labelPosition: inside
    direction: vertical
frame:
  kind: sysml
  titleTab: System
  headerHeight: 44
  padding: { top: 20, right: 24, bottom: 28, left: 32 }
  labelPosition: top
  direction: horizontal
`;
		const parsed = parseDiagramDsl(source, { sourceFormat: "yaml" });
		const normalized = normalizeDiagramDsl(parsed.value);

		expect(parsed.diagnostics).toEqual([]);
		expect(normalized.diagnostics).toEqual([]);
		expect(normalized.diagram?.groups[0]).toMatchObject({
			id: "semantic",
			headerHeight: 32,
			labelPosition: "inside",
			direction: "vertical",
		});
		expect(normalized.diagram?.frame).toMatchObject({
			kind: "sysml",
			headerHeight: 44,
			padding: { top: 20, right: 24, bottom: 28, left: 32 },
			labelPosition: "top",
			direction: "horizontal",
		});
	});
});

function readFixture(name: string): string {
	return readFileSync(fixturePath(name), "utf8");
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/phase-05/${name}`, import.meta.url));
}

function readEvidenceFixture(name: string): string {
	return readFileSync(evidenceFixturePath(name), "utf8");
}

function evidenceFixturePath(name: string): string {
	return fileURLToPath(
		new URL(`./fixtures/evidence-blocks/${name}`, import.meta.url),
	);
}

function valueWithNodes(value: unknown): { nodes?: Record<string, unknown> } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as { nodes?: Record<string, unknown> };
}

function expectStableEvidenceBlockIds(result: NormalizeDiagramDslResult): void {
	const ids = [
		...(result.diagram?.matrices?.map((matrix) => matrix.id) ?? []),
		...(result.diagram?.tables?.map((table) => table.id) ?? []),
		...(result.diagram?.evidencePanels?.map((panel) => panel.id) ?? []),
	];

	expect(ids.length).toBeGreaterThan(0);
	for (const id of ids) {
		expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	}
}
