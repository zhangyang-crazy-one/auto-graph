import type { Box } from "../ir/geometry.js";

/**
 * How much a layout moved between two versions of a diagram, over the
 * nodes present in both. Positions are compared after the translation that
 * best aligns the two layouts (median shift), so adding a node at the top
 * that pushes everything down by one row is one move, not a hundred.
 */
export interface LayoutStability {
	/** Nodes present in both layouts. */
	common: number;
	/** Mean distance a common node's centre moved, after alignment. */
	meanShift: number;
	/** Largest distance a common node's centre moved, after alignment. */
	maxShift: number;
	/** Share of common nodes that moved more than `moveThreshold`. */
	movedShare: number;
	/**
	 * Share of common node pairs that kept both their left/right and their
	 * above/below relation (1 = the mental map is intact).
	 */
	orderPreserved: number;
}

export interface LayoutStabilityOptions {
	/** Distance below which a node counts as unmoved (default 1). */
	moveThreshold?: number;
	/**
	 * Centres closer than this on an axis count as level on it; a pair that
	 * only goes from level to one side is not a flip (default 1).
	 */
	levelTolerance?: number;
}

export function measureLayoutStability(
	previous: ReadonlyMap<string, Box>,
	next: ReadonlyMap<string, Box>,
	options: LayoutStabilityOptions = {},
): LayoutStability {
	const moveThreshold = options.moveThreshold ?? 1;
	const level = options.levelTolerance ?? 1;
	const ids = [...previous.keys()].filter((id) => next.has(id)).sort();
	const centre = (box: Box) => ({
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
	});
	const points = ids.map((id) => ({
		before: centre(previous.get(id) as Box),
		after: centre(next.get(id) as Box),
	}));
	if (points.length === 0) {
		return {
			common: 0,
			meanShift: 0,
			maxShift: 0,
			movedShare: 0,
			orderPreserved: 1,
		};
	}
	const dx = median(points.map(({ before, after }) => after.x - before.x));
	const dy = median(points.map(({ before, after }) => after.y - before.y));
	let total = 0;
	let max = 0;
	let moved = 0;
	for (const { before, after } of points) {
		const shift = Math.hypot(after.x - dx - before.x, after.y - dy - before.y);
		total += shift;
		max = Math.max(max, shift);
		if (shift > moveThreshold) moved += 1;
	}
	const side = (delta: number) => (delta > level ? 1 : delta < -level ? -1 : 0);
	let pairs = 0;
	let flipped = 0;
	points.forEach((first, i) => {
		for (const second of points.slice(i + 1)) {
			pairs += 1;
			const flipX =
				side(second.before.x - first.before.x) *
					side(second.after.x - first.after.x) <
				0;
			const flipY =
				side(second.before.y - first.before.y) *
					side(second.after.y - first.after.y) <
				0;
			if (flipX || flipY) flipped += 1;
		}
	});
	return {
		common: points.length,
		meanShift: round(total / points.length),
		maxShift: round(max),
		movedShare: round(moved / points.length),
		orderPreserved: pairs === 0 ? 1 : round(1 - flipped / pairs),
	};
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] as number)
		: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
