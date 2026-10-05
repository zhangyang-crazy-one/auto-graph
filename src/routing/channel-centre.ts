import type { CoordinatedEdge } from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import { simplifyRoute } from "./routes.js";

/**
 * Channel centring for obstacle-avoiding routes.
 *
 * The obstacle-avoiding router finds shortest paths through the corners of
 * the obstacles, so its segments run a couple of pixels beside a node side
 * or a group frame, and its end stubs are as short as that leaves them.
 * Each interior segment is moved to the middle of the free channel it runs
 * in: the space between the nearest walls (node, group and obstacle sides)
 * on either side over the segment's whole span. Segments of different
 * routes sharing one channel, with overlapping spans, are spaced evenly
 * across it in their current order, so no two meet and none swap sides.
 *
 * End segments stay put (they are attached to their nodes); moving the
 * segment after one lengthens or shortens it, never past a wall, since the
 * end node's side bounds the channel. The caller validates every moved
 * route (obstacles, crossings, overlaps) and keeps the original otherwise.
 */
export function centreSegmentsInChannels(
	edges: readonly CoordinatedEdge[],
	/** Solid boxes: nodes and obstacles. */
	walls: readonly Box[],
	/** Frames: group and lane boxes, which routes may run inside. */
	frames: readonly Box[] = [],
	fixed: ReadonlySet<string> = new Set(),
	/** Channels narrower than this are left alone. */
	minWidth = MIN_CHANNEL_WIDTH,
): CoordinatedEdge[] {
	const candidates: Candidate[] = [];
	edges.forEach((edge, edgeIndex) => {
		if (fixed.has(edge.id)) return;
		const points = edge.points;
		// Interior segments only: segment s runs from point s to point s + 1.
		for (let segment = 1; segment + 2 < points.length; segment += 1) {
			const a = points[segment] as Point;
			const b = points[segment + 1] as Point;
			const vertical = Math.abs(a.x - b.x) < EPSILON;
			const horizontal = Math.abs(a.y - b.y) < EPSILON;
			if (vertical === horizontal) continue;
			const at = vertical ? a.x : a.y;
			const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
			const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
			const bounds = channelBounds(walls, frames, vertical, at, lo, hi);
			if (bounds === undefined || bounds.high - bounds.low < minWidth) {
				continue;
			}
			candidates.push({ edgeIndex, segment, vertical, at, lo, hi, ...bounds });
		}
	});
	if (candidates.length === 0) return [...edges];

	// Segments sharing a channel whose spans overlap form one bank.
	const parent = candidates.map((_, index) => index);
	const find = (index: number): number => {
		let at = index;
		while (parent[at] !== at) at = parent[at] as number;
		return at;
	};
	for (let i = 0; i < candidates.length; i += 1) {
		const left = candidates[i] as Candidate;
		for (let j = i + 1; j < candidates.length; j += 1) {
			const right = candidates[j] as Candidate;
			if (
				left.vertical !== right.vertical ||
				Math.abs(left.low - right.low) > 0.5 ||
				Math.abs(left.high - right.high) > 0.5 ||
				Math.min(left.hi, right.hi) - Math.max(left.lo, right.lo) <= 0.5
			) {
				continue;
			}
			const a = find(i);
			const b = find(j);
			if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
		}
	}
	const banks = new Map<number, Candidate[]>();
	candidates.forEach((candidate, index) => {
		const root = find(index);
		banks.set(root, [...(banks.get(root) ?? []), candidate]);
	});

	const moved = edges.map((edge) => edge.points.map((point) => ({ ...point })));
	for (const bank of banks.values()) {
		const ordered = [...bank].sort(
			(left, right) =>
				left.at - right.at ||
				(edges[left.edgeIndex]?.id ?? "").localeCompare(
					edges[right.edgeIndex]?.id ?? "",
				) ||
				left.segment - right.segment,
		);
		const first = ordered[0] as Candidate;
		const pitch = (first.high - first.low) / (ordered.length + 1);
		ordered.forEach((candidate, rank) => {
			const coordinate = first.low + pitch * (rank + 1);
			const points = moved[candidate.edgeIndex] as Point[];
			for (const index of [candidate.segment, candidate.segment + 1]) {
				const point = points[index] as Point;
				if (candidate.vertical) point.x = coordinate;
				else point.y = coordinate;
			}
		});
	}
	return edges.map((edge, index) => {
		const points = moved[index] as Point[];
		const changed = points.some(
			(point, at) =>
				Math.abs(point.x - (edge.points[at]?.x ?? point.x)) > EPSILON ||
				Math.abs(point.y - (edge.points[at]?.y ?? point.y)) > EPSILON,
		);
		return changed ? { ...edge, points: simplifyRoute(points) } : edge;
	});
}

/** Channels narrower than this keep their segments where they are. */
const MIN_CHANNEL_WIDTH = 8;
const EPSILON = 1e-6;

interface Candidate {
	edgeIndex: number;
	segment: number;
	vertical: boolean;
	/** The segment's fixed coordinate (x when vertical). */
	at: number;
	lo: number;
	hi: number;
	/** The channel: nearest walls below and above `at`. */
	low: number;
	high: number;
}

/**
 * The free channel around a segment: the nearest wall on each side among
 * the boxes overlapping its span. A frame the segment runs inside bounds
 * it by its own sides; any other box is solid. Undefined when the segment
 * runs through a solid box or is open on a side (nothing to centre
 * between).
 */
function channelBounds(
	walls: readonly Box[],
	frames: readonly Box[],
	vertical: boolean,
	at: number,
	lo: number,
	hi: number,
): { low: number; high: number } | undefined {
	let low = Number.NEGATIVE_INFINITY;
	let high = Number.POSITIVE_INFINITY;
	const sides = (box: Box) => {
		const spanLo = vertical ? box.y : box.x;
		const spanHi = vertical ? box.y + box.height : box.x + box.width;
		if (Math.min(hi, spanHi) - Math.max(lo, spanLo) <= 0.5) return undefined;
		return vertical
			? { near: box.x, far: box.x + box.width }
			: { near: box.y, far: box.y + box.height };
	};
	for (const box of frames) {
		const side = sides(box);
		if (side === undefined) continue;
		if (side.far <= at + 0.5) low = Math.max(low, side.far);
		else if (side.near >= at - 0.5) high = Math.min(high, side.near);
		else {
			low = Math.max(low, side.near);
			high = Math.min(high, side.far);
		}
	}
	for (const box of walls) {
		const side = sides(box);
		if (side === undefined) continue;
		if (side.far <= at + 0.5) low = Math.max(low, side.far);
		else if (side.near >= at - 0.5) high = Math.min(high, side.near);
		else return undefined;
	}
	return Number.isFinite(low) && Number.isFinite(high)
		? { low, high }
		: undefined;
}
