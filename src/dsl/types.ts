import type { Diagnostic } from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type { JsonObject, PreviousLayout } from "../ir/geometry.js";
import type { FontSource } from "../text/index.js";
import type { TextMeasurer } from "../text/types.js";

export type DslDiagnosticLayer =
	| "parse"
	| "validate"
	| "solve"
	| "export"
	| "io";

export type DslOutputFormat = "svg" | "excalidraw" | "geometry";

export interface DslDiagnostic extends Diagnostic {
	layer: DslDiagnosticLayer;
	hint?: string;
}

export interface ParseDiagramDslResult {
	value?: unknown;
	diagnostics: DslDiagnostic[];
}

export interface ParseDiagramDslOptions {
	sourcePath?: string;
	sourceFormat?: "yaml" | "json";
	maxBytes?: number;
}

export interface NormalizeDiagramDslResult {
	diagram?: NormalizedDiagram;
	diagnostics: DslDiagnostic[];
	output?: {
		format?: DslOutputFormat;
	};
}

export interface RenderDiagramDslOptions {
	sourcePath?: string;
	sourceFormat?: "yaml" | "json";
	format?: string;
	textMeasurer?: TextMeasurer;
	/**
	 * Font files the diagram is drawn with: registered for measurement
	 * (Node), and CJK ones are put first in the CJK font stack.
	 */
	fonts?: readonly (string | FontSource)[];
	/**
	 * The previous solved version of this diagram (see `previousLayoutOf`,
	 * `previousLayoutFromGeometry`): keeps the layout stable across edits.
	 */
	previousLayout?: PreviousLayout;
	/** See `SolveDiagramOptions.stabilityWeight`. */
	stabilityWeight?: number;
}

export interface RenderDiagramDslResult {
	format?: DslOutputFormat;
	content?: string;
	diagnostics: DslDiagnostic[];
	diagram?: CoordinatedDiagram;
	/** Normalized constraints of the rendered diagram (e.g. for metrics). */
	constraints?: NormalizedDiagram["constraints"];
	metadata?: JsonObject;
}
