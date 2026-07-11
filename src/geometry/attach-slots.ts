import type { AnchorName, Box, Point } from "../ir/geometry.js";

/**
 * Public attach-slot fractions for a side (#84 §B).
 *
 * For the dense / short-path contract (`count === 3`), slots are the three
 * interior quarter-division points in ascending order: 25% / 50% / 75%.
 * Other counts use equal interior divisions `(i+1)/(n+1)`.
 */
export function attachSlotFractions(count: number): number[] {
	const n = Math.max(1, Math.floor(count));
	if (n === 1) {
		return [0.5];
	}
	if (n === 3) {
		return [0.25, 0.5, 0.75];
	}
	return Array.from({ length: n }, (_, index) => (index + 1) / (n + 1));
}

/**
 * Tournament-priority fractions: mid-side first, then 25%/75% (#76).
 * Public contract order remains {@link attachSlotFractions}.
 */
export function attachSlotFractionsTournamentFirst(count: number): number[] {
	const n = Math.max(1, Math.floor(count));
	if (n === 1) {
		return [0.5];
	}
	if (n === 3) {
		return [0.5, 0.25, 0.75];
	}
	return attachSlotFractions(n);
}

/** Point on a box side at fraction `t` along that side (0→1). */
export function sidePointAtFraction(
	box: Box,
	side: AnchorName,
	fraction: number,
): Point {
	const t = Math.min(1, Math.max(0, fraction));
	switch (side) {
		case "left":
			return { x: box.x, y: box.y + box.height * t };
		case "right":
			return { x: box.x + box.width, y: box.y + box.height * t };
		case "top":
			return { x: box.x + box.width * t, y: box.y };
		case "bottom":
			return { x: box.x + box.width * t, y: box.y + box.height };
		default:
			return {
				x: box.x + box.width / 2,
				y: box.y + box.height / 2,
			};
	}
}

/**
 * Attach slots for one AABB side. Uses the public 25/50/75 contract when
 * `count === 3`.
 */
export function attachSlotsForBox(
	box: Box,
	side: AnchorName,
	count: number,
): Point[] {
	return attachSlotFractions(count).map((fraction) =>
		sidePointAtFraction(box, side, fraction),
	);
}

/**
 * Attach slots ordered for routing tournament (mid-first when count is 3).
 */
export function attachSlotsForBoxTournamentFirst(
	box: Box,
	side: AnchorName,
	count: number,
): Point[] {
	return attachSlotFractionsTournamentFirst(count).map((fraction) =>
		sidePointAtFraction(box, side, fraction),
	);
}
