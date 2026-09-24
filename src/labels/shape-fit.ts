import {
	cylinderCapRadius,
	normalizeInsets,
	shapeSkew,
} from "../geometry/index.js";
import type { NodeShape } from "../ir/elements.js";
import type { Insets, Size } from "../ir/geometry.js";
import type { TextMeasurer } from "../text/index.js";
import { resolveLineHeight } from "../text/index.js";
import { fitLabel } from "./fit.js";
import type { LabelFitOptions, LabelLayout } from "./types.js";

/**
 * Shape-aware node label fitting.
 *
 * `fitLabel` sizes a rectangle around the measured text. Non-rectangular
 * shapes need a larger outline to actually contain that rectangle (a
 * diamond needs twice the text width and height, a circle needs the text
 * box diagonal, …). This helper:
 *
 * 1. measures the label once with the configured text backend (Pretext by
 *    default, so CJK / Latin / mixed scripts break by real glyph widths);
 * 2. tries a few line counts and, for each, the narrowest wrap width that
 *    keeps that line count ("balanced" wrapping, so no orphan character or
 *    word ends up alone on the last line);
 * 3. picks the candidate whose enclosing shape is most compact;
 * 4. returns the label layout centred inside the final node size.
 */
export interface ShapeLabelFit {
	layout: LabelLayout;
	size: Size;
}

export interface ShapeLabelFitOptions extends LabelFitOptions {
	shape: NodeShape;
	/** Keep ellipses circular (terminator style, #84). Default true. */
	circleEllipse?: boolean;
}

/** Longest aspect ratio (width / height) accepted for pointed shapes. */
const MAX_POINTED_ASPECT = 2.6;
const MAX_EXTRA_LINES = 3;

export function fitLabelToShape(
	text: string,
	options: ShapeLabelFitOptions,
	measurer: TextMeasurer,
): ShapeLabelFit {
	const padding = normalizeInsets(options.padding);
	const lineHeight = resolveLineHeight(options.font);
	const prepared = measurer.prepare(text, options.font);
	const natural = measurer.naturalWidth(prepared);
	const horizontalPadding = padding.left + padding.right;
	const contentMax =
		options.maxWidth === undefined
			? natural
			: Math.max(1, options.maxWidth - horizontalPadding);
	const greedy = measurer.layout(prepared, contentMax, lineHeight);
	const baseLines = Math.max(1, greedy.lines.length);

	const balancedWidth = (lines: number): number => {
		// Narrowest content width that still fits the text in `lines` lines.
		let low = 0;
		let high = Math.max(contentMax, natural);
		if (measurer.layout(prepared, high, lineHeight).lines.length > lines) {
			return high;
		}
		for (let iteration = 0; iteration < 14; iteration += 1) {
			const middle = (low + high) / 2;
			if (measurer.layout(prepared, middle, lineHeight).lines.length <= lines) {
				high = middle;
			} else {
				low = middle;
			}
		}
		return Math.ceil(high * 100) / 100;
	};

	const pointed =
		options.shape !== "rectangle" && options.shape !== "rounded-rectangle";
	const lineCounts = pointed
		? Array.from(
				{ length: MAX_EXTRA_LINES + 1 },
				(_, extra) => baseLines + extra,
			)
		: [baseLines];
	let best:
		| { width: number; score: number; size: Size; textSize: Size }
		| undefined;
	let previousLines = 0;
	for (const lines of lineCounts) {
		const width = balancedWidth(lines);
		const layout = measurer.layout(prepared, width, lineHeight);
		// Stop once extra lines no longer change the wrap (single long word).
		if (layout.lines.length <= previousLines) break;
		previousLines = layout.lines.length;
		const textSize = { width: layout.width, height: layout.height };
		const size = shapeSizeForText(options.shape, textSize, padding, options);
		const aspect = size.width / Math.max(1, size.height);
		const aspectPenalty =
			pointed && aspect > MAX_POINTED_ASPECT ? aspect / MAX_POINTED_ASPECT : 1;
		const score = size.width * size.height * aspectPenalty;
		if (best === undefined || score < best.score - 1e-6) {
			best = { width, score, size, textSize };
		}
	}

	const chosenWidth = best?.width ?? contentMax;
	const layout = fitLabel(
		text,
		{
			font: options.font,
			padding: options.padding,
			// A hair above the balanced width so float rounding cannot add a line.
			maxWidth: chosenWidth + horizontalPadding + 0.01,
			...(options.overflow === undefined ? {} : { overflow: options.overflow }),
		},
		measurer,
	);
	const minSize = options.minSize ?? {};
	let size = best?.size ?? {
		width: layout.fittedSize.width,
		height: layout.fittedSize.height,
	};
	size = {
		width: Math.max(size.width, minSize.width ?? 0, layout.fittedSize.width),
		height: Math.max(
			size.height,
			minSize.height ?? 0,
			layout.fittedSize.height,
		),
	};
	if (options.shape === "ellipse" && options.circleEllipse !== false) {
		const diameter = Math.max(size.width, size.height);
		size = { width: diameter, height: diameter };
	}
	return { layout: centerLayout(layout, size), size };
}

/**
 * Smallest node size of `shape` whose drawn outline contains the padded
 * text box. Matches the outlines drawn by the SVG exporter.
 */
export function shapeSizeForText(
	shape: NodeShape,
	text: Size,
	padding: Insets,
	options: { circleEllipse?: boolean } = {},
): Size {
	const padX = padding.left + padding.right;
	const padY = padding.top + padding.bottom;
	switch (shape) {
		case "rectangle":
		case "rounded-rectangle":
			return { width: text.width + padX, height: text.height + padY };
		case "diamond":
			// Inscribed rectangle w×h fits when w/W + h/H <= 1; W=2w, H=2h is the
			// minimum-area solution. Half the padding keeps text off the edges.
			return {
				width: 2 * text.width + padX,
				height: 2 * text.height + padY / 2,
			};
		case "ellipse": {
			if (options.circleEllipse !== false) {
				const diameter =
					Math.hypot(text.width, text.height) + Math.min(padX, padY) / 2;
				return { width: diameter, height: diameter };
			}
			return {
				width: text.width * Math.SQRT2 + padX / 2,
				height: text.height * Math.SQRT2 + padY / 2,
			};
		}
		case "hexagon": {
			const inner = text.width + padX;
			const wide = inner + 48;
			const width =
				shapeSkew({ x: 0, y: 0, width: wide, height: 1 }) >= 24
					? wide
					: inner / 0.6;
			return { width, height: text.height + padY };
		}
		case "parallelogram": {
			const inner = text.width + padX;
			const wide = inner + 24;
			const width =
				shapeSkew({ x: 0, y: 0, width: wide, height: 1 }) >= 24
					? wide
					: inner / 0.8;
			return { width, height: text.height + padY };
		}
		case "cylinder": {
			const inner = text.height + padY;
			const tall = inner + 24;
			const height =
				cylinderCapRadius({ x: 0, y: 0, width: 1, height: tall }) >= 12
					? tall
					: inner / 0.5;
			return { width: text.width + padX, height };
		}
	}
}

function centerLayout(layout: LabelLayout, size: Size): LabelLayout {
	const x = Math.max(0, (size.width - layout.box.width) / 2);
	const y = Math.max(0, (size.height - layout.box.height) / 2);
	if (x === layout.box.x && y === layout.box.y) return layout;
	const dx = x - layout.box.x;
	const dy = y - layout.box.y;
	return {
		...layout,
		box: { ...layout.box, x, y },
		contentBox: {
			...layout.contentBox,
			x: layout.contentBox.x + dx,
			y: layout.contentBox.y + dy,
		},
	};
}
