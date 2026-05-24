import type { Diagnostic } from "../ir/diagnostics.js";

export interface TextStyleOptions {
	fontFamily: string;
	fontSize: number;
	fontWeight?: number | string;
	fontStyle?: "normal" | "italic";
	lineHeight?: number;
	letterSpacing?: number;
	whiteSpace?: "normal" | "pre-wrap";
	wordBreak?: "normal" | "keep-all";
}

export type TextMeasurementBackend = "deterministic" | "pretext";

export interface PreparedText {
	text: string;
	font: string;
	style: TextStyleOptions;
	backend: TextMeasurementBackend;
}

export interface TextCursor {
	segmentIndex: number;
	graphemeIndex: number;
}

export interface TextLayoutLine {
	text: string;
	width: number;
	start: TextCursor;
	end: TextCursor;
}

export interface TextLayout {
	width: number;
	height: number;
	lineHeight: number;
	lineCount: number;
	lines: TextLayoutLine[];
	diagnostics: Diagnostic[];
}

export interface TextMeasurer {
	prepare(text: string, style: TextStyleOptions): PreparedText;
	layout(
		prepared: PreparedText,
		maxWidth: number,
		lineHeight?: number,
	): TextLayout;
	naturalWidth(prepared: PreparedText): number;
}

export function assertFinitePositive(value: number, label: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${label} must be finite and positive`);
	}
}

export function assertFiniteNonNegative(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError(`${label} must be a finite non-negative width`);
	}
}

export function validateTextStyle(style: TextStyleOptions): void {
	assertFinitePositive(style.fontSize, "fontSize");

	if (style.lineHeight !== undefined) {
		assertFinitePositive(style.lineHeight, "lineHeight");
	}

	if (
		style.letterSpacing !== undefined &&
		!Number.isFinite(style.letterSpacing)
	) {
		throw new TypeError("letterSpacing must be finite");
	}
}

export function resolveLineHeight(style: TextStyleOptions): number {
	validateTextStyle(style);
	return style.lineHeight ?? style.fontSize * 1.2;
}

export function toCanvasFont(style: TextStyleOptions): string {
	validateTextStyle(style);

	const fontStyle = style.fontStyle === "italic" ? "italic " : "";
	const fontWeight = style.fontWeight ?? 400;

	return `${fontStyle}${fontWeight} ${style.fontSize}px ${style.fontFamily}`;
}
