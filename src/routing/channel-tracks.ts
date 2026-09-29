import { detectOrthogonalEdgeCrossings } from "../geometry/edge-crossings.js";
import type { CoordinatedEdge } from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";

export interface ChannelSegment {
	edgeId: string;
	segmentIndex: number;
	axis: "h" | "v";
	/** Fixed coordinate (y for horizontal, x for vertical). */
	coord: number;
	/** Interval start along the free axis. */
	start: number;
	/** Interval end along the free axis. */
	end: number;
}

export interface ChannelTrackAssignment {
	edgeId: string;
	segmentIndex: number;
	axis: "h" | "v";
	track: number;
	/** Nudged fixed coordinate after track * pitch. */
	coord: number;
}

export interface AssignChannelTracksResult {
	assignments: ChannelTrackAssignment[];
	capacityExhausted: boolean;
	maxTracksUsed: number;
}

const DEFAULT_MAX_TRACKS = 8;
/** Track pitch when none (or no usable one) is given. */
const DEFAULT_PITCH = 10;

/**
 * Extract axis-aligned interior segments and assign VLSI-style tracks via
 * Left-Edge / interval coloring (#86 / #88 / #92). MLCM path ordering is
 * deferred — this is greedy track coloring only.
 */
export function assignChannelTracks(
	edges: readonly CoordinatedEdge[],
	options: {
		idealNudgingDistance?: number;
		maxTracks?: number;
		hardObstacles?: readonly Box[];
	} = {},
): AssignChannelTracksResult {
	// A zero, negative or non-finite pitch would stack every track on one
	// coordinate: library callers get the default instead.
	const requested = options.idealNudgingDistance;
	const pitch =
		requested !== undefined && Number.isFinite(requested) && requested > 0
			? requested
			: DEFAULT_PITCH;
	const maxTracks = options.maxTracks ?? DEFAULT_MAX_TRACKS;
	const hardObstacles = options.hardObstacles ?? [];
	const segments = extractChannelSegments(edges);
	const groups = groupOverlappingSegments(segments);
	const assignments: ChannelTrackAssignment[] = [];
	let capacityExhausted = false;
	let maxTracksUsed = 0;

	for (const group of groups) {
		if (group.length < 2) continue;
		const ordered = [...group].sort(
			(left, right) =>
				left.start - right.start ||
				left.end - right.end ||
				left.edgeId.localeCompare(right.edgeId),
		);
		const trackEnds: number[] = [];
		const tracks: number[] = [];
		for (const segment of ordered) {
			let track = trackEnds.findIndex((end) => end <= segment.start + 1e-6);
			if (track < 0) {
				track = trackEnds.length;
				trackEnds.push(segment.end);
			} else {
				trackEnds[track] = segment.end;
			}
			if (track >= maxTracks) {
				capacityExhausted = true;
				track = maxTracks - 1;
			}
			tracks.push(track);
		}
		// Centre this group's tracks on the channel it came from.
		const used = Math.min(maxTracks, trackEnds.length);
		maxTracksUsed = Math.max(maxTracksUsed, used);
		const center =
			group.reduce((sum, item) => sum + item.coord, 0) / group.length;
		const coordOf = (index: number, shift: number) =>
			center + ((tracks[index] ?? 0) - (used - 1) / 2 + shift) * pitch;
		// A bank centred beside a one-sided blocker pushes a track into it
		// (and that route back onto the channel): shift the whole bank by
		// whole pitches, up to its own width, to the offset with the fewest
		// tracks on a hard obstacle, the centred one on a tie.
		const blocked = (shift: number) =>
			ordered.filter((segment, index) => {
				const at = coordOf(index, shift);
				const a =
					segment.axis === "h"
						? { x: segment.start, y: at }
						: { x: at, y: segment.start };
				const b =
					segment.axis === "h"
						? { x: segment.end, y: at }
						: { x: at, y: segment.end };
				return hardObstacles.some((box) => segmentHitsBox(a, b, box));
			}).length;
		let shift = 0;
		if (hardObstacles.length > 0) {
			let fewest = blocked(0);
			for (let step = 1; step <= used && fewest > 0; step += 1) {
				for (const candidate of [-step, step]) {
					const count = blocked(candidate);
					if (count < fewest) {
						fewest = count;
						shift = candidate;
					}
				}
			}
		}
		ordered.forEach((segment, index) => {
			const track = tracks[index] ?? 0;
			assignments.push({
				edgeId: segment.edgeId,
				segmentIndex: segment.segmentIndex,
				axis: segment.axis,
				track,
				coord: coordOf(index, shift),
			});
		});
	}

	return { assignments, capacityExhausted, maxTracksUsed };
}

export function extractChannelSegments(
	edges: readonly CoordinatedEdge[],
): ChannelSegment[] {
	const segments: ChannelSegment[] = [];
	for (const edge of edges) {
		if (edge.points.length < 2) continue;
		// Interior segments only: moving an end segment would pull the
		// endpoint off its slot (or leave a jog along the node border).
		for (let i = 1; i < edge.points.length - 2; i += 1) {
			const a = edge.points[i];
			const b = edge.points[i + 1];
			if (a === undefined || b === undefined) continue;
			const horizontal = Math.abs(a.y - b.y) < 1e-6;
			const vertical = Math.abs(a.x - b.x) < 1e-6;
			if (!horizontal && !vertical) continue;
			const length = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
			if (length < 8) continue;
			if (horizontal) {
				segments.push({
					edgeId: edge.id,
					segmentIndex: i,
					axis: "h",
					coord: a.y,
					start: Math.min(a.x, b.x),
					end: Math.max(a.x, b.x),
				});
			} else {
				segments.push({
					edgeId: edge.id,
					segmentIndex: i,
					axis: "v",
					coord: a.x,
					start: Math.min(a.y, b.y),
					end: Math.max(a.y, b.y),
				});
			}
		}
	}
	return segments;
}

/** Parallel segments this close (px) share a channel. */
const CHANNEL_TOLERANCE = 4;

function groupOverlappingSegments(
	segments: readonly ChannelSegment[],
): ChannelSegment[][] {
	// Near-coincident channels: per axis, coordinates chained within
	// CHANNEL_TOLERANCE of each other (by distance, so 1.9 and 2.1 group
	// together however they round).
	const byAxis = new Map<string, ChannelSegment[]>();
	for (const axis of ["h", "v"] as const) {
		const sorted = segments
			.filter((segment) => segment.axis === axis)
			.sort(
				(left, right) =>
					left.coord - right.coord ||
					left.edgeId.localeCompare(right.edgeId) ||
					left.segmentIndex - right.segmentIndex,
			);
		let cluster = 0;
		let previous: number | undefined;
		for (const segment of sorted) {
			if (
				previous !== undefined &&
				segment.coord - previous > CHANNEL_TOLERANCE
			) {
				cluster += 1;
			}
			previous = segment.coord;
			const key = `${axis}:${cluster}`;
			const bucket = byAxis.get(key) ?? [];
			bucket.push(segment);
			byAxis.set(key, bucket);
		}
	}
	// Overlap components per bucket: sweep by start and extend the current
	// group while the next interval starts before its furthest end, so
	// intervals joined only through a bridge land in one group.
	const groups: ChannelSegment[][] = [];
	for (const bucket of byAxis.values()) {
		const sorted = [...bucket].sort(
			(left, right) =>
				left.start - right.start ||
				left.end - right.end ||
				left.edgeId.localeCompare(right.edgeId) ||
				left.segmentIndex - right.segmentIndex,
		);
		let group: ChannelSegment[] = [];
		let groupEnd = Number.NEGATIVE_INFINITY;
		for (const segment of sorted) {
			if (group.length > 0 && segment.start < groupEnd - 1e-6) {
				group.push(segment);
				groupEnd = Math.max(groupEnd, segment.end);
				continue;
			}
			if (group.length > 0) groups.push(group);
			group = [segment];
			groupEnd = segment.end;
		}
		if (group.length > 0) groups.push(group);
	}
	return groups;
}

/** Apply track coordinates to edge polylines (interior vertices only). */
export function applyChannelTrackAssignments(
	edges: readonly CoordinatedEdge[],
	assignments: readonly ChannelTrackAssignment[],
	hardObstacles: readonly Box[] = [],
	/**
	 * Unexpanded node outlines. Hard obstacles may be node boxes grown by a
	 * margin or gutter, which contain their own route ends; a moved track
	 * is kept out of its end nodes' real outlines instead.
	 */
	nodeOutlines?: readonly Box[],
): CoordinatedEdge[] {
	const byEdge = new Map<string, ChannelTrackAssignment[]>();
	for (const assignment of assignments) {
		const list = byEdge.get(assignment.edgeId) ?? [];
		list.push(assignment);
		byEdge.set(assignment.edgeId, list);
	}
	return edges.map((edge) => {
		const edgeAssignments = byEdge.get(edge.id);
		if (edgeAssignments === undefined || edge.points.length < 2) {
			return edge;
		}
		const points = edge.points.map((point) => ({ ...point }));
		for (const assignment of edgeAssignments) {
			const a = points[assignment.segmentIndex];
			const b = points[assignment.segmentIndex + 1];
			if (a === undefined || b === undefined) continue;
			if (assignment.axis === "h") {
				a.y = assignment.coord;
				b.y = assignment.coord;
			} else {
				a.x = assignment.coord;
				b.x = assignment.coord;
			}
		}
		// Keep true endpoints fixed.
		const first = edge.points[0];
		const last = edge.points[edge.points.length - 1];
		if (first !== undefined) {
			points[0] = { ...first };
		}
		if (last !== undefined) {
			points[points.length - 1] = { ...last };
		}
		// The edge's own end nodes are not in its way, but it may not cut
		// through them either.
		const atEnd = (box: Box) =>
			(first !== undefined && touchesBox(first, box)) ||
			(last !== undefined && touchesBox(last, box));
		const endBoxes = hardObstacles.filter(atEnd);
		if (
			routeHitsHard(
				points,
				hardObstacles.filter((box) => !endBoxes.includes(box)),
			) ||
			routeEntersInterior(points, nodeOutlines?.filter(atEnd) ?? endBoxes)
		) {
			return edge;
		}
		return { ...edge, points };
	});
}

/**
 * Channel tracks are assigned as a group, but a nudged route can still be
 * rolled back on its own (a hard obstacle, or a new obstacle hit), onto the
 * coordinate another route was just moved to. Undo every move that leaves
 * its route more coincident (its interior segments on one line with any
 * segment of another route, spans overlapping) than before, until none
 * does, and say whether such coincident segments remain.
 */
export function revertCoincidentMoves(
	original: readonly CoordinatedEdge[],
	moved: readonly CoordinatedEdge[],
): { edges: CoordinatedEdge[]; overlapping: boolean } {
	const result = moved.map((edge, index) => edge ?? original[index]);
	const interior = (edge: CoordinatedEdge): ChannelSegment[] =>
		channelSegmentsOf(edge).filter(
			(segment) =>
				segment.segmentIndex > 0 &&
				segment.segmentIndex < edge.points.length - 2,
		);
	const coincidence = (edge: CoordinatedEdge, skip: number): number => {
		let total = 0;
		const own = interior(edge);
		result.forEach((other, index) => {
			if (index === skip || other === undefined) return;
			// The moved edge's interior against every segment of the others,
			// end stubs included: a track moved onto another route's stub
			// overlaps it just the same.
			const others = channelSegmentsOf(other);
			for (const segment of own) {
				for (const theirs of others) {
					if (theirs.axis !== segment.axis) continue;
					if (Math.abs(theirs.coord - segment.coord) >= 0.5) continue;
					total += Math.max(
						0,
						Math.min(segment.end, theirs.end) -
							Math.max(segment.start, theirs.start),
					);
				}
			}
		});
		return total;
	};
	for (let changed = true; changed; ) {
		changed = false;
		result.forEach((edge, index) => {
			const before = original[index];
			if (edge === undefined || before === undefined) return;
			if (edge.points === before.points) return;
			if (coincidence(edge, index) > coincidence(before, index) + 1e-6) {
				result[index] = before;
				changed = true;
			}
		});
	}
	const overlapping = result.some(
		(edge, index) => edge !== undefined && coincidence(edge, index) > 1e-6,
	);
	return { edges: result as CoordinatedEdge[], overlapping };
}

/**
 * A nudged track stretches its neighbouring segments, which can carry them
 * across other routes. Undo every move that leaves its route crossing the
 * current routes more often than it crossed the original ones in place,
 * one at a time (the first offender), until none does.
 */
export function revertCrossingMoves(
	original: readonly CoordinatedEdge[],
	moved: readonly CoordinatedEdge[],
): CoordinatedEdge[] {
	const crossingCount = (
		edge: CoordinatedEdge,
		others: readonly CoordinatedEdge[],
	): number =>
		detectOrthogonalEdgeCrossings([edge, ...others]).filter(
			(crossing) =>
				crossing.underEdgeId === edge.id || crossing.overEdgeId === edge.id,
		).length;
	let result: (CoordinatedEdge | undefined)[] = moved.map(
		(edge, index) => edge ?? original[index],
	);
	for (let pass = 0; pass < result.length; pass += 1) {
		const offender = result.findIndex((edge, index) => {
			const before = original[index];
			if (edge === undefined || before === undefined) return false;
			if (edge.points === before.points) return false;
			const others = result.filter(
				(other, at): other is CoordinatedEdge =>
					at !== index && other !== undefined,
			);
			// Against the untouched routes: two moves that only cross each
			// other would each look no worse against the other's new line.
			const originals = original.filter(
				(other, at): other is CoordinatedEdge =>
					at !== index && other !== undefined,
			);
			return crossingCount(edge, others) > crossingCount(before, originals);
		});
		if (offender < 0) break;
		result = result.map((edge, index) =>
			index === offender ? original[index] : edge,
		);
	}
	return result as CoordinatedEdge[];
}

/** Axis-aligned segments of one route, as channel intervals. */
/**
 * Total length of `route`'s segments lying on one line with a segment of
 * `others` (within 0.5px), spans overlapping: connector strokes drawn on
 * top of each other.
 */
export function collinearOverlapLength(
	route: readonly Point[],
	others: readonly CoordinatedEdge[],
): number {
	const own = segmentsOf("", route);
	let total = 0;
	for (const other of others) {
		for (const theirs of channelSegmentsOf(other)) {
			for (const segment of own) {
				if (theirs.axis !== segment.axis) continue;
				if (Math.abs(theirs.coord - segment.coord) >= 0.5) continue;
				total += Math.max(
					0,
					Math.min(segment.end, theirs.end) -
						Math.max(segment.start, theirs.start),
				);
			}
		}
	}
	return total;
}

function channelSegmentsOf(edge: CoordinatedEdge): ChannelSegment[] {
	return segmentsOf(edge.id, edge.points);
}

function segmentsOf(
	edgeId: string,
	points: readonly Point[],
): ChannelSegment[] {
	const segments: ChannelSegment[] = [];
	for (let index = 0; index + 1 < points.length; index += 1) {
		const a = points[index] as Point;
		const b = points[index + 1] as Point;
		if (Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 1e-6) {
			segments.push({
				edgeId,
				segmentIndex: index,
				axis: "h",
				coord: a.y,
				start: Math.min(a.x, b.x),
				end: Math.max(a.x, b.x),
			});
		} else if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
			segments.push({
				edgeId,
				segmentIndex: index,
				axis: "v",
				coord: a.x,
				start: Math.min(a.y, b.y),
				end: Math.max(a.y, b.y),
			});
		}
	}
	return segments;
}

function touchesBox(point: Point, box: Box): boolean {
	return (
		point.x >= box.x - 0.5 &&
		point.x <= box.x + box.width + 0.5 &&
		point.y >= box.y - 0.5 &&
		point.y <= box.y + box.height + 0.5
	);
}

/** A segment passes through the inside of a box (touching is fine). */
function routeEntersInterior(
	points: readonly Point[],
	boxes: readonly Box[],
): boolean {
	for (let i = 0; i < points.length - 1; i += 1) {
		const a = points[i];
		const b = points[i + 1];
		if (a === undefined || b === undefined) continue;
		for (const box of boxes) {
			if (
				Math.max(a.x, b.x) > box.x + 0.5 &&
				Math.min(a.x, b.x) < box.x + box.width - 0.5 &&
				Math.max(a.y, b.y) > box.y + 0.5 &&
				Math.min(a.y, b.y) < box.y + box.height - 0.5
			) {
				return true;
			}
		}
	}
	return false;
}

function routeHitsHard(
	points: readonly Point[],
	obstacles: readonly Box[],
): boolean {
	for (let i = 0; i < points.length - 1; i += 1) {
		const a = points[i];
		const b = points[i + 1];
		if (a === undefined || b === undefined) continue;
		for (const box of obstacles) {
			if (segmentHitsBox(a, b, box)) {
				return true;
			}
		}
	}
	return false;
}

function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
	const minX = Math.min(a.x, b.x);
	const maxX = Math.max(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	const maxY = Math.max(a.y, b.y);
	return !(
		maxX < box.x ||
		minX > box.x + box.width ||
		maxY < box.y ||
		minY > box.y + box.height
	);
}
