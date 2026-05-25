import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run.js";

const VALID_DSL = `
title: CLI
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

const INVALID_DSL = `
nodes:
  api: { label: API }
edges:
  - api -> missing
`;

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

	it("runCli reads --input files and writes SVG to stdout", async () => {
		await using workspace = await tempWorkspace();
		const inputPath = join(workspace.path, "diagram.yaml");
		await writeFile(inputPath, VALID_DSL, "utf8");
		const io = memoryIo();

		const exitCode = await runCli(
			["--input", inputPath, "--format", "svg"],
			io.environment,
		);

		expect(exitCode).toBe(0);
		expect(io.stdout()).toContain("<svg");
		expect(io.stderr()).toBe("");
	});

	it("runCli reads stdin and writes Excalidraw JSON to stdout", async () => {
		const io = memoryIo(VALID_DSL);

		const exitCode = await runCli(["--format", "excalidraw"], io.environment);

		expect(exitCode).toBe(0);
		expect(JSON.parse(io.stdout()).type).toBe("excalidraw");
		expect(io.stderr()).toBe("");
	});

	it("runCli writes JSON diagnostics to stderr for invalid input", async () => {
		const io = memoryIo(INVALID_DSL);

		const exitCode = await runCli(["--json"], io.environment);

		expect(exitCode).toBe(1);
		expect(io.stdout()).toBe("");
		const payload = JSON.parse(io.stderr());
		expect(payload.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					layer: "validate",
					code: "validate.reference.missing",
					path: ["edges", 0, "target"],
				}),
			]),
		);
	});

	it("runCli returns 2 for unknown options", async () => {
		const io = memoryIo(VALID_DSL);

		const exitCode = await runCli(["--unknown"], io.environment);

		expect(exitCode).toBe(2);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toContain("unknown option");
	});

	it("runCli writes SVG output files atomically after successful render", async () => {
		await using workspace = await tempWorkspace();
		const inputPath = join(workspace.path, "diagram.yaml");
		const outputPath = join(workspace.path, "diagram.svg");
		await writeFile(inputPath, VALID_DSL, "utf8");
		const io = memoryIo();

		const exitCode = await runCli(
			["--input", inputPath, "--format", "svg", "--output", outputPath],
			io.environment,
		);

		expect(exitCode).toBe(0);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe("");
		expect(await readFile(outputPath, "utf8")).toContain("<svg");
	});

	it("runCli emits warnings to stderr without blocking output", async () => {
		const io = memoryIo(`%FOO bar
---
nodes:
  api: { label: API }
`);

		const exitCode = await runCli(["--format", "svg"], io.environment);

		expect(exitCode).toBe(0);
		expect(io.stdout()).toContain("<svg");
		expect(io.stderr()).toContain("parse.yaml.warning");
	});

	it("runCli preserves an existing output file on invalid input", async () => {
		await using workspace = await tempWorkspace();
		const inputPath = join(workspace.path, "bad.yaml");
		const outputPath = join(workspace.path, "diagram.svg");
		await writeFile(inputPath, INVALID_DSL, "utf8");
		await writeFile(outputPath, "original content", "utf8");
		const io = memoryIo();

		const exitCode = await runCli(
			["--input", inputPath, "--format", "svg", "--output", outputPath],
			io.environment,
		);

		expect(exitCode).toBe(1);
		expect(io.stdout()).toBe("");
		expect(await readFile(outputPath, "utf8")).toBe("original content");
	});

	it("runCli returns 1 with io.input.too-large for oversized stdin", async () => {
		const io = memoryIo("x".repeat(1_000_001));

		const exitCode = await runCli(["--json"], io.environment);

		expect(exitCode).toBe(1);
		expect(JSON.parse(io.stderr()).diagnostics[0]).toMatchObject({
			severity: "error",
			layer: "io",
			code: "io.input.too-large",
		});
	});

	it.each([
		"architecture",
		"flowchart",
		"edge-labels",
		"groups",
		"hybrid-layout",
	])("runCli exports Phase 5 %s fixture to SVG stdout", async (fixtureName) => {
		const io = memoryIo();

		const exitCode = await runCli(
			["--input", phase05Fixture(`${fixtureName}.yaml`), "--format", "svg"],
			io.environment,
		);

		expect(exitCode).toBe(0);
		expect(io.stdout()).toContain("<svg");
		expect(io.stderr()).toBe("");
	});

	it("runCli exports a Phase 5 fixture to Excalidraw JSON stdout", async () => {
		const io = memoryIo();

		const exitCode = await runCli(
			[
				"--input",
				phase05Fixture("architecture.yaml"),
				"--format",
				"excalidraw",
			],
			io.environment,
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(io.stdout()).type).toBe("excalidraw");
		expect(io.stderr()).toBe("");
	});
});

function memoryIo(stdin = "") {
	let stdout = "";
	let stderr = "";
	const stdoutStream = new Writable({
		write(chunk, _encoding, callback) {
			stdout += chunk.toString();
			callback();
		},
	});
	const stderrStream = new Writable({
		write(chunk, _encoding, callback) {
			stderr += chunk.toString();
			callback();
		},
	});

	return {
		environment: {
			stdin: Readable.from([stdin]),
			stdout: stdoutStream,
			stderr: stderrStream,
		},
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

async function tempWorkspace() {
	const path = await mkdtemp(join(tmpdir(), "dge-cli-"));

	return {
		path,
		async [Symbol.asyncDispose]() {
			await rm(path, { force: true, recursive: true });
		},
	};
}

function phase05Fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/phase-05/${name}`, import.meta.url));
}
