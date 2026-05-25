import type { Readable, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { sortDslDiagnostics } from "../dsl/diagnostics.js";
import { renderDiagramDsl } from "../dsl/render.js";
import type { DslDiagnostic } from "../dsl/types.js";
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

	try {
		const source =
			options.input === undefined
				? await readStdin(stdin)
				: await readInputFile(options.input);
		const result = renderDiagramDsl(source, {
			...(options.input === undefined ? {} : { sourcePath: options.input }),
			...(options.format === undefined ? {} : { format: options.format }),
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

		return 0;
	} catch (error) {
		const diagnostics = [toIoDiagnostic(error)];
		await writeDiagnostics(stderr, diagnostics, options.json === true);
		return 1;
	}
}

function buildCommand(): Command {
	return new Command()
		.name("dge")
		.exitOverride()
		.configureOutput({
			writeOut: () => {},
			writeErr: () => {},
		})
		.option("--input <path>", "Read diagram DSL from a file")
		.option("--output <path>", "Write generated output to a file")
		.option("--format <format>", "Output format: svg or excalidraw")
		.option("--json", "Write diagnostics as JSON to stderr");
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
