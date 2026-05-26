import { exportExcalidraw, exportSvg } from "../exporters/index.js";
import type { ExportResult } from "../exporters/types.js";
import type { CoordinatedDiagram } from "../ir/diagram.js";
import type { JsonObject } from "../ir/geometry.js";
import type { PortShiftingOptions } from "../solver/index.js";
import { solveDiagram } from "../solver/index.js";
import { sortDslDiagnostics } from "./diagnostics.js";
import { normalizeDiagramDsl } from "./normalize.js";
import { parseDiagramDsl } from "./parse.js";
import type {
	DslDiagnostic,
	DslOutputFormat,
	RenderDiagramDslOptions,
	RenderDiagramDslResult,
} from "./types.js";

export function resolveOutputFormat(
	cliFormat?: string,
	dslFormat?: DslOutputFormat,
): { format?: DslOutputFormat; diagnostics: DslDiagnostic[] } {
	const selected = cliFormat ?? dslFormat ?? "svg";

	if (selected === "svg" || selected === "excalidraw") {
		return { format: selected, diagnostics: [] };
	}

	return {
		diagnostics: [
			{
				severity: "error",
				layer: "validate",
				code: "validate.output-format.unsupported",
				message: `Unsupported output format "${selected}".`,
				path: ["output", "format"],
				hint: "Use svg or excalidraw.",
			},
		],
	};
}

export function exportDiagram(
	format: DslOutputFormat,
	diagram: CoordinatedDiagram,
): ExportResult {
	const content =
		format === "svg" ? exportSvg(diagram) : exportExcalidraw(diagram);

	return { format, content, diagnostics: [] };
}

export function renderDiagramDsl(
	source: string,
	options: RenderDiagramDslOptions = {},
): RenderDiagramDslResult {
	const parsed = parseDiagramDsl(source, options);
	if (hasErrorDiagnostics(parsed.diagnostics) || parsed.value === undefined) {
		return { diagnostics: parsed.diagnostics };
	}

	const normalized = normalizeDiagramDsl(
		parsed.value,
		options.textMeasurer === undefined
			? {}
			: { textMeasurer: options.textMeasurer },
	);
	const format = resolveOutputFormat(options.format, normalized.output?.format);
	const diagnostics = sortDslDiagnostics([
		...parsed.diagnostics,
		...normalized.diagnostics,
		...format.diagnostics,
	]);

	if (
		normalized.diagram === undefined ||
		format.format === undefined ||
		hasErrorDiagnostics(diagnostics)
	) {
		return { diagnostics };
	}

	const solved = solveDiagram(normalized.diagram, {
		routeKind:
			normalized.diagram.metadata?.routeKind === "straight"
				? "straight"
				: "orthogonal",
		...solvePortShiftingOption(normalized.diagram.metadata?.portShifting),
	});
	const solveDiagnostics = solved.diagnostics.map(toSolveDiagnostic);
	if (hasErrorDiagnostics(solveDiagnostics)) {
		return {
			diagram: solved,
			diagnostics: sortDslDiagnostics(solveDiagnostics),
		};
	}

	try {
		const exported = exportDiagram(format.format, solved);
		return {
			format: exported.format,
			content: exported.content,
			diagram: solved,
			diagnostics: sortDslDiagnostics([
				...diagnostics,
				...solveDiagnostics,
				...exported.diagnostics.map(toExportDiagnostic),
			]),
		};
	} catch (error) {
		return {
			diagram: solved,
			diagnostics: [
				{
					severity: "error",
					layer: "export",
					code: "export.failed",
					message: error instanceof Error ? error.message : String(error),
					hint: "Check the coordinated diagram and selected output format.",
				},
			],
		};
	}
}

function toSolveDiagnostic(
	diagnostic: CoordinatedDiagram["diagnostics"][number],
): DslDiagnostic {
	return { ...diagnostic, layer: "solve" };
}

function solvePortShiftingOption(value: unknown):
	| {
			portShifting: PortShiftingOptions;
	  }
	| Record<string, never> {
	if (!isJsonObject(value)) {
		return {};
	}
	const portShifting: PortShiftingOptions = {};
	if (value.enabled === false) {
		portShifting.enabled = false;
	}
	if (typeof value.spacing === "number") {
		portShifting.spacing = value.spacing;
	}
	return { portShifting };
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toExportDiagnostic(
	diagnostic: ExportResult["diagnostics"][number],
): DslDiagnostic {
	return { ...diagnostic, layer: "export" };
}

function hasErrorDiagnostics(diagnostics: DslDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
