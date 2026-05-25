import type { DslDiagnostic } from "./types.js";

const EDGE_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SHORTHAND_PATTERN = /^(.+?)\s*->\s*([^:]+)(?::(.*))?$/;

export interface ParsedEdgeShorthand {
	sourceId: string;
	targetId: string;
	label?: { text: string };
}

export function parseEdgeShorthand(
	value: string,
	path: Array<string | number>,
): { edge?: ParsedEdgeShorthand; diagnostics: DslDiagnostic[] } {
	const match = SHORTHAND_PATTERN.exec(value.trim());
	if (match === null) {
		return invalidEdgeShorthand(path);
	}

	const sourceId = match[1]?.trim() ?? "";
	const targetId = match[2]?.trim() ?? "";
	const labelText = match[3]?.trim();

	if (!isValidEdgeId(sourceId) || !isValidEdgeId(targetId)) {
		return invalidEdgeShorthand(path);
	}

	return {
		edge: {
			sourceId,
			targetId,
			...(labelText === undefined || labelText === ""
				? {}
				: { label: { text: labelText } }),
		},
		diagnostics: [],
	};
}

function invalidEdgeShorthand(path: Array<string | number>): {
	diagnostics: DslDiagnostic[];
} {
	return {
		diagnostics: [
			{
				severity: "error",
				layer: "validate",
				code: "validate.edge-shorthand.invalid",
				message: "Invalid edge shorthand.",
				path,
				hint: 'Use "source -> target" or "source -> target: label".',
			},
		],
	};
}

function isValidEdgeId(value: string): boolean {
	return value.length > 0 && EDGE_ID_PATTERN.test(value);
}
