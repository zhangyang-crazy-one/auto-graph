import { Buffer } from "node:buffer";
import { parseDocument } from "yaml";
import { createParseDiagnostic, sortDslDiagnostics } from "./diagnostics.js";
import { parseEdgeShorthand } from "./edges.js";
import { validateDiagramDsl } from "./schema.js";
import type {
	DslDiagnostic,
	ParseDiagramDslOptions,
	ParseDiagramDslResult,
} from "./types.js";

export const DEFAULT_DSL_MAX_BYTES = 1_000_000;

export function parseDiagramDsl(
	source: string,
	options: ParseDiagramDslOptions = {},
): ParseDiagramDslResult {
	const maxBytes = options.maxBytes ?? DEFAULT_DSL_MAX_BYTES;

	if (Buffer.byteLength(source, "utf8") > maxBytes) {
		return {
			diagnostics: [
				createParseDiagnostic(
					"parse.input.too-large",
					`Input exceeds the ${maxBytes} byte limit.`,
					"Split the diagram into smaller inputs or raise maxBytes for trusted sources.",
				),
			],
		};
	}

	const parsed = parseSource(source, options);
	if (parsed.value === undefined || hasErrorDiagnostics(parsed.diagnostics)) {
		return { diagnostics: sortDslDiagnostics(parsed.diagnostics) };
	}

	const expanded = expandEdgeShorthand(parsed.value);
	if (hasErrorDiagnostics(expanded.diagnostics)) {
		return { diagnostics: sortDslDiagnostics(expanded.diagnostics) };
	}

	const validated = validateDiagramDsl(expanded.value);

	return {
		value: validated.value,
		diagnostics: sortDslDiagnostics([
			...parsed.diagnostics,
			...validated.diagnostics,
		]),
	};
}

function parseSource(
	source: string,
	options: ParseDiagramDslOptions,
): { value?: unknown; diagnostics: DslDiagnostic[] } {
	if (isJsonSource(options)) {
		return parseJsonSource(source);
	}

	return parseYamlSource(source);
}

function parseJsonSource(source: string): {
	value?: unknown;
	diagnostics: DslDiagnostic[];
} {
	try {
		return { value: JSON.parse(source), diagnostics: [] };
	} catch (error) {
		return {
			diagnostics: [
				createParseDiagnostic(
					"parse.json.invalid",
					`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
					"Fix the JSON syntax or use a .yaml source file.",
				),
			],
		};
	}
}

function parseYamlSource(source: string): {
	value?: unknown;
	diagnostics: DslDiagnostic[];
} {
	const document = parseDocument(source);
	const diagnostics: DslDiagnostic[] = [
		...document.errors.map((error) =>
			createParseDiagnostic(
				"parse.yaml.invalid",
				`Invalid YAML: ${error.message}`,
				"Fix the YAML syntax near the reported parser error.",
			),
		),
		...document.warnings.map((warning) => ({
			severity: "warning" as const,
			layer: "parse" as const,
			code: "parse.yaml.warning",
			message: `YAML warning: ${warning.message}`,
			hint: "Review the YAML warning before relying on the parsed value.",
		})),
	];

	if (document.errors.length > 0) {
		return { diagnostics };
	}

	return { value: document.toJS(), diagnostics };
}

function isJsonSource(options: ParseDiagramDslOptions): boolean {
	return (
		options.sourceFormat === "json" ||
		(options.sourcePath?.toLowerCase().endsWith(".json") ?? false)
	);
}

function hasErrorDiagnostics(diagnostics: DslDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function expandEdgeShorthand(value: unknown): {
	value: unknown;
	diagnostics: DslDiagnostic[];
} {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("edges" in value)
	) {
		return { value, diagnostics: [] };
	}

	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.edges)) {
		return { value, diagnostics: [] };
	}

	const diagnostics: DslDiagnostic[] = [];
	const edges = record.edges.map((edge, index) => {
		const shorthand = edgeShorthandText(edge);
		if (shorthand === undefined) {
			return edge;
		}

		const result = parseEdgeShorthand(shorthand, ["edges", index]);
		diagnostics.push(...result.diagnostics);

		if (result.edge === undefined) {
			return edge;
		}

		return {
			sourceId: result.edge.sourceId,
			targetId: result.edge.targetId,
			...(result.edge.label === undefined ? {} : { label: result.edge.label }),
		};
	});

	return { value: { ...record, edges }, diagnostics };
}

function edgeShorthandText(edge: unknown): string | undefined {
	if (typeof edge === "string") {
		return edge;
	}

	if (edge === null || typeof edge !== "object" || Array.isArray(edge)) {
		return undefined;
	}

	const entries = Object.entries(edge);
	if (entries.length !== 1) {
		return undefined;
	}

	const entry = entries[0];
	if (entry === undefined) {
		return undefined;
	}

	const [key, value] = entry;
	if (!key.includes("->") || typeof value !== "string") {
		return undefined;
	}

	return `${key}: ${value}`;
}
