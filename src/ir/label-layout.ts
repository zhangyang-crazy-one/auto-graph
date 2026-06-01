import type {
	TextCursor,
	TextMeasurementBackend,
	TextStyleOptions,
} from "../text/index.js";
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
	textBackend?: TextMeasurementBackend;
	lineHeight: number;
	lines: LabelLineLayout[];
	overflow: {
		horizontal: boolean;
		vertical: boolean;
		truncated: boolean;
	};
	diagnostics: Diagnostic[];
}

export type TextSurfaceKind =
	| "node-label"
	| "group-label"
	| "port-label"
	| "edge-label"
	| "compartment-row"
	| "swimlane-label"
	| "frame-title";

export interface SolvedTextAnnotation {
	text: string;
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	box: Box;
	anchor: Box | { x: number; y: number };
	paddings: Insets;
	lines: LabelLayout["lines"];
	fontSize: number;
	textBackend?: LabelLayout["textBackend"];
}
