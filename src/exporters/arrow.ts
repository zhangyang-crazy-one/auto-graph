import type { Point } from "../ir/geometry.js";

export interface Arrowhead {
	tip: Point;
	left: Point;
	right: Point;
	direction: Point;
}

export function computeArrowhead(
	points: readonly Point[],
	options: { length?: number; width?: number } = {},
): Arrowhead {
	const { length = 10, width = 8 } = options;

	for (let index = points.length - 1; index > 0; index -= 1) {
		const tip = points[index];
		const previous = points[index - 1];
		if (tip === undefined || previous === undefined) {
			continue;
		}

		const dx = tip.x - previous.x;
		const dy = tip.y - previous.y;
		const magnitude = Math.hypot(dx, dy);
		if (magnitude === 0) {
			continue;
		}

		const direction = { x: dx / magnitude, y: dy / magnitude };
		const perpendicular = { x: -direction.y, y: direction.x };
		const base = {
			x: tip.x - direction.x * length,
			y: tip.y - direction.y * length,
		};
		const halfWidth = width / 2;

		return {
			tip: { ...tip },
			left: {
				x: base.x + perpendicular.x * halfWidth,
				y: base.y + perpendicular.y * halfWidth,
			},
			right: {
				x: base.x - perpendicular.x * halfWidth,
				y: base.y - perpendicular.y * halfWidth,
			},
			direction,
		};
	}

	throw new TypeError("Arrowhead requires at least one non-zero segment");
}
