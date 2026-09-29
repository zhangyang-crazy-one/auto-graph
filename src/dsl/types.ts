import type { Diagnostic } from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type { JsonObject, PreviousLayout } from "../ir/geometry.js";
import type { PageFit, PageInput } from "../solver/page-fit.js";
import type { FontSource } from "../text/index.js";
import type { TextMeasurer } from "../text/types.js";

export type DslDiagnosticLayer =
	| "parse"
	| "view"
	| "validate"
	| "solve"
	| "export"
	| "io";

export type DslOutputFormat = "svg" | "excalidraw" | "drawio" | "geometry";

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
	/**
	 * Fit the diagram to a page ("A4", "slide", "1200x800" or a spec);
	 * overrides the document's `page`.
	 */
	page?: string | PageInput;
}

export interface RenderDiagramDslResult {
	format?: DslOutputFormat;
	content?: string;
	diagnostics: DslDiagnostic[];
	diagram?: CoordinatedDiagram;
	/** Normalized constraints of the rendered diagram (e.g. for metrics). */
	constraints?: NormalizedDiagram["constraints"];
	metadata?: JsonObject;
	/** How the diagram fits its page, when it has one. */
	page?: PageFit;
}
