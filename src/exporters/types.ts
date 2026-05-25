import type { Diagnostic } from "../ir/diagnostics.js";

export type ExportFormat = "svg" | "excalidraw";

export interface ExportResult {
	format: ExportFormat;
	content: string;
	diagnostics: Diagnostic[];
}

export interface ExportOptions {
	title?: string;
}
