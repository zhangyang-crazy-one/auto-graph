import {
	exportExcalidraw,
	exportGeometry,
	exportSvg,
} from "../exporters/index.js";
import type { ExportOptions, ExportResult } from "../exporters/types.js";
import type { CoordinatedDiagram } from "../ir/diagram.js";
import type { JsonObject } from "../ir/geometry.js";
import { DEFAULT_CJK_FONT_FAMILY } from "../solver/cjk-typography.js";
import type {
	PortShiftingOptions,
	SolveDiagramOptions,
} from "../solver/index.js";
import {
	type PageInput,
	resolvePage,
	solveDiagram,
	solveForPage,
} from "../solver/index.js";
import { type FontSource, registerFonts } from "../text/index.js";
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

	if (
		selected === "svg" ||
		selected === "excalidraw" ||
		selected === "geometry"
	) {
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
				hint: "Use svg, excalidraw or geometry.",
			},
		],
	};
}

export function exportDiagram(
	format: DslOutputFormat,
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): ExportResult {
	const content =
		format === "svg"
			? exportSvg(diagram, options)
			: format === "geometry"
				? `${JSON.stringify(exportGeometry(diagram), null, 2)}\n`
				: exportExcalidraw(diagram);

	return { format, content, diagnostics: [] };
}

export function renderDiagramDsl(
	source: string,
	options: RenderDiagramDslOptions = {},
): RenderDiagramDslResult {
	const fonts = registerDiagramFonts(options.fonts ?? []);
	if (fonts.diagnostics.length > 0) {
		return { diagnostics: fonts.diagnostics };
	}
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

	const pageInput = options.page ?? normalized.diagram.metadata?.page;
	const resolvedPage =
		pageInput === undefined
			? undefined
			: resolvePage(pageInput as string | PageInput);
	if (resolvedPage !== undefined && "error" in resolvedPage) {
		return {
			diagnostics: sortDslDiagnostics([
				...diagnostics,
				{
					severity: "error",
					layer: "validate",
					code: "validate.page.invalid",
					message: resolvedPage.error,
					path: ["page"],
					hint: 'Use a size such as "A4", "A3-landscape", "slide" or "1200x800".',
				},
			]),
		};
	}
	const solveOptions: SolveDiagramOptions = {
		...(fonts.cjkFamilies.length === 0
			? {}
			: {
					cjkFontFamily: [
						...fonts.cjkFamilies.map((family) => `'${family}'`),
						DEFAULT_CJK_FONT_FAMILY,
					].join(", "),
				}),
		...solveInitialLayoutOption(normalized.diagram.metadata?.initialLayout),
		...(typeof normalized.diagram.metadata?.targetAspectRatio === "number"
			? { targetAspectRatio: normalized.diagram.metadata.targetAspectRatio }
			: {}),
		...(typeof normalized.diagram.metadata?.foldLayout === "boolean"
			? { foldLayout: normalized.diagram.metadata.foldLayout }
			: {}),
		routeKind:
			normalized.diagram.metadata?.routeKind === "straight"
				? "straight"
				: normalized.diagram.metadata?.routeKind === "obstacle-avoiding"
					? "obstacle-avoiding"
					: normalized.diagram.metadata?.routeKind === "short-orthogonal-jumps"
						? "short-orthogonal-jumps"
						: "orthogonal",
		...solvePortShiftingOption(normalized.diagram.metadata?.portShifting),
		...solveDenseRoutingOptions(normalized.diagram.metadata),
		...(options.textMeasurer === undefined
			? {}
			: { textMeasurer: options.textMeasurer }),
		...(options.previousLayout === undefined
			? {}
			: { previousLayout: options.previousLayout }),
		...(options.stabilityWeight === undefined
			? {}
			: { stabilityWeight: options.stabilityWeight }),
	};
	const fitted =
		resolvedPage === undefined
			? undefined
			: solveForPage(normalized.diagram, solveOptions, resolvedPage.page);
	const solved =
		fitted?.solved ?? solveDiagram(normalized.diagram, solveOptions);
	const page = fitted?.fit;
	const solveDiagnostics = solved.diagnostics.map(toSolveDiagnostic);
	if (hasErrorDiagnostics(solveDiagnostics)) {
		return {
			diagram: solved,
			diagnostics: sortDslDiagnostics(solveDiagnostics),
		};
	}

	try {
		const exported = exportDiagram(
			format.format,
			solved,
			page === undefined
				? {}
				: {
						page: { width: page.width, height: page.height, scale: page.scale },
					},
		);
		return {
			format: exported.format,
			content: exported.content,
			...(page === undefined ? {} : { page }),
			diagram: solved,
			constraints: normalized.diagram.constraints,
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

function solveInitialLayoutOption(
	value: unknown,
): Pick<SolveDiagramOptions, "initialLayout"> {
	if (value === "positions" || value === "global" || value === "dagre") {
		return { initialLayout: value };
	}
	// No explicit mode: let the solver pick (global for swimlanes and long
	// flows unless geometry is pinned, Dagre otherwise).
	return { initialLayout: "auto" };
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

function solveDenseRoutingOptions(
	metadata: JsonObject | undefined,
):
	| Pick<
			SolveDiagramOptions,
			| "textIntersectionTolerance"
			| "compactTextObstacles"
			| "edgeLabelRerouting"
			| "textObstacleVertices"
			| "fixedSwimlaneGeometry"
			| "anchorCapacity"
			| "edgeSeparation"
			| "railRouting"
			| "pagePolicy"
			| "externalLabels"
			| "deliverabilityMode"
			| "remediationPolicy"
	  >
	| Record<string, never> {
	if (metadata === undefined) {
		return {};
	}
	const options: Pick<
		SolveDiagramOptions,
		| "textIntersectionTolerance"
		| "compactTextObstacles"
		| "edgeLabelRerouting"
		| "textObstacleVertices"
		| "fixedSwimlaneGeometry"
		| "anchorCapacity"
		| "edgeSeparation"
		| "railRouting"
		| "pagePolicy"
		| "externalLabels"
		| "deliverabilityMode"
		| "remediationPolicy"
	> = {};
	if (typeof metadata.textIntersectionTolerance === "number") {
		options.textIntersectionTolerance = metadata.textIntersectionTolerance;
	}
	if (
		typeof metadata.compactTextObstacles === "boolean" ||
		metadata.compactTextObstacles === "labels-only"
	) {
		options.compactTextObstacles = metadata.compactTextObstacles;
	}
	if (
		typeof metadata.edgeLabelRerouting === "boolean" ||
		isEdgeLabelReroutingOptions(metadata.edgeLabelRerouting)
	) {
		options.edgeLabelRerouting = metadata.edgeLabelRerouting;
	}
	if (typeof metadata.textObstacleVertices === "boolean") {
		options.textObstacleVertices = metadata.textObstacleVertices;
	}
	if (
		typeof metadata.fixedSwimlaneGeometry === "boolean" ||
		metadata.fixedSwimlaneGeometry === "diagnose-overflow"
	) {
		options.fixedSwimlaneGeometry = metadata.fixedSwimlaneGeometry;
	}
	if (
		typeof metadata.anchorCapacity === "boolean" ||
		isAnchorCapacityOptions(metadata.anchorCapacity)
	) {
		options.anchorCapacity = metadata.anchorCapacity;
	}
	if (
		typeof metadata.edgeSeparation === "boolean" ||
		isEdgeSeparationOptions(metadata.edgeSeparation)
	) {
		options.edgeSeparation = metadata.edgeSeparation;
	}
	if (
		metadata.railRouting === false ||
		metadata.railRouting === "auto" ||
		metadata.railRouting === "dependency"
	) {
		options.railRouting = metadata.railRouting;
	}
	const pagePolicy = metadata.pagePolicy;
	if (isPagePolicyOption(pagePolicy)) {
		options.pagePolicy = pagePolicy;
	}
	if (
		typeof metadata.externalLabels === "boolean" ||
		isExternalLabelsOptions(metadata.externalLabels)
	) {
		options.externalLabels = metadata.externalLabels;
	}
	if (
		metadata.deliverabilityMode === "strict" ||
		metadata.deliverabilityMode === "degraded-ok"
	) {
		options.deliverabilityMode = metadata.deliverabilityMode;
	}
	if (isRemediationPolicyOptions(metadata.remediationPolicy)) {
		options.remediationPolicy = metadata.remediationPolicy;
	}
	return options;
}

function isEdgeLabelReroutingOptions(
	value: unknown,
): value is { maxIterations?: number } {
	return (
		isJsonObject(value) &&
		(value.maxIterations === undefined ||
			typeof value.maxIterations === "number")
	);
}

function isAnchorCapacityOptions(
	value: unknown,
): value is { minSpacing?: number; grow?: boolean } {
	return (
		isJsonObject(value) &&
		(value.minSpacing === undefined || typeof value.minSpacing === "number") &&
		(value.grow === undefined || typeof value.grow === "boolean")
	);
}

function isEdgeSeparationOptions(
	value: unknown,
): value is { spacing?: number } {
	return (
		isJsonObject(value) &&
		(value.spacing === undefined || typeof value.spacing === "number")
	);
}

function isExternalLabelsOptions(
	value: unknown,
): value is { edgeLabels?: boolean } {
	return (
		isJsonObject(value) &&
		(value.edgeLabels === undefined || typeof value.edgeLabels === "boolean")
	);
}

function isPagePolicyOption(
	value: unknown,
): value is NonNullable<SolveDiagramOptions["pagePolicy"]> {
	return (
		value === "off" ||
		value === "auto" ||
		value === "dependency" ||
		value === "resource-flow" ||
		value === "lane-behavior" ||
		value === "ibd-high-fan-in"
	);
}

function isRemediationPolicyOptions(value: unknown): value is {
	externalLabels?: "off" | "suggest" | "auto";
	routeRails?: "off" | "suggest" | "auto";
	growFixedGeometry?: "off" | "suggest" | "auto";
	pageSplit?: "off" | "suggest";
} {
	return (
		isJsonObject(value) &&
		isRemediationPolicyMode(value.externalLabels) &&
		isRemediationPolicyMode(value.routeRails) &&
		isRemediationPolicyMode(value.growFixedGeometry) &&
		(value.pageSplit === undefined ||
			value.pageSplit === "off" ||
			value.pageSplit === "suggest")
	);
}

function isRemediationPolicyMode(value: unknown): boolean {
	return (
		value === undefined ||
		value === "off" ||
		value === "suggest" ||
		value === "auto"
	);
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

/**
 * Register the diagram's font files; CJK families go first in the CJK
 * font stack so the output names the font the labels were measured with.
 */
function registerDiagramFonts(fonts: readonly (string | FontSource)[]): {
	cjkFamilies: string[];
	diagnostics: DslDiagnostic[];
} {
	try {
		const registered = registerFonts(fonts);
		return {
			cjkFamilies: registered
				.filter((font) => font.cjk)
				// A collection's first family is its main face.
				.flatMap((font) => font.families.slice(0, 1)),
			diagnostics: [],
		};
	} catch (error) {
		return {
			cjkFamilies: [],
			diagnostics: [
				{
					severity: "error",
					layer: "io",
					code: "io.font.unreadable",
					message: error instanceof Error ? error.message : String(error),
					path: ["fonts"],
					hint: "Pass a readable .ttf, .otf, .ttc or .woff2 file.",
				},
			],
		};
	}
}
