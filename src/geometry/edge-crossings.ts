import type { CoordinatedEdge, EdgeCrossing } from "../ir/elements.js";
import type { Point } from "../ir/geometry.js";

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
	for (let i = 0; i < edges.length; i += 1) {
		const left = edges[i];
		if (left === undefined || left.points.length < 2) continue;
		for (let j = i + 1; j < edges.length; j += 1) {
			const right = edges[j];
			if (right === undefined || right.points.length < 2) continue;
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
					crossings.push({
						x: point.x,
						y: point.y,
						underEdgeId: underId,
						overEdgeId: overId,
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
