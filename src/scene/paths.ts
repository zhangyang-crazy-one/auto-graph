import { BinaryHeap } from "../routing/binary-heap.js";
import { findSparseGridPath } from "../routing/sparse-grid-router.js";
import {
	axisAngle,
	corners,
	direction,
	type Footprint,
	halfExtent,
	type Vec2,
} from "./geometry.js";
import type {
	PlannedScenePath,
	SceneAgent,
	SceneDiagnostic,
	SceneObject,
	SceneOpening,
	ScenePathSpec,
	SceneSpec,
} from "./ir.js";

/**
 * Paths for agents (people, robots, carts) between objects and openings.
 *
 * The agent is shrunk to a point and every object in its way (anything
 * whose bottom is below the agent's height) grows by the agent's radius
 * plus the path's clearance: the configuration space. The room's walls
 * pull in by the same amount. A path is then a polyline for a point:
 *
 * - any angle (default): shortest path through the corners of the grown
 *   footprints (a visibility graph searched with A*), the way people walk
 *   past furniture;
 * - `orthogonal`: auto-graph's sparse-grid router (the one that routes
 *   diagram edges), turning only at right angles, for aisles and rails.
 *
 * An object is reached at the point in front of it (from its `front`),
 * else at the first free side; an opening at the point just inside it.
 * Every path is checked on its own against the objects' turned
 * footprints and the walls. When there is no path, the agent's radius is
 * shrunk until there is one: where that path runs closest to something is
 * the bottleneck, reported with the two things that form it and how much
 * width is missing.
 */

export interface PathObstacle {
	object: SceneObject;
	shape: Footprint;
	/** Bottom height. */
	z: number;
}

export interface PlanPathsResult {
	paths: PlannedScenePath[];
	diagnostics: SceneDiagnostic[];
}

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** A place a path goes to: the points an agent may stand at, best first. */
interface Place {
	id: string;
	stands: Vec2[];
}

/** Points nudged this far off grown footprints so they count as outside. */
const EPS = 1e-6;
/** Where an agent stands is this much (3 mm) off what it reaches. */
const STAND_OFF = 0.003;
/** Bisection steps when looking for the bottleneck. */
const SHRINK_STEPS = 16;
/** Coordinates handed to the sparse-grid router are millimeters. */
const MM = 1000;

export function planPaths(
	spec: SceneSpec,
	placed: ReadonlyMap<string, PathObstacle>,
): PlanPathsResult {
	const paths: PlannedScenePath[] = [];
	const diagnostics: SceneDiagnostic[] = [];
	const agents = new Map(spec.agents.map((agent) => [agent.id, agent]));
	const openings = new Map(
		spec.openings.map((opening) => [opening.id, opening]),
	);

	for (const path of spec.paths) {
		const agent = agents.get(path.agent) as SceneAgent;
		const obstacles = [...placed.values()].filter(
			(item) => item.z < agent.height,
		);
		const narrow = [path.from, ...path.via, path.to]
			.map((id) => openings.get(id))
			.find(
				(opening): opening is SceneOpening =>
					opening !== undefined && opening.width < 2 * agent.radius,
			);
		if (narrow !== undefined) {
			diagnostics.push({
				severity: "error",
				code: "scene.path.opening-narrow",
				message: `"${agent.id}" (${round(2 * agent.radius)} m wide) does not fit through "${narrow.id}" (${round(narrow.width)} m).`,
				objects: [narrow.id],
				path: path.path,
				hint: `Widen "${narrow.id}" or use a narrower agent.`,
				detail: { width: round(narrow.width), needs: round(2 * agent.radius) },
			});
			continue;
		}
		const reach = agent.radius + path.clearance;
		const found = route(spec, path, obstacles, placed, openings, reach);
		if (found !== undefined) {
			paths.push(planned(spec, path, agent, found, obstacles));
			continue;
		}
		diagnostics.push(
			bottleneck(spec, path, agent, obstacles, placed, openings, reach),
		);
	}
	return { paths, diagnostics };
}

/** The whole route through every place, or undefined when blocked. */
function route(
	spec: SceneSpec,
	path: ScenePathSpec,
	obstacles: readonly PathObstacle[],
	placed: ReadonlyMap<string, PathObstacle>,
	openings: ReadonlyMap<string, SceneOpening>,
	reach: number,
): Vec2[] | undefined {
	const room: Rect = {
		x0: reach,
		y0: reach,
		x1: spec.bounds.width - reach,
		y1: spec.bounds.depth - reach,
	};
	if (room.x0 > room.x1 || room.y0 > room.y1) return undefined;
	const grown = obstacles.map((item) => grownBox(item.shape, reach));
	const free = (point: Vec2) =>
		point.x >= room.x0 - EPS &&
		point.x <= room.x1 + EPS &&
		point.y >= room.y0 - EPS &&
		point.y <= room.y1 + EPS &&
		!grown.some((box) => insideOpen(point, box));
	const places = [path.from, ...path.via, path.to].map((id) =>
		place(id, spec, placed, openings, reach),
	);
	const starts = (places[0] as Place).stands.filter(free);
	if (starts.length === 0) return undefined;
	let at = starts[0] as Vec2;
	const points: Vec2[] = [at];
	for (const next of places.slice(1)) {
		let leg: Vec2[] | undefined;
		for (const stand of next.stands) {
			if (!free(stand)) continue;
			leg = path.orthogonal
				? orthogonalLeg(at, stand, grown, spec, reach)
				: anyAngleLeg(at, stand, grown, room);
			if (leg !== undefined) break;
		}
		if (leg === undefined) return undefined;
		points.push(...leg.slice(1));
		at = points.at(-1) as Vec2;
	}
	return simplify(points);
}

/** Where an agent stands to reach a place, best first. */
function place(
	id: string,
	spec: SceneSpec,
	placed: ReadonlyMap<string, PathObstacle>,
	openings: ReadonlyMap<string, SceneOpening>,
	reach: number,
): Place {
	const opening = openings.get(id);
	if (opening !== undefined) {
		const { width, depth } = spec.bounds;
		const inset = reach + STAND_OFF;
		const at = opening.at;
		const stand =
			opening.wall === "south"
				? { x: at, y: inset }
				: opening.wall === "north"
					? { x: at, y: depth - inset }
					: opening.wall === "west"
						? { x: inset, y: at }
						: { x: width - inset, y: at };
		return { id, stands: [stand] };
	}
	const item = placed.get(id) as PathObstacle;
	const { shape } = item;
	// The front first, snapped to the nearest world axis, then its left,
	// right and back (as seen facing the front).
	const forward = snap(
		direction(objectYaw(shape) + axisAngle(item.object.front)),
	);
	const right = { x: -forward.y, y: forward.x };
	const sides = [
		forward,
		{ x: -right.x, y: -right.y },
		right,
		{ x: -forward.x, y: -forward.y },
	];
	// Each stand slides along its side into the room when the middle of
	// the side is too close to a wall (a shelf against a wall, reached from
	// its end), but never past the side.
	const room = {
		x0: reach + STAND_OFF,
		y0: reach + STAND_OFF,
		x1: spec.bounds.width - reach - STAND_OFF,
		y1: spec.bounds.depth - reach - STAND_OFF,
	};
	const stands = sides.map((side) => {
		const out = halfExtent(shape, side) + reach + STAND_OFF;
		const stand = {
			x: shape.center.x + side.x * out,
			y: shape.center.y + side.y * out,
		};
		const along = { x: Math.abs(side.y), y: Math.abs(side.x) };
		const span = halfExtent(shape, along);
		if (along.x === 1) {
			stand.x = clamp(stand.x, room.x0, room.x1, shape.center.x, span);
		} else {
			stand.y = clamp(stand.y, room.y0, room.y1, shape.center.y, span);
		}
		return stand;
	});
	return { id, stands };
}

/** The footprint's turn, from its x axis. */
function objectYaw(shape: Footprint): number {
	return (Math.atan2(shape.axisX.y, shape.axisX.x) * 180) / Math.PI;
}

/** Into [low, high], but no farther than `span` from `center`. */
function clamp(
	value: number,
	low: number,
	high: number,
	center: number,
	span: number,
): number {
	const into = Math.min(Math.max(value, low), high);
	return Math.min(Math.max(into, center - span), center + span);
}

function snap(vector: Vec2): Vec2 {
	return Math.abs(vector.x) >= Math.abs(vector.y)
		? { x: Math.sign(vector.x) || 1, y: 0 }
		: { x: 0, y: Math.sign(vector.y) || 1 };
}

/** World-axis box of a footprint, grown by `by`. */
function grownBox(shape: Footprint, by: number): Rect {
	const ex = halfExtent(shape, { x: 1, y: 0 }) + by;
	const ey = halfExtent(shape, { x: 0, y: 1 }) + by;
	return {
		x0: shape.center.x - ex,
		y0: shape.center.y - ey,
		x1: shape.center.x + ex,
		y1: shape.center.y + ey,
	};
}

function insideOpen(point: Vec2, box: Rect): boolean {
	return (
		point.x > box.x0 + EPS / 2 &&
		point.x < box.x1 - EPS / 2 &&
		point.y > box.y0 + EPS / 2 &&
		point.y < box.y1 - EPS / 2
	);
}

/**
 * Shortest any-angle path for a point among boxes: A* over the visibility
 * graph of the endpoints and the boxes' corners (nudged outwards).
 */
function anyAngleLeg(
	from: Vec2,
	to: Vec2,
	boxes: readonly Rect[],
	room: Rect,
): Vec2[] | undefined {
	const vertices: Vec2[] = [from, to];
	for (const box of boxes) {
		for (const corner of [
			{ x: box.x0 - EPS, y: box.y0 - EPS },
			{ x: box.x1 + EPS, y: box.y0 - EPS },
			{ x: box.x1 + EPS, y: box.y1 + EPS },
			{ x: box.x0 - EPS, y: box.y1 + EPS },
		]) {
			if (
				corner.x < room.x0 - EPS ||
				corner.x > room.x1 + EPS ||
				corner.y < room.y0 - EPS ||
				corner.y > room.y1 + EPS ||
				boxes.some((other) => insideOpen(corner, other))
			) {
				continue;
			}
			vertices.push(corner);
		}
	}
	const visible = (a: Vec2, b: Vec2) =>
		!boxes.some((box) => segmentEntersBox(a, b, box));
	const goal = 1;
	const best = new Map<number, number>([[0, 0]]);
	const previous = new Map<number, number>();
	const heap = new BinaryHeap<number>();
	heap.push(0, distance(from, to));
	const done = new Set<number>();
	while (heap.size > 0) {
		const current = heap.pop() as number;
		if (done.has(current)) continue;
		done.add(current);
		if (current === goal) break;
		const here = vertices[current] as Vec2;
		const cost = best.get(current) as number;
		for (let next = 0; next < vertices.length; next += 1) {
			if (next === current || done.has(next)) continue;
			const there = vertices[next] as Vec2;
			const through = cost + distance(here, there);
			if (through >= (best.get(next) ?? Number.POSITIVE_INFINITY) - 1e-12) {
				continue;
			}
			if (!visible(here, there)) continue;
			best.set(next, through);
			previous.set(next, current);
			heap.push(next, through + distance(there, to));
		}
	}
	if (!done.has(goal)) return undefined;
	const out: Vec2[] = [];
	for (
		let at: number | undefined = goal;
		at !== undefined;
		at = previous.get(at)
	) {
		out.unshift(vertices[at] as Vec2);
	}
	return out;
}

/** Right-angle path through auto-graph's sparse-grid router (in mm). */
function orthogonalLeg(
	from: Vec2,
	to: Vec2,
	boxes: readonly Rect[],
	spec: SceneSpec,
	reach: number,
): Vec2[] | undefined {
	const toBox = (rect: Rect) => ({
		x: rect.x0 * MM,
		y: rect.y0 * MM,
		width: (rect.x1 - rect.x0) * MM,
		height: (rect.y1 - rect.y0) * MM,
	});
	const { width, depth } = spec.bounds;
	const far = Math.max(width, depth);
	// The walls, pulled in by the agent's reach, as boxes around the room.
	const walls = [
		{ x0: -far, y0: -far, x1: width + far, y1: reach },
		{ x0: -far, y0: depth - reach, x1: width + far, y1: depth + far },
		{ x0: -far, y0: -far, x1: reach, y1: depth + far },
		{ x0: width - reach, y0: -far, x1: width + far, y1: depth + far },
	];
	const found = findSparseGridPath(
		{ x: from.x * MM, y: from.y * MM },
		{ x: to.x * MM, y: to.y * MM },
		[...boxes, ...walls].map(toBox),
		{ clearance: 2, bendPenalty: 200 },
	);
	if (found === null) return undefined;
	const points = found.map((point) => ({ x: point.x / MM, y: point.y / MM }));
	// Trust but verify: the router keeps 2 mm off walls it was given.
	const room = { x0: reach, y0: reach, x1: width - reach, y1: depth - reach };
	for (let k = 0; k + 1 < points.length; k += 1) {
		const a = points[k] as Vec2;
		const b = points[k + 1] as Vec2;
		if (boxes.some((box) => segmentEntersBox(a, b, box))) return undefined;
		for (const p of [a, b]) {
			if (
				p.x < room.x0 - 1e-4 ||
				p.x > room.x1 + 1e-4 ||
				p.y < room.y0 - 1e-4 ||
				p.y > room.y1 + 1e-4
			) {
				return undefined;
			}
		}
	}
	return points;
}

/** Whether segment ab passes through the open interior of a box. */
function segmentEntersBox(a: Vec2, b: Vec2, box: Rect): boolean {
	// Liang–Barsky clip against the box shrunk by a hair (touching is fine).
	const shrink = EPS / 2;
	const x0 = box.x0 + shrink;
	const x1 = box.x1 - shrink;
	const y0 = box.y0 + shrink;
	const y1 = box.y1 - shrink;
	if (x0 >= x1 || y0 >= y1) return false;
	let low = 0;
	let high = 1;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	for (const [p, q] of [
		[-dx, a.x - x0],
		[dx, x1 - a.x],
		[-dy, a.y - y0],
		[dy, y1 - a.y],
	] as const) {
		if (p === 0) {
			if (q <= 0) return false;
			continue;
		}
		const t = q / p;
		if (p < 0) low = Math.max(low, t);
		else high = Math.min(high, t);
		if (low >= high) return false;
	}
	return high - low > 1e-12;
}

function planned(
	spec: SceneSpec,
	path: ScenePathSpec,
	agent: SceneAgent,
	points: Vec2[],
	obstacles: readonly PathObstacle[],
): PlannedScenePath {
	const length = points
		.slice(1)
		.reduce((sum, point, k) => sum + distance(points[k] as Vec2, point), 0);
	const room = nearest(spec, points, obstacles).gap;
	return {
		id: path.id,
		agent: agent.id,
		from: path.from,
		to: path.to,
		points: points.map((point) => [round(point.x), round(point.y), 0]),
		length: round(length),
		width: round(2 * agent.radius),
		clearance: round(Math.max(0, room - agent.radius)),
	};
}

interface Nearest {
	/** Least distance from the path's center line to anything. */
	gap: number;
	/** Where on the path. */
	at: Vec2;
	/** What it is: an object id or a wall name. */
	what: string;
}

/** The closest approach of a polyline to the objects (true turned shapes) and walls. */
function nearest(
	spec: SceneSpec,
	points: readonly Vec2[],
	obstacles: readonly PathObstacle[],
	exclude: ReadonlySet<string> = new Set(),
): Nearest {
	let best: Nearest = {
		gap: Number.POSITIVE_INFINITY,
		at: points[0] ?? { x: 0, y: 0 },
		what: "",
	};
	const consider = (gap: number, at: Vec2, what: string) => {
		if (gap < best.gap - 1e-12) best = { gap, at, what };
	};
	const segments =
		points.length > 1
			? points.slice(1).map((p, k) => [points[k] as Vec2, p] as const)
			: [[points[0] as Vec2, points[0] as Vec2] as const];
	for (const [a, b] of segments) {
		for (const item of obstacles) {
			if (exclude.has(item.object.id)) continue;
			const near = segmentPolygon(a, b, corners(item.shape));
			consider(near.gap, near.at, item.object.id);
		}
		for (const [wall, value] of wallLines(spec)) {
			if (exclude.has(wall)) continue;
			for (const p of [a, b]) consider(value(p), p, wall);
		}
	}
	return best;
}

function wallLines(spec: SceneSpec): [string, (p: Vec2) => number][] {
	const { width, depth } = spec.bounds;
	return [
		["the south wall", (p) => p.y],
		["the north wall", (p) => depth - p.y],
		["the west wall", (p) => p.x],
		["the east wall", (p) => width - p.x],
	];
}

/** Least distance between a segment and a convex polygon, and where on the segment. */
function segmentPolygon(
	a: Vec2,
	b: Vec2,
	polygon: readonly Vec2[],
): { gap: number; at: Vec2 } {
	let best = { gap: Number.POSITIVE_INFINITY, at: a };
	const n = polygon.length;
	for (let k = 0; k < n; k += 1) {
		const p = polygon[k] as Vec2;
		const q = polygon[(k + 1) % n] as Vec2;
		if (segmentsCross(a, b, p, q)) return { gap: 0, at: a };
		for (const [point, onPath] of [
			[a, true],
			[b, true],
			[p, false],
			[q, false],
		] as const) {
			const [s, t] = onPath ? [p, q] : [a, b];
			const foot = closestOnSegment(point, s, t);
			const gap = distance(point, foot);
			if (gap < best.gap) best = { gap, at: onPath ? point : foot };
		}
	}
	if (insidePolygon(a, polygon)) return { gap: 0, at: a };
	return best;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
	const cross = (o: Vec2, p: Vec2, q: Vec2) =>
		(p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

function insidePolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
	let sign = 0;
	for (let k = 0; k < polygon.length; k += 1) {
		const p = polygon[k] as Vec2;
		const q = polygon[(k + 1) % polygon.length] as Vec2;
		const side = Math.sign(
			(q.x - p.x) * (point.y - p.y) - (q.y - p.y) * (point.x - p.x),
		);
		if (side === 0) continue;
		if (sign === 0) sign = side;
		else if (side !== sign) return false;
	}
	return true;
}

function closestOnSegment(point: Vec2, a: Vec2, b: Vec2): Vec2 {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = dx * dx + dy * dy;
	const t =
		length === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length),
				);
	return { x: a.x + dx * t, y: a.y + dy * t };
}

/**
 * No path: shrink the agent until one exists. Where that path runs closest
 * to something is the bottleneck; the next-closest thing across from it
 * is the other side.
 */
function bottleneck(
	spec: SceneSpec,
	path: ScenePathSpec,
	agent: SceneAgent,
	obstacles: readonly PathObstacle[],
	placed: ReadonlyMap<string, PathObstacle>,
	openings: ReadonlyMap<string, SceneOpening>,
	reach: number,
): SceneDiagnostic {
	const try_ = (r: number) => route(spec, path, obstacles, placed, openings, r);
	let thin = try_(1e-4);
	if (thin === undefined) {
		return {
			severity: "error",
			code: "scene.path.blocked",
			message: `"${agent.id}" cannot get from "${path.from}" to "${path.to}" at all: one end is shut in.`,
			objects: [path.from, path.to],
			path: path.path,
			hint: "Move what surrounds the ends, or pick other places.",
		};
	}
	let low = 1e-4;
	let high = reach;
	for (let step = 0; step < SHRINK_STEPS; step += 1) {
		const middle = (low + high) / 2;
		const found = try_(middle);
		if (found === undefined) high = middle;
		else {
			low = middle;
			thin = found;
		}
	}
	// The widest agent that gets through is as wide as the narrowest place
	// on its way. Ends are reached 3 mm looser than that, so the closest
	// approach of its path is the bottleneck, not where it stands.
	const first = nearest(spec, thin, obstacles);
	const across = nearest(spec, [first.at], obstacles, new Set([first.what]));
	const wide = 2 * low;
	const needs = 2 * reach;
	return {
		severity: "error",
		code: "scene.path.blocked",
		message: `"${agent.id}" cannot get from "${path.from}" to "${path.to}": the way between ${name(first.what)} and ${name(across.what)} is ${round(wide)} m wide; it needs ${round(needs)} m (${round(needs - wide)} m short).`,
		objects: [first.what, across.what].filter(
			(what) => !what.startsWith("the "),
		),
		path: path.path,
		hint: `Move ${name(first.what)} or ${name(across.what)} ${round(needs - wide)} m apart, or use a narrower agent or less clearance.`,
		detail: {
			at: `${round(first.at.x)}, ${round(first.at.y)}`,
			width: round(wide),
			needs: round(needs),
		},
	};
}

function name(what: string): string {
	return what.startsWith("the ") ? what : `"${what}"`;
}

function simplify(points: readonly Vec2[]): Vec2[] {
	const out: Vec2[] = [];
	for (const point of points) {
		const last = out.at(-1);
		if (last !== undefined && distance(last, point) < 1e-9) continue;
		const before = out.at(-2);
		if (
			last !== undefined &&
			before !== undefined &&
			Math.abs(
				(last.x - before.x) * (point.y - before.y) -
					(last.y - before.y) * (point.x - before.x),
			) < 1e-12
		) {
			out[out.length - 1] = point;
			continue;
		}
		out.push(point);
	}
	return out;
}

function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(value: number): number {
	if (!Number.isFinite(value * 1e4)) return value;
	const rounded = Math.round(value * 1e4) / 1e4;
	return rounded === 0 ? 0 : rounded;
}
