import { readFileSync } from "node:fs";
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

	it("runCli writes an agent report, also when rendering fails", async () => {
		await using workspace = await tempWorkspace();
		const reportPath = join(workspace.path, "report.json");
		const good = memoryIo("view: tree\nroot: { 公司: [财务, 技术] }\n");
		expect(
			await runCli(["--page", "A4", "--report", reportPath], good.environment),
		).toBe(0);
		const report = JSON.parse(await readFile(reportPath, "utf8"));
		expect(report.verdict).toBe("ok");
		expect(report.page.size).toBe("A4");

		const bad = memoryIo(
			"view: flowchart\nsteps: { review: 审核 }\nflow: [reveiw -> 结束]\n",
		);
		expect(await runCli(["--report", reportPath], bad.environment)).toBe(1);
		const failed = JSON.parse(await readFile(reportPath, "utf8"));
		expect(failed.verdict).toBe("fail");
		expect(failed.issues[0].where).toBe("flow.0");
	});

	it("runCli grows the SVG canvas by --padding", async () => {
		const viewBox = async (args: string[]) => {
			const io = memoryIo(VALID_DSL);
			expect(await runCli(args, io.environment)).toBe(0);
			return (io.stdout().match(/viewBox="([^"]*)"/)?.[1] ?? "")
				.split(" ")
				.map(Number);
		};
		const tight = await viewBox(["--padding", "0"]);
		const wide = await viewBox(["--padding", "20"]);
		const defaults = await viewBox([]);
		// 20px more on every side than with no margin; the default is 4px.
		expect(wide[0]).toBe((tight[0] ?? 0) - 20);
		expect(wide[2]).toBe((tight[2] ?? 0) + 40);
		expect(defaults[0]).toBe((tight[0] ?? 0) - 4);

		const bad = memoryIo(VALID_DSL);
		expect(await runCli(["--padding", "-1"], bad.environment)).toBe(2);
		expect(bad.stderr()).toContain("expected a number >= 0");
	});

	it("runCli prints informational diagnostics only with --verbose", async () => {
		const source =
			"nodes: { a: { label: 订单 }, b: { label: 支付 } }\nedges: [a -> b]\n";
		const quiet = memoryIo(source);
		expect(await runCli([], quiet.environment)).toBe(0);
		expect(quiet.stderr()).toBe("");
		const verbose = memoryIo(source);
		expect(await runCli(["--verbose"], verbose.environment)).toBe(0);
		expect(verbose.stderr()).toContain("info");
	});

	it("runCli refuses a report path that is also the output", async () => {
		const io = memoryIo(VALID_DSL);
		expect(
			await runCli(
				["--output", "same.svg", "--report", "same.svg"],
				io.environment,
			),
		).toBe(2);
		expect(io.stderr()).toContain("io.output-conflict");
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

describe("agh CLI with scene documents", () => {
	const study = readFileSync(
		new URL("../examples/scene/study.yaml", import.meta.url),
		"utf8",
	);
	const broken = readFileSync(
		new URL("./fixtures/scene/study-broken.yaml", import.meta.url),
		"utf8",
	);

	it("writes scene-json by default", async () => {
		const io = memoryIo(study);
		expect(await runCli([], io.environment)).toBe(0);
		const document = JSON.parse(io.stdout());
		expect(document).toMatchObject({ format: "dge-scene", valid: true });
		expect(io.stderr()).toBe("");
	});

	it("writes a Blender script or a top view", async () => {
		const blender = memoryIo(study);
		expect(await runCli(["--format", "blender"], blender.environment)).toBe(0);
		expect(blender.stdout()).toContain("import bpy");
		const svg = memoryIo(study);
		expect(await runCli(["--format", "svg"], svg.environment)).toBe(0);
		expect(svg.stdout()).toContain("<svg");
	});

	it("writes glTF, and a binary glb file byte for byte", async () => {
		const gltf = memoryIo(study);
		expect(await runCli(["--format", "gltf"], gltf.environment)).toBe(0);
		expect(JSON.parse(gltf.stdout())).toMatchObject({
			asset: { version: "2.0" },
		});
		await using workspace = await tempWorkspace();
		const outputPath = join(workspace.path, "study.glb");
		const io = memoryIo(study);
		expect(
			await runCli(["--format", "glb", "--output", outputPath], io.environment),
		).toBe(0);
		const bytes = await readFile(outputPath);
		expect(bytes.subarray(0, 4).toString("latin1")).toBe("glTF");
		expect(bytes.readUInt32LE(8)).toBe(bytes.length);
	});

	it("still writes an invalid scene, with its errors and exit code 1", async () => {
		const io = memoryIo(broken);
		expect(await runCli(["--json"], io.environment)).toBe(1);
		expect(JSON.parse(io.stdout())).toMatchObject({ valid: false });
		const { diagnostics } = JSON.parse(io.stderr());
		expect(diagnostics[0]).toMatchObject({
			severity: "error",
			layer: "solve",
		});
	});

	it("writes nothing for a scene that does not validate", async () => {
		const io = memoryIo("scene: x\nbounds: { width: 4 }\nobjects: {}\n");
		expect(await runCli([], io.environment)).toBe(1);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toContain("bounds.depth");
	});

	it("rejects diagram options and unknown formats", async () => {
		const page = memoryIo(study);
		expect(await runCli(["--page", "A4"], page.environment)).toBe(2);
		expect(page.stderr()).toContain("io.scene-option");
		const format = memoryIo(study);
		expect(await runCli(["--format", "drawio"], format.environment)).toBe(1);
		expect(format.stderr()).toContain("export.scene.format");
	});
});
