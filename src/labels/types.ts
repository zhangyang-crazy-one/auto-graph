import type { Insets, Size } from "../ir/geometry.js";
import type { TextStyleOptions } from "../text/index.js";

export type { LabelLayout, LabelLineLayout } from "../ir/label-layout.js";

export interface LabelFitOptions {
	font: TextStyleOptions;
	padding: Insets | number;
	minSize?: Partial<Size>;
	maxWidth?: number;
	overflow?: "allow" | "diagnose" | "truncate";
}
