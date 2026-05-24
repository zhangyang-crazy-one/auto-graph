import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Insets, Size } from "../ir/geometry.js";
import { normalizeInsets } from "../geometry/index.js";
import type { TextLayout, TextMeasurer } from "../text/index.js";
import { assertFiniteNonNegative, resolveLineHeight } from "../text/index.js";
import type { LabelFitOptions, LabelLayout, LabelLineLayout } from "./types.js";

export function fitLabel(
	text: string,
	options: LabelFitOptions,
	measurer: TextMeasurer,
): LabelLayout {
	return new LabelFitter(measurer).fit(text, options);
}

export class LabelFitter {
	constructor(private readonly measurer: TextMeasurer) {}

	fit(text: string, options: LabelFitOptions): LabelLayout {
		const padding = normalizeInsets(options.padding);
		const minSize = normalizeMinSize(options.minSize);
		const lineHeight = resolveLineHeight(options.font);
		const maxWidth = normalizeMaxWidth(options.maxWidth);
		const prepared = this.measurer.prepare(text, options.font);
		const naturalTextWidth = this.measurer.naturalWidth(prepared);
		const contentMaxWidth =
			maxWidth === undefined
				? naturalTextWidth
				: Math.max(0, maxWidth - padding.left - padding.right);
		const textLayout = this.measurer.layout(prepared, contentMaxWidth, lineHeight);
		const naturalSize = {
			width: naturalTextWidth,
			height: textLayout.height,
		};
		const contentWidth = Math.max(textLayout.width, minContentWidth(minSize, padding));
		const contentHeight = Math.max(
			textLayout.height,
			minContentHeight(minSize, padding),
		);
		const idealWidth = contentWidth + padding.left + padding.right;
		const idealHeight = contentHeight + padding.top + padding.bottom;
		const fittedSize = {
			width: maxWidth === undefined ? idealWidth : Math.min(maxWidth, idealWidth),
			height: idealHeight,
		};
		const box: Box = {
			x: 0,
			y: 0,
			width: fittedSize.width,
			height: fittedSize.height,
		};
		const contentBox: Box = {
			x: padding.left,
			y: padding.top,
			width: Math.max(0, box.width - padding.left - padding.right),
			height: Math.max(0, box.height - padding.top - padding.bottom),
		};
		const overflow = {
			horizontal: textLayout.width > contentBox.width,
			vertical:
				textLayout.height > contentBox.height ||
				diagnosedHeightConstraintOverflow(textLayout.height, padding, minSize),
			truncated: options.overflow === "truncate" && textLayout.width > contentBox.width,
		};
		const diagnostics = buildDiagnostics(overflow, options.overflow);

		return {
			text,
			box,
			contentBox,
			naturalSize,
			fittedSize,
			padding,
			font: { ...options.font },
			lineHeight,
			lines: buildLines(textLayout, contentBox, lineHeight),
			overflow,
			diagnostics,
		};
	}
}

function buildLines(
	textLayout: TextLayout,
	contentBox: Box,
	lineHeight: number,
): LabelLineLayout[] {
	return textLayout.lines.map((line, lineIndex) => ({
		text: line.text,
		box: {
			x: contentBox.x,
			y: contentBox.y + lineIndex * lineHeight,
			width: line.width,
			height: lineHeight,
		},
		baselineY: contentBox.y + lineIndex * lineHeight + lineHeight * 0.8,
		width: line.width,
		lineIndex,
		sourceStart: { ...line.start },
		sourceEnd: { ...line.end },
	}));
}

function normalizeMinSize(minSize: Partial<Size> = {}): Partial<Size> {
	if (minSize.width !== undefined) {
		assertFiniteNonNegative(minSize.width, "minSize.width");
	}

	if (minSize.height !== undefined) {
		assertFiniteNonNegative(minSize.height, "minSize.height");
	}

	return { ...minSize };
}

function normalizeMaxWidth(maxWidth: number | undefined): number | undefined {
	if (maxWidth === undefined) {
		return undefined;
	}

	assertFiniteNonNegative(maxWidth, "maxWidth");

	return maxWidth;
}

function minContentWidth(minSize: Partial<Size>, padding: Insets): number {
	return Math.max(0, (minSize.width ?? 0) - padding.left - padding.right);
}

function minContentHeight(minSize: Partial<Size>, padding: Insets): number {
	return Math.max(0, (minSize.height ?? 0) - padding.top - padding.bottom);
}

function diagnosedHeightConstraintOverflow(
	textHeight: number,
	padding: Insets,
	minSize: Partial<Size>,
): boolean {
	return (
		minSize.height !== undefined &&
		textHeight + padding.top + padding.bottom > minSize.height
	);
}

function buildDiagnostics(
	overflow: LabelLayout["overflow"],
	mode: LabelFitOptions["overflow"] = "allow",
): Diagnostic[] {
	if (mode !== "diagnose") {
		return [];
	}

	const diagnostics: Diagnostic[] = [];

	if (overflow.horizontal) {
		diagnostics.push({
			severity: "warning",
			code: "label.overflow.horizontal",
			message: "Label text exceeds the fitted content width.",
		});
	}

	if (overflow.vertical) {
		diagnostics.push({
			severity: "warning",
			code: "label.overflow.vertical",
			message: "Label text exceeds the fitted content height.",
		});
	}

	return diagnostics;
}
