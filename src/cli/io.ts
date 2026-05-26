import {
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { DslDiagnostic } from "../dsl/index.js";

export const MAX_INPUT_BYTES = 1_000_000;

export async function readStdin(stream: Readable): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.byteLength;
		if (size > MAX_INPUT_BYTES) {
			throw inputTooLargeDiagnostic();
		}
		chunks.push(buffer);
	}

	return Buffer.concat(chunks).toString("utf8");
}

export async function readInputFile(path: string): Promise<string> {
	const inputStat = await stat(path);
	if (inputStat.size > MAX_INPUT_BYTES) {
		throw inputTooLargeDiagnostic();
	}

	const content = await readFile(path, "utf8");
	if (Buffer.byteLength(content, "utf8") > MAX_INPUT_BYTES) {
		throw inputTooLargeDiagnostic();
	}

	return content;
}

export async function writeStdout(
	stream: Writable,
	content: string,
): Promise<void> {
	await writeStream(stream, content);
}

export async function writeStderr(
	stream: Writable,
	content: string,
): Promise<void> {
	await writeStream(stream, content);
}

export async function writeFileAtomic(
	path: string,
	content: string,
): Promise<void> {
	const dir = dirname(path);
	const tempDir = await mkdtemp(join(dir, ".agh-output-"));
	const tempPath = join(tempDir, "output.tmp");

	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, path);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

function writeStream(stream: Writable, content: string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(content, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function inputTooLargeDiagnostic(): DslDiagnostic {
	return {
		severity: "error",
		layer: "io",
		code: "io.input.too-large",
		message: `Input exceeds ${MAX_INPUT_BYTES} bytes.`,
		hint: "Reduce the DSL input size or split the diagram into smaller files.",
	};
}
