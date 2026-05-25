import { describe, expect, it } from "vitest";
import type { DslDiagnostic, DslDiagnosticLayer } from "../src/dsl/index.js";

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

	it.todo("YAML parse errors include parse layer diagnostics");
	it.todo(
		"Zod validation errors include validate layer diagnostics with stable paths",
	);
	it.todo("solve errors are converted into solve layer diagnostics");
	it.todo("export errors are converted into export layer diagnostics");
	it.todo("JSON diagnostic output remains stable for --json consumers");
});
