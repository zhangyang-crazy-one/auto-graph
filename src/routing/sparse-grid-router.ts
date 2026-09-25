import type { Box, Point } from "../ir/geometry.js";
import { BinaryHeap } from "./binary-heap.js";

/**
 * Orthogonal shortest path with bend penalty on a lazily expanded Hanan
 * grid (the lines through every obstacle side offset by `clearance`, the
 * endpoints, and the middle of every channel between two lines).
 *
 * `walls` are never entered. Each `softObstacles` box the path enters
 * costs `softPenalty` (entering once, however long the path stays inside),
 * so a route crosses a foreign group or a label only when going around is
 * longer than the penalty.
 *
 * Unlike the corner visibility graph (quadratic in the corner count) or the
 * dense grid A* (builds every grid cell up front), states are only created
 * when the search reaches them and box tests go through a bucket index, so
 * the search stays cheap on diagrams with hundreds of nodes. Used when the
 * bounded heuristic candidates all pass through a node.
 *
 * Returns the simplified path (source first, target last) or `null` when no
 * path exists within `maxExpansions`.
 */
export interface SparseGridRouteOptions {
	/** Boxes entered at a cost (groups, labels). */
	readonly softObstacles?: readonly Box[];
	/** Cost of entering one soft obstacle, in px of length (default 400). */
	readonly softPenalty?: number;
	/** Distance kept from obstacle sides (default 12). */
	readonly clearance?: number;
	/** Cost of one bend in px of length (default 60). */
	readonly bendPenalty?: number;
	/** Popped states before giving up (default 60 000). */
	readonly maxExpansions?: number;
	/** Box the source point sits on; the route leaves it outwards. */
	readonly sourceBox?: Box;
	/** Box the target point sits on; the route enters it from outside. */
	readonly targetBox?: Box;
	/**
	 * Keep the path inside this box: only obstacles reaching into it take
	 * part, so a local route searches a small grid.
	 */
	readonly window?: Box;
}

const BUCKET = 128;
/** Weight of the A* estimate (bounded-suboptimal search). */
const HEURISTIC_WEIGHT = 1.5;
/** Walls are inflated by this much for blocked tests (tangent slack). */
const TOUCH_SLACK = 1.5;

const RIGHT = 0;
const LEFT = 1;
const DOWN = 2;
const UP = 3;
const START = 4;

export function findSparseGridPath(
	source: Point,
	target: Point,
	walls: readonly Box[],
	options: SparseGridRouteOptions = {},
): Point[] | null {
	const clearance = options.clearance ?? 12;
	const bendPenalty = options.bendPenalty ?? 60;
	const softPenalty = options.softPenalty ?? 400;
	const maxExpansions = options.maxExpansions ?? 60_000;
	const window = options.window;
	const reaches = (box: Box) =>
		window === undefined ||
		(box.x - clearance < window.x + window.width &&
			box.x + box.width + clearance > window.x &&
			box.y - clearance < window.y + window.height &&
			box.y + box.height + clearance > window.y);
	const soft = (options.softObstacles ?? []).filter(reaches);
	walls = walls.filter(reaches);
	const inside = (value: number, low: number, high: number) =>
		value >= low && value <= high;
	const inflated = walls.map((box) => ({
		x: box.x - TOUCH_SLACK,
		y: box.y - TOUCH_SLACK,
		width: box.width + 2 * TOUCH_SLACK,
		height: box.height + 2 * TOUCH_SLACK,
	}));
	// Endpoint boxes block only their strict interior: the endpoints sit on
	// their border.
	const endpointBoxes = [options.sourceBox, options.targetBox].filter(
		(box): box is Box => box !== undefined,
	);
	const outlined = [...walls, ...soft, ...endpointBoxes];
	const xs = channelCoordinates(
		[
			source.x,
			target.x,
			...outlined.flatMap((box) => [
				box.x - clearance,
				box.x + box.width + clearance,
			]),
			...(window === undefined ? [] : [window.x, window.x + window.width]),
		].filter(
			(value) =>
				window === undefined ||
				inside(value, window.x, window.x + window.width),
		),
		2 * clearance,
	);
	const ys = channelCoordinates(
		[
			source.y,
			target.y,
			...outlined.flatMap((box) => [
				box.y - clearance,
				box.y + box.height + clearance,
			]),
			...(window === undefined ? [] : [window.y, window.y + window.height]),
		].filter(
			(value) =>
				window === undefined ||
				inside(value, window.y, window.y + window.height),
		),
		2 * clearance,
	);
	const sx = xs.indexOf(source.x);
	const sy = ys.indexOf(source.y);
	const tx = xs.indexOf(target.x);
	const ty = ys.indexOf(target.y);
	if (sx < 0 || sy < 0 || tx < 0 || ty < 0) return null;

	const wallIndex = bucketIndex(inflated);
	const softIndex = bucketIndex(soft);
	const nx = xs.length;
	const ny = ys.length;
	const point = (i: number, j: number): Point => ({
		x: xs[i] as number,
		y: ys[j] as number,
	});
	// Per cell and axis: 0 = unknown, 1 = free, 2 = blocked.
	const state = acquireSearchState(nx * ny * 5, nx * ny * 2);
	const generation = state.generation;
	const blockedCache = state.blocked;
	const blockedStamp = state.blockedStamp;
	/** Is the move between (i, j) and its +x (axis 0) / +y (axis 1) neighbour blocked? */
	const blocked = (i: number, j: number, axis: 0 | 1): boolean => {
		const key = ((j * nx + i) << 1) | axis;
		if (blockedStamp[key] === generation) return blockedCache[key] === 1;
		const a = point(i, j);
		const b = axis === 0 ? point(i + 1, j) : point(i, j + 1);
		let hit = false;
		visitBuckets(wallIndex, a, b, (boxIndex) => {
			if (!hit && segmentEntersBox(a, b, inflated[boxIndex] as Box)) {
				hit = true;
			}
		});
		for (const box of endpointBoxes) {
			if (hit) break;
			if (segmentEntersBox(a, b, box)) hit = true;
		}
		blockedStamp[key] = generation;
		blockedCache[key] = hit ? 1 : 0;
		return hit;
	};
	/** Soft boxes entered by the move from `a` to `b` (start not inside). */
	const softCost = (a: Point, b: Point): number => {
		if (soft.length === 0) return 0;
		let entered = 0;
		visitBuckets(softIndex, a, b, (boxIndex) => {
			const box = soft[boxIndex] as Box;
			if (!pointInside(a, box) && segmentEntersBox(a, b, box)) entered += 1;
		});
		return entered * softPenalty;
	};

	const startDirection =
		options.sourceBox === undefined
			? START
			: outwardDirection(source, options.sourceBox);
	const finalDirection =
		options.targetBox === undefined
			? undefined
			: opposite(outwardDirection(target, options.targetBox));

	const { best, parent, stamp, closed } = state;
	// Entries written by an earlier search are stale: stamp[k] marks the
	// ones this search has set.
	const bestOf = (key: number) =>
		stamp[key] === generation
			? (best[key] as number)
			: Number.POSITIVE_INFINITY;
	const heap = new BinaryHeap<number>();
	// Length plus a lower bound on the bends still needed, so the search
	// does not flood the plateau of equally long staircases.
	const heuristic = (i: number, j: number, direction: number) => {
		const dx = target.x - (xs[i] as number);
		const dy = target.y - (ys[j] as number);
		let bends = 0;
		if (dx !== 0 && dy !== 0) bends = 1;
		else if (direction !== START && (dx !== 0 || dy !== 0)) {
			const toward = dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : UP;
			if (direction !== toward) bends = 1;
		}
		return Math.abs(dx) + Math.abs(dy) + bends * bendPenalty;
	};
	// Weighted A*: the estimate counts 1.5 times, so the search heads for
	// the target instead of settling every state cheaper than the optimum
	// (on long edges across dense diagrams that is most of the grid). The
	// path found costs at most 1.5 times the optimum.
	const priority = (cost: number, estimate: number) =>
		cost + estimate * HEURISTIC_WEIGHT;
	const startKey = (sy * nx + sx) * 5 + startDirection;
	best[startKey] = 0;
	parent[startKey] = -1;
	stamp[startKey] = generation;
	heap.push(startKey, priority(0, heuristic(sx, sy, startDirection)));
	let expansions = 0;
	let goal = -1;
	while (heap.size > 0) {
		const key = heap.pop() as number;
		if (closed[key] === generation) continue;
		closed[key] = generation;
		const direction = key % 5;
		const cell = (key - direction) / 5;
		const i = cell % nx;
		const j = (cell - i) / nx;
		const cost = bestOf(key);
		if (i === tx && j === ty) {
			goal = key;
			break;
		}
		expansions += 1;
		if (expansions > maxExpansions) return null;
		for (let next = 0; next < 4; next += 1) {
			if (direction !== START && next === opposite(direction)) continue;
			// Leave the source straight out of its side (never along it).
			if (key === startKey && direction !== START && next !== direction) {
				continue;
			}
			let ni = i;
			let nj = j;
			if (next === RIGHT) {
				if (i + 1 >= nx || blocked(i, j, 0)) continue;
				ni = i + 1;
			} else if (next === LEFT) {
				if (i === 0 || blocked(i - 1, j, 0)) continue;
				ni = i - 1;
			} else if (next === DOWN) {
				if (j + 1 >= ny || blocked(i, j, 1)) continue;
				nj = j + 1;
			} else {
				if (j === 0 || blocked(i, j - 1, 1)) continue;
				nj = j - 1;
			}
			const from = point(i, j);
			const to = point(ni, nj);
			let step =
				Math.abs(to.x - from.x) + Math.abs(to.y - from.y) + softCost(from, to);
			if (direction !== START && next !== direction) step += bendPenalty;
			// Enter the target straight into its side.
			if (
				ni === tx &&
				nj === ty &&
				finalDirection !== undefined &&
				next !== finalDirection
			) {
				continue;
			}
			const nextKey = (nj * nx + ni) * 5 + next;
			const nextCost = cost + step;
			if (bestOf(nextKey) <= nextCost) continue;
			best[nextKey] = nextCost;
			parent[nextKey] = key;
			stamp[nextKey] = generation;
			heap.push(nextKey, priority(nextCost, heuristic(ni, nj, next)));
		}
	}
	if (goal < 0) return null;

	const cells: Point[] = [];
	for (let cursor = goal; cursor >= 0; cursor = parent[cursor] as number) {
		const direction = cursor % 5;
		const cell = (cursor - direction) / 5;
		const i = cell % nx;
		cells.push(point(i, (cell - i) / nx));
	}
	cells.reverse();
	return simplify(cells);
}

interface SearchState {
	generation: number;
	best: Float64Array;
	parent: Int32Array;
	stamp: Uint32Array;
	closed: Uint32Array;
	blocked: Uint8Array;
	blockedStamp: Uint32Array;
}

/**
 * Search arrays shared by every call and grown on demand. Each search takes
 * a new generation; an entry counts only if its stamp matches, so the
 * arrays are never cleared (a large grid would otherwise allocate and fill
 * millions of entries per edge).
 */
const SEARCH_STATE: SearchState = {
	generation: 0,
	best: new Float64Array(0),
	parent: new Int32Array(0),
	stamp: new Uint32Array(0),
	closed: new Uint32Array(0),
	blocked: new Uint8Array(0),
	blockedStamp: new Uint32Array(0),
};

function acquireSearchState(states: number, moves: number): SearchState {
	const state = SEARCH_STATE;
	if (state.best.length < states) {
		const size = Math.max(states, state.best.length * 2);
		state.best = new Float64Array(size);
		state.parent = new Int32Array(size);
		state.stamp = new Uint32Array(size);
		state.closed = new Uint32Array(size);
	}
	if (state.blocked.length < moves) {
		const size = Math.max(moves, state.blocked.length * 2);
		state.blocked = new Uint8Array(size);
		state.blockedStamp = new Uint32Array(size);
	}
	state.generation += 1;
	if (state.generation >= 0xffffffff) {
		state.generation = 1;
		state.stamp.fill(0);
		state.closed.fill(0);
		state.blockedStamp.fill(0);
	}
	return state;
}

/** Sorted unique coordinates plus the middle of every gap wider than `gap`. */
function channelCoordinates(values: readonly number[], gap: number): number[] {
	const sorted = [...new Set(values.filter(Number.isFinite))].sort(
		(a, b) => a - b,
	);
	const result: number[] = [];
	for (let k = 0; k < sorted.length; k += 1) {
		const value = sorted[k] as number;
		const previous = sorted[k - 1];
		if (previous !== undefined && value - previous > gap) {
			result.push((previous + value) / 2);
		}
		result.push(value);
	}
	return result;
}

function outwardDirection(point: Point, box: Box): number {
	const distances = [
		Math.abs(point.x - (box.x + box.width)),
		Math.abs(point.x - box.x),
		Math.abs(point.y - (box.y + box.height)),
		Math.abs(point.y - box.y),
	];
	let bestSide = 0;
	for (let side = 1; side < 4; side += 1) {
		if ((distances[side] as number) < (distances[bestSide] as number)) {
			bestSide = side;
		}
	}
	return [RIGHT, LEFT, DOWN, UP][bestSide] as number;
}

function opposite(direction: number): number {
	switch (direction) {
		case RIGHT:
			return LEFT;
		case LEFT:
			return RIGHT;
		case DOWN:
			return UP;
		case UP:
			return DOWN;
		default:
			return START;
	}
}

interface BucketIndex {
	cells: Map<string, number[]>;
}

function bucketIndex(boxes: readonly Box[]): BucketIndex {
	const cells = new Map<string, number[]>();
	boxes.forEach((box, boxIndex) => {
		for (
			let cx = Math.floor(box.x / BUCKET);
			cx <= Math.floor((box.x + box.width) / BUCKET);
			cx += 1
		) {
			for (
				let cy = Math.floor(box.y / BUCKET);
				cy <= Math.floor((box.y + box.height) / BUCKET);
				cy += 1
			) {
				const key = `${cx},${cy}`;
				const list = cells.get(key);
				if (list === undefined) cells.set(key, [boxIndex]);
				else list.push(boxIndex);
			}
		}
	});
	return { cells };
}

function visitBuckets(
	index: BucketIndex,
	a: Point,
	b: Point,
	visit: (boxIndex: number) => void,
): void {
	const seen = new Set<number>();
	for (
		let cx = Math.floor(Math.min(a.x, b.x) / BUCKET);
		cx <= Math.floor(Math.max(a.x, b.x) / BUCKET);
		cx += 1
	) {
		for (
			let cy = Math.floor(Math.min(a.y, b.y) / BUCKET);
			cy <= Math.floor(Math.max(a.y, b.y) / BUCKET);
			cy += 1
		) {
			for (const boxIndex of index.cells.get(`${cx},${cy}`) ?? []) {
				if (seen.has(boxIndex)) continue;
				seen.add(boxIndex);
				visit(boxIndex);
			}
		}
	}
}

function pointInside(point: Point, box: Box): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

/** Does the axis-aligned segment a–b pass through the open interior of box? */
function segmentEntersBox(a: Point, b: Point, box: Box): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	if (a.y === b.y) {
		if (a.y <= top || a.y >= bottom) return false;
		return Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
	}
	if (a.x <= left || a.x >= right) return false;
	return Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

function simplify(points: readonly Point[]): Point[] {
	const result: Point[] = [];
	for (const point of points) {
		const last = result[result.length - 1];
		if (last !== undefined && last.x === point.x && last.y === point.y) {
			continue;
		}
		const previous = result[result.length - 2];
		if (
			previous !== undefined &&
			last !== undefined &&
			((previous.x === last.x && last.x === point.x) ||
				(previous.y === last.y && last.y === point.y))
		) {
			result[result.length - 1] = point;
			continue;
		}
		result.push(point);
	}
	return result;
}
