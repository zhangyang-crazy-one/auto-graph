import type { Insets, Size } from "../ir/geometry.js";
import type { TextStyleOptions } from "../text/index.js";

export type { LabelLayout, LabelLineLayout } from "../ir/label-layout.js";

export interface LabelFitOptions {
	font: TextStyleOptions;
	padding: Insets | number;
	minSize?: Partial<Size>;
	maxWidth?: number;
	overflow?: "allow" | "diagnose" | "truncate";
	/**
	 * Horizontal alignment of line boxes inside the content box. `center`
	 * centres each wrapped line (node labels); default `start` keeps lines
	 * left-aligned at the content origin.
	 */
	align?: "start" | "center";
}
