import { describe, expect, it, vi } from "vitest";
import type { DslDiagnostic, DslDiagnosticLayer } from "../src/dsl/index.js";
import {
	parseDiagramDsl,
	parseEdgeShorthand,
	renderDiagramDsl,
	resolveOutputFormat,
	sortDslDiagnostics,
} from "../src/dsl/index.js";
import * as exporters from "../src/exporters/index.js";

describe("DSL diagnostics contract", () => {
	it("supports layered diagnostics with path and hint fields", () => {
		const layers: DslDiagnosticLayer[] = [
			"parse",
			"validate",
			"solve",
			"export",
			"io",
		];
		const diagnostic: DslDiagnostic = {
			severity: "error",
			layer: "validate",
			code: "validate.schema.invalid",
			message: "Unsupported shape.",
			path: ["nodes", "api", "shape"],
			hint: "Use a supported node shape.",
		};

		expect(layers).toEqual(["parse", "validate", "solve", "export", "io"]);
		expect(diagnostic.path).toEqual(["nodes", "api", "shape"]);
		expect(diagnostic.hint).toContain("supported");
	});

	it("YAML parse errors include parse layer diagnostics", () => {
		const result = parseDiagramDsl("nodes:\n  api: [");

		expect(result.value).toBeUndefined();
		expect(result.diagnostics[0]).toMatchObject({
			severity: "error",
			layer: "parse",
			code: "parse.yaml.invalid",
		});
		expect(result.diagnostics[0]?.message).toContain("YAML");
	});

	it("JSON parse errors include parse layer diagnostics", () => {
		const result = parseDiagramDsl("{", { sourcePath: "diagram.json" });

		expect(result.value).toBeUndefined();
		expect(result.diagnostics[0]).toMatchObject({
			severity: "error",
			layer: "parse",
			code: "parse.json.invalid",
		});
	});

	it("Zod validation errors include validate layer diagnostics with stable paths", () => {
		const result = parseDiagramDsl(`
nodes:
  api:
    shape: unsupported
    position: { x: .nan, y: 0 }
output:
  format: drawio
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.schema.invalid",
					path: ["nodes", "api", "shape"],
				}),
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.schema.invalid",
					path: ["nodes", "api", "position", "x"],
				}),
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.schema.invalid",
					path: ["output", "format"],
				}),
			]),
		);
		for (const diagnostic of result.diagnostics) {
			expect(diagnostic.layer).toBeDefined();
			expect(diagnostic.code).toBeDefined();
			expect(diagnostic.message).toBeDefined();
			expect(diagnostic.path).toBeDefined();
		}
	});

	it("malformed edge shorthand includes the original edge array path", () => {
		const result = parseEdgeShorthand("api db", ["edges", 0]);

		expect(result.edge).toBeUndefined();
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				severity: "error",
				layer: "validate",
				code: "validate.edge-shorthand.invalid",
				path: ["edges", 0],
				hint: 'Use "source -> target" or "source -> target: label".',
			}),
		]);
	});

	it("sortDslDiagnostics orders by severity, layer, path, and code", () => {
		const sorted = sortDslDiagnostics([
			{
				severity: "warning",
				layer: "parse",
				code: "parse.yaml.warning",
				message: "warn",
			},
			{
				severity: "error",
				layer: "validate",
				code: "validate.z",
				message: "z",
				path: ["nodes", "z"],
			},
			{
				severity: "error",
				layer: "parse",
				code: "parse.input.too-large",
				message: "too large",
			},
			{
				severity: "error",
				layer: "validate",
				code: "validate.a",
				message: "a",
				path: ["nodes", "a"],
			},
		]);

		expect(sorted.map((diagnostic) => diagnostic.code)).toEqual([
			"parse.input.too-large",
			"validate.a",
			"validate.z",
			"parse.yaml.warning",
		]);
	});
	it("solve errors are converted into solve layer diagnostics", () => {
		const result = renderDiagramDsl(`
nodes:
  a: { label: A }
constraints:
  - kind: exact-position
    target: a
    position: { x: 10, y: 10 }
  - kind: exact-position
    target: a
    position: { x: 20, y: 20 }
`);

		expect(result.content).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					layer: "solve",
					code: "constraints.conflict.exact-position",
				}),
			]),
		);
	});

	it("export errors are converted into export layer diagnostics", () => {
		const spy = vi.spyOn(exporters, "exportSvg").mockImplementation(() => {
			throw new Error("Mock export error");
		});

		try {
			const result = renderDiagramDsl(`
nodes:
  a: { label: A }
`);
			expect(result.content).toBeUndefined();
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
					severity: "error",
					layer: "export",
					code: "export.failed",
					message: "Mock export error",
				}),
			]);
		} finally {
			spy.mockRestore();
		}
	});

	it("JSON diagnostic output remains stable for --json consumers", () => {
		const diagnostic: DslDiagnostic = {
			severity: "error",
			layer: "validate",
			code: "validate.reference.missing",
			message: "Missing node reference",
			path: ["edges", 0, "target"],
			hint: "Define the missing node.",
		};

		const serialized = JSON.stringify(diagnostic);
		const parsed = JSON.parse(serialized);

		expect(parsed).toEqual({
			severity: "error",
			layer: "validate",
			code: "validate.reference.missing",
			message: "Missing node reference",
			path: ["edges", 0, "target"],
			hint: "Define the missing node.",
		});
	});

	it("reports missing references before render output", () => {
		const result = renderDiagramDsl(`
nodes:
  api: { label: API }
edges:
  - api -> missing
groups:
  backend:
    nodes: [api, missing]
constraints:
  - kind: relative-position
    source: missing
    reference: api
    relation: right-of
`);

		expect(result.content).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.reference.missing",
					path: ["edges", 0, "target"],
				}),
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.reference.missing",
					path: ["groups", "backend", "nodes", 1],
				}),
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.reference.missing",
					path: ["constraints", 0, "source"],
				}),
			]),
		);
	});

	it("rejects containment containers that cannot be solved before render output", () => {
		const result = renderDiagramDsl(`
nodes:
  api: { label: API }
  db: { label: DB }
groups:
  backend:
    nodes: [api, db]
swimlanes:
  system:
    lanes:
      app:
        children: [api]
constraints:
  - kind: containment
    container: backend
    children: [api]
  - kind: containment
    container: system.app
    children: [db]
`);

		expect(result.content).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.reference.missing",
					path: ["constraints", 0, "container"],
				}),
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.reference.missing",
					path: ["constraints", 1, "container"],
				}),
			]),
		);
	});

	it("rejects negative swimlane sizing during validation", () => {
		const result = parseDiagramDsl(`
swimlanes:
  behavior:
    layout: contract
    headerHeight: -1
    padding: -2
    orientation: vertical
    lanes:
      lane_a:
        children: [a]
nodes:
  a: { label: A }
`);

		expect(result.value).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.schema.invalid",
					path: ["swimlanes", "behavior", "headerHeight"],
				}),
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.schema.invalid",
					path: ["swimlanes", "behavior", "padding"],
				}),
			]),
		);
	});

	it("rejects unsupported output formats", () => {
		for (const format of ["drawio", "mermaid", "ascii"]) {
			const result = resolveOutputFormat(format);

			expect(result.format).toBeUndefined();
			expect(result.diagnostics).toEqual([
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.output-format.unsupported",
					path: ["output", "format"],
				}),
			]);
		}
	});
});
