import type { Diagnostic } from "../ir/diagnostics.js";
export type ExportFormat = "svg" | "excalidraw" | "geometry";

export interface ExportResult {
	format: ExportFormat;
	content: string;
	diagnostics: Diagnostic[];
}

export interface ExportOptions {
	title?: string;
	/** Padding around diagram bounds for viewport metadata, in pixels. */
	viewportPadding?: number;
	/**
	 * Lay the drawing out on a page (SVG): the document gets the page's
	 * size and the content is drawn at `scale`, centred.
	 */
	page?: { width: number; height: number; scale: number };
}
