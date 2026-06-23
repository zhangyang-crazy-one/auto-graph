import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Point } from "../ir/geometry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AstarOptions {
	/** Per-unit cost for each segment length unit (default 1.0). */
	readonly segmentPenalty?: number;
	/** Cost added for each direction change / turn (default 50). */
	readonly turnPenalty?: number;
	/** Obstacle expansion margin (default 0). */
	readonly margin?: number;
	/** Boxes that block edges unless the segment is the first or last. */
	readonly endpointObstacles?: readonly Box[];
	/** Maximum number of graph nodes before giving up (default 4000). */
	readonly maxNodes?: number;
}

interface GraphNode {
	readonly x: number;
	readonly y: number;
	readonly id: number;
	neighbors: Map<number, number>; // neighbor id → edge cost
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find an orthogonal, obstacle-free path from `source` to `target`
 * using a coordinate-aligned visibility graph + A* search.
 *
 * Returns the path as an array of Points (source first, target last), or
 * `null` if no path exists or the graph exceeds `maxNodes`.
 */
export function findObstacleFreePath(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
	options: AstarOptions = {},
	diagnostics?: Diagnostic[],
): Point[] | null {
	const margin = options.margin ?? 0;
	const turnPenalty = options.turnPenalty ?? 50;
	const segmentPenalty = options.segmentPenalty ?? 1;
	const endpointObstacles = options.endpointObstacles ?? [];
	const maxNodes = options.maxNodes ?? (obstacles.length > 30 ? 16000 : 4000);

	// 1. Collect interesting coordinates.
	const xs = collectXs(source, target, obstacles, margin);
	const ys = collectYs(source, target, obstacles, margin);

	if (xs.length * ys.length > maxNodes) {
		diagnostics?.push({
			severity: "warning",
			code: "routing.astar.grid_overflow",
			message: `A* grid overflow: ${xs.length * ys.length} nodes > ${maxNodes} limit. Falling back to heuristic routing.`,
			detail: {
				xsCount: xs.length,
				ysCount: ys.length,
				maxNodes,
			},
		});
		return null;
	}

	// 2. Build graph.
	const { nodes, nodeIndex } = buildGraph(xs, ys);

	// 3. Connect edges.
	connectHorizontalEdges(nodes, ys, obstacles, endpointObstacles, margin);
	connectVerticalEdges(nodes, xs, obstacles, endpointObstacles, margin);

	// 4. A* search.
	const path = aStarSearch(
		nodes,
		nodeIndex,
		source,
		target,
		turnPenalty,
		segmentPenalty,
	);

	if (path === null) return null;

	// 5. Simplify.
	return simplifyRoute(path);
}

// ---------------------------------------------------------------------------
// Coordinate collection
// ---------------------------------------------------------------------------

function collectXs(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
	margin: number,
): number[] {
	const raw: number[] = [source.x, target.x];
	// Offset obstacle edges by 2 px so grid lines sit just outside,
	// avoiding tangent-touch AABB intersections (Issue #39).
	for (const obs of obstacles) {
		raw.push(obs.x - margin - 2, obs.x + obs.width + margin + 2);
	}
	return dedupSorted(raw);
}

function collectYs(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
	margin: number,
): number[] {
	const raw: number[] = [source.y, target.y];
	// Offset obstacle edges by 2 px so grid lines sit just outside,
	// avoiding tangent-touch AABB intersections (Issue #39).
	for (const obs of obstacles) {
		raw.push(obs.y - margin - 2, obs.y + obs.height + margin + 2);
	}
	return dedupSorted(raw);
}

/**
 * Sort and merge coordinates within 2 px tolerance so aligned
 * obstacles (e.g. same container) produce fewer redundant grid
 * lines (Issue #47).
 */
function dedupSorted(values: number[]): number[] {
	const sorted = [...values].sort((a, b) => a - b);
	const result: number[] = [];
	for (const v of sorted) {
		const last = result[result.length - 1];
		if (last === undefined || v - last > 2) {
			result.push(v);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function buildGraph(
	xs: number[],
	ys: number[],
): { nodes: GraphNode[]; nodeIndex: Map<string, number> } {
	const nodes: GraphNode[] = [];
	const nodeIndex = new Map<string, number>();

	for (let xi = 0; xi < xs.length; xi++) {
		for (let yi = 0; yi < ys.length; yi++) {
			const x = xs[xi] as number;
			const y = ys[yi] as number;
			const id = nodes.length;
			nodes.push({ x, y, id, neighbors: new Map() });
			nodeIndex.set(`${x},${y}`, id);
		}
	}

	return { nodes, nodeIndex };
}

// ---------------------------------------------------------------------------
// Edge connection
// ---------------------------------------------------------------------------

function connectHorizontalEdges(
	nodes: GraphNode[],
	ys: number[],
	obstacles: readonly Box[],
	endpointObstacles: readonly Box[],
	margin: number,
): void {
	for (const y of ys) {
		const row = nodes.filter((n) => n.y === y).sort((a, b) => a.x - b.x);
		for (let i = 0; i < row.length - 1; i++) {
			const a = row[i] as GraphNode;
			const b = row[i + 1] as GraphNode;
			const dx = b.x - a.x;
			if (dx <= 0) continue;
			if (segmentCrossesAny(a, b, obstacles, endpointObstacles, margin)) {
				continue;
			}
			a.neighbors.set(b.id, dx);
			b.neighbors.set(a.id, dx);
		}
	}
}

function connectVerticalEdges(
	nodes: GraphNode[],
	xs: number[],
	obstacles: readonly Box[],
	endpointObstacles: readonly Box[],
	margin: number,
): void {
	for (const x of xs) {
		const col = nodes.filter((n) => n.x === x).sort((a, b) => a.y - b.y);
		for (let i = 0; i < col.length - 1; i++) {
			const a = col[i] as GraphNode;
			const b = col[i + 1] as GraphNode;
			const dy = b.y - a.y;
			if (dy <= 0) continue;
			if (segmentCrossesAny(a, b, obstacles, endpointObstacles, margin)) {
				continue;
			}
			a.neighbors.set(b.id, dy);
			b.neighbors.set(a.id, dy);
		}
	}
}

// ---------------------------------------------------------------------------
// Edge validity
// ---------------------------------------------------------------------------

function segmentCrossesAny(
	a: Point,
	b: Point,
	obstacles: readonly Box[],
	endpointObstacles: readonly Box[],
	margin: number,
): boolean {
	for (const obs of obstacles) {
		if (segmentCrossesBoxStrict(a, b, obs, margin)) return true;
	}
	for (const ep of endpointObstacles) {
		if (segmentCrossesBoxStrict(a, b, ep, margin)) return true;
	}
	return false;
}

/**
 * Like `segmentIntersectsBox` but excludes tangent touches — only
 * returns true when the segment truly enters the box interior.
 * Endpoints ON the box boundary are not counted as interior.
 */
function segmentCrossesBoxStrict(
	start: Point,
	end: Point,
	box: Box,
	margin: number,
): boolean {
	const left = box.x - margin;
	const right = box.x + box.width + margin;
	const top = box.y - margin;
	const bottom = box.y + box.height + margin;

	// Strict interior check for endpoints
	if (pointInsideStrict(start, left, right, top, bottom)) return true;
	if (pointInsideStrict(end, left, right, top, bottom)) return true;

	// Axis-aligned segments — use non-strict comparisons so
	// tangent-touching edges are caught, matching intersectsAabb.
	if (start.x === end.x) {
		return (
			start.x >= left &&
			start.x <= right &&
			rangesOverlap(start.y, end.y, top, bottom)
		);
	}
	if (start.y === end.y) {
		return (
			start.y >= top &&
			start.y <= bottom &&
			rangesOverlap(start.x, end.x, left, right)
		);
	}

	// Diagonal: check all four edges
	return (
		segmentEdgeIntersect(start, end, left, top, right, top) ||
		segmentEdgeIntersect(start, end, right, top, right, bottom) ||
		segmentEdgeIntersect(start, end, right, bottom, left, bottom) ||
		segmentEdgeIntersect(start, end, left, bottom, left, top)
	);
}

function pointInsideStrict(
	p: Point,
	left: number,
	right: number,
	top: number,
	bottom: number,
): boolean {
	return p.x > left && p.x < right && p.y > top && p.y < bottom;
}

function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return high > min && low < max;
}

function segmentEdgeIntersect(
	start: Point,
	end: Point,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): boolean {
	const denominator =
		(end.x - start.x) * (y2 - y1) - (end.y - start.y) * (x2 - x1);
	if (denominator === 0) return false;

	const t =
		((start.x - x1) * (y2 - y1) - (start.y - y1) * (x2 - x1)) / denominator;
	const u =
		((start.x - x1) * (end.y - start.y) - (start.y - y1) * (end.x - start.x)) /
		denominator;

	return t > 0 && t < 1 && u > 0 && u < 1;
}

// ---------------------------------------------------------------------------
// A* search
// ---------------------------------------------------------------------------

interface SearchState {
	id: number;
	f: number;
}

function aStarSearch(
	nodes: GraphNode[],
	nodeIndex: Map<string, number>,
	source: Point,
	target: Point,
	turnPenalty: number,
	segmentPenalty: number,
): Point[] | null {
	const startId = nodeIndex.get(`${source.x},${source.y}`);
	const goalId = nodeIndex.get(`${target.x},${target.y}`);
	if (startId === undefined || goalId === undefined) return null;

	const gScore = new Map<number, number>();
	gScore.set(startId, 0);

	const cameFrom = new Map<number, number>();
	const cameFromDir = new Map<number, "h" | "v">();

	// Simple binary min-heap
	const openSet: SearchState[] = [];
	openSet.push({
		id: startId,
		f: manhattan(source, target),
	});

	while (openSet.length > 0) {
		// Extract min-f
		let bestIdx = 0;
		for (let i = 1; i < openSet.length; i++) {
			if ((openSet[i] as SearchState).f < (openSet[bestIdx] as SearchState).f) {
				bestIdx = i;
			}
		}
		const current = openSet.splice(bestIdx, 1)[0] as SearchState;

		if (current.id === goalId) {
			return reconstructPath(nodes, cameFrom, goalId);
		}

		const node = nodes[current.id] as GraphNode;
		const currentG = gScore.get(current.id) as number;
		const prevDir = cameFromDir.get(current.id);

		for (const [neighborId, edgeCost] of node.neighbors) {
			const neighbor = nodes[neighborId] as GraphNode;
			const tentativeG = currentG + edgeCost * segmentPenalty;

			const newDir: "h" | "v" = neighbor.y === node.y ? "h" : "v";
			const turnCost =
				prevDir !== undefined && prevDir !== newDir ? turnPenalty : 0;
			const totalG = tentativeG + turnCost;

			const existingG = gScore.get(neighborId);
			if (existingG === undefined || totalG < existingG) {
				gScore.set(neighborId, totalG);
				cameFrom.set(neighborId, current.id);
				cameFromDir.set(neighborId, newDir);
				const f = totalG + manhattan(neighbor, target);
				openSet.push({ id: neighborId, f });
			}
		}
	}

	return null;
}

function manhattan(a: Point, b: Point): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstructPath(
	nodes: GraphNode[],
	cameFrom: Map<number, number>,
	goalId: number,
): Point[] {
	const path: Point[] = [];
	let current: number | undefined = goalId;
	while (current !== undefined) {
		const node = nodes[current] as GraphNode;
		path.unshift({ x: node.x, y: node.y });
		current = cameFrom.get(current);
	}
	return path;
}

// ---------------------------------------------------------------------------
// Route simplification
// ---------------------------------------------------------------------------

/**
 * Remove intermediate collinear points from the route.
 */
function simplifyRoute(points: readonly Point[]): Point[] {
	if (points.length <= 2) return [...points];

	const result: Point[] = [points[0] as Point];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = result[result.length - 1] as Point;
		const curr = points[i] as Point;
		const next = points[i + 1] as Point;
		if (!areCollinear(prev, curr, next)) {
			result.push(curr);
		}
	}
	result.push(points[points.length - 1] as Point);
	return result;
}

function areCollinear(a: Point, b: Point, c: Point): boolean {
	return (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
}
