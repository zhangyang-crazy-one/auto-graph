import type { Box } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";

/** Margin between the visible text and its backdrop. */
export const LABEL_BACKDROP_PADDING = { x: 3, y: 1 } as const;
export const LABEL_BACKDROP_FILL = "#ffffff";

/**
 * Opaque box drawn behind a label that can sit over lines (edge labels,
 * group titles, port labels): the extent of the rendered text lines plus a
 * small margin. It follows the fitted text, not the padded annotation box,
 * so it hides crossing strokes without covering neighbouring geometry.
 */
export function labelBackdropBox(annotation: SolvedTextAnnotation): Box {
	const text =
		annotation.lines.length > 0
			? unionLines(annotation)
			: {
					x: annotation.box.x + annotation.paddings.left,
					y: annotation.box.y + annotation.paddings.top,
					width: Math.max(
						0,
						annotation.box.width -
							annotation.paddings.left -
							annotation.paddings.right,
					),
					height: Math.max(
						0,
						annotation.box.height -
							annotation.paddings.top -
							annotation.paddings.bottom,
					),
				};
	return {
		x: text.x - LABEL_BACKDROP_PADDING.x,
		y: text.y - LABEL_BACKDROP_PADDING.y,
		width: text.width + 2 * LABEL_BACKDROP_PADDING.x,
		height: text.height + 2 * LABEL_BACKDROP_PADDING.y,
	};
}

function unionLines(annotation: SolvedTextAnnotation): Box {
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const line of annotation.lines) {
		left = Math.min(left, annotation.box.x + line.box.x);
		top = Math.min(top, annotation.box.y + line.box.y);
		right = Math.max(right, annotation.box.x + line.box.x + line.box.width);
		bottom = Math.max(bottom, annotation.box.y + line.box.y + line.box.height);
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}
