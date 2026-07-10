import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
	SwimlaneLane,
	VisualStyle,
} from "../ir/elements.js";
import type { TextStyleOptions } from "../text/types.js";

export interface CjkTypographyOptions {
	fontFamily?: string;
	minFontSize?: number;
}

export interface CjkTypography {
	fontFamily?: string;
	fontSize?: number;
}

const DEFAULT_CJK_FONT_FAMILY = "YaHei,SimSun,sans-serif";
const DEFAULT_MIN_CJK_FONT_SIZE = 14;

/** Minimal options for CJK typography resolution. */
export type CjkSolveOptions = {
	cjkFontFamily?: string | false;
	minCjkFontSize?: number | false;
};

export function createCjkTypographyOptions(
	options: CjkSolveOptions,
): CjkTypographyOptions {
	const fontFamily =
		options.cjkFontFamily === false
			? undefined
			: (options.cjkFontFamily ?? DEFAULT_CJK_FONT_FAMILY);
	const minFontSize =
		options.minCjkFontSize === false
			? undefined
			: (options.minCjkFontSize ?? DEFAULT_MIN_CJK_FONT_SIZE);
	return {
		...(fontFamily === undefined ? {} : { fontFamily }),
		...(minFontSize === undefined ? {} : { minFontSize }),
	};
}

export function enhanceNodeCjkTypography(
	node: NormalizedNode,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): NormalizedNode {
	const nodeWithStyle = enhanceStyledLabelOwner(
		node,
		["nodes", node.id],
		options,
		diagnostics,
	);
	const ports =
		nodeWithStyle.ports === undefined
			? undefined
			: nodeWithStyle.ports.map((port) =>
					enhanceStyledLabelOwner(
						port,
						["nodes", node.id, "ports", port.id],
						options,
						diagnostics,
					),
				);
	return ports === undefined ? nodeWithStyle : { ...nodeWithStyle, ports };
}

export function enhanceEdgeCjkTypography(
	edge: NormalizedEdge,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): NormalizedEdge {
	return enhanceStyledLabelOwner(
		edge,
		["edges", edge.id],
		options,
		diagnostics,
	);
}

export function enhanceGroupCjkTypography(
	group: NormalizedGroup,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): NormalizedGroup {
	return enhanceStyledLabelOwner(
		group,
		["groups", group.id],
		options,
		diagnostics,
	);
}

export function enhanceSwimlaneCjkTypography(
	swimlane: Swimlane,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): Swimlane {
	const root = enhanceStyledLabelOwner(
		swimlane,
		["swimlanes", swimlane.id],
		options,
		diagnostics,
	);
	const lanes = root.lanes.map((lane) =>
		enhanceSwimlaneLaneCjkTypography(swimlane.id, lane, options, diagnostics),
	);
	return { ...root, lanes };
}

function enhanceSwimlaneLaneCjkTypography(
	swimlaneId: string,
	lane: SwimlaneLane,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): SwimlaneLane {
	return enhanceStyledLabelOwner(
		lane,
		["swimlanes", swimlaneId, "lanes", lane.id],
		options,
		diagnostics,
	);
}

function enhanceStyledLabelOwner<
	T extends { id: string; label?: { text: string; metadata?: unknown } },
>(
	owner: T,
	path: readonly (string | number)[],
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): T {
	const text = owner.label?.text;
	if (text === undefined || !containsCjk(text)) {
		return owner;
	}
	const typography = cjkTypographyForOwner(owner, options);
	if (
		typography.fontFamily === undefined &&
		typography.fontSize === undefined
	) {
		return owner;
	}
	const label = owner.label;
	if (label === undefined) {
		return owner;
	}
	const nextLabel = {
		...label,
		metadata: {
			...metadataObject(label.metadata),
			cjkTypography: typography,
		},
	};
	const nextOwner = { ...owner, label: nextLabel };
	const maybeStyled = nextOwner as T & { style?: VisualStyle };
	const nextStyle = enhanceCjkStyle(maybeStyled.style, typography);
	reportCjkTypographyDiagnostics(
		path,
		typography,
		maybeStyled.style,
		diagnostics,
	);
	return nextStyle === maybeStyled.style
		? nextOwner
		: { ...nextOwner, style: nextStyle };
}

function cjkTypographyForOwner(
	owner: {
		label?: { metadata?: unknown } | undefined;
		style?: VisualStyle | undefined;
	},
	options: CjkTypographyOptions,
): CjkTypography {
	const metadataTypography = labelCjkTypography(owner.label?.metadata);
	const fontFamily =
		metadataTypography.fontFamily ??
		owner.style?.fontFamily ??
		options.fontFamily;
	const fontSize = boostedCjkFontSize(
		metadataTypography.fontSize ?? owner.style?.fontSize,
		options.minFontSize,
	);
	return {
		...(fontFamily === undefined ? {} : { fontFamily }),
		...(fontSize === undefined ? {} : { fontSize }),
	};
}

export function labelCjkTypography(metadata: unknown): CjkTypography {
	const metadataRecord = metadataObject(metadata);
	if (metadataRecord === undefined) {
		return {};
	}
	const value = metadataRecord.cjkTypography;
	if (value === undefined || value === null || typeof value !== "object") {
		return {};
	}
	const typography = value as Record<string, unknown>;
	const fontFamily =
		typeof typography.fontFamily === "string"
			? typography.fontFamily
			: undefined;
	const fontSize =
		typeof typography.fontSize === "number" &&
		Number.isFinite(typography.fontSize) &&
		typography.fontSize > 0
			? typography.fontSize
			: undefined;
	return {
		...(fontFamily === undefined ? {} : { fontFamily }),
		...(fontSize === undefined ? {} : { fontSize }),
	};
}

function metadataObject(
	metadata: unknown,
): Record<string, unknown> | undefined {
	if (
		metadata === undefined ||
		metadata === null ||
		typeof metadata !== "object" ||
		Array.isArray(metadata)
	) {
		return undefined;
	}
	return metadata as Record<string, unknown>;
}

export function typographyForLabel(
	label: { metadata?: unknown } | undefined,
): CjkTypography {
	return labelCjkTypography(label?.metadata);
}

export function typographyTextStyle(
	label: { metadata?: unknown } | undefined,
	base: TextStyleOptions,
): TextStyleOptions {
	const typography = typographyForLabel(label);
	return {
		...base,
		...(typography.fontFamily === undefined
			? {}
			: { fontFamily: typography.fontFamily }),
		...(typography.fontSize === undefined
			? {}
			: {
					fontSize: typography.fontSize,
					lineHeight: Math.max(base.lineHeight ?? 0, typography.fontSize * 1.2),
				}),
	};
}

function boostedCjkFontSize(
	current: number | undefined,
	minFontSize: number | undefined,
): number | undefined {
	if (minFontSize === undefined) {
		return current;
	}
	if (current === undefined || current < minFontSize) {
		return minFontSize;
	}
	return current;
}

function enhanceCjkStyle(
	style: VisualStyle | undefined,
	typography: CjkTypography,
): VisualStyle | undefined {
	let next = style;
	if (typography.fontFamily !== undefined && next?.fontFamily === undefined) {
		next = { ...next, fontFamily: typography.fontFamily };
	}
	if (
		typography.fontSize !== undefined &&
		(next?.fontSize === undefined || next.fontSize < typography.fontSize)
	) {
		next = { ...next, fontSize: typography.fontSize };
	}
	return next;
}

function reportCjkTypographyDiagnostics(
	path: readonly (string | number)[],
	typography: CjkTypography,
	previousStyle: VisualStyle | undefined,
	diagnostics: Diagnostic[],
): void {
	if (
		typography.fontFamily !== undefined &&
		previousStyle?.fontFamily === undefined
	) {
		diagnostics.push({
			severity: "info",
			code: "cjk_font_family_applied",
			message: `Applied CJK font family ${typography.fontFamily}.`,
			path: [...path, "label", "metadata", "cjkTypography", "fontFamily"],
			detail: { fontFamily: typography.fontFamily },
		});
	}
	if (
		typography.fontSize !== undefined &&
		(previousStyle?.fontSize === undefined ||
			previousStyle.fontSize < typography.fontSize)
	) {
		diagnostics.push({
			severity: "info",
			code: "cjk_font_size_boosted",
			message: `Raised CJK font size to ${typography.fontSize}.`,
			path: [...path, "label", "metadata", "cjkTypography", "fontSize"],
			detail: {
				minFontSize: typography.fontSize,
				...(previousStyle?.fontSize === undefined
					? {}
					: { previousFontSize: previousStyle.fontSize }),
			},
		});
	}
}

function containsCjk(value: string): boolean {
	return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(value);
}
