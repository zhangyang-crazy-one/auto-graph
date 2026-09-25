import { detectOrthogonalEdgeCrossings } from "../geometry/edge-crossings.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type { DiagramDirection } from "../ir/geometry.js";
import type { SolveDiagramOptions } from "./options.js";
import { solveDiagram } from "./solve.js";

/**
 * Page fitting (plan phase 4): lay a diagram out for a target page — A4,
 * a slide, a wiki column — instead of an abstract canvas.
 *
 * The page's usable aspect steers folding (long flows wrap into bands
 * shaped like the page); with `orientation: auto` both orientations are
 * tried, with `direction: auto` both flow directions too. The candidate
 * that can be drawn largest wins, and the fit reports the scale and the
 * size text ends up at on the page, so a caller knows whether the page is
 * readable or the diagram should be split.
 */

/** Page sizes in CSS px (96 per inch), portrait. */
export const PAGE_SIZES: Readonly<
	Record<string, { width: number; height: number; landscapeOnly?: boolean }>
> = {
	a3: { width: 1123, height: 1587 },
	a4: { width: 794, height: 1123 },
	a5: { width: 559, height: 794 },
	letter: { width: 816, height: 1056 },
	legal: { width: 816, height: 1344 },
	slide: { width: 1280, height: 720, landscapeOnly: true },
	"slide-4:3": { width: 1024, height: 768, landscapeOnly: true },
};

export type PageOrientation = "auto" | "portrait" | "landscape";

export interface PageSpec {
	/** Preset name (lowercase), when one was used. */
	name?: string;
	/** Portrait size (landscape swaps them). */
	width: number;
	height: number;
	orientation: PageOrientation;
	/** Blank border on every side, px (default 24). */
	margin: number;
	/** `auto` lets fitting flip the flow direction (LR ↔ TB). */
	direction: "keep" | "auto";
}

export interface PageInput {
	size?: string;
	width?: number;
	height?: number;
	orientation?: PageOrientation;
	margin?: number;
	direction?: "keep" | "auto";
}

/** Below this on-page label size text is not readable (px). */
export const MIN_READABLE_FONT_PX = 8;
/** From this on-page label size text reads comfortably (px). */
export const COMFORTABLE_FONT_PX = 11;
const DEFAULT_MARGIN = 24;
const DEFAULT_FONT_PX = 14;

/**
 * `"A4"`, `"a4-landscape"`, `"A3 portrait"`, `"1200x800"`, or an object
 * `{ size, width, height, orientation, margin, direction }`.
 */
export function resolvePage(
	input: string | PageInput,
): { page: PageSpec } | { error: string } {
	const spec: PageInput =
		typeof input === "string" ? parsePageText(input) : { ...input };
	let width = spec.width;
	let height = spec.height;
	let name: string | undefined;
	let orientation = spec.orientation;
	if (spec.size !== undefined) {
		const parsed = parsePageText(spec.size);
		name = parsed.size;
		orientation ??= parsed.orientation;
		width ??= parsed.width;
		height ??= parsed.height;
		if (name !== undefined) {
			const preset = PAGE_SIZES[name];
			if (preset === undefined) {
				return {
					error: `Unknown page size "${spec.size}". Sizes: ${Object.keys(PAGE_SIZES).join(", ")}, or WIDTHxHEIGHT in px.`,
				};
			}
			width = preset.width;
			height = preset.height;
			if (preset.landscapeOnly === true) orientation = "landscape";
		}
	}
	if (
		width === undefined ||
		height === undefined ||
		!(width > 0) ||
		!(height > 0)
	) {
		return {
			error:
				'A page needs a size ("A4", "slide", …) or a width and height in px.',
		};
	}
	const margin = spec.margin ?? DEFAULT_MARGIN;
	if (!(margin >= 0) || 2 * margin >= Math.min(width, height)) {
		return { error: `Page margin ${margin} leaves no room on the page.` };
	}
	return {
		page: {
			...(name === undefined ? {} : { name }),
			width,
			height,
			// Custom sizes are taken as given; presets turn freely.
			orientation:
				orientation ??
				(name !== undefined
					? "auto"
					: width > height
						? "landscape"
						: "portrait"),
			margin,
			direction: spec.direction ?? "keep",
		},
	};
}

function parsePageText(text: string): PageInput & { size?: string } {
	const trimmed = text.trim().toLowerCase();
	const dimensions = /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
	if (dimensions !== null) {
		return { width: Number(dimensions[1]), height: Number(dimensions[2]) };
	}
	const match = /^(.+?)(?:[\s_-]+(landscape|portrait))?$/.exec(trimmed);
	const size = match?.[1] ?? trimmed;
	const orientation = match?.[2] as PageOrientation | undefined;
	return { size, ...(orientation === undefined ? {} : { orientation }) };
}

export interface PageCandidate {
	orientation: "portrait" | "landscape";
	direction: DiagramDirection;
	scale: number;
	crossings: number;
}

export interface PageFit {
	name?: string;
	/** Page size as used (after orientation), px. */
	width: number;
	height: number;
	orientation: "portrait" | "landscape";
	margin: number;
	direction: DiagramDirection;
	/**
	 * Content scale on the page: at most 1 (a small diagram is not blown
	 * up, it sits at its natural size in the middle of the page).
	 */
	scale: number;
	/** Median node label size on the page, px. */
	fontPx: number;
	/** Text stays readable (fontPx ≥ MIN_READABLE_FONT_PX). */
	readable: boolean;
	/** Text reads comfortably (fontPx ≥ COMFORTABLE_FONT_PX). */
	comfortable: boolean;
	/** Every layout tried, best first. */
	candidates: PageCandidate[];
}

/** Solve `diagram` for `page` and return the best-fitting layout. */
export function solveForPage(
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions,
	page: PageSpec,
): { solved: CoordinatedDiagram; fit: PageFit } {
	const preset = page.name === undefined ? undefined : PAGE_SIZES[page.name];
	const orientations: ("portrait" | "landscape")[] =
		preset?.landscapeOnly === true
			? ["landscape"]
			: page.orientation === "auto"
				? ["portrait", "landscape"]
				: [page.orientation];
	const directions: DiagramDirection[] =
		page.direction === "auto"
			? [diagram.direction, flipDirection(diagram.direction)]
			: [diagram.direction];

	// The page is what fitting is for; overflow is measured below.
	const { pageBounds: _pageBounds, ...base } = options;
	const tried: {
		solved: CoordinatedDiagram;
		candidate: PageCandidate;
		fill: number;
		order: number;
	}[] = [];
	for (const direction of directions) {
		const variant =
			direction === diagram.direction
				? diagram
				: withDirection(diagram, direction);
		for (const orientation of orientations) {
			const size = oriented(page, orientation);
			const availableWidth = size.width - 2 * page.margin;
			const availableHeight = size.height - 2 * page.margin;
			const solved = solveDiagram(variant, {
				...base,
				targetAspectRatio: availableWidth / availableHeight,
			});
			const { width, height } = solved.bounds;
			const scale = Math.min(
				availableWidth / Math.max(1, width),
				availableHeight / Math.max(1, height),
			);
			const shown = Math.min(1, scale);
			tried.push({
				solved,
				candidate: {
					orientation,
					direction,
					scale: round(shown),
					crossings: detectOrthogonalEdgeCrossings(solved.edges).length,
				},
				fill: (width * height * shown * shown) / (size.width * size.height),
				order: tried.length,
			});
		}
	}
	// Largest drawing first; among equals (both at natural size, or within
	// 2%), the one that fills the page better, then fewer crossings, then
	// the author's own direction and portrait.
	tried.sort(
		(a, b) =>
			(Math.abs(a.candidate.scale - b.candidate.scale) > 0.02
				? b.candidate.scale - a.candidate.scale
				: 0) ||
			(Math.abs(a.fill - b.fill) > 0.05 ? b.fill - a.fill : 0) ||
			a.candidate.crossings - b.candidate.crossings ||
			a.order - b.order,
	);
	const best = tried[0] as (typeof tried)[number];
	const size = oriented(page, best.candidate.orientation);
	const fontPx = round(medianLabelFont(best.solved) * best.candidate.scale);
	return {
		solved: best.solved,
		fit: {
			...(page.name === undefined ? {} : { name: page.name }),
			width: size.width,
			height: size.height,
			orientation: best.candidate.orientation,
			margin: page.margin,
			direction: best.candidate.direction,
			scale: best.candidate.scale,
			fontPx,
			readable: fontPx >= MIN_READABLE_FONT_PX,
			comfortable: fontPx >= COMFORTABLE_FONT_PX,
			candidates: tried.map((entry) => entry.candidate),
		},
	};
}

function oriented(
	page: PageSpec,
	orientation: "portrait" | "landscape",
): { width: number; height: number } {
	const long = Math.max(page.width, page.height);
	const short = Math.min(page.width, page.height);
	return orientation === "portrait"
		? { width: short, height: long }
		: { width: long, height: short };
}

function flipDirection(direction: DiagramDirection): DiagramDirection {
	switch (direction) {
		case "LR":
			return "TB";
		case "RL":
			return "BT";
		case "TB":
			return "LR";
		default:
			return "RL";
	}
}

/** The diagram flowing the other way; swimlanes turn with it. */
function withDirection(
	diagram: NormalizedDiagram,
	direction: DiagramDirection,
): NormalizedDiagram {
	const horizontal = direction === "LR" || direction === "RL";
	return {
		...diagram,
		direction,
		...(diagram.swimlanes === undefined
			? {}
			: {
					swimlanes: diagram.swimlanes.map((swimlane) => ({
						...swimlane,
						orientation: horizontal ? "horizontal" : "vertical",
					})),
				}),
	};
}

function medianLabelFont(diagram: CoordinatedDiagram): number {
	const sizes = (diagram.textAnnotations ?? [])
		.filter((annotation) => annotation.surfaceKind === "node-label")
		.map((annotation) => annotation.fontSize)
		.filter((size) => Number.isFinite(size) && size > 0)
		.sort((a, b) => a - b);
	return sizes.length === 0
		? DEFAULT_FONT_PX
		: (sizes[Math.floor(sizes.length / 2)] as number);
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
