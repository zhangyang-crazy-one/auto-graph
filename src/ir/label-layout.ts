import type { TextCursor, TextStyleOptions } from "../text/index.js";
import type { Diagnostic } from "./diagnostics.js";
import type { Box, Insets, Size } from "./geometry.js";

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
