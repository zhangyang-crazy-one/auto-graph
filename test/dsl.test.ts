import { describe, expect, it } from "vitest";
import type {
	NormalizeDiagramDslResult,
	ParseDiagramDslResult,
	RenderDiagramDslResult,
} from "../src/dsl/index.js";
import { parseDiagramDsl } from "../src/dsl/index.js";

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
	it.todo(
		"normalizeDiagramDsl maps fixed positions and constraints for DSL-03",
	);
	it.todo(
		"renderDiagramDsl dispatches through solve/export instead of recomputing geometry",
	);
});
