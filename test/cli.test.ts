import { describe, expect, it } from "vitest";

describe("dge CLI contract", () => {
	it("names the planned CLI command surface", () => {
		const usageAnchors = [
			"dge",
			"--input",
			"--output",
			"--format",
			"--json",
			"stdin",
			"stdout",
			"stderr",
			"atomic",
		];

		expect(usageAnchors).toContain("dge");
		expect(usageAnchors).toContain("--input");
		expect(usageAnchors).toContain("--output");
		expect(usageAnchors).toContain("--format");
		expect(usageAnchors).toContain("--json");
		expect(usageAnchors).toContain("stdin");
		expect(usageAnchors).toContain("stdout");
		expect(usageAnchors).toContain("stderr");
		expect(usageAnchors).toContain("atomic");
	});

	it.todo("runCli reads --input files for CLI-01");
	it.todo("runCli reads stdin when --input is omitted for CLI-02");
	it.todo("runCli writes stdout when --output is omitted for CLI-02");
	it.todo("runCli writes diagnostics to stderr for CLI-03");
	it.todo(
		"runCli preserves an existing output file on invalid input with atomic writes",
	);
});
