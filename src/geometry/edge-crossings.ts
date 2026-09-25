import type { CoordinatedEdge, EdgeCrossing } from "../ir/elements.js";
import type { Point } from "../ir/geometry.js";

/** Glyph radius used by SVG/Excalidraw hop/gap rendering and bounds padding. */
export const EDGE_CROSSING_GLYPH_RADIUS = 6;

/**
 * Detect proper (non-endpoint) intersections between orthogonal edge
 * segments and emit deterministic jump records (#84).
 *
 * Over/under: lexicographic edge id — lower id is under (receives the hop).
 */
export function detectOrthogonalEdgeCrossings(
	edges: readonly CoordinatedEdge[],
	style: EdgeCrossing["style"] = "jump",
): EdgeCrossing[] {
	const crossings: EdgeCrossing[] = [];
	const seen = new Set<string>();
	// Sweep over x: only edges whose bounding boxes overlap can cross.
	const extents = edges
		.filter((edge) => edge.points.length >= 2)
		.map((edge) => {
			let minX = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const point of edge.points) {
				minX = Math.min(minX, point.x);
				maxX = Math.max(maxX, point.x);
				minY = Math.min(minY, point.y);
				maxY = Math.max(maxY, point.y);
			}
			return { edge, minX, maxX, minY, maxY };
		})
		.sort((a, b) => a.minX - b.minX);
	for (let i = 0; i < extents.length; i += 1) {
		const first = extents[i] as (typeof extents)[number];
		const left = first.edge;
		for (let j = i + 1; j < extents.length; j += 1) {
			const second = extents[j] as (typeof extents)[number];
			if (second.minX > first.maxX) break;
			if (second.minY > first.maxY || second.maxY < first.minY) continue;
			const right = second.edge;
			const [underId, overId] =
				left.id < right.id ? [left.id, right.id] : [right.id, left.id];
			const underEdge = left.id === underId ? left : right;
			const overEdge = left.id === overId ? left : right;
			for (let ai = 0; ai < underEdge.points.length - 1; ai += 1) {
				const a0 = underEdge.points[ai];
				const a1 = underEdge.points[ai + 1];
				if (a0 === undefined || a1 === undefined) continue;
				for (let bi = 0; bi < overEdge.points.length - 1; bi += 1) {
					const b0 = overEdge.points[bi];
					const b1 = overEdge.points[bi + 1];
					if (b0 === undefined || b1 === undefined) continue;
					const point = properSegmentIntersection(a0, a1, b0, b1);
					if (point === undefined) continue;
					const key = `${underId}|${overId}|${point.x.toFixed(3)}|${point.y.toFixed(3)}`;
					if (seen.has(key)) continue;
					seen.add(key);
					// The under edge draws the hop: when the crossing sits too
					// close to a bend of its segment for the glyph, but not of
					// the other one, the other edge jumps instead.
					const swap = !fitsGlyph(point, a0, a1) && fitsGlyph(point, b0, b1);
					crossings.push({
						x: point.x,
						y: point.y,
						underEdgeId: swap ? overId : underId,
						overEdgeId: swap ? underId : overId,
						style,
					});
				}
			}
		}
	}
	crossings.sort((a, b) => {
		const byUnder = a.underEdgeId.localeCompare(b.underEdgeId);
		if (byUnder !== 0) return byUnder;
		const byOver = a.overEdgeId.localeCompare(b.overEdgeId);
		if (byOver !== 0) return byOver;
		return a.x - b.x || a.y - b.y;
	});
	return crossings;
}

/** A hop glyph centred at `point` fits inside segment `a`–`b`. */
function fitsGlyph(point: Point, a: Point, b: Point): boolean {
	return (
		Math.hypot(point.x - a.x, point.y - a.y) >= EDGE_CROSSING_GLYPH_RADIUS &&
		Math.hypot(point.x - b.x, point.y - b.y) >= EDGE_CROSSING_GLYPH_RADIUS
	);
}

function properSegmentIntersection(
	a: Point,
	b: Point,
	c: Point,
	d: Point,
): Point | undefined {
	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);
	const proper =
		((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
		((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
	if (!proper) {
		return undefined;
	}
	const denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
	if (Math.abs(denom) < 1e-9) {
		return undefined;
	}
	const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denom;
	return {
		x: a.x + t * (b.x - a.x),
		y: a.y + t * (b.y - a.y),
	};
}

function cross(o: Point, a: Point, b: Point): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
