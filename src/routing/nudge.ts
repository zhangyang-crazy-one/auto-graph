import type { Box, Point } from "../ir/geometry.js";

/**
 * Orthogonal edge separation ("nudging").
 *
 * Routers in this package solve one edge at a time, so independently
 * routed edges frequently share the same corridor coordinate: fan-out
 * trunks collapse onto one vertical line and it becomes impossible to tell
 * which edge goes where. This pass runs after all edges are routed and
 * spreads collinear, overlapping interior segments into evenly spaced
 * parallel tracks inside the free channel around them.
 *
 * Guarantees:
 * - Route endpoints (and the first/last segment, which attach to ports)
 *   never move.
 * - A segment only moves inside the channel bounded by the nearest
 *   obstacles on each side, and never so far that an adjacent segment
 *   would reverse direction.
 * - Track order inside a bundle minimises edge–edge crossings (exhaustive
 *   for small bundles, adjacent-swap descent for large ones).
 * - A bundle move that makes any member cross more obstacles is reverted.
 * - Deterministic: ties break on route order / id.
 */

export interface SeparableRoute {
	id: string;
	points: readonly Point[];
	/** Fixed routes (e.g. allocated rails) are never moved but still count for crossings. */
	fixed?: boolean;
}

export interface EdgeSeparationOptions {
	/** Desired gap between parallel tracks (default 12). */
	spacing?: number;
	/** Desired clearance between a track and an obstacle (default 10). */
	clearance?: number;
	/** Minimum stub length kept at route endpoints (default 10). */
	minStub?: number;
	/** Vertical/horizontal alternation passes (default 2). */
	maxPasses?: number;
}

type Orientation = "v" | "h";

interface MovableSegment {
	routeIndex: number;
	/** Index of the segment's first point; the segment is points[index]→points[index+1]. */
	index: number;
	orientation: Orientation;
	coord: number;
	min: number;
	max: number;
}

const EPSILON = 0.5;
const EXHAUSTIVE_BUNDLE_LIMIT = 5;
/** Smallest obstacle clearance used when a channel is tight. */
const MIN_CLEARANCE = 2;

export function separateParallelSegments(
	routes: readonly SeparableRoute[],
	obstacles: readonly Box[],
	options: EdgeSeparationOptions = {},
): Point[][] {
	const spacing = Math.max(2, options.spacing ?? 12);
	const clearance = Math.max(0, options.clearance ?? 10);
	const minStub = Math.max(1, options.minStub ?? 10);
	const maxPasses = Math.max(1, options.maxPasses ?? 2);
	const points = routes.map((route) => compact(route.points));
	const movable = routes.map(
		(route, index) => route.fixed !== true && isOrthogonal(points[index] ?? []),
	);

	for (let pass = 0; pass < maxPasses; pass += 1) {
		let moved = false;
		for (const orientation of ["v", "h"] as const) {
			const segments = collectMovableSegments(points, movable, orientation);
			for (const cluster of clusterSegments(segments, spacing)) {
				// Re-read coordinates: earlier clusters in this pass may have
				// shifted neighbouring segments of the same route.
				const members = cluster
					.map((segment) => refreshSegment(points, segment))
					.filter(
						(segment): segment is MovableSegment => segment !== undefined,
					);
				if (members.length < 2) continue;
				if (
					applyBundle(members, points, obstacles, {
						spacing,
						clearance,
						minStub,
					})
				) {
					moved = true;
				}
			}
		}
		if (!moved) break;
	}

	escapeObstacles(points, movable, obstacles, { clearance, minStub }, routes);

	return points.map((route) => compact(route));
}

/**
 * A lone interior segment that clips an obstacle (the router kept its
 * least-bad candidate) is shifted just past the nearer obstacle edge when
 * that lowers the route's obstacle hits without reversing its neighbours.
 * Bundles never trigger this; it only repairs single grazes.
 */
function escapeObstacles(
	points: Point[][],
	movable: readonly boolean[],
	obstacles: readonly Box[],
	config: { clearance: number; minStub: number },
	routes: readonly SeparableRoute[],
): void {
	for (let routeIndex = 0; routeIndex < points.length; routeIndex += 1) {
		if (movable[routeIndex] !== true) continue;
		const route = points[routeIndex] ?? [];
		for (let index = 1; index <= route.length - 3; index += 1) {
			const segment = describeSegment(routeIndex, index, route);
			if (segment === undefined) continue;
			const start = route[index];
			const end = route[index + 1];
			if (start === undefined || end === undefined) continue;
			const hits = obstacles.filter((box) =>
				segmentEntersBoxInterior(start, end, box),
			);
			if (hits.length === 0) continue;
			const vertical = segment.orientation === "v";
			const [minCoord, maxCoord] = neighbourBounds(
				segment,
				route,
				config.minStub,
			);
			const before = countObstacleHits(route, obstacles);
			// Escape candidates just past either side of every obstacle hit,
			// nearest first; the first one that lowers the hit count wins.
			const candidates = [
				...new Set(
					hits.flatMap((box) => {
						const low = vertical ? box.x : box.y;
						const high = vertical ? box.x + box.width : box.y + box.height;
						return [low - config.clearance, high + config.clearance];
					}),
				),
			]
				.filter((coord) => coord > minCoord && coord < maxCoord)
				.sort(
					(a, b) =>
						Math.abs(a - segment.coord) - Math.abs(b - segment.coord) || a - b,
				);
			for (const coord of candidates) {
				const trial = route.map((point) => ({ ...point }));
				const a = trial[index];
				const b = trial[index + 1];
				if (a === undefined || b === undefined) continue;
				if (vertical) {
					a.x = coord;
					b.x = coord;
				} else {
					a.y = coord;
					b.y = coord;
				}
				if (countObstacleHits(trial, obstacles) >= before) continue;
				// Do not trade an obstacle graze for stacking on another edge.
				// (A new crossing is fine: it renders as a hop, while passing
				// through a node is a hard violation.)
				const overlapsOther = points.some(
					(other, otherIndex) =>
						otherIndex !== routeIndex &&
						routes[otherIndex] !== undefined &&
						countOverlaps(trial, other) > countOverlaps(route, other),
				);
				if (overlapsOther) continue;
				points[routeIndex] = trial;
				break;
			}
		}
	}
}

/** Coordinate range that keeps both neighbouring segments' directions. */
function neighbourBounds(
	segment: MovableSegment,
	route: readonly Point[],
	minStub: number,
): [number, number] {
	let low = Number.NEGATIVE_INFINITY;
	let high = Number.POSITIVE_INFINITY;
	const vertical = segment.orientation === "v";
	const lastIndex = route.length - 1;
	for (const [point, endpoint] of [
		[route[segment.index - 1], segment.index - 1 === 0],
		[route[segment.index + 2], segment.index + 2 === lastIndex],
	] as const) {
		if (point === undefined) continue;
		const coord = vertical ? point.x : point.y;
		const gap = endpoint ? minStub : 1;
		if (coord < segment.coord) low = Math.max(low, coord + gap);
		else if (coord > segment.coord) high = Math.min(high, coord - gap);
	}
	return [low, high];
}

function applyBundle(
	members: MovableSegment[],
	points: Point[][],
	obstacles: readonly Box[],
	config: { spacing: number; clearance: number; minStub: number },
): boolean {
	const count = members.length;
	// Clearance to obstacles is soft: prefer the configured value, but shrink
	// it when the free channel is too narrow for the bundle.
	const bundleChannel = (clearance: number): [number, number] => {
		let channelLow = Number.NEGATIVE_INFINITY;
		let channelHigh = Number.POSITIVE_INFINITY;
		for (const member of members) {
			const [memberLow, memberHigh] = segmentChannel(
				member,
				points,
				obstacles,
				{
					...config,
					clearance,
				},
			);
			channelLow = Math.max(channelLow, memberLow);
			channelHigh = Math.min(channelHigh, memberHigh);
		}
		return [channelLow, channelHigh];
	};
	const needed = (count - 1) * config.spacing;
	let [low, high] = bundleChannel(config.clearance);
	for (const clearance of [config.clearance / 2, MIN_CLEARANCE]) {
		if (high - low >= needed) break;
		[low, high] = bundleChannel(Math.min(config.clearance, clearance));
	}
	if (!(low <= high)) return false;

	let spacing = config.spacing;
	const width = high - low;
	if (Number.isFinite(width) && (count - 1) * spacing > width) {
		spacing = width / (count - 1);
	}
	if (spacing < 3) return false;
	const total = (count - 1) * spacing;
	const mean =
		members.reduce((sum, member) => sum + member.coord, 0) / Math.max(1, count);
	const center = clamp(mean, low + total / 2, high - total / 2);
	const slots = Array.from(
		{ length: count },
		(_, index) => center - total / 2 + index * spacing,
	);

	const memberRouteIndexes = [
		...new Set(members.map((member) => member.routeIndex)),
	].sort((a, b) => a - b);
	const obstacleHitsBefore = new Map(
		memberRouteIndexes.map((routeIndex) => [
			routeIndex,
			countObstacleHits(points[routeIndex] ?? [], obstacles),
		]),
	);

	const evaluate = (order: readonly number[]): number => {
		const trial = applyOrder(points, members, order, slots);
		let crossings = 0;
		for (const routeIndex of memberRouteIndexes) {
			const route = trial.get(routeIndex) ?? points[routeIndex] ?? [];
			for (let other = 0; other < points.length; other += 1) {
				if (other === routeIndex) continue;
				// Count each member pair once.
				if (trial.has(other) && other < routeIndex) continue;
				const otherRoute = trial.get(other) ?? points[other] ?? [];
				crossings += countConflicts(route, otherRoute);
			}
		}
		let displacement = 0;
		for (let index = 0; index < order.length; index += 1) {
			const member = members[order[index] ?? 0];
			const slot = slots[index];
			if (member !== undefined && slot !== undefined) {
				displacement += Math.abs(member.coord - slot);
			}
		}
		return crossings * 1_000_000 + displacement;
	};

	const initial = members
		.map((member, index) => ({ member, index }))
		.sort(
			(a, b) =>
				a.member.coord - b.member.coord ||
				a.member.routeIndex - b.member.routeIndex ||
				a.member.index - b.member.index,
		)
		.map((entry) => entry.index);
	const best =
		count <= EXHAUSTIVE_BUNDLE_LIMIT
			? bestPermutation(initial, evaluate)
			: adjacentSwapDescent(initial, evaluate);

	const trial = applyOrder(points, members, best, slots);
	for (const [routeIndex, route] of trial) {
		const before = obstacleHitsBefore.get(routeIndex) ?? 0;
		if (countObstacleHits(route, obstacles) > before) {
			return false;
		}
	}
	let changed = false;
	for (const [routeIndex, route] of trial) {
		const previous = points[routeIndex];
		if (previous !== undefined && !samePoints(previous, route)) {
			changed = true;
		}
		points[routeIndex] = route;
	}
	return changed;
}

function applyOrder(
	points: readonly Point[][],
	members: readonly MovableSegment[],
	order: readonly number[],
	slots: readonly number[],
): Map<number, Point[]> {
	const trial = new Map<number, Point[]>();
	for (let slotIndex = 0; slotIndex < order.length; slotIndex += 1) {
		const member = members[order[slotIndex] ?? 0];
		const slot = slots[slotIndex];
		if (member === undefined || slot === undefined) continue;
		const route =
			trial.get(member.routeIndex) ??
			(points[member.routeIndex] ?? []).map((point) => ({ ...point }));
		const start = route[member.index];
		const end = route[member.index + 1];
		if (start === undefined || end === undefined) continue;
		if (member.orientation === "v") {
			start.x = slot;
			end.x = slot;
		} else {
			start.y = slot;
			end.y = slot;
		}
		trial.set(member.routeIndex, route);
	}
	return trial;
}

function bestPermutation(
	initial: readonly number[],
	evaluate: (order: readonly number[]) => number,
): number[] {
	let best = [...initial];
	let bestScore = evaluate(best);
	const current = [...initial];
	const used = new Array<boolean>(initial.length).fill(false);
	const order: number[] = [];
	const visit = (): void => {
		if (order.length === current.length) {
			const score = evaluate(order);
			if (score < bestScore - 1e-9) {
				bestScore = score;
				best = [...order];
			}
			return;
		}
		for (let index = 0; index < current.length; index += 1) {
			if (used[index]) continue;
			used[index] = true;
			order.push(current[index] ?? 0);
			visit();
			order.pop();
			used[index] = false;
		}
	};
	visit();
	return best;
}

function adjacentSwapDescent(
	initial: readonly number[],
	evaluate: (order: readonly number[]) => number,
): number[] {
	const order = [...initial];
	let score = evaluate(order);
	for (let round = 0; round < order.length * order.length; round += 1) {
		let improved = false;
		for (let index = 0; index + 1 < order.length; index += 1) {
			const swapped = [...order];
			const left = swapped[index] ?? 0;
			swapped[index] = swapped[index + 1] ?? 0;
			swapped[index + 1] = left;
			const swappedScore = evaluate(swapped);
			if (swappedScore < score - 1e-9) {
				order.splice(0, order.length, ...swapped);
				score = swappedScore;
				improved = true;
			}
		}
		if (!improved) break;
	}
	return order;
}

/**
 * Free coordinate range for a segment: bounded by the nearest obstacles on
 * either side that overlap its span, and by the adjacent segments so they
 * keep their direction (and endpoint stubs keep `minStub`).
 */
function segmentChannel(
	segment: MovableSegment,
	points: readonly Point[][],
	obstacles: readonly Box[],
	config: { clearance: number; minStub: number },
): [number, number] {
	const { coord, min, max } = segment;
	let low = Number.NEGATIVE_INFINITY;
	let high = Number.POSITIVE_INFINITY;
	const vertical = segment.orientation === "v";
	for (const box of obstacles) {
		const alongMin = vertical ? box.y : box.x;
		const alongMax = vertical ? box.y + box.height : box.x + box.width;
		if (alongMin > max || alongMax < min) continue;
		const crossMin = vertical ? box.x : box.y;
		const crossMax = vertical ? box.x + box.width : box.y + box.height;
		if (crossMax <= coord + EPSILON) {
			low = Math.max(low, Math.min(crossMax + config.clearance, coord));
		} else if (crossMin >= coord - EPSILON) {
			high = Math.min(high, Math.max(crossMin - config.clearance, coord));
		}
	}

	const route = points[segment.routeIndex] ?? [];
	const lastIndex = route.length - 1;
	const neighbours: Array<{ point: Point | undefined; endpoint: boolean }> = [
		{ point: route[segment.index - 1], endpoint: segment.index - 1 === 0 },
		{
			point: route[segment.index + 2],
			endpoint: segment.index + 2 === lastIndex,
		},
	];
	for (const { point, endpoint } of neighbours) {
		if (point === undefined) continue;
		const neighbourCoord = vertical ? point.x : point.y;
		const gap = endpoint ? config.minStub : 1;
		if (neighbourCoord < coord) {
			low = Math.max(low, Math.min(neighbourCoord + gap, coord));
		} else if (neighbourCoord > coord) {
			high = Math.min(high, Math.max(neighbourCoord - gap, coord));
		}
	}
	return [low, high];
}

function collectMovableSegments(
	points: readonly Point[][],
	movable: readonly boolean[],
	orientation: Orientation,
): MovableSegment[] {
	const segments: MovableSegment[] = [];
	for (let routeIndex = 0; routeIndex < points.length; routeIndex += 1) {
		if (movable[routeIndex] !== true) continue;
		const route = points[routeIndex] ?? [];
		// Skip the first and last segment: they attach to ports.
		for (let index = 1; index <= route.length - 3; index += 1) {
			const segment = describeSegment(routeIndex, index, route);
			if (segment !== undefined && segment.orientation === orientation) {
				segments.push(segment);
			}
		}
	}
	return segments;
}

function refreshSegment(
	points: readonly Point[][],
	segment: MovableSegment,
): MovableSegment | undefined {
	const route = points[segment.routeIndex] ?? [];
	const refreshed = describeSegment(segment.routeIndex, segment.index, route);
	if (
		refreshed === undefined ||
		refreshed.orientation !== segment.orientation
	) {
		return undefined;
	}
	return refreshed;
}

function describeSegment(
	routeIndex: number,
	index: number,
	route: readonly Point[],
): MovableSegment | undefined {
	const start = route[index];
	const end = route[index + 1];
	if (start === undefined || end === undefined) return undefined;
	const dx = Math.abs(end.x - start.x);
	const dy = Math.abs(end.y - start.y);
	if (dx < EPSILON && dy >= EPSILON) {
		return {
			routeIndex,
			index,
			orientation: "v",
			coord: start.x,
			min: Math.min(start.y, end.y),
			max: Math.max(start.y, end.y),
		};
	}
	if (dy < EPSILON && dx >= EPSILON) {
		return {
			routeIndex,
			index,
			orientation: "h",
			coord: start.y,
			min: Math.min(start.x, end.x),
			max: Math.max(start.x, end.x),
		};
	}
	return undefined;
}

/**
 * Group parallel segments that sit closer than `spacing` and share part of
 * their span (transitively). Only clusters with at least two distinct routes
 * are returned, in deterministic order.
 */
function clusterSegments(
	segments: readonly MovableSegment[],
	spacing: number,
): MovableSegment[][] {
	const sorted = [...segments].sort(
		(a, b) =>
			a.coord - b.coord ||
			a.min - b.min ||
			a.routeIndex - b.routeIndex ||
			a.index - b.index,
	);
	const parent = sorted.map((_, index) => index);
	const find = (index: number): number => {
		let root = index;
		while (parent[root] !== root) root = parent[root] ?? root;
		let cursor = index;
		while (parent[cursor] !== root) {
			const next = parent[cursor] ?? root;
			parent[cursor] = root;
			cursor = next;
		}
		return root;
	};
	for (let i = 0; i < sorted.length; i += 1) {
		const a = sorted[i];
		if (a === undefined) continue;
		for (let j = i + 1; j < sorted.length; j += 1) {
			const b = sorted[j];
			if (b === undefined) continue;
			if (b.coord - a.coord >= spacing - EPSILON) break;
			if (a.routeIndex === b.routeIndex) continue;
			const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min);
			if (overlap <= EPSILON) continue;
			const rootA = find(i);
			const rootB = find(j);
			if (rootA !== rootB)
				parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
		}
	}
	const groups = new Map<number, MovableSegment[]>();
	for (let index = 0; index < sorted.length; index += 1) {
		const segment = sorted[index];
		if (segment === undefined) continue;
		const root = find(index);
		const group = groups.get(root) ?? [];
		group.push(segment);
		groups.set(root, group);
	}
	return [...groups.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, group]) => group)
		.filter(
			(group) => new Set(group.map((segment) => segment.routeIndex)).size > 1,
		);
}

/** Proper crossings plus collinear overlaps between two orthogonal polylines. */
function countConflicts(a: readonly Point[], b: readonly Point[]): number {
	let conflicts = 0;
	for (let i = 0; i + 1 < a.length; i += 1) {
		const a0 = a[i];
		const a1 = a[i + 1];
		if (a0 === undefined || a1 === undefined) continue;
		for (let j = 0; j + 1 < b.length; j += 1) {
			const b0 = b[j];
			const b1 = b[j + 1];
			if (b0 === undefined || b1 === undefined) continue;
			if (segmentsCross(a0, a1, b0, b1) || segmentsOverlap(a0, a1, b0, b1)) {
				conflicts += 1;
			}
		}
	}
	return conflicts;
}

/** Collinear overlaps (stacked runs) between two orthogonal polylines. */
function countOverlaps(a: readonly Point[], b: readonly Point[]): number {
	let overlaps = 0;
	for (let i = 0; i + 1 < a.length; i += 1) {
		const a0 = a[i];
		const a1 = a[i + 1];
		if (a0 === undefined || a1 === undefined) continue;
		for (let j = 0; j + 1 < b.length; j += 1) {
			const b0 = b[j];
			const b1 = b[j + 1];
			if (b0 === undefined || b1 === undefined) continue;
			if (segmentsOverlap(a0, a1, b0, b1)) overlaps += 1;
		}
	}
	return overlaps;
}

function segmentsCross(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
	const aVertical = Math.abs(a0.x - a1.x) < EPSILON;
	const bVertical = Math.abs(b0.x - b1.x) < EPSILON;
	if (aVertical === bVertical) return false;
	const [v0, v1, h0, h1] = aVertical ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
	const x = v0.x;
	const y = h0.y;
	const hMin = Math.min(h0.x, h1.x);
	const hMax = Math.max(h0.x, h1.x);
	const vMin = Math.min(v0.y, v1.y);
	const vMax = Math.max(v0.y, v1.y);
	return (
		x > hMin + EPSILON &&
		x < hMax - EPSILON &&
		y > vMin + EPSILON &&
		y < vMax - EPSILON
	);
}

function segmentsOverlap(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
	const aVertical = Math.abs(a0.x - a1.x) < EPSILON;
	const bVertical = Math.abs(b0.x - b1.x) < EPSILON;
	const aHorizontal = Math.abs(a0.y - a1.y) < EPSILON;
	const bHorizontal = Math.abs(b0.y - b1.y) < EPSILON;
	if (aVertical && bVertical && Math.abs(a0.x - b0.x) < 1) {
		return rangeOverlap(a0.y, a1.y, b0.y, b1.y) > 1;
	}
	if (aHorizontal && bHorizontal && Math.abs(a0.y - b0.y) < 1) {
		return rangeOverlap(a0.x, a1.x, b0.x, b1.x) > 1;
	}
	return false;
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): number {
	return (
		Math.min(Math.max(a0, a1), Math.max(b0, b1)) -
		Math.max(Math.min(a0, a1), Math.min(b0, b1))
	);
}

function countObstacleHits(
	route: readonly Point[],
	obstacles: readonly Box[],
): number {
	let hits = 0;
	for (let index = 0; index + 1 < route.length; index += 1) {
		const start = route[index];
		const end = route[index + 1];
		if (start === undefined || end === undefined) continue;
		for (const box of obstacles) {
			if (segmentEntersBoxInterior(start, end, box)) hits += 1;
		}
	}
	return hits;
}

function segmentEntersBoxInterior(start: Point, end: Point, box: Box): boolean {
	const minX = Math.min(start.x, end.x);
	const maxX = Math.max(start.x, end.x);
	const minY = Math.min(start.y, end.y);
	const maxY = Math.max(start.y, end.y);
	return (
		maxX > box.x + EPSILON &&
		minX < box.x + box.width - EPSILON &&
		maxY > box.y + EPSILON &&
		minY < box.y + box.height - EPSILON
	);
}

function isOrthogonal(route: readonly Point[]): boolean {
	if (route.length < 2) return false;
	for (let index = 0; index + 1 < route.length; index += 1) {
		const start = route[index];
		const end = route[index + 1];
		if (start === undefined || end === undefined) return false;
		if (
			Math.abs(start.x - end.x) >= EPSILON &&
			Math.abs(start.y - end.y) >= EPSILON
		) {
			return false;
		}
	}
	return true;
}

function compact(route: readonly Point[]): Point[] {
	const deduped: Point[] = [];
	for (const point of route) {
		const previous = deduped.at(-1);
		if (
			previous !== undefined &&
			Math.abs(previous.x - point.x) < 1e-9 &&
			Math.abs(previous.y - point.y) < 1e-9
		) {
			continue;
		}
		deduped.push({ x: point.x, y: point.y });
	}
	if (deduped.length <= 2) return deduped;
	const result: Point[] = [deduped[0] as Point];
	for (let index = 1; index < deduped.length - 1; index += 1) {
		const previous = result.at(-1) as Point;
		const current = deduped[index] as Point;
		const next = deduped[index + 1] as Point;
		const collinearVertical =
			Math.abs(previous.x - current.x) < 1e-9 &&
			Math.abs(current.x - next.x) < 1e-9;
		const collinearHorizontal =
			Math.abs(previous.y - current.y) < 1e-9 &&
			Math.abs(current.y - next.y) < 1e-9;
		if (collinearVertical || collinearHorizontal) continue;
		result.push(current);
	}
	result.push(deduped.at(-1) as Point);
	return result;
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((point, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			Math.abs(point.x - other.x) < 1e-9 &&
			Math.abs(point.y - other.y) < 1e-9
		);
	});
}

function clamp(value: number, low: number, high: number): number {
	if (low > high) return (low + high) / 2;
	return Math.min(high, Math.max(low, value));
}
