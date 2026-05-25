import { describe, expect, it } from "vitest";
import type { DslDiagnostic, DslDiagnosticLayer } from "../src/dsl/index.js";
import {
	parseDiagramDsl,
	parseEdgeShorthand,
	sortDslDiagnostics,
} from "../src/dsl/index.js";

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
	it.todo("solve errors are converted into solve layer diagnostics");
	it.todo("export errors are converted into export layer diagnostics");
	it.todo("JSON diagnostic output remains stable for --json consumers");
});
