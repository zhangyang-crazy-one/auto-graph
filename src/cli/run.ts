import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { sortDslDiagnostics } from "../dsl/diagnostics.js";
import { renderDiagramDsl } from "../dsl/render.js";
import type { DslDiagnostic } from "../dsl/types.js";
import { previousLayoutFromGeometry } from "../exporters/geometry.js";
import type { PreviousLayout } from "../ir/index.js";
import {
	containmentRelations,
	measureLayoutQuality,
} from "../quality/index.js";
import {
	readInputFile,
	readStdin,
	writeFileAtomic,
	writeStderr,
	writeStdout,
} from "./io.js";

export interface CliEnvironment {
	stdin?: Readable;
	stdout?: Writable;
	stderr?: Writable;
}

interface CliOptions {
	input?: string;
	output?: string;
	format?: string;
	json?: boolean;
	metrics?: string;
	font?: string[];
	previous?: string;
	stability?: number;
}

export async function runCli(
	args: string[],
	env: CliEnvironment = {},
): Promise<number> {
	const stdout = env.stdout ?? process.stdout;
	const stderr = env.stderr ?? process.stderr;
	const stdin = env.stdin ?? process.stdin;
	const command = buildCommand();

	try {
		command.parse(args, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) {
			await writeStderr(stderr, error.message);
			return error.exitCode === 0 ? 0 : 2;
		}
		throw error;
	}

	const options = command.opts<CliOptions>();

	if (
		options.output !== undefined &&
		options.metrics !== undefined &&
		resolve(options.output) === resolve(options.metrics)
	) {
		// Writing metrics over the diagram would silently lose the output.
		await writeDiagnostics(
			stderr,
			[
				{
					severity: "error",
					layer: "io",
					code: "io.output-metrics-conflict",
					message: `--output and --metrics both write ${options.output}.`,
					hint: "Choose a different file for --metrics.",
				},
			],
			options.json === true,
		);
		return 2;
	}

	try {
		const source =
			options.input === undefined
				? await readStdin(stdin)
				: await readInputFile(options.input);
		let previousLayout: PreviousLayout | undefined;
		if (options.previous !== undefined) {
			const read = readPreviousLayout(
				await readInputFile(options.previous),
				options.previous,
			);
			if ("diagnostic" in read) {
				await writeDiagnostics(
					stderr,
					[read.diagnostic],
					options.json === true,
				);
				return 1;
			}
			previousLayout = read.layout;
		}
		const result = renderDiagramDsl(source, {
			...(options.input === undefined ? {} : { sourcePath: options.input }),
			...(previousLayout === undefined ? {} : { previousLayout }),
			...(options.stability === undefined
				? {}
				: { stabilityWeight: options.stability }),
			...(options.format === undefined ? {} : { format: options.format }),
			...(options.font === undefined
				? {}
				: { fonts: options.font.map(parseFontArgument) }),
		});
		const diagnostics = sortDslDiagnostics(result.diagnostics);

		if (hasErrors(diagnostics) || result.content === undefined) {
			await writeDiagnostics(stderr, diagnostics, options.json === true);
			return 1;
		}

		if (diagnostics.length > 0) {
			await writeDiagnostics(stderr, diagnostics, options.json === true);
		}

		if (options.output === undefined) {
			await writeStdout(stdout, result.content);
		} else {
			await writeFileAtomic(options.output, result.content);
		}

		if (options.metrics !== undefined && result.diagram !== undefined) {
			await writeFileAtomic(
				options.metrics,
				`${JSON.stringify(
					measureLayoutQuality(result.diagram, {
						containment: containmentRelations(result.constraints),
					}),
					null,
					2,
				)}\n`,
			);
		}

		return 0;
	} catch (error) {
		const diagnostics = [toIoDiagnostic(error)];
		await writeDiagnostics(stderr, diagnostics, options.json === true);
		return 1;
	}
}

function buildCommand(): Command {
	return new Command()
		.name("agh")
		.exitOverride()
		.configureOutput({
			writeOut: () => {},
			writeErr: () => {},
		})
		.option("--input <path>", "Read diagram DSL from a file")
		.option("--output <path>", "Write generated output to a file")
		.option(
			"--format <format>",
			"Output format: svg, excalidraw or geometry (solved geometry JSON)",
		)
		.option(
			"--font <file>",
			"Measure with this font file (repeatable; Family=file to name it)",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option(
			"--previous <path>",
			"Keep the layout stable: a geometry JSON of the previous version (--format geometry)",
		)
		.option(
			"--stability <weight>",
			"With --previous: crossings one kept node order is worth (default 1)",
			parseStability,
		)
		.option("--json", "Write diagnostics as JSON to stderr")
		.option(
			"--metrics <path>",
			"Write whole-canvas layout quality metrics as JSON to a file",
		);
}

function parseStability(value: string): number {
	const weight = Number(value);
	if (!Number.isFinite(weight) || weight < 0) {
		throw new InvalidArgumentError("expected a number >= 0.");
	}
	return weight;
}

function readPreviousLayout(
	content: string,
	path: string,
): { layout: PreviousLayout } | { diagnostic: DslDiagnostic } {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return {
			diagnostic: {
				severity: "error",
				layer: "io",
				code: "io.previous-invalid",
				message: `${path} is not JSON.`,
				hint: "Pass a file written with --format geometry.",
			},
		};
	}
	const read = previousLayoutFromGeometry(value);
	return "error" in read
		? {
				diagnostic: {
					severity: "error",
					layer: "io",
					code: "io.previous-invalid",
					message: `${path}: ${read.error}`,
					hint: "Pass a file written with --format geometry.",
				},
			}
		: read;
}

async function writeDiagnostics(
	stderr: Writable,
	diagnostics: DslDiagnostic[],
	asJson: boolean,
): Promise<void> {
	if (diagnostics.length === 0) {
		return;
	}

	const content = asJson
		? `${JSON.stringify({ diagnostics }, null, 2)}\n`
		: formatHumanDiagnostics(diagnostics);
	await writeStderr(stderr, content);
}

function formatHumanDiagnostics(diagnostics: DslDiagnostic[]): string {
	const lines = [`${diagnostics.length} diagnostic(s):`];

	for (const diagnostic of diagnostics) {
		const path = formatPath(diagnostic.path);
		lines.push(
			[
				diagnostic.severity,
				diagnostic.layer,
				diagnostic.code,
				path,
				diagnostic.message,
				diagnostic.hint,
			]
				.filter((part) => part !== undefined && part !== "")
				.join(" | "),
		);
	}

	return `${lines.join("\n")}\n`;
}

function formatPath(path: DslDiagnostic["path"]): string {
	return path === undefined || path.length === 0
		? ""
		: `path=${path.map(String).join(".")}`;
}

function hasErrors(diagnostics: DslDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function toIoDiagnostic(error: unknown): DslDiagnostic {
	if (isDslDiagnostic(error)) {
		return error;
	}

	return {
		severity: "error",
		layer: "io",
		code: "io.failed",
		message: error instanceof Error ? error.message : String(error),
		hint: "Check input and output paths, permissions, and CLI arguments.",
	};
}

function isDslDiagnostic(error: unknown): error is DslDiagnostic {
	return (
		typeof error === "object" &&
		error !== null &&
		"severity" in error &&
		"layer" in error &&
		"code" in error &&
		"message" in error
	);
}

/** "file" or "Family=file". */
function parseFontArgument(value: string): { path: string; family?: string } {
	const at = value.indexOf("=");
	return at <= 0
		? { path: value }
		: { family: value.slice(0, at), path: value.slice(at + 1) };
}
