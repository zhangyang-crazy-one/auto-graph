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
import {
	centreAnyAngle,
	centreOrthogonal,
	type FreeSpace,
	insideOpen,
	type LanePath,
	LENGTH_BUDGET,
	pathLength,
	type Rect,
	segmentEntersBox,
	separateLanes,
} from "./path-refine.js";
import { findMeetings, type TimedPath, timePath } from "./path-timing.js";
import { GridTerrain } from "./terrain/index.js";

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
	/** Height of the ground under it (0 on a flat floor). */
	ground?: number;
}

export interface PlanPathsResult {
	paths: PlannedScenePath[];
	diagnostics: SceneDiagnostic[];
	/** Where blocked paths are too narrow, for the layout to widen. */
	bottlenecks: PathBottleneck[];
}

/**
 * The narrowest place on a blocked path's way: two objects, or an object
 * and a wall (`wall:<side>`), that must stand `needs` apart.
 */
export interface PathBottleneck {
	path: string;
	agent: string;
	between: [string, string];
	needs: number;
	/** Room the path would like beyond `needs`, on each side. */
	comfort: number;
}

/** A place a path goes to: the points an agent may stand at, best first. */
interface Place {
	id: string;
	stands: Vec2[];
}

interface Routed {
	path: ScenePathSpec;
	agent: SceneAgent;
	obstacles: PathObstacle[];
	reach: number;
	legs: Vec2[][];
	space: FreeSpace;
	/** Length of the shortest route, before any refinement. */
	shortest: number;
}

/** Room a path keeps beyond its clearance by default (as the DSL). */
const DEFAULT_COMFORT = 0.15;

/**
 * Paths and agents built without the DSL (from code, or stored before a
 * field existed) get the DSL's defaults instead of undefined.
 */
function withPathDefaults(path: ScenePathSpec): ScenePathSpec {
	return {
		...path,
		via: path.via ?? [],
		clearance: Number.isFinite(path.clearance) ? path.clearance : 0,
		comfort: Number.isFinite(path.comfort) ? path.comfort : DEFAULT_COMFORT,
	};
}

function withAgentDefaults(agent: SceneAgent): SceneAgent {
	return {
		...agent,
		speed: agent.speed > 0 ? agent.speed : 1,
		accel: agent.accel > 0 ? agent.accel : 1,
	};
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
	const bottlenecks: PathBottleneck[] = [];
	const agents = new Map(
		spec.agents.map((agent) => [agent.id, withAgentDefaults(agent)]),
	);
	const openings = new Map(
		spec.openings.map((opening) => [opening.id, opening]),
	);

	const routed: Routed[] = [];
	for (const given of spec.paths) {
		const path = withPathDefaults(given);
		const agent = agents.get(path.agent) as SceneAgent;
		const obstacles = [...placed.values()].filter(
			(item) => item.z - (item.ground ?? 0) < agent.height,
		);
		const places = [path.from, ...path.via, path.to];
		// A place without a position (left out of the layout) cannot be
		// walked to.
		const lost = places.filter((id) => !openings.has(id) && !placed.has(id));
		if (lost.length > 0) {
			diagnostics.push({
				severity: "error",
				code: "scene.path.unplaced",
				message: `"${path.id}" goes to ${lost.map((id) => `"${id}"`).join(", ")}, which has no position.`,
				objects: lost,
				path: path.path,
				hint: "Fix what keeps it out of the layout (see its diagnostic).",
			});
			continue;
		}
		const reach = agent.radius + path.clearance;
		// An opening must take the agent and its clearance on both sides.
		const narrow = places
			.map((id) => openings.get(id))
			.find(
				(opening): opening is SceneOpening =>
					opening !== undefined && opening.width < 2 * reach - EPS,
			);
		if (narrow !== undefined) {
			const needs = 2 * reach;
			diagnostics.push({
				severity: "error",
				code: "scene.path.opening-narrow",
				message:
					path.clearance > 0
						? `"${agent.id}" (${round(2 * agent.radius)} m wide, ${round(path.clearance)} m clear each side) does not fit through "${narrow.id}" (${round(narrow.width)} m; it needs ${round(needs)} m).`
						: `"${agent.id}" (${round(2 * agent.radius)} m wide) does not fit through "${narrow.id}" (${round(narrow.width)} m).`,
				objects: [narrow.id],
				path: path.path,
				hint: `Widen "${narrow.id}" or use a narrower agent${path.clearance > 0 ? " or less clearance" : ""}.`,
				detail: { width: round(narrow.width), needs: round(needs) },
			});
			continue;
		}
		const found = route(spec, path, obstacles, placed, openings, reach);
		if (found !== undefined) {
			routed.push({
				path,
				agent,
				obstacles,
				reach,
				...found,
				shortest: found.legs.reduce((sum, leg) => sum + pathLength(leg), 0),
			});
			continue;
		}
		const blocked = bottleneck(
			spec,
			path,
			agent,
			obstacles,
			placed,
			openings,
			reach,
		);
		diagnostics.push(blocked.diagnostic);
		if (blocked.between !== undefined) {
			bottlenecks.push({
				path: path.id,
				agent: agent.id,
				between: blocked.between,
				needs: 2 * reach,
				comfort: path.comfort,
			});
		}
	}

	// Refine: walk mid-aisle rather than skimming corners, within a length
	// budget over the shortest route.
	for (const item of routed) {
		if (item.path.orthogonal) continue;
		item.legs = item.legs.map((leg) =>
			centreAnyAngle(
				leg,
				item.space,
				item.path.comfort,
				LENGTH_BUDGET * pathLength(leg),
			),
		);
	}
	// Right-angle legs of agents that see the same free space are centred
	// together, so legs sharing a channel spread across it.
	const groups = new Map<string, Routed[]>();
	for (const item of routed) {
		if (!item.path.orthogonal || item.path.comfort <= 0) continue;
		const key = `${item.reach}:${item.agent.height}`;
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	for (const group of groups.values()) {
		const legs = group.flatMap((item) => item.legs);
		const centred = centreOrthogonal(
			legs,
			(group[0] as Routed).space,
			legs.map((leg) => LENGTH_BUDGET * pathLength(leg)),
		);
		let at = 0;
		for (const item of group) {
			item.legs = centred.slice(at, at + item.legs.length);
			at += item.legs.length;
		}
	}

	// Lanes: paths meeting head-on on a shared run keep right.
	const lanes = separateLanes(
		routed.map((item): LanePath => {
			const joined = joinLegs(item.legs);
			return {
				...joined,
				width: 2 * item.agent.radius,
				space: item.space,
				orthogonal: item.path.orthogonal,
				// The same budget as centring, on the shortest route: steps
				// never add up past it.
				budget: LENGTH_BUDGET * item.shortest,
				movable: item.path.comfort > 0,
			};
		}),
	);
	for (const {
		paths: [i, j],
		at,
		reason,
	} of lanes.shared) {
		const a = routed[i] as Routed;
		const b = routed[j] as Routed;
		const near = `${round(at.x)}, ${round(at.y)}`;
		const pair = `"${a.path.id}" and "${b.path.id}"`;
		diagnostics.push(
			reason === "narrow"
				? {
						severity: "info",
						code: "scene.path.single-file",
						message: `${pair} meet head-on where the way is too narrow to pass side by side (near ${near}).`,
						path: b.path.path,
						hint: `Passing there needs ${round(2 * a.agent.radius + 2 * b.agent.radius)} m between things; widen it if they must pass each other.`,
						detail: { at: near },
					}
				: {
						severity: "info",
						code: "scene.path.head-on",
						message: `${pair} share a run head-on near ${near}: ${
							reason === "budget"
								? "stepping aside would take one more than 15 % over its shortest route"
								: reason === "fixed"
									? "a path with comfort 0 keeps its shortest route"
									: "the lanes were not worked out within the round limit"
						}.`,
						path: b.path.path,
						hint:
							reason === "fixed"
								? "Give one of them some comfort to let it step aside."
								: "Give them a start each if they must not meet, or route one another way.",
						detail: { at: near, reason },
					},
		);
	}

	routed.forEach((item, index) => {
		const points = simplifyKeeping(
			(lanes.paths[index] as LanePath).points,
			(lanes.paths[index] as LanePath).fixed,
		);
		const result = planned(spec, item.path, item.agent, points, item.obstacles);
		paths.push(result);
		const direct = pathLength(
			item.legs
				.map((leg) => leg[0] as Vec2)
				.concat([item.legs.at(-1)?.at(-1) as Vec2]),
		);
		if (
			direct > 0.01 &&
			result.length > 2 * direct &&
			result.length - direct > 1
		) {
			diagnostics.push({
				severity: "info",
				code: "scene.path.detour",
				message: `"${item.path.id}" is ${round(result.length)} m long, ${round(result.length / direct)} times the ${round(direct)} m of straight lines between its places.`,
				path: item.path.path,
				hint: "Something stands in the direct way; move it or add an opening if the detour matters.",
				detail: { length: round(result.length), direct: round(direct) },
			});
		}
	});

	// Paths given a start run on one clock: agents that would bump into
	// each other on the way are reported, with a later start that avoids it.
	const timed = routed.flatMap((item, index): TimedPath[] => {
		if (item.path.start === undefined) return [];
		const result = paths[index] as PlannedScenePath;
		const corners = result.points.map(([x, y]) => ({ x, y }));
		return [
			{
				id: item.path.id,
				points: corners,
				timing: timePath(
					corners,
					item.agent.speed,
					item.agent.accel,
					item.path.start,
				),
				radius: item.agent.radius,
			},
		];
	});
	const byId = new Map(spec.paths.map((path) => [path.id, path]));
	for (const meeting of findMeetings(timed)) {
		const later = byId.get(meeting.b) as ScenePathSpec;
		const start = (later.start ?? 0) + (meeting.delay ?? 0);
		diagnostics.push({
			severity: "warning",
			code: "scene.path.meet",
			message: `"${meeting.a}" and "${meeting.b}" run into each other ${round(meeting.at)} s in, near ${round(meeting.where.x)}, ${round(meeting.where.y)}.`,
			path: later.path,
			hint:
				meeting.delay === undefined
					? "Route one of them another way."
					: `Start "${meeting.b}" ${meeting.delay} s later (\`start ${round(start)}\`), or route one of them another way.`,
			detail: {
				at: round(meeting.at),
				where: `${round(meeting.where.x)}, ${round(meeting.where.y)}`,
				...(meeting.delay === undefined ? {} : { delay: meeting.delay }),
			},
		});
	}
	return { paths, diagnostics, bottlenecks };
}

/** The whole route through every place, or undefined when blocked. */
function route(
	spec: SceneSpec,
	path: ScenePathSpec,
	obstacles: readonly PathObstacle[],
	placed: ReadonlyMap<string, PathObstacle>,
	openings: ReadonlyMap<string, SceneOpening>,
	reach: number,
): { legs: Vec2[][]; space: FreeSpace } | undefined {
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
	// Every free stand at the start is tried in turn: the first may sit in
	// a pocket the others are not in.
	for (const first of starts) {
		let at = first;
		const legs: Vec2[][] = [];
		for (const next of places.slice(1)) {
			let leg: Vec2[] | undefined;
			for (const stand of next.stands) {
				if (!free(stand)) continue;
				leg = path.orthogonal
					? orthogonalLeg(at, stand, grown, spec, reach)
					: anyAngleLeg(at, stand, grown, room);
				if (leg !== undefined) break;
			}
			if (leg === undefined) break;
			const tight = simplify(leg);
			legs.push(tight);
			at = tight.at(-1) as Vec2;
		}
		if (legs.length === places.length - 1) {
			return { legs, space: { boxes: grown, room } };
		}
	}
	return undefined;
}

/** Legs joined into one polyline; the joints (vias) stay fixed. */
function joinLegs(legs: readonly Vec2[][]): {
	points: Vec2[];
	fixed: boolean[];
} {
	const points: Vec2[] = [];
	const fixed: boolean[] = [];
	legs.forEach((leg, index) => {
		leg.forEach((point, k) => {
			if (index > 0 && k === 0) return;
			points.push(point);
			fixed.push(k === 0 || k === leg.length - 1);
		});
	});
	return { points, fixed };
}

/**
 * Places that cannot reach the largest group of places that reach each
 * other; empty when the groups tie (then nothing stands out).
 */
function cutOff(
	places: readonly string[],
	connected: (a: string, b: string) => boolean,
): string[] {
	const unique = [...new Set(places)];
	const group = new Map(unique.map((id, k) => [id, k]));
	const find = (id: string): number => {
		let k = group.get(id) as number;
		while (group.get(unique[k] as string) !== k)
			k = group.get(unique[k] as string) as number;
		return k;
	};
	for (let i = 0; i < unique.length; i += 1) {
		for (let j = i + 1; j < unique.length; j += 1) {
			const a = unique[i] as string;
			const b = unique[j] as string;
			if (find(a) === find(b)) continue;
			if (connected(a, b)) group.set(unique[find(b)] as string, find(a));
		}
	}
	const sizes = new Map<number, number>();
	for (const id of unique) sizes.set(find(id), (sizes.get(find(id)) ?? 0) + 1);
	const largest = Math.max(...sizes.values());
	const leaders = [...sizes].filter(([, size]) => size === largest);
	if (leaders.length !== 1) return [];
	const main = (leaders[0] as [number, number])[0];
	return unique.filter((id) => find(id) !== main);
}

/** Whether a place has a spot an agent of this reach can stand at. */
function standsFree(
	id: string,
	spec: SceneSpec,
	obstacles: readonly PathObstacle[],
	placed: ReadonlyMap<string, PathObstacle>,
	openings: ReadonlyMap<string, SceneOpening>,
	reach: number,
): boolean {
	const grown = obstacles.map((item) => grownBox(item.shape, reach));
	return place(id, spec, placed, openings, reach).stands.some(
		(point) =>
			point.x >= reach - EPS &&
			point.x <= spec.bounds.width - reach + EPS &&
			point.y >= reach - EPS &&
			point.y <= spec.bounds.depth - reach + EPS &&
			!grown.some((box) => insideOpen(point, box)),
	);
}

/** What an object ultimately stands on (itself when on the floor). */
function rootSupport(
	id: string,
	spec: SceneSpec,
	placed: ReadonlyMap<string, PathObstacle>,
): string {
	const supportOf = new Map(
		spec.relations.flatMap((relation) =>
			relation.kind === "on" ? [[relation.subject, relation.support]] : [],
		),
	);
	let at = id;
	const seen = new Set<string>();
	for (
		let next = supportOf.get(at);
		next !== undefined;
		next = supportOf.get(at)
	) {
		if (seen.has(next) || !placed.has(next)) break;
		seen.add(next);
		at = next;
	}
	return at;
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
	// Something standing on a support (a lamp on a desk) is reached from
	// where one reaches the support it stands on.
	const item = placed.get(rootSupport(id, spec, placed)) as PathObstacle;
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
	// The room, pulled in by the agent's reach, is the router's window: its
	// grid lines stay inside it, so the walls need no boxes (boxes reaching
	// far outside the room would fill the router's bucket index with
	// floor area nobody walks on).
	const window = toBox({
		x0: reach,
		y0: reach,
		x1: width - reach,
		y1: depth - reach,
	});
	const found = findSparseGridPath(
		{ x: from.x * MM, y: from.y * MM },
		{ x: to.x * MM, y: to.y * MM },
		boxes.map(toBox),
		{ clearance: 2, bendPenalty: 200, window },
	);
	if (found === null) return undefined;
	const points = found.map((point) => ({ x: point.x / MM, y: point.y / MM }));
	// Trust but verify: no box entered, nothing past the pulled-in walls.
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
	// Corners that round to the same point are one corner.
	const corners: Vec2[] = [];
	for (const point of points) {
		const at = { x: round(point.x), y: round(point.y) };
		const last = corners.at(-1);
		if (last === undefined || last.x !== at.x || last.y !== at.y) {
			corners.push(at);
		}
	}

	const timing = timePath(corners, agent.speed, agent.accel, path.start ?? 0);
	// On terrain the corners lie on the ground.
	const ground =
		spec.terrain === undefined ? undefined : new GridTerrain(spec.terrain);
	return {
		id: path.id,
		agent: agent.id,
		from: path.from,
		to: path.to,
		points: corners.map((point) => [
			point.x,
			point.y,
			ground === undefined ? 0 : round(ground.heightNear(point.x, point.y)),
		]),
		length: round(length),
		width: round(2 * agent.radius),
		clearance: round(Math.max(0, room - agent.radius)),
		start: timing.start,
		times: timing.times.map(round),
		duration: round(timing.duration),
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
): { diagnostic: SceneDiagnostic; between?: [string, string] } {
	const try_ = (r: number) => {
		const found = route(spec, path, obstacles, placed, openings, r);
		return found === undefined ? undefined : joinLegs(found.legs).points;
	};
	let thin = try_(1e-4);
	if (thin === undefined) {
		// Even a point cannot get through: name the places (ends or vias)
		// with no free spot to stand at; else those cut off from the rest.
		const places = [path.from, ...path.via, path.to];
		let shut = places.filter(
			(id) => !standsFree(id, spec, obstacles, placed, openings, 1e-4),
		);
		if (shut.length === 0)
			shut = cutOff(
				places,
				(a, b) =>
					route(
						spec,
						{ ...path, from: a, via: [], to: b },
						obstacles,
						placed,
						openings,
						1e-4,
					) !== undefined,
			);
		const named = shut.map((id) => `"${id}"`).join(", ");
		return {
			diagnostic: {
				severity: "error",
				code: "scene.path.blocked",
				message:
					shut.length > 0
						? `"${agent.id}" cannot get from "${path.from}" to "${path.to}" at all: ${named} ${shut.length === 1 ? "is" : "are"} shut in.`
						: `"${agent.id}" cannot get from "${path.from}" to "${path.to}" at all: there is no way through between them.`,
				objects: shut.length > 0 ? shut : [path.from, path.to],
				path: path.path,
				hint:
					shut.length > 0
						? `Move what surrounds ${named}, or pick other places.`
						: "Open a way between the places, or pick other places.",
			},
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
	const diagnostic: SceneDiagnostic = {
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
	const wall = (what: string) =>
		what.startsWith("the ") ? `wall:${what.split(" ")[1]}` : what;
	if (first.what === "" || across.what === "") return { diagnostic };
	return { diagnostic, between: [wall(first.what), wall(across.what)] };
}

function name(what: string): string {
	return what.startsWith("the ") ? what : `"${what}"`;
}

/** `simplify`, but never dropping a fixed point (stands, vias). */
function simplifyKeeping(
	points: readonly Vec2[],
	fixed: readonly boolean[],
): Vec2[] {
	const out: Vec2[] = [];
	const pinned: boolean[] = [];
	points.forEach((point, k) => {
		const last = out.at(-1);
		const before = out.at(-2);
		if (last !== undefined && distance(last, point) < 1e-9) {
			pinned[pinned.length - 1] ||= fixed[k] === true;
			return;
		}
		if (
			last !== undefined &&
			before !== undefined &&
			pinned.at(-1) !== true &&
			Math.abs(
				(last.x - before.x) * (point.y - before.y) -
					(last.y - before.y) * (point.x - before.x),
			) < 1e-12 &&
			(last.x - before.x) * (point.x - last.x) +
				(last.y - before.y) * (point.y - last.y) >
				0
		) {
			out[out.length - 1] = point;
			pinned[pinned.length - 1] = fixed[k] === true;
			return;
		}
		out.push(point);
		pinned.push(fixed[k] === true);
	});
	return out;
}

function simplify(points: readonly Vec2[]): Vec2[] {
	const out: Vec2[] = [];
	for (const point of points) {
		const last = out.at(-1);
		if (last !== undefined && distance(last, point) < 1e-9) continue;
		const before = out.at(-2);
		// Only a corner the path runs straight on through is dropped; a
		// turn back on the same line (out to a `via` and back) is kept.
		if (
			last !== undefined &&
			before !== undefined &&
			Math.abs(
				(last.x - before.x) * (point.y - before.y) -
					(last.y - before.y) * (point.x - before.x),
			) < 1e-12 &&
			(last.x - before.x) * (point.x - last.x) +
				(last.y - before.y) * (point.y - last.y) >
				0
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
