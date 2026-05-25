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
    container: backend
    children: [api, db]
output:
  format: excalidraw
`);

		const result = normalizeDiagramDsl(parsed.value);

		expect(result.diagnostics).toEqual([]);
		expect(result.output?.format).toBe("excalidraw");
		expect(result.diagram?.id).toBe("system");
		expect(result.diagram?.direction).toBe("LR");
		expect(result.diagram?.nodes.map((node) => node.id)).toEqual(["api", "db"]);
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
});

function readFixture(name: string): string {
	return readFileSync(fixturePath(name), "utf8");
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/phase-05/${name}`, import.meta.url));
}
