import {
	cylinderCapRadius,
	normalizeInsets,
	shapeSkew,
} from "../geometry/index.js";
import type { NodeShape } from "../ir/elements.js";
import type { Insets, Size } from "../ir/geometry.js";
import type { TextMeasurer } from "../text/index.js";
import { resolveLineHeight } from "../text/index.js";
import { fitLabel, translateLabelLayout } from "./fit.js";
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
/** Narrowest aspect ratio accepted for pointed shapes (circles are exempt). */
const MIN_POINTED_ASPECT = 1;
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

	const allowedWordBreaks = midWordBreaks(greedy);
	const greedyWidth = Math.max(contentMax, 1);
	const balancedWidth = (lines: number): number => {
		// 1. Narrowest content width that keeps `lines` lines (monotonic).
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
		// 2. Never trade balance for a break inside a Latin word (CJK may
		//    break between any two characters): walk up to the first width
		//    without extra mid-word breaks, never past the greedy width.
		const ceiling = Math.max(
			high,
			Math.min(greedyWidth, Math.max(contentMax, natural)),
		);
		for (let width = high; width <= ceiling + 1e-9; width += 1) {
			const layout = measurer.layout(prepared, width, lineHeight);
			if (
				layout.lines.length <= lines &&
				midWordBreaks(layout) <= allowedWordBreaks
			) {
				return Math.ceil(width * 100) / 100;
			}
		}
		return ceiling;
	};

	// Extra lines only pay off for outlines that scale on both axes with the
	// text box (diamond, ellipse); slanted/capped shapes behave like boxes.
	const pointed = options.shape === "diamond" || options.shape === "ellipse";
	const lineCounts = pointed
		? Array.from(
				{ length: MAX_EXTRA_LINES + 1 },
				(_, extra) => baseLines + extra,
			)
		: [baseLines];
	let best:
		| { width: number; score: number; size: ShapeTextSize; textSize: Size }
		| undefined;
	let previousLines = 0;
	for (const lines of lineCounts) {
		const width = balancedWidth(lines);
		const layout = measurer.layout(prepared, width, lineHeight);
		// Stop once extra lines no longer change the wrap (single long word).
		if (layout.lines.length <= previousLines) break;
		previousLines = layout.lines.length;
		const textSize = { width: layout.width, height: layout.height };
		const raw = shapeSizeForText(options.shape, textSize, padding, options);
		// Score the size the node will actually get (minimum size floor).
		const size = {
			...raw,
			width: Math.max(raw.width, options.minSize?.width ?? 0),
			height: Math.max(raw.height, options.minSize?.height ?? 0),
		};
		const aspect = size.width / Math.max(1, size.height);
		// Diamonds read best between square and MAX_POINTED_ASPECT wide; a tall
		// narrow diamond blocks a whole row, a flat one a whole column.
		const aspectPenalty = !pointed
			? 1
			: aspect > MAX_POINTED_ASPECT
				? (aspect / MAX_POINTED_ASPECT) ** 2
				: aspect < MIN_POINTED_ASPECT
					? (MIN_POINTED_ASPECT / aspect) ** 2
					: 1;
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
			align: "center",
			...(options.overflow === undefined ? {} : { overflow: options.overflow }),
		},
		measurer,
	);
	const minSize = options.minSize ?? {};
	const fitted = best?.size;
	let size: Size = {
		width: Math.max(
			fitted?.width ?? 0,
			minSize.width ?? 0,
			layout.fittedSize.width,
		),
		height: Math.max(
			fitted?.height ?? 0,
			minSize.height ?? 0,
			layout.fittedSize.height,
		),
	};
	if (options.shape === "ellipse" && options.circleEllipse !== false) {
		const diameter = Math.max(size.width, size.height);
		size = { width: diameter, height: diameter };
	}
	// Recompute the cylinder label shift for the final (floored) size.
	const labelOffsetY =
		options.shape === "cylinder" && best !== undefined
			? cylinderLabelOffset(best.textSize, size)
			: 0;
	return { layout: centerLayout(layout, size, labelOffsetY), size };
}

/**
 * Downward label shift that keeps a text box of `text` size clear of both
 * cylinder cap arcs inside a node of `size`.
 */
export function cylinderLabelOffset(text: Size, size: Size): number {
	const ry = cylinderCapRadius({ x: 0, y: 0, ...size });
	const ratio = Math.min(1, (text.width + 2 * OUTLINE_MARGIN) / size.width);
	const s = Math.sqrt(Math.max(0, 1 - ratio * ratio));
	const half = (size.height - text.height) / 2 - OUTLINE_MARGIN;
	// Text top must clear the top cap arc, text bottom the bottom arc.
	const lower = ry * (1 + s) - half;
	const upper = half - ry * (1 - s);
	const preferred = ry * s;
	if (lower > upper) return (lower + upper) / 2;
	return Math.min(upper, Math.max(lower, preferred));
}

const LATIN_WORD_CHAR = /[\p{Script=Latin}\p{Nd}]/u;

/** Line breaks that split a Latin word or number between two lines. */
function midWordBreaks(layout: { lines: readonly { text: string }[] }): number {
	let breaks = 0;
	for (let index = 0; index + 1 < layout.lines.length; index += 1) {
		const current = layout.lines[index]?.text ?? "";
		const next = layout.lines[index + 1]?.text ?? "";
		const last = current.at(-1) ?? "";
		const first = next[0] ?? "";
		if (LATIN_WORD_CHAR.test(last) && LATIN_WORD_CHAR.test(first)) breaks += 1;
	}
	return breaks;
}

/** Minimum clearance between text and a curved / slanted outline. */
const OUTLINE_MARGIN = 6;

export interface ShapeTextSize extends Size {
	/** Downward shift of the label centre from the node centre (cylinders). */
	labelOffsetY: number;
}

/**
 * Smallest node size of `shape` whose drawn outline contains the label.
 *
 * Contract (each bound is the exact containment condition at the corners):
 * - rectangle-like outlines (rectangle, hexagon, parallelogram, cylinder
 *   width) contain the text box plus the full `padding`;
 * - curved / pointed outlines (diamond, ellipse, cylinder caps) contain the
 *   text box grown by `OUTLINE_MARGIN` on every side. Using the full
 *   rectangular padding there would double the node for no visual gain.
 * Matches the outlines drawn by the SVG exporter.
 */
export function shapeSizeForText(
	shape: NodeShape,
	text: Size,
	padding: Insets,
	options: { circleEllipse?: boolean } = {},
): ShapeTextSize {
	const padX = padding.left + padding.right;
	const padY = padding.top + padding.bottom;
	const { width: w, height: h } = text;
	// Text box grown by the outline margin on every side.
	const mw = w + 2 * OUTLINE_MARGIN;
	const mh = h + 2 * OUTLINE_MARGIN;
	switch (shape) {
		case "rectangle":
		case "rounded-rectangle":
			return { width: w + padX, height: h + padY, labelOffsetY: 0 };
		case "diamond":
			// Corner (mw/2, mh/2) lies inside when mw/W + mh/H <= 1; W = 2mw,
			// H = 2mh is the minimum-area solution.
			return { width: 2 * mw, height: 2 * mh, labelOffsetY: 0 };
		case "ellipse": {
			if (options.circleEllipse !== false) {
				// A circle contains the box when its diameter covers the diagonal.
				const diameter = Math.hypot(mw, mh);
				return { width: diameter, height: diameter, labelOffsetY: 0 };
			}
			// (mw/W)^2 + (mh/H)^2 <= 1 with the same scale on both axes.
			return {
				width: mw * Math.SQRT2,
				height: mh * Math.SQRT2,
				labelOffsetY: 0,
			};
		}
		case "hexagon": {
			// Left/right tips: at |y| = h/2 the edge is inset by skew * h / H.
			const height = h + padY;
			let width = w + padX;
			for (let iteration = 0; iteration < 4; iteration += 1) {
				const skew = shapeSkew({ x: 0, y: 0, width, height });
				width = w + padX + (2 * skew * h) / height;
			}
			return { width, height, labelOffsetY: 0 };
		}
		case "parallelogram": {
			// Top-left and bottom-right corners meet the slanted edges, each
			// inset by skew * (H + h) / (2H).
			const height = h + padY;
			let width = w + padX;
			for (let iteration = 0; iteration < 4; iteration += 1) {
				const skew = shapeSkew({ x: 0, y: 0, width, height });
				width = w + padX + (skew * (height + h)) / height;
			}
			return { width, height, labelOffsetY: 0 };
		}
		case "cylinder": {
			// The top cap's front arc dips to 2*ry at the centre, the bottom arc
			// only to ry at the corners. Shifting the label down by ry*s
			// (s = sqrt(1 - (w/W)^2)) balances both: H = h + 2m + 2ry.
			const width = w + padX;
			let height = Math.max(h + padY, h + 2 * OUTLINE_MARGIN + 24);
			for (let iteration = 0; iteration < 4; iteration += 1) {
				const ry = cylinderCapRadius({ x: 0, y: 0, width, height });
				height = Math.max(h + padY, h + 2 * OUTLINE_MARGIN + 2 * ry);
			}
			const ry = cylinderCapRadius({ x: 0, y: 0, width, height });
			const ratio = Math.min(1, (w + 2 * OUTLINE_MARGIN) / width);
			const s = Math.sqrt(Math.max(0, 1 - ratio * ratio));
			return { width, height, labelOffsetY: ry * s };
		}
	}
}

function centerLayout(
	layout: LabelLayout,
	size: Size,
	offsetY = 0,
): LabelLayout {
	const x = Math.max(0, (size.width - layout.box.width) / 2);
	const y = Math.max(
		0,
		Math.min(
			size.height - layout.box.height,
			(size.height - layout.box.height) / 2 + offsetY,
		),
	);
	return translateLabelLayout(layout, x - layout.box.x, y - layout.box.y);
}
