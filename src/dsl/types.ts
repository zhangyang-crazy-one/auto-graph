import type { Diagnostic } from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type { JsonObject } from "../ir/geometry.js";
import type { TextMeasurer } from "../text/types.js";

export type DslDiagnosticLayer =
	| "parse"
	| "validate"
	| "solve"
	| "export"
	| "io";

export type DslOutputFormat = "svg" | "excalidraw";

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
}

export interface RenderDiagramDslResult {
	format?: DslOutputFormat;
	content?: string;
	diagnostics: DslDiagnostic[];
	diagram?: CoordinatedDiagram;
	metadata?: JsonObject;
}
