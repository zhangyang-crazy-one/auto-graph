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
					const swap =
						!fitsGlyph(point, a0, a1, ai === underEdge.points.length - 2) &&
						fitsGlyph(point, b0, b1, bi === overEdge.points.length - 2);
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

/** One hop glyph on a segment, bridging one crossing or a close cluster. */
export interface HopGlyph<T extends Point> {
	/** The crossings under this glyph, in order along the segment. */
	hops: T[];
	/** Where the glyph leaves and rejoins the segment. */
	before: Point;
	after: Point;
	/** Half the glyph's length along the segment. */
	halfLength: number;
}

/**
 * Hop glyphs for one segment, from crossings already sorted along it.
 * Crossings closer than a glyph (2 × radius) share one wider glyph, so
 * every crossing stays under a hop and no two glyphs overlap. A crossing
 * whose own glyph does not fit inside the segment (right at a bend) is
 * drawn plainly (it stays recorded and counted) and never joins a cluster.
 */
export function hopGlyphs<T extends Point>(
	sorted: readonly T[],
	start: Point,
	end: Point,
): HopGlyph<T>[] {
	const length = Math.hypot(end.x - start.x, end.y - start.y);
	if (length < 1e-9) return [];
	const ux = (end.x - start.x) / length;
	const uy = (end.y - start.y) / length;
	const along = (point: Point) =>
		(point.x - start.x) * ux + (point.y - start.y) * uy;
	// A crossing whose own glyph cannot fit (right at an end of the
	// segment) is drawn plainly; it must not pull a drawable neighbour
	// into a cluster that no longer fits.
	const drawable = sorted.filter(
		(hop) =>
			along(hop) >= EDGE_CROSSING_GLYPH_RADIUS - 1e-6 &&
			length - along(hop) >= EDGE_CROSSING_GLYPH_RADIUS - 1e-6,
	);
	const clusters: T[][] = [];
	for (const hop of drawable) {
		const current = clusters.at(-1);
		const last = current?.at(-1);
		if (
			current !== undefined &&
			last !== undefined &&
			along(hop) - along(last) < 2 * EDGE_CROSSING_GLYPH_RADIUS - 1e-6
		) {
			current.push(hop);
		} else {
			clusters.push([hop]);
		}
	}
	const glyphs: HopGlyph<T>[] = [];
	for (const hops of clusters) {
		// Every member fits on its own, so the cluster's glyph fits too.
		const from = along(hops[0] as T) - EDGE_CROSSING_GLYPH_RADIUS;
		const to = along(hops.at(-1) as T) + EDGE_CROSSING_GLYPH_RADIUS;
		glyphs.push({
			hops,
			before: { x: start.x + ux * from, y: start.y + uy * from },
			after: { x: start.x + ux * to, y: start.y + uy * to },
			halfLength: (to - from) / 2,
		});
	}
	return glyphs;
}

/**
 * Length exporters cut off an edge's last segment for its arrowhead
 * (`computeArrowhead`'s default); a hop cannot be drawn inside it.
 */
const ARROWHEAD_LENGTH = 10;

/**
 * A hop glyph centred at `point` fits inside segment `a`–`b` (with the
 * arrowhead cut off `b` when it is the edge's last segment).
 */
function fitsGlyph(
	point: Point,
	a: Point,
	b: Point,
	lastSegment: boolean,
): boolean {
	return (
		Math.hypot(point.x - a.x, point.y - a.y) >= EDGE_CROSSING_GLYPH_RADIUS &&
		Math.hypot(point.x - b.x, point.y - b.y) >=
			EDGE_CROSSING_GLYPH_RADIUS + (lastSegment ? ARROWHEAD_LENGTH : 0)
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
