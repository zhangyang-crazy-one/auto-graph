import type { Diagnostic } from "../ir/diagnostics.js";
export type ExportFormat = "svg" | "excalidraw" | "drawio" | "geometry";

export interface ExportResult {
	format: ExportFormat;
	content: string;
	diagnostics: Diagnostic[];
}

export interface ExportOptions {
	title?: string;
	/**
	 * Margin around the drawn content, in pixels. SVG: the canvas (view box
	 * and background) grows by it around everything drawn (default 4), and
	 * it is recorded in `data-dge-viewport` metadata. draw.io: the page grows
	 * by it (default 0). Excalidraw: the initial scroll and zoom leave it
	 * free. A negative or non-finite value is treated as 0 (SVG: as the
	 * default).
	 */
	viewportPadding?: number;
	/**
	 * Lay the drawing out on a page (SVG): the document gets the page's
	 * size and the content is drawn at `scale`, centred.
	 */
	page?: { width: number; height: number; scale: number };
}
