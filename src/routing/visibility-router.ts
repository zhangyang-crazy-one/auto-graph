import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Point } from "../ir/geometry.js";
import { BinaryHeap } from "./binary-heap.js";

// ---------------------------------------------------------------------------
// Corner visibility-graph A* (Issue #54, 方案 B — libavoid approach)
// ---------------------------------------------------------------------------

export interface VisibilityRouterOptions {
	readonly segmentPenalty?: number;
	readonly turnPenalty?: number;
	readonly margin?: number;
	readonly endpointObstacles?: readonly Box[];
	readonly maxCorners?: number;
}

interface CornerVertex {
	readonly point: Point;
	readonly obstacleIndex: number; // -1 for source/target
}

interface VisEdge {
	readonly from: number;
	readonly to: number;
	readonly cost: number; // euclidean distance
}

/**
 * Find an obstacle-free path using corner-based visibility graph + A*.
 * Returns the path or null if no path exists or corner count exceeds maxCorners.
 */
export function findCornerGraphPath(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
	options: VisibilityRouterOptions = {},
	diagnostics?: Diagnostic[],
): Point[] | null {
	const margin = options.margin ?? 0;
	const turnPenalty = options.turnPenalty ?? 50;
	const segmentPenalty = options.segmentPenalty ?? 1;
	const endpointObstacles = options.endpointObstacles ?? [];
	const maxCorners = options.maxCorners ?? 300;

	// Collect vertices
	const vertices = collectCornerVertices(source, target, obstacles, margin);
	if (vertices.length > maxCorners) {
		diagnostics?.push({
			severity: "warning",
			code: "routing.visibility.corner_overflow",
			message: `Corner graph overflow: ${vertices.length} vertices > ${maxCorners}. Falling back to grid A*.`,
			detail: { vertexCount: vertices.length, maxCorners },
		});
		return null;
	}

	if (obstacles.length === 0) {
		return simplifyRoute([source, target]);
	}

	// Build visibility edges
	const expandedObstacles =
		margin === 0 ? obstacles : obstacles.map((o) => expandBox(o, margin));
	const edges = buildVisibilityEdges(
		vertices,
		expandedObstacles,
		endpointObstacles,
	);

	// A*
	const path = aStarSearch(
		vertices,
		edges,
		source,
		target,
		segmentPenalty,
		turnPenalty,
	);
	if (path === null) return null;

	return simplifyRoute(path, expandedObstacles);
}

// ---------------------------------------------------------------------------
// Vertex collection
// ---------------------------------------------------------------------------

function collectCornerVertices(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
	margin: number = 0,
): CornerVertex[] {
	const vertices: CornerVertex[] = [
		{ point: { x: source.x, y: source.y }, obstacleIndex: -1 },
		{ point: { x: target.x, y: target.y }, obstacleIndex: -1 },
	];

	const seen = new Set<string>();
	seen.add(`${source.x},${source.y}`);
	seen.add(`${target.x},${target.y}`);

	const addVertex = (p: Point, obstacleIndex: number): void => {
		const key = `${p.x},${p.y}`;
		if (seen.has(key)) return;
		seen.add(key);
		vertices.push({ point: p, obstacleIndex });
	};

	for (let i = 0; i < obstacles.length; i++) {
		const obs = obstacles[i] as Box;
		// When margin > 0, corners are also offset outward so the
		// resulting path doesn't tangent-touch the obstacle edge
		// (which the loose AABB intersection check would reject).
		const c0: Point = { x: obs.x - margin, y: obs.y - margin };
		const c1: Point = { x: obs.x + obs.width + margin, y: obs.y - margin };
		const c2: Point = {
			x: obs.x + obs.width + margin,
			y: obs.y + obs.height + margin,
		};
		const c3: Point = { x: obs.x - margin, y: obs.y + obs.height + margin };
		for (const c of [c0, c1, c2, c3]) {
			addVertex(c, i);
		}
	}

	// Steiner points: axis-aligned projections where source/target
	// coordinates project onto obstacle edges. These create waypoints
	// so the router can leave source/target perpendicular to an
	// obstacle edge before routing along it (corner-astar review fix).
	// With margin > 0, projections are offset outward so the path
	// stays outside the expanded obstacle and avoids tangent touches.
	for (const p of [source, target]) {
		for (let i = 0; i < obstacles.length; i++) {
			const obs = obstacles[i] as Box;
			// Project p.x onto left/right edges (offset outward by margin).
			addVertex({ x: obs.x - margin, y: p.y }, i);
			addVertex({ x: obs.x + obs.width + margin, y: p.y }, i);
			// Project p.y onto top/bottom edges (offset outward by margin).
			addVertex({ x: p.x, y: obs.y - margin }, i);
			addVertex({ x: p.x, y: obs.y + obs.height + margin }, i);
			// Also project the source/target coordinate lines onto the
			// edges they intersect (interior projections).
			if (p.x > obs.x && p.x < obs.x + obs.width) {
				addVertex({ x: p.x, y: obs.y - margin }, i);
				addVertex({ x: p.x, y: obs.y + obs.height + margin }, i);
			}
			if (p.y > obs.y && p.y < obs.y + obs.height) {
				addVertex({ x: obs.x - margin, y: p.y }, i);
				addVertex({ x: obs.x + obs.width + margin, y: p.y }, i);
			}
		}
	}

	return vertices;
}

// ---------------------------------------------------------------------------
// Visibility graph construction
// ---------------------------------------------------------------------------

function buildVisibilityEdges(
	vertices: CornerVertex[],
	obstacles: readonly Box[],
	endpointObstacles: readonly Box[],
): VisEdge[] {
	const edges: VisEdge[] = [];

	// For each vertex, find nearest visible neighbor in 4 directions
	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i] as CornerVertex;
		const right = visibleInDirection(
			v,
			vertices,
			obstacles,
			endpointObstacles,
			"right",
		);
		const left = visibleInDirection(
			v,
			vertices,
			obstacles,
			endpointObstacles,
			"left",
		);
		const down = visibleInDirection(
			v,
			vertices,
			obstacles,
			endpointObstacles,
			"down",
		);
		const up = visibleInDirection(
			v,
			vertices,
			obstacles,
			endpointObstacles,
			"up",
		);

		for (const neighbor of [right, left, down, up]) {
			if (neighbor !== null && neighbor.index > i) {
				edges.push({
					from: i,
					to: neighbor.index,
					cost: neighbor.distance,
				});
			}
		}
	}

	return edges;
}

interface VisibleNeighbor {
	index: number;
	distance: number;
}

function visibleInDirection(
	origin: CornerVertex,
	vertices: CornerVertex[],
	obstacles: readonly Box[],
	endpointObstacles: readonly Box[],
	dir: "left" | "right" | "up" | "down",
): VisibleNeighbor | null {
	const candidates: Array<{ index: number; dist: number }> = [];

	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i] as CornerVertex;
		const dx = v.point.x - origin.point.x;
		const dy = v.point.y - origin.point.y;

		switch (dir) {
			case "right":
				if (dx > 0 && dy === 0) candidates.push({ index: i, dist: dx });
				break;
			case "left":
				if (dx < 0 && dy === 0) candidates.push({ index: i, dist: -dx });
				break;
			case "down":
				if (dy > 0 && dx === 0) candidates.push({ index: i, dist: dy });
				break;
			case "up":
				if (dy < 0 && dx === 0) candidates.push({ index: i, dist: -dy });
				break;
		}
	}

	candidates.sort((a, b) => a.dist - b.dist);

	for (const c of candidates) {
		if (
			isSegmentVisible(
				origin.point,
				(vertices[c.index] as CornerVertex).point,
				obstacles,
				endpointObstacles,
				origin.obstacleIndex,
				(vertices[c.index] as CornerVertex).obstacleIndex,
			)
		) {
			return { index: c.index, distance: c.dist };
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Visibility test
// ---------------------------------------------------------------------------

function isSegmentVisible(
	a: Point,
	b: Point,
	obstacles: readonly Box[],
	endpointObstacles: readonly Box[],
	_aObsIdx: number,
	_bObsIdx: number,
): boolean {
	// Use strict interior check for ALL obstacles. The strict check
	// treats endpoints on the boundary as not "inside", so Steiner
	// points on obstacle edges can still leave the edge without
	// being falsely rejected. This also correctly rejects segments
	// that re-enter an obstacle after leaving from an edge.
	for (let i = 0; i < obstacles.length; i++) {
		if (segmentEntersBox(a, b, obstacles[i] as Box)) return false;
	}
	for (const ep of endpointObstacles) {
		if (segmentEntersBox(a, b, ep)) return false;
	}
	return true;
}

/**
 * Returns true if the segment enters the INTERIOR of the box
 * (strict). Endpoints on the boundary and segments tangent to the
 * boundary are NOT considered entering.
 */
function segmentEntersBox(start: Point, end: Point, box: Box): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	const inside = (p: Point): boolean =>
		p.x > left && p.x < right && p.y > top && p.y < bottom;
	if (inside(start) || inside(end)) return true;
	if (start.x === end.x) {
		return (
			start.x > left &&
			start.x < right &&
			Math.max(start.y, end.y) > top &&
			Math.min(start.y, end.y) < bottom
		);
	}
	if (start.y === end.y) {
		return (
			start.y > top &&
			start.y < bottom &&
			Math.max(start.x, end.x) > left &&
			Math.min(start.x, end.x) < right
		);
	}
	return false;
}

function expandBox(box: Box, margin: number): Box {
	return {
		x: box.x - margin,
		y: box.y - margin,
		width: box.width + margin * 2,
		height: box.height + margin * 2,
	};
}

// ---------------------------------------------------------------------------
// A* on visibility graph (open set uses BinaryHeap, Issue #60)
// ---------------------------------------------------------------------------

function aStarSearch(
	vertices: CornerVertex[],
	edges: VisEdge[],
	source: Point,
	target: Point,
	segmentPenalty: number,
	turnPenalty: number,
): Point[] | null {
	const startId = 0; // source is always first vertex
	const goalId = 1; // target is always second vertex

	const gScore = new Map<number, number>();
	gScore.set(startId, 0);

	const cameFrom = new Map<number, number>();
	const cameFromDir = new Map<number, "h" | "v">();

	const openSet = new BinaryHeap<number>();
	openSet.push(startId, manhattan(source, target));

	const neighborMap = new Map<number, Array<{ to: number; cost: number }>>();
	for (const e of edges) {
		let list = neighborMap.get(e.from);
		if (list === undefined) {
			list = [];
			neighborMap.set(e.from, list);
		}
		list.push({ to: e.to, cost: e.cost });
		list = neighborMap.get(e.to);
		if (list === undefined) {
			list = [];
			neighborMap.set(e.to, list);
		}
		list.push({ to: e.from, cost: e.cost });
	}

	while (openSet.size > 0) {
		const currentId = openSet.pop()!;
		const currentG = gScore.get(currentId);
		// Lazy deletion: skip stale entries.
		if (currentG === undefined) continue;

		if (currentId === goalId) {
			return reconstructPath(vertices, cameFrom, goalId);
		}

		const prevDir = cameFromDir.get(currentId);
		const neighbors = neighborMap.get(currentId) ?? [];

		for (const { to, cost } of neighbors) {
			const tentativeG = currentG + cost * segmentPenalty;
			const toV = vertices[to] as CornerVertex;
			const curV = vertices[currentId] as CornerVertex;
			const newDir: "h" | "v" = toV.point.y === curV.point.y ? "h" : "v";
			const turnCost =
				prevDir !== undefined && prevDir !== newDir ? turnPenalty : 0;
			const totalG = tentativeG + turnCost;

			const existingG = gScore.get(to);
			if (existingG === undefined || totalG < existingG) {
				gScore.set(to, totalG);
				cameFrom.set(to, currentId);
				cameFromDir.set(to, newDir);
				const f = totalG + manhattan(toV.point, target);
				openSet.push(to, f);
			}
		}
	}

	return null;
}

function manhattan(a: Point, b: Point): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstructPath(
	vertices: CornerVertex[],
	cameFrom: Map<number, number>,
	goalId: number,
): Point[] {
	const path: Point[] = [];
	let current: number | undefined = goalId;
	while (current !== undefined) {
		const v = vertices[current] as CornerVertex;
		path.unshift({ x: v.point.x, y: v.point.y });
		current = cameFrom.get(current);
	}
	return path;
}

// ---------------------------------------------------------------------------
// Route simplification
// ---------------------------------------------------------------------------

function simplifyRoute(
	points: readonly Point[],
	obstacles: readonly Box[] = [],
): Point[] {
	if (points.length <= 2) return [...points];
	const result: Point[] = [points[0] as Point];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = result[result.length - 1] as Point;
		const curr = points[i] as Point;
		const next = points[i + 1] as Point;
		const collinear =
			(prev.x === curr.x && curr.x === next.x) ||
			(prev.y === curr.y && curr.y === next.y);
		if (!collinear) {
			result.push(curr);
			continue;
		}
		// Only collapse if the resulting direct segment is still
		// obstacle-free. Otherwise keep the intermediate waypoint
		// so the route hugs the obstacle boundary instead of cutting
		// through it (corner-astar review fix).
		if (segmentCrossesAnyObstacle(prev, next, obstacles)) {
			result.push(curr);
		}
	}
	result.push(points[points.length - 1] as Point);
	return result;
}

function segmentCrossesAnyObstacle(
	a: Point,
	b: Point,
	obstacles: readonly Box[],
): boolean {
	for (const obs of obstacles) {
		if (segmentEntersBox(a, b, obs)) return true;
	}
	return false;
}
