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

/**
 * Extract axis-aligned interior segments and assign VLSI-style tracks via
 * Left-Edge / interval coloring (#86 / #88).
 */
export function assignChannelTracks(
	edges: readonly CoordinatedEdge[],
	options: {
		idealNudgingDistance?: number;
		maxTracks?: number;
		hardObstacles?: readonly Box[];
	} = {},
): AssignChannelTracksResult {
	const pitch = options.idealNudgingDistance ?? 10;
	const maxTracks = options.maxTracks ?? DEFAULT_MAX_TRACKS;
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
			maxTracksUsed = Math.max(maxTracksUsed, track + 1);
			const center =
				group.reduce((sum, item) => sum + item.coord, 0) / group.length;
			const coord = center + (track - (maxTracksUsed - 1) / 2) * pitch;
			assignments.push({
				edgeId: segment.edgeId,
				segmentIndex: segment.segmentIndex,
				axis: segment.axis,
				track,
				coord,
			});
		}
	}

	return { assignments, capacityExhausted, maxTracksUsed };
}

export function extractChannelSegments(
	edges: readonly CoordinatedEdge[],
): ChannelSegment[] {
	const segments: ChannelSegment[] = [];
	for (const edge of edges) {
		if (edge.points.length < 2) continue;
		for (let i = 0; i < edge.points.length - 1; i += 1) {
			const a = edge.points[i];
			const b = edge.points[i + 1];
			if (a === undefined || b === undefined) continue;
			// Skip stubs attached to endpoints (first/last) for track grouping
			// only when they are short escape stubs — keep mid spans.
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

function groupOverlappingSegments(
	segments: readonly ChannelSegment[],
): ChannelSegment[][] {
	const byAxis = new Map<string, ChannelSegment[]>();
	for (const segment of segments) {
		const bucketKey = `${segment.axis}:${Math.round(segment.coord / 4)}`;
		const bucket = byAxis.get(bucketKey) ?? [];
		bucket.push(segment);
		byAxis.set(bucketKey, bucket);
	}
	const groups: ChannelSegment[][] = [];
	for (const bucket of byAxis.values()) {
		const remaining = [...bucket].sort(
			(left, right) => left.start - right.start || left.end - right.end,
		);
		while (remaining.length > 0) {
			const seed = remaining.shift();
			if (seed === undefined) break;
			const group = [seed];
			for (let i = remaining.length - 1; i >= 0; i -= 1) {
				const candidate = remaining[i];
				if (candidate === undefined) continue;
				if (
					intervalsOverlap(
						seed.start,
						seed.end,
						candidate.start,
						candidate.end,
					) ||
					group.some((member) =>
						intervalsOverlap(
							member.start,
							member.end,
							candidate.start,
							candidate.end,
						),
					)
				) {
					group.push(candidate);
					remaining.splice(i, 1);
				}
			}
			groups.push(group);
		}
	}
	return groups;
}

function intervalsOverlap(
	a0: number,
	a1: number,
	b0: number,
	b1: number,
): boolean {
	return a0 < b1 - 1e-6 && b0 < a1 - 1e-6;
}

/** Apply track coordinates to edge polylines (interior vertices only). */
export function applyChannelTrackAssignments(
	edges: readonly CoordinatedEdge[],
	assignments: readonly ChannelTrackAssignment[],
	hardObstacles: readonly Box[] = [],
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
		if (routeHitsHard(points, hardObstacles)) {
			return edge;
		}
		return { ...edge, points };
	});
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
