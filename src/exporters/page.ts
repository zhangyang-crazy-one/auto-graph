import type { ExportOptions } from "./types.js";

/**
 * The requested page when it can be laid out: finite, positive width,
 * height and scale. Anything else (a library caller's zero, negative or
 * non-finite value) would divide into non-finite geometry, so the export
 * falls back to the unpaged canvas.
 */
export function usablePage(
	page: ExportOptions["page"],
): NonNullable<ExportOptions["page"]> | undefined {
	if (page === undefined) return undefined;
	const positive = (value: number) => Number.isFinite(value) && value > 0;
	return positive(page.width) && positive(page.height) && positive(page.scale)
		? page
		: undefined;
}
