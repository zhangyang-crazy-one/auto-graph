import { describe, expect, it } from "vitest";
import type {
	NormalizeDiagramDslResult,
	ParseDiagramDslResult,
	RenderDiagramDslResult,
} from "../src/dsl/index.js";

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

	it.todo("parseDiagramDsl accepts YAML nodes as an object map for DSL-01");
	it.todo("parseDiagramDsl accepts JSON input equivalent to YAML for DSL-01");
	it.todo(
		"normalizeDiagramDsl maps fixed positions and constraints for DSL-03",
	);
	it.todo(
		"renderDiagramDsl dispatches through solve/export instead of recomputing geometry",
	);
});
