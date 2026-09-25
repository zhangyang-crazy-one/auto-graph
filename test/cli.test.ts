import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run.js";
import { PretextTextMeasurer } from "../src/text/index.js";

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

describe("agh CLI contract", () => {
	it("names the planned CLI command surface", () => {
		const usageAnchors = [
			"agh",
			"--input",
			"--output",
			"--format",
			"--json",
			"stdin",
			"stdout",
			"stderr",
			"atomic",
		];

		expect(usageAnchors).toContain("agh");
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

	it("runCli uses the default Pretext text measurer and exports backend metadata in SVG", async () => {
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		globalThis.OffscreenCanvas =
			undefined as unknown as typeof globalThis.OffscreenCanvas;
		const prepareSpy = vi.spyOn(PretextTextMeasurer.prototype, "prepare");

		try {
			const io = memoryIo(VALID_DSL);

			const exitCode = await runCli(["--format", "svg"], io.environment);

			expect(exitCode).toBe(0);
			expect(io.stdout()).toContain("<svg");
			expect(io.stderr()).toBe("");
			expect(prepareSpy).toHaveBeenCalled();
			expect(io.stdout()).toContain('data-text-backend="pretext"');
		} finally {
			prepareSpy.mockRestore();
			globalThis.OffscreenCanvas = originalOffscreenCanvas;
		}
	});

	it("runCli writes the geometry contract with --format geometry", async () => {
		const io = memoryIo(VALID_DSL);

		const exitCode = await runCli(["--format", "geometry"], io.environment);

		expect(exitCode).toBe(0);
		const document = JSON.parse(io.stdout());
		expect(document.format).toBe("dge-geometry");
		expect(document.version).toBe(1);
		expect(io.stderr()).toBe("");
	});

	it("runCli keeps a layout stable with --previous", async () => {
		await using workspace = await tempWorkspace();
		const previousPath = join(workspace.path, "previous.json");
		const first = memoryIo(VALID_DSL);
		expect(await runCli(["--format", "geometry"], first.environment)).toBe(0);
		await writeFile(previousPath, first.stdout(), "utf8");

		const next = memoryIo(VALID_DSL);
		const exitCode = await runCli(
			["--format", "geometry", "--previous", previousPath, "--stability", "2"],
			next.environment,
		);

		expect(exitCode).toBe(0);
		expect(next.stderr()).toBe("");
		expect(JSON.parse(next.stdout()).format).toBe("dge-geometry");
	});

	it("runCli rejects a --previous file that is not a geometry document", async () => {
		await using workspace = await tempWorkspace();
		const previousPath = join(workspace.path, "previous.json");
		await writeFile(previousPath, '{"format":"other"}', "utf8");
		const io = memoryIo(VALID_DSL);

		const exitCode = await runCli(["--previous", previousPath], io.environment);

		expect(exitCode).toBe(1);
		expect(io.stderr()).toContain("io.previous-invalid");
	});

	it("runCli rejects a negative --stability", async () => {
		const io = memoryIo(VALID_DSL);

		expect(await runCli(["--stability", "-1"], io.environment)).toBe(2);
	});

	it("runCli lists views and prints their examples and schemas", async () => {
		const list = memoryIo();
		expect(await runCli(["--list-views", "--json"], list.environment)).toBe(0);
		expect(
			JSON.parse(list.stdout()).map((view: { id: string }) => view.id),
		).toContain("swimlane");

		const example = memoryIo();
		expect(
			await runCli(["--view-example", "flowchart"], example.environment),
		).toBe(0);
		expect(example.stdout()).toMatch(/^view: flowchart/);

		const schema = memoryIo();
		expect(await runCli(["--view-schema", "tree"], schema.environment)).toBe(0);
		expect(JSON.parse(schema.stdout()).properties.view.const).toBe("tree");

		const unknown = memoryIo();
		expect(await runCli(["--view-schema", "nope"], unknown.environment)).toBe(
			2,
		);
		expect(unknown.stderr()).toContain("view.unknown");
	});

	it("runCli renders a view document and expands it with --expand", async () => {
		const source = "view: tree\nroot: { 公司: [财务, 技术] }\n";
		const rendered = memoryIo(source);
		expect(await runCli(["--format", "svg"], rendered.environment)).toBe(0);
		expect(rendered.stdout()).toContain("<svg");

		const expanded = memoryIo(source);
		expect(await runCli(["--expand"], expanded.environment)).toBe(0);
		expect(expanded.stdout()).toContain("nodes:");
		expect(expanded.stdout()).not.toContain("view:");

		const plain = memoryIo(VALID_DSL);
		expect(await runCli(["--expand"], plain.environment)).toBe(1);
		expect(plain.stderr()).toContain("view.missing");
	});

	it("runCli rejects a --font file it cannot load", async () => {
		const io = memoryIo(VALID_DSL);

		const exitCode = await runCli(
			["--font", "/does/not/exist.ttf"],
			io.environment,
		);

		expect(exitCode).toBe(1);
		expect(io.stderr()).toContain("io.font.unreadable");
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

	it("runCli refuses to write metrics over the output file", async () => {
		await using workspace = await tempWorkspace();
		const inputPath = join(workspace.path, "diagram.yaml");
		const outputPath = join(workspace.path, "diagram.svg");
		await writeFile(inputPath, VALID_DSL, "utf8");
		await writeFile(outputPath, "original content", "utf8");
		const io = memoryIo();

		const exitCode = await runCli(
			[
				"--input",
				inputPath,
				"--output",
				outputPath,
				"--metrics",
				join(workspace.path, ".", "diagram.svg"),
			],
			io.environment,
		);

		expect(exitCode).toBe(2);
		expect(io.stderr()).toContain("io.output-metrics-conflict");
		expect(await readFile(outputPath, "utf8")).toBe("original content");
	});

	it("runCli writes layout metrics next to the output", async () => {
		await using workspace = await tempWorkspace();
		const inputPath = join(workspace.path, "diagram.yaml");
		const outputPath = join(workspace.path, "diagram.svg");
		const metricsPath = join(workspace.path, "metrics.json");
		await writeFile(inputPath, VALID_DSL, "utf8");
		const io = memoryIo();

		const exitCode = await runCli(
			["--input", inputPath, "--output", outputPath, "--metrics", metricsPath],
			io.environment,
		);

		expect(exitCode).toBe(0);
		expect(await readFile(outputPath, "utf8")).toContain("<svg");
		expect(JSON.parse(await readFile(metricsPath, "utf8"))).toHaveProperty(
			"nodeOverlaps",
		);
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
	const path = await mkdtemp(join(tmpdir(), "agh-cli-"));

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
