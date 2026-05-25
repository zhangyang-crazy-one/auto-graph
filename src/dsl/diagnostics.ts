import type { DslDiagnostic, DslDiagnosticLayer } from "./types.js";

const SEVERITY_RANK = new Map([
	["error", 0],
	["warning", 1],
	["info", 2],
] as const);

const LAYER_RANK = new Map<DslDiagnosticLayer, number>([
	["parse", 0],
	["validate", 1],
	["solve", 2],
	["export", 3],
	["io", 4],
]);

export function sortDslDiagnostics(
	diagnostics: DslDiagnostic[],
): DslDiagnostic[] {
	return [...diagnostics].sort((a, b) => {
		const severityDelta =
			(SEVERITY_RANK.get(a.severity) ?? 99) -
			(SEVERITY_RANK.get(b.severity) ?? 99);
		if (severityDelta !== 0) {
			return severityDelta;
		}

		const layerDelta =
			(LAYER_RANK.get(a.layer) ?? 99) - (LAYER_RANK.get(b.layer) ?? 99);
		if (layerDelta !== 0) {
			return layerDelta;
		}

		const pathDelta = pathKey(a.path).localeCompare(pathKey(b.path));
		if (pathDelta !== 0) {
			return pathDelta;
		}

		return a.code.localeCompare(b.code);
	});
}

export function createSchemaDiagnostic(
	path: Array<string | number>,
	message: string,
): DslDiagnostic {
	return {
		severity: "error",
		layer: "validate",
		code: "validate.schema.invalid",
		message,
		path,
		hint: hintForPath(path),
	};
}

export function createParseDiagnostic(
	code: string,
	message: string,
	hint: string,
): DslDiagnostic {
	return {
		severity: "error",
		layer: "parse",
		code,
		message,
		hint,
	};
}

function hintForPath(path: Array<string | number>): string {
	const pathText = pathKey(path);

	if (pathText.endsWith(".shape")) {
		return "Use one of: rectangle, rounded-rectangle, ellipse, diamond, parallelogram, hexagon, cylinder.";
	}

	if (pathText.endsWith(".format")) {
		return "Use output format svg or excalidraw.";
	}

	if (pathText.includes(".position.")) {
		return "Use finite numeric x and y coordinates.";
	}

	return "Check the DSL value at this path against the supported schema.";
}

function pathKey(path: DslDiagnostic["path"]): string {
	return (path ?? []).map(String).join(".");
}
