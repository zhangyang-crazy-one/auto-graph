import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Insets, Size } from "../ir/geometry.js";
import type { TextCursor, TextStyleOptions } from "../text/index.js";

export interface LabelFitOptions {
	font: TextStyleOptions;
	padding: Insets | number;
	minSize?: Partial<Size>;
	maxWidth?: number;
	overflow?: "allow" | "diagnose" | "truncate";
}

export interface LabelLineLayout {
	text: string;
	box: Box;
	baselineY: number;
	width: number;
	lineIndex: number;
	sourceStart?: TextCursor;
	sourceEnd?: TextCursor;
}

export interface LabelLayout {
	text: string;
	box: Box;
	contentBox: Box;
	naturalSize: Size;
	fittedSize: Size;
	padding: Insets;
	font: TextStyleOptions;
	lineHeight: number;
	lines: LabelLineLayout[];
	overflow: {
		horizontal: boolean;
		vertical: boolean;
		truncated: boolean;
	};
	diagnostics: Diagnostic[];
}
