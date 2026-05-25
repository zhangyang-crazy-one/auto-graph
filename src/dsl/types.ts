import type { Diagnostic } from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type { JsonObject } from "../ir/geometry.js";

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
}

export interface RenderDiagramDslResult {
	format?: DslOutputFormat;
	content?: string;
	diagnostics: DslDiagnostic[];
	diagram?: CoordinatedDiagram;
	metadata?: JsonObject;
}
