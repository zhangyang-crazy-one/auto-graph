import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Point } from "../ir/geometry.js";

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
	const vertices = collectCornerVertices(source, target, obstacles);
	if (vertices.length > maxCorners) {
		diagnostics?.push({
			severity: "warning",
			code: "routing.astar.corner_overflow",
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

	return simplifyRoute(path);
}

// ---------------------------------------------------------------------------
// Vertex collection
// ---------------------------------------------------------------------------

function collectCornerVertices(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
): CornerVertex[] {
	const vertices: CornerVertex[] = [
		{ point: { x: source.x, y: source.y }, obstacleIndex: -1 },
		{ point: { x: target.x, y: target.y }, obstacleIndex: -1 },
	];

	const seen = new Set<string>();
	seen.add(`${source.x},${source.y}`);
	seen.add(`${target.x},${target.y}`);

	for (let i = 0; i < obstacles.length; i++) {
		const obs = obstacles[i] as Box;
		const corners: Point[] = [
			{ x: obs.x, y: obs.y },
			{ x: obs.x + obs.width, y: obs.y },
			{ x: obs.x + obs.width, y: obs.y + obs.height },
			{ x: obs.x, y: obs.y + obs.height },
		];
		for (const c of corners) {
			const key = `${c.x},${c.y}`;
			if (!seen.has(key)) {
				seen.add(key);
				vertices.push({ point: c, obstacleIndex: i });
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
	aObsIdx: number,
	bObsIdx: number,
): boolean {
	for (let i = 0; i < obstacles.length; i++) {
		if (i === aObsIdx || i === bObsIdx) continue;
		if (segmentCrossesBox(a, b, obstacles[i] as Box)) return false;
	}
	for (const ep of endpointObstacles) {
		if (segmentCrossesBox(a, b, ep)) return false;
	}
	return true;
}

function segmentCrossesBox(start: Point, end: Point, box: Box): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;

	if (pointInside(start, box) || pointInside(end, box)) return true;

	if (start.x === end.x) {
		return (
			start.x > left &&
			start.x < right &&
			rangesOverlap(start.y, end.y, top, bottom)
		);
	}
	if (start.y === end.y) {
		return (
			start.y > top &&
			start.y < bottom &&
			rangesOverlap(start.x, end.x, left, right)
		);
	}

	return (
		edgeIntersect(start, end, left, top, right, top) ||
		edgeIntersect(start, end, right, top, right, bottom) ||
		edgeIntersect(start, end, right, bottom, left, bottom) ||
		edgeIntersect(start, end, left, bottom, left, top)
	);
}

function pointInside(p: Point, box: Box): boolean {
	return (
		p.x > box.x &&
		p.x < box.x + box.width &&
		p.y > box.y &&
		p.y < box.y + box.height
	);
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

function edgeIntersect(
	start: Point,
	end: Point,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): boolean {
	const denom = (end.x - start.x) * (y2 - y1) - (end.y - start.y) * (x2 - x1);
	if (denom === 0) return false;
	const t = ((start.x - x1) * (y2 - y1) - (start.y - y1) * (x2 - x1)) / denom;
	const u =
		((start.x - x1) * (end.y - start.y) - (start.y - y1) * (end.x - start.x)) /
		denom;
	return t > 0 && t < 1 && u > 0 && u < 1;
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
// A* on visibility graph
// ---------------------------------------------------------------------------

interface AStarState {
	id: number;
	f: number;
}

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

	const openSet: AStarState[] = [{ id: startId, f: manhattan(source, target) }];

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

	while (openSet.length > 0) {
		let bestIdx = 0;
		for (let i = 1; i < openSet.length; i++) {
			if ((openSet[i] as AStarState).f < (openSet[bestIdx] as AStarState).f) {
				bestIdx = i;
			}
		}
		const current = openSet.splice(bestIdx, 1)[0] as AStarState;

		if (current.id === goalId) {
			return reconstructPath(vertices, cameFrom, goalId);
		}

		const currentG = gScore.get(current.id) as number;
		const prevDir = cameFromDir.get(current.id);
		const neighbors = neighborMap.get(current.id) ?? [];

		for (const { to, cost } of neighbors) {
			const tentativeG = currentG + cost * segmentPenalty;
			const toV = vertices[to] as CornerVertex;
			const curV = vertices[current.id] as CornerVertex;
			const newDir: "h" | "v" = toV.point.y === curV.point.y ? "h" : "v";
			const turnCost =
				prevDir !== undefined && prevDir !== newDir ? turnPenalty : 0;
			const totalG = tentativeG + turnCost;

			const existingG = gScore.get(to);
			if (existingG === undefined || totalG < existingG) {
				gScore.set(to, totalG);
				cameFrom.set(to, current.id);
				cameFromDir.set(to, newDir);
				const f = totalG + manhattan(toV.point, target);
				openSet.push({ id: to, f });
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

function simplifyRoute(points: readonly Point[]): Point[] {
	if (points.length <= 2) return [...points];
	const result: Point[] = [points[0] as Point];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = result[result.length - 1] as Point;
		const curr = points[i] as Point;
		const next = points[i + 1] as Point;
		if (
			!(
				(prev.x === curr.x && curr.x === next.x) ||
				(prev.y === curr.y && curr.y === next.y)
			)
		) {
			result.push(curr);
		}
	}
	result.push(points[points.length - 1] as Point);
	return result;
}
