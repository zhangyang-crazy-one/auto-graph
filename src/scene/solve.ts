import {
	GEO_REACH,
	type GeoFrame,
	geoFrame as makeGeoFrame,
	utmEpsg,
	utmScale,
	utmZone,
} from "./geo/index.js";
import {
	axisAngle,
	contains,
	direction,
	distance,
	dot,
	type Footprint,
	footprint,
	halfExtent,
	normalizeDegrees,
	overhang,
	penetration,
	sub,
	type Vec2,
} from "./geometry.js";
import type {
	GeoPoint,
	PlacedSceneObject,
	SceneDiagnostic,
	SceneObject,
	ScenePath,
	SceneRelation,
	SceneSpec,
	SolvedScene,
	SupportSpot,
	WallSide,
} from "./ir.js";
import { type FloorLayoutResult, layoutFloor } from "./layout.js";
import { layWaypoints, polylineLength, segmentHitsBox } from "./lines.js";
import { type PathBottleneck, planPaths } from "./paths.js";
import { GridTerrain } from "./terrain/index.js";

/** Lengths below this (0.1 mm) count as touching, not overlapping. */
const TOLERANCE = 1e-4;
/** Two turns closer than this (degrees) agree. */
const YAW_TOLERANCE = 0.01;
/** Turn-and-lay-out passes before the turns must have settled. */
const MAX_PASSES = 4;
/** Rounds of floor plan plus supports before turns must have settled. */
const MAX_ROUNDS = 4;
/** Ground rising more than this (m) under an upright object is reported. */
const UNEVEN = 0.1;
/** Times objects are moved to ground that meets their slope and elevation limits. */
const MASK_ROUNDS = 3;
/** Candidate spots tried per object when looking for such ground. */
const MASK_CANDIDATES = 40_000;

/** Latitude and longitude to 1e-9° (about 0.1 mm), height to 0.1 mm. */
function geoPoint(point: {
	lat: number;
	lon: number;
	alt?: number | undefined;
}): GeoPoint {
	return {
		lat: Math.round(point.lat * 1e9) / 1e9,
		lon: Math.round(point.lon * 1e9) / 1e9,
		alt: Math.round((point.alt ?? 0) * 1e4) / 1e4,
	};
}

/** Times the layout is solved again to make way for blocked paths. */
const MAKE_WAY_ROUNDS = 4;
/** Aisles are held this much wider than a path needs (stands, rounding). */
const AISLE_SLACK = 0.02;

/** Two things held apart for blocked paths (see `layoutFloor`). */
interface Aisle {
	between: [string, string];
	gap: number;
	paths: string[];
}

/**
 * The aisles so far, widened or joined by new bottlenecks. A thing at a
 * bottleneck that the floor plan cannot move itself (an object standing
 * on a support) is replaced by what it stands on; pairs the floor plan
 * cannot hold apart (two walls, a pinned object) are left out.
 */
function widen(
	aisles: readonly Aisle[],
	bottlenecks: readonly PathBottleneck[],
	comfortable: boolean,
	floorOf: (id: string) => string | undefined,
): Aisle[] {
	const out = aisles.map((aisle) => ({ ...aisle, paths: [...aisle.paths] }));
	for (const bottleneck of bottlenecks) {
		const a = floorOf(bottleneck.between[0]);
		const b = floorOf(bottleneck.between[1]);
		if (a === undefined || b === undefined || a === b) continue;
		if (a.startsWith("wall:") && b.startsWith("wall:")) continue;
		const pair = [a, b].sort() as [string, string];
		const gap =
			bottleneck.needs +
			AISLE_SLACK +
			(comfortable ? 2 * bottleneck.comfort : 0);
		const known = out.find(
			(aisle) => aisle.between[0] === pair[0] && aisle.between[1] === pair[1],
		);
		if (known === undefined) {
			out.push({ between: pair, gap, paths: [bottleneck.path] });
			continue;
		}
		known.gap = Math.max(known.gap, gap);
		if (!known.paths.includes(bottleneck.path))
			known.paths.push(bottleneck.path);
	}
	return out;
}

/** Blocked paths, each with how much width it is missing (∞: shut in). */
function blockage(
	diagnostics: readonly SceneDiagnostic[],
): Map<string, number> {
	const out = new Map<string, number>();
	for (const d of diagnostics) {
		if (d.code !== "scene.path.blocked") continue;
		const width = d.detail?.width;
		const needs = d.detail?.needs;
		out.set(
			JSON.stringify(d.path ?? []),
			typeof width === "number" && typeof needs === "number"
				? needs - width
				: Number.POSITIVE_INFINITY,
		);
	}
	return out;
}

/**
 * Whether `after` is a step forward from `before`: no path blocked that
 * was clear, and fewer paths blocked, or less width missing, or (a path
 * with several narrow places) the narrowest one passed for another.
 */
function progress(
	before: readonly SceneDiagnostic[],
	after: readonly SceneDiagnostic[],
	aisles: readonly Aisle[],
): boolean {
	const was = blockage(before);
	const now = blockage(after);
	if ([...now.keys()].some((key) => !was.has(key))) return false;
	if (now.size < was.size) return true;
	const missing = (map: Map<string, number>) =>
		[...map.values()].reduce((sum, value) => sum + value, 0);
	if (missing(now) < missing(was) - 1e-6) return true;
	// Same count and shortfall: progress only if the narrowest places are
	// new ones (the old ones are held open now).
	const held = new Set(aisles.map((aisle) => aisle.between.join("|")));
	const places = (list: readonly SceneDiagnostic[]) =>
		list
			.filter((d) => d.code === "scene.path.blocked")
			.map((d) => [...(d.objects ?? [])].sort().join("|"));
	const before_ = new Set(places(before));
	return places(after).some((key) => !before_.has(key) && !held.has(key));
}

/** Fewer paths blocked, or as many with less width missing. */
function better(
	before: readonly SceneDiagnostic[],
	after: readonly SceneDiagnostic[],
): boolean {
	const was = blockage(before);
	const now = blockage(after);
	if (now.size !== was.size) return now.size < was.size;
	const missing = (map: Map<string, number>) =>
		[...map.values()].reduce((sum, value) => sum + value, 0);
	return missing(now) < missing(was) - 1e-6;
}

/** Whether an aisle is as wide as it should be in the final layout. */
function aisleHolds(
	aisle: Aisle,
	placed: ReadonlyMap<string, Placement>,
	spec: SceneSpec,
): boolean {
	const box = (id: string) => {
		const placement = placed.get(id);
		return placement === undefined ? undefined : output(placement).aabb;
	};
	const [a, b] = aisle.between;
	const need = aisle.gap - 1e-6;
	if (b.startsWith("wall:") || a.startsWith("wall:")) {
		const wall = (a.startsWith("wall:") ? a : b).slice(5);
		const it = box(a.startsWith("wall:") ? b : a);
		if (it === undefined) return false;
		const { width, depth } = spec.bounds;
		const gap =
			wall === "west"
				? it.min[0]
				: wall === "east"
					? width - it.max[0]
					: wall === "south"
						? it.min[1]
						: depth - it.max[1];
		return gap >= need;
	}
	const p = box(a);
	const q = box(b);
	if (p === undefined || q === undefined) return false;
	const apart = (k: 0 | 1) =>
		Math.max(p.min[k] - q.max[k], q.min[k] - p.max[k]);
	return Math.max(apart(0), apart(1)) >= need;
}

/**
 * Whether `after` is worse than `before` on any check other than paths:
 * a problem that was not there (same check, same objects), a warning
 * that became an error, or a measure that grew (how far past a wall, how
 * deep a collision, how far an overhang, how short a gap). One problem
 * going away never pays for another appearing.
 */
function worseOnOtherChecks(
	before: readonly SceneDiagnostic[],
	after: readonly SceneDiagnostic[],
): boolean {
	const known = new Map<string, { rank: number; badness: number }>();
	for (const diagnostic of before) {
		const key = problemKey(diagnostic);
		if (key === undefined) continue;
		const seen = known.get(key);
		known.set(key, {
			rank: Math.max(severityRank(diagnostic), seen?.rank ?? 0),
			badness: Math.max(badness(diagnostic), seen?.badness ?? 0),
		});
	}
	return after.some((diagnostic) => {
		const key = problemKey(diagnostic);
		if (key === undefined) return false;
		const was = known.get(key);
		return (
			was === undefined ||
			severityRank(diagnostic) > was.rank ||
			badness(diagnostic) > was.badness + 1e-6
		);
	});
}

/** The check and the objects it is about; undefined for paths and info. */
function problemKey(diagnostic: SceneDiagnostic): string | undefined {
	if (
		diagnostic.severity === "info" ||
		diagnostic.code.startsWith("scene.path.")
	) {
		return undefined;
	}
	const objects = [...(diagnostic.objects ?? [])].sort().join(",");
	return `${diagnostic.code}|${objects}|${JSON.stringify(diagnostic.path ?? [])}`;
}

function severityRank(diagnostic: SceneDiagnostic): number {
	return diagnostic.severity === "error" ? 2 : 1;
}

/** How bad a problem is, in meters (0 when it carries no measure). */
function badness(diagnostic: SceneDiagnostic): number {
	const detail = diagnostic.detail ?? {};
	const number = (key: string) =>
		typeof detail[key] === "number" ? (detail[key] as number) : undefined;
	const past = number("past") ?? number("overhang") ?? number("depth");
	if (past !== undefined) return past;
	const gap = number("gap");
	const need = number("minGap") ?? number("clearance");
	return gap !== undefined && need !== undefined ? Math.max(need - gap, 0) : 0;
}

/** Compass directions as angles counter-clockwise from east. */
const COMPASS: Record<WallSide, number> = {
	east: 0,
	north: 90,
	west: 180,
	south: -90,
};

/** Which way an object's front points when its back is to a wall. */
const AWAY_FROM_WALL: Record<WallSide, number> = {
	north: -90,
	south: 90,
	east: 180,
	west: 0,
};

interface Placement {
	object: SceneObject;
	center: Vec2;
	z: number;
	/** Height of the ground under its center (0 on a flat floor). */
	ground: number;
	yaw: number;
	shape: Footprint;
	support?: string;
	/** Leaning with the slope (`align to slope`). */
	tilt?: Tilt;
}

/** A lean: the object's up axis, and the rotation taking z to it. */
interface Tilt {
	up: [number, number, number];
	quaternion: [number, number, number, number];
}

/** The lean that stands an object square on ground with this gradient. */
function tiltFor(gradient: Vec2): Tilt {
	const norm = Math.hypot(gradient.x, gradient.y, 1);
	const up: [number, number, number] = [
		-gradient.x / norm,
		-gradient.y / norm,
		1 / norm,
	];
	// About the horizontal axis z × up, by the angle between them.
	const across = Math.hypot(up[0], up[1]);
	if (across < 1e-15) return { up: [0, 0, 1], quaternion: [0, 0, 0, 1] };
	const angle = Math.atan2(across, up[2]);
	const s = Math.sin(angle / 2);
	return {
		up,
		quaternion: [
			(-up[1] / across) * s,
			(up[0] / across) * s,
			0,
			Math.cos(angle / 2),
		],
	};
}

/** How far below its bottom center a leaning box's lowest corner is (≤ 0). */
function lowestCorner(
	size: readonly [number, number, number],
	yaw: number,
	tilt: Tilt,
): number {
	const half = (yaw * Math.PI) / 360;
	const q = multiply(tilt.quaternion, [0, 0, Math.sin(half), Math.cos(half)]);
	let low = 0;
	for (const sx of [-1, 1]) {
		for (const sy of [-1, 1]) {
			low = Math.min(
				low,
				rotate(q, [(sx * size[0]) / 2, (sy * size[1]) / 2, 0])[2],
			);
		}
	}
	return low;
}

/** Hamilton product a ⊗ b of quaternions [x, y, z, w]. */
function multiply(
	a: readonly [number, number, number, number],
	b: readonly [number, number, number, number],
): [number, number, number, number] {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

/** A vector turned by a unit quaternion [x, y, z, w]. */
function rotate(
	q: readonly [number, number, number, number],
	v: readonly [number, number, number],
): [number, number, number] {
	const [x, y, z, w] = q;
	// v + 2w(q × v) + 2 q × (q × v)
	const cx = y * v[2] - z * v[1];
	const cy = z * v[0] - x * v[2];
	const cz = x * v[1] - y * v[0];
	return [
		v[0] + 2 * (w * cx + y * cz - z * cy),
		v[1] + 2 * (w * cy + z * cx - x * cz),
		v[2] + 2 * (w * cz + x * cy - y * cx),
	];
}

/** The rotation of a placement: its turn about z, then its lean. */
function rotationOf(item: Placement): [number, number, number, number] {
	const half = (item.yaw * Math.PI) / 360;
	const turn: [number, number, number, number] = [
		0,
		0,
		Math.sin(half),
		Math.cos(half),
	];
	return item.tilt === undefined ? turn : multiply(item.tilt.quaternion, turn);
}

/**
 * Solve a scene: where every object stands, which way it faces, and
 * whether the result holds up.
 *
 * - Supports: `on` relations form a forest; an object stands on top of its
 *   support (z = support top) at its `at` spot, the rest on the floor.
 * - Floor plan: relations become separation constraints on each axis (see
 *   `layoutFloor`); pinned positions are fixed offsets from the walls.
 * - Turns: a pinned `yaw`, `rotate` or `facing` (the nearest point of an
 *   object) decides; otherwise `around` faces the center, `against wall`
 *   turns the back to the wall, and an object on a support turns with it.
 *   Turns that depend on positions are settled by re-running the layout.
 * - Checks: interpenetration (separating axes), objects past the walls or
 *   ceiling, objects whose center is off their support, relations that
 *   cannot hold together, `keep clear`; overhangs and `minGap` warn.
 *
 * `valid` is false when any check fails; the geometry is still returned
 * so the failure can be seen.
 */
export function solveScene(spec: SceneSpec): SolvedScene {
	const diagnostics: SceneDiagnostic[] = [];
	const byId = new Map(spec.objects.map((object) => [object.id, object]));
	const order = new Map(
		spec.objects.map((object, index) => [object.id, index]),
	);

	const supports = supportForest(spec, diagnostics);
	const depth = (id: string): number => {
		let count = 0;
		for (let at = supports.get(id); at !== undefined; at = supports.get(at)) {
			count += 1;
		}
		return count;
	};
	const sequence = [...spec.objects].sort(
		(a, b) =>
			depth(a.id) - depth(b.id) ||
			(order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
	);

	const floor = spec.objects.filter((object) => !supports.has(object.id));
	const pinnedCenter = (id: string): Vec2 | undefined => {
		const pinned = byId.get(id)?.position;
		return pinned === undefined ? undefined : { x: pinned[0], y: pinned[1] };
	};
	const hasSymmetric = spec.relations.some(
		(relation) => relation.kind === "symmetric",
	);
	// The ground: objects on the floor stand on it, those aligned to the
	// slope lean with it.
	const terrain =
		spec.terrain === undefined ? undefined : new GridTerrain(spec.terrain);
	const aligned = new Set(
		spec.relations.flatMap((relation) =>
			relation.kind === "ground" && relation.align ? [relation.subject] : [],
		),
	);
	const groundAt = (point: Vec2): number =>
		terrain === undefined ? 0 : terrain.heightNear(point.x, point.y);
	// Fixed leans (`tilt`), toward each object's front.
	const tilted = new Map<string, number>();
	for (const relation of spec.relations) {
		if (relation.kind !== "tilt") continue;
		const before = tilted.get(relation.subject);
		if (before !== undefined && Math.abs(before - relation.degrees) > 1e-9) {
			diagnostics.push({
				severity: "error",
				code: "scene.tilt.conflict",
				message: `"${relation.subject}" is tilted both ${before}° and ${relation.degrees}°.`,
				objects: [relation.subject],
				path: relation.path,
				hint: "Keep one tilt.",
			});
			continue;
		}
		if (aligned.has(relation.subject)) {
			diagnostics.push({
				severity: "error",
				code: "scene.tilt.conflict",
				message: `"${relation.subject}" both leans with the slope and is tilted ${relation.degrees}°; it keeps the slope.`,
				objects: [relation.subject],
				path: relation.path,
				hint: "Keep `align to slope` or `tilt`, not both.",
			});
			continue;
		}
		tilted.set(relation.subject, relation.degrees);
	}

	/**
	 * One round: lay out the floor plan, then stand every object on its
	 * support. Turns that face an object need that object's position, so a
	 * round reads the positions of the previous one (`prior`) wherever the
	 * current one has none yet; rounds repeat until no turn changes.
	 */
	const solveRound = (
		prior: ReadonlyMap<string, Placement> | undefined,
		aisles: readonly Aisle[],
		layoutSpec: SceneSpec,
	) => {
		const found: SceneDiagnostic[] = [];
		const priorShape = (id: string) => prior?.get(id)?.shape;
		const priorFloor =
			prior === undefined
				? undefined
				: new Map(
						floor.flatMap((object) => {
							const center = prior.get(object.id)?.center;
							return center === undefined ? [] : [[object.id, center]];
						}),
					);

		// Floor plan: turn, lay out, and turn again from the new positions
		// (facing and around depend on where things are) until turns settle.
		let layout: FloorLayoutResult | undefined;
		let yaws = new Map<string, number>();
		for (let pass = 0; pass < MAX_PASSES; pass += 1) {
			const centers = layout?.centers;
			const lookup = (id: string) =>
				centers?.get(id) ?? prior?.get(id)?.center ?? pinnedCenter(id);
			const next = new Map(
				floor.map((object) => [
					object.id,
					resolveYaw(object, spec, undefined, lookup, [], (id) => {
						const center = centers?.get(id);
						const target = byId.get(id);
						return center === undefined || target === undefined
							? priorShape(id)
							: footprint(center, target.size, yaws.get(id) ?? 0);
					}),
				]),
			);
			const settled =
				layout !== undefined &&
				(pass >= 2 || !hasSymmetric) &&
				floor.every(
					(object) =>
						angleGap(next.get(object.id) ?? 0, yaws.get(object.id) ?? 0) <=
						YAW_TOLERANCE,
				);
			if (settled) break;
			yaws = next;
			// The first pass starts from the last round's floor plan, so a
			// round only refines it.
			const start = centers ?? priorFloor;
			layout = layoutFloor({
				spec: layoutSpec,
				floor,
				yaw: yaws,
				aisles,
				...(start === undefined ? {} : { previous: start }),
			});
		}
		found.push(...(layout?.diagnostics ?? []));
		const floorCenters = layout?.centers ?? new Map<string, Vec2>();

		const placed = new Map<string, Placement>();
		const centerOf = (id: string): Vec2 | undefined =>
			placed.get(id)?.center ??
			floorCenters.get(id) ??
			prior?.get(id)?.center ??
			pinnedCenter(id);
		const shapeOf = (id: string): Footprint | undefined => {
			const done = placed.get(id)?.shape;
			if (done !== undefined) return done;
			const center = floorCenters.get(id);
			const target = byId.get(id);
			return center === undefined || target === undefined
				? priorShape(id)
				: footprint(center, target.size, yaws.get(id) ?? 0);
		};

		for (const object of sequence) {
			const supportId = supports.get(object.id);
			const support =
				supportId === undefined ? undefined : placed.get(supportId);
			if (supportId !== undefined && support === undefined) continue;
			const pinned = floorCenters.get(object.id) ?? pinnedCenter(object.id);
			const spot = (yaw: number): Vec2 | undefined => {
				if (pinned !== undefined) return pinned;
				if (support === undefined) return undefined;
				const on = spec.relations.find(
					(relation) =>
						relation.kind === "on" && relation.subject === object.id,
				) as Extract<SceneRelation, { kind: "on" }> | undefined;
				return spotCenter(
					support,
					support.object,
					footprint({ x: 0, y: 0 }, object.size, yaw),
					on?.at ?? "center",
				);
			};
			// Where it stands depends on its turn (its extent on the support),
			// and a turn that faces something on where it stands: guess the
			// spot from the last turn, turn, then take the spot again.
			const guess =
				spot(prior?.get(object.id)?.yaw ?? support?.yaw ?? 0) ??
				prior?.get(object.id)?.center;
			const yaw = resolveYaw(
				object,
				spec,
				support,
				(id) => (id === object.id ? guess : centerOf(id)),
				found,
				shapeOf,
			);
			const center = spot(yaw);
			if (center === undefined) continue;
			const shape = footprint(center, object.size, yaw);
			const ground = groundAt(center);
			// On the floor: on the ground, square to its slope if aligned. A
			// fixed tilt leans it toward its front, lifted so its lowest
			// corner is at the height it stands on.
			const degrees = tilted.get(object.id);
			const front = ((yaw + axisAngle(object.front)) * Math.PI) / 180;
			const lean =
				degrees === undefined ? 0 : Math.tan((degrees * Math.PI) / 180);
			const tilt =
				support === undefined && terrain !== undefined && aligned.has(object.id)
					? tiltFor(terrain.planeUnder(shape))
					: degrees !== undefined && degrees > 0
						? tiltFor({
								x: -lean * Math.cos(front),
								y: -lean * Math.sin(front),
							})
						: undefined;
			const base =
				support === undefined ? ground : support.z + support.object.size[2];
			const lift =
				degrees !== undefined && tilt !== undefined
					? -lowestCorner(object.size, yaw, tilt)
					: 0;
			placed.set(object.id, {
				object,
				center,
				z: base + lift,
				ground,
				yaw,
				shape,
				...(supportId === undefined ? {} : { support: supportId }),
				...(tilt === undefined ? {} : { tilt }),
			});
		}
		return { placed, found };
	};

	/**
	 * Lay out, check and plan paths, with the given aisles held open and
	 * the given objects held at spots (ground that meets their limits).
	 */
	const attempt = (
		aisles: readonly Aisle[],
		spots: ReadonlyMap<string, Spot> = new Map(),
	) => {
		const layoutSpec: SceneSpec =
			spots.size === 0
				? spec
				: {
						...spec,
						relations: [
							...spec.relations,
							...[...spots].map(
								([subject, held]): SceneRelation => ({
									kind: "at-point",
									subject,
									point: held.point,
									from: "ground that meets its limits",
									path: held.path,
								}),
							),
						],
					};
		let result = solveRound(undefined, aisles, layoutSpec);
		for (let again = 1; again < MAX_ROUNDS; again += 1) {
			const next = solveRound(result.placed, aisles, layoutSpec);
			const settled = [...next.placed].every(([id, placement]) => {
				const before = result.placed.get(id);
				return (
					before !== undefined &&
					angleGap(before.yaw, placement.yaw) <= YAW_TOLERANCE &&
					Math.hypot(
						before.center.x - placement.center.x,
						before.center.y - placement.center.y,
					) <= 1e-9
				);
			});
			result = next;
			if (settled) break;
		}
		const placed = result.placed;
		const found = [...result.found];

		// No output carries a number that is not finite: an object whose
		// position, turn or box overflows (sizes near the largest double) is
		// left out, listed as unplaced, and reported.
		const broken = new Set<string>();
		for (const placement of placed.values()) {
			const out = output(placement);
			const numbers = [
				...out.position,
				out.yaw,
				...out.quaternion,
				...out.size,
				...out.aabb.min,
				...out.aabb.max,
			];
			if (numbers.every(Number.isFinite)) continue;
			broken.add(placement.object.id);
			found.push({
				severity: "error",
				code: "scene.non-finite",
				message: `"${placement.object.id}" ends up at a position, turn or size that is not a finite number; it is left out.`,
				objects: [placement.object.id],
				path: placement.object.path,
				hint: "Use sizes, gaps and angles of reasonable magnitude.",
			});
		}
		for (const id of broken) placed.delete(id);

		check(spec, placed, found);
		if (terrain !== undefined) checkTerrain(spec, terrain, placed, found);
		// A leaning object's lowest point decides what passes under it.
		const obstacles = new Map(
			[...placed].map(([id, item]) => [
				id,
				item.tilt === undefined
					? item
					: { ...item, bottom: heightRange(item)[0] },
			]),
		);
		const planned = planPaths(spec, obstacles);
		found.push(...planned.diagnostics);
		return { placed, broken, found, planned };
	};

	// Paths shape the layout: where a path is blocked, the two things at
	// its bottleneck are held apart as wide as it needs, and the layout is
	// solved again. A new layout is kept only if it makes progress (fewer
	// paths blocked, less width missing, or a narrow place passed for the
	// next one), blocks no path that was clear, and no other check got
	// worse (see `worseOnOtherChecks`).
	type Attempt = ReturnType<typeof attempt>;
	const floorOf = (id: string): string | undefined => {
		if (id.startsWith("wall:")) return id;
		let at = id;
		const seen = new Set<string>();
		for (let up = supports.get(at); up !== undefined; up = supports.get(at)) {
			if (seen.has(up)) return undefined;
			seen.add(up);
			at = up;
		}
		return byId.has(at) && byId.get(at)?.position === undefined
			? at
			: undefined;
	};
	let best = attempt([]);
	// Objects on ground that breaks their slope or elevation limits move
	// to the nearest spot that meets them, where nothing else fixes them.
	// All at once first; if that makes another check worse (a spot that
	// fights a relation or pin), one at a time, keeping each that helps.
	let spots = new Map<string, Spot>();
	/** Objects given a new spot (the others held are kept where they were). */
	const moved = new Set<string>();
	const others = (found: readonly SceneDiagnostic[]) =>
		found.filter((d) => !isMaskProblem(d));
	// A step helps when objects come within their limits and none leaves
	// them (one fixed never pays for another broken), and nothing else got
	// worse.
	const helps = (from: Attempt, to: Attempt) => {
		const before = offLimits(from.found);
		const after = offLimits(to.found);
		return (
			after.size < before.size &&
			[...after].every((id) => before.has(id)) &&
			!worseOnOtherChecks(others(from.found), others(to.found))
		);
	};
	for (let k = 0; terrain !== undefined && k < MASK_ROUNDS; k += 1) {
		const off = best.found.filter(isMaskProblem);
		if (off.length === 0) break;
		const shapes = new Map(
			[...best.placed].map(([id, item]) => [id, item.shape]),
		);
		const ids = [...new Set(off.flatMap((d) => d.objects ?? []))].sort(
			(a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
		);
		const wanted: [string, Spot][] = [];
		for (const id of ids) {
			const item = best.placed.get(id);
			if (item === undefined || item.support !== undefined) continue;
			if (item.object.position !== undefined) continue;
			const limits = limitsOf(spec, id);
			const spot = findSpot(spec, terrain, item, limits, shapes, best.placed);
			if (spot === undefined) continue;
			wanted.push([id, { point: spot, path: limits.path }]);
			shapes.set(id, footprint(spot, item.object.size, item.yaw));
		}
		if (wanted.length === 0) break;
		for (const [id] of wanted) moved.add(id);
		// Objects already within their limits stay where they are, so the
		// moves (held apart from them by the layout) do not push them off.
		const stay: [string, Spot][] = [];
		for (const item of best.placed.values()) {
			const id = item.object.id;
			if (spots.has(id) || ids.includes(id)) continue;
			if (item.support !== undefined || item.object.position !== undefined) {
				continue;
			}
			const limits = limitsOf(spec, id);
			if (limits.path.length === 0) continue;
			stay.push([id, { point: item.center, path: limits.path }]);
		}
		// The stays are kept only with a move that is.
		const base = new Map([...spots, ...stay]);
		const all = new Map([...base, ...wanted]);
		const together = attempt([], all);
		if (helps(best, together)) {
			best = together;
			spots = all;
			continue;
		}
		let step = best;
		let kept = base;
		for (const [id, spot] of wanted) {
			const trial = new Map(kept).set(id, spot);
			const tried = attempt([], trial);
			if (helps(step, tried)) {
				step = tried;
				kept = trial;
			}
		}
		if (kept === base) {
			for (const [id] of wanted) moved.delete(id);
			break;
		}
		best = step;
		spots = kept;
	}
	const held = spots;
	let aisles: Aisle[] = [];
	// Steps may pass one narrow place to reach the next; what is kept in
	// the end is the best layout seen (the original on a tie).
	let kept = { result: best, aisles };
	for (let k = 0; spec.makeWay && k < MAKE_WAY_ROUNDS; k += 1) {
		const wanted = best.planned.bottlenecks;
		if (wanted.length === 0) break;
		// A comfortable aisle first, the bare width if that does not fit.
		let accepted: { aisles: Aisle[]; result: Attempt } | undefined;
		for (const comfortable of [true, false]) {
			const next = widen(aisles, wanted, comfortable, floorOf);
			const same =
				next.length === aisles.length &&
				next.every((aisle, i) => aisle.gap === aisles[i]?.gap);
			if (same) continue;
			const tried = attempt(next, held);
			if (
				progress(best.found, tried.found, aisles) &&
				!worseOnOtherChecks(best.found, tried.found)
			) {
				accepted = { aisles: next, result: tried };
				break;
			}
		}
		if (accepted === undefined) break;
		best = accepted.result;
		aisles = accepted.aisles;
		if (better(kept.result.found, best.found)) kept = { result: best, aisles };
	}
	best = kept.result;
	aisles = kept.aisles;
	const { placed, broken } = best;
	diagnostics.push(...best.found);
	const stillBlocked = new Set(
		best.found
			.filter((d) => d.code === "scene.path.blocked")
			.map((d) => spec.paths[Number(d.path?.[1])]?.id),
	);
	// Only the aisles that hold in the final layout are reported.
	for (const held of aisles) {
		// Reported for the paths it lets through, where it holds.
		const aisle = {
			...held,
			paths: held.paths.filter((id) => !stillBlocked.has(id)),
		};
		if (aisle.paths.length === 0 || !aisleHolds(aisle, placed, spec)) continue;
		const [a, b] = aisle.between.map((what) =>
			what.startsWith("wall:") ? `the ${what.slice(5)} wall` : `"${what}"`,
		);
		diagnostics.push({
			severity: "info",
			code: "scene.path.made-way",
			message: `${a} and ${b} are kept ${round(aisle.gap)} m apart so ${aisle.paths.map((id) => `"${id}"`).join(", ")} can get through.`,
			objects: aisle.between.filter((what) => !what.startsWith("wall:")),
			path: ["paths"],
			hint: "Set `makeWay: false` to keep the layout as the relations alone leave it.",
			detail: { gap: round(aisle.gap) },
		});
	}

	// Objects moved to ground that meets their limits, where it does.
	for (const [id, spot] of held) {
		const item = placed.get(id);
		if (item === undefined || !moved.has(id)) continue;
		if (best.found.some((d) => isMaskProblem(d) && d.objects?.includes(id))) {
			continue;
		}
		diagnostics.push({
			severity: "info",
			code: "scene.terrain.moved",
			message: `"${id}" stands at (${round(spot.point.x)}, ${round(spot.point.y)}), the nearest place where the ground meets its slope and elevation limits.`,
			objects: [id],
			path: spot.path,
			hint: "Pin it or relate it to something to place it yourself.",
		});
	}

	const unplaced = spec.objects
		.filter((object) => !placed.has(object.id))
		.map((object) => object.id);
	for (const id of unplaced) {
		if (broken.has(id)) continue;
		const object = byId.get(id) as SceneObject;
		const supportId = supports.get(id);
		diagnostics.push({
			severity: "info",
			code: "scene.position.missing",
			message:
				supportId !== undefined && !placed.has(supportId)
					? `"${id}" stands on "${supportId}", which has no position.`
					: `"${id}" has no position.`,
			objects: [id],
			path: object.path,
			hint: "Give its support a place, or remove the `on` relation.",
		});
	}
	// A scene placed on the Earth: geographic positions on the output; a
	// note of the projection when one was chosen for a large site; a
	// warning when a local frame reaches too far, or a UTM site spans zones.
	const geoFrame =
		spec.frame === undefined ? undefined : makeGeoFrame(spec.frame);
	if (spec.frame !== undefined && geoFrame !== undefined) {
		diagnostics.push(...projectionNotes(spec, geoFrame));
	}
	// A spec built without `projection` (by hand, or from before it) is on
	// a local frame.
	if (
		spec.frame !== undefined &&
		(spec.frame.projection?.kind ?? "enu") === "enu"
	) {
		const { anchor } = spec.frame;
		const corners = [
			[0, 0],
			[spec.bounds.width, 0],
			[0, spec.bounds.depth],
			[spec.bounds.width, spec.bounds.depth],
		];
		const reach = Math.max(
			...corners.map(([x = 0, y = 0]) =>
				Math.hypot(x - anchor.x, y - anchor.y),
			),
			...(spec.landmarks ?? []).map((landmark) =>
				Math.hypot(
					landmark.position.x - anchor.x,
					landmark.position.y - anchor.y,
				),
			),
		);
		if (reach > GEO_REACH) {
			diagnostics.push({
				severity: "warning",
				code: "scene.geo.extent",
				message: `The scene reaches ${round(reach / 1000)} km from its origin; one local frame is meant for sites within ${GEO_REACH / 1000} km.`,
				path: ["frame"],
				hint: "Leave `frame.projection` at `auto` (or set `utm`) to put a large site on a map projection, or split it into scenes with their own origins.",
				detail: { reach: round(reach) },
			});
		}
	}
	const objects = spec.objects.flatMap((object) => {
		const placement = placed.get(object.id);
		if (placement === undefined) return [];
		const out = output(placement);
		if (geoFrame === undefined) return [out];
		const [x, y, z] = out.position;
		return [{ ...out, geo: geoPoint(geoFrame.toGeo(x, y, z)) }];
	});
	// Lines lie on the ground; waypoints fly above it.
	const groundUnder = (x: number, y: number) =>
		terrain === undefined ? 0 : terrain.heightNear(x, y);
	const lines = (spec.lines ?? []).map((line) => ({
		id: line.id,
		points: line.points.map((p): [number, number, number] => [
			round(p.x),
			round(p.y),
			round(groundUnder(p.x, p.y)),
		]),
		length: round(polylineLength(line.points)),
	}));
	const step =
		terrain === undefined
			? undefined
			: Math.min(terrain.grid.spacing.x, terrain.grid.spacing.y) / 8;
	const waypoints = (spec.waypoints ?? []).flatMap((set) => {
		const line = spec.lines?.find((item) => item.id === set.line);
		if (line === undefined) return [];
		const laid = layWaypoints(line.points, {
			...(set.spacing === undefined ? {} : { spacing: set.spacing }),
			...(set.count === undefined ? {} : { count: set.count }),
			height: set.height,
			ground: groundUnder,
			...(step === undefined ? {} : { step }),
		});
		if (laid.lowest < set.min - 1e-9) {
			diagnostics.push({
				severity: "warning",
				code: "scene.waypoint.low",
				message: `Between waypoints "${set.id}" comes down to ${round(laid.lowest)} m above the ground; it must keep ${round(set.min)} m.`,
				path: set.path,
				hint: "Fly higher, put waypoints closer together, or lower `min`.",
				detail: { lowest: round(laid.lowest), min: round(set.min) },
			});
		}
		// Legs that pass through an object.
		const hit = new Set<string>();
		for (let k = 1; k < laid.points.length; k += 1) {
			const a = laid.points[k - 1] as [number, number, number];
			const b = laid.points[k] as [number, number, number];
			for (const object of objects) {
				if (!hit.has(object.id) && segmentHitsBox(a, b, object.aabb)) {
					hit.add(object.id);
				}
			}
		}
		if (hit.size > 0) {
			diagnostics.push({
				severity: "warning",
				code: "scene.waypoint.collision",
				message: `Waypoints "${set.id}" fly through ${[...hit].map((id) => `"${id}"`).join(", ")}.`,
				objects: [...hit],
				path: set.path,
				hint: "Fly higher, or move the line clear of them.",
			});
		}
		const points = laid.points.map(([x, y, z]): [number, number, number] => [
			round(x),
			round(y),
			round(z),
		]);
		return [
			{
				id: set.id,
				line: set.line,
				height: round(set.height),
				points,
				...(geoFrame === undefined
					? {}
					: {
							geo: laid.points.map(([x, y, z]) =>
								geoPoint(geoFrame.toGeo(x, y, z)),
							),
						}),
				lowest: round(laid.lowest),
			},
		];
	});
	const rank = { error: 0, warning: 1, info: 2 } as const;
	const sorted = diagnostics
		.map((diagnostic, index) => ({ diagnostic, index }))
		.sort(
			(a, b) =>
				rank[a.diagnostic.severity] - rank[b.diagnostic.severity] ||
				a.index - b.index,
		)
		.map(({ diagnostic }) => diagnostic);

	return {
		name: spec.name,
		bounds: spec.bounds,
		objects,
		openings: spec.openings.map(({ id, wall, at, width }) => ({
			id,
			wall,
			at,
			width,
		})),
		agents: spec.agents.map(({ id, radius, height, speed, accel }) => ({
			id,
			radius: round(radius),
			height: round(height),
			// Exact: the timing on the paths is computed from these, and
			// exporters (Blender's keyframes) recompute it from the output.
			speed,
			accel,
		})),
		paths: best.planned.paths,
		...(lines.length === 0 ? {} : { lines }),
		...(waypoints.length === 0 ? {} : { waypoints }),
		...(spec.terrain === undefined
			? {}
			: {
					terrain: {
						origin: [
							round(spec.terrain.origin.x),
							round(spec.terrain.origin.y),
						] as [number, number],
						spacing: [
							round(spec.terrain.spacing.x),
							round(spec.terrain.spacing.y),
						] as [number, number],
						base: round(spec.terrain.base),
						heights: spec.terrain.heights.map((row) => row.map(round)),
					},
				}),
		...(spec.frame === undefined
			? {}
			: {
					geo: {
						origin: geoPoint(spec.frame.origin),
						datum: spec.frame.datum,
						anchor: [
							round(spec.frame.anchor.x),
							round(spec.frame.anchor.y),
						] as [number, number],
						heading: spec.frame.heading,
						projection: outputProjection(
							spec.frame.projection ?? { kind: "enu" },
						),
					},
					landmarks: (spec.landmarks ?? []).map((landmark) => ({
						id: landmark.id,
						position: [
							round(landmark.position.x),
							round(landmark.position.y),
						] as [number, number],
						geo: geoPoint(landmark.geo),
					})),
				}),
		unplaced,
		valid: !sorted.some((diagnostic) => diagnostic.severity === "error"),
		diagnostics: sorted,
	};
}

/** Support of each object; repeated supports and cycles are reported and dropped. */
function supportForest(
	spec: SceneSpec,
	diagnostics: SceneDiagnostic[],
): Map<string, string> {
	const supports = new Map<string, string>();
	const firstPath = new Map<string, ScenePath>();
	for (const relation of spec.relations) {
		if (relation.kind !== "on") continue;
		const earlier = supports.get(relation.subject);
		if (earlier !== undefined) {
			if (earlier !== relation.support) {
				diagnostics.push({
					severity: "error",
					code: "scene.support.multiple",
					message: `"${relation.subject}" is on "${earlier}" and on "${relation.support}".`,
					objects: [relation.subject, earlier, relation.support],
					path: relation.path,
					hint: `Keep one support; the first is at ${(firstPath.get(relation.subject) ?? []).join(".")}.`,
				});
			}
			continue;
		}
		supports.set(relation.subject, relation.support);
		firstPath.set(relation.subject, relation.path);
	}
	for (const object of spec.objects) {
		const seen = [object.id];
		for (
			let at = supports.get(object.id);
			at !== undefined;
			at = supports.get(at)
		) {
			if (at === object.id) {
				diagnostics.push({
					severity: "error",
					code: "scene.support.cycle",
					message: `Objects stand on each other in a loop: ${[...seen, at].join(" on ")}.`,
					objects: seen,
					...pathOf(firstPath.get(object.id)),
					hint: "Remove one `on` relation from the loop.",
				});
				for (const id of seen) supports.delete(id);
				break;
			}
			if (seen.includes(at)) break;
			seen.push(at);
		}
	}
	return supports;
}

function resolveYaw(
	object: SceneObject,
	spec: SceneSpec,
	support: Placement | undefined,
	centerOf: (id: string) => Vec2 | undefined,
	diagnostics: SceneDiagnostic[],
	shapeOf: (id: string) => Footprint | undefined = () => undefined,
): number {
	const front = axisAngle(object.front);
	const own = centerOf(object.id);
	// Face the nearest point of an object (the side of a long table, not
	// its middle); its center when standing over it.
	const nearestPoint = (id: string): Vec2 | undefined => {
		const shape = shapeOf(id);
		if (shape === undefined || own === undefined) return centerOf(id);
		const local = sub(own, shape.center);
		const u = clamp(dot(local, shape.axisX), shape.halfX);
		const v = clamp(dot(local, shape.axisY), shape.halfY);
		const point = {
			x: shape.center.x + shape.axisX.x * u + shape.axisY.x * v,
			y: shape.center.y + shape.axisX.y * u + shape.axisY.y * v,
		};
		return Math.hypot(point.x - own.x, point.y - own.y) < TOLERANCE
			? shape.center
			: point;
	};
	const facingYaw = (target: Vec2 | undefined): number | undefined => {
		if (own === undefined || target === undefined) return undefined;
		const dx = target.x - own.x;
		const dy = target.y - own.y;
		if (Math.hypot(dx, dy) < TOLERANCE) return undefined;
		return normalizeDegrees((Math.atan2(dy, dx) * 180) / Math.PI - front);
	};

	const explicit: { yaw: number; path: ScenePath }[] = [];
	if (object.yaw !== undefined) {
		explicit.push({
			yaw: normalizeDegrees(object.yaw),
			path: [...object.path, "yaw"],
		});
	}
	for (const relation of spec.relations) {
		if (relation.kind === "rotate" && relation.subject === object.id) {
			explicit.push({
				yaw: normalizeDegrees(relation.degrees),
				path: relation.path,
			});
		}
		if (relation.kind === "facing" && relation.subject === object.id) {
			const yaw =
				"direction" in relation.target
					? normalizeDegrees(COMPASS[relation.target.direction] - front)
					: "point" in relation.target
						? facingYaw(relation.target.point)
						: facingYaw(nearestPoint(relation.target.object));
			if (yaw === undefined) {
				if ("object" in relation.target) {
					diagnostics.push({
						severity: "warning",
						code: "scene.facing.unresolved",
						message: `"${object.id}" cannot face "${relation.target.object}": they stand at the same spot.`,
						objects: [object.id, relation.target.object],
						path: relation.path,
						hint: "Move one of them, or face a direction (north, south, east, west).",
					});
				}
				continue;
			}
			explicit.push({ yaw, path: relation.path });
		}
	}
	const [first, ...others] = explicit;
	if (first !== undefined) {
		for (const other of others) {
			if (angleGap(first.yaw, other.yaw) > YAW_TOLERANCE) {
				diagnostics.push({
					severity: "error",
					code: "scene.yaw.conflict",
					message: `"${object.id}" is turned to ${round(first.yaw)}° and to ${round(other.yaw)}°.`,
					objects: [object.id],
					path: other.path,
					hint: `Keep one turn; the first comes from ${first.path.join(".")}.`,
				});
			}
		}
		return first.yaw;
	}

	for (const relation of spec.relations) {
		if (
			relation.kind === "around" &&
			relation.faceCenter &&
			relation.subjects.includes(object.id)
		) {
			const yaw = facingYaw(relation.point ?? centerOf(relation.center));
			if (yaw !== undefined) return yaw;
		}
	}
	const wall = spec.relations.find(
		(relation) =>
			relation.kind === "against-wall" && relation.subject === object.id,
	);
	if (wall?.kind === "against-wall") {
		return normalizeDegrees(AWAY_FROM_WALL[wall.wall] - front);
	}
	if (support !== undefined) {
		return normalizeDegrees(
			support.yaw + axisAngle(support.object.front) - front,
		);
	}
	return 0;
}

/** Center of an object of footprint `shape` at `spot` on top of `support`. */
function spotCenter(
	support: Placement,
	supportObject: SceneObject,
	shape: Footprint,
	spot: SupportSpot,
): Vec2 {
	const forward = direction(support.yaw + axisAngle(supportObject.front));
	// Right as seen by someone standing in front, looking at the support.
	const right = { x: -forward.y, y: forward.x };
	const reach = (along: Vec2) =>
		Math.max(0, halfExtent(support.shape, along) - halfExtent(shape, along));
	const parts = spot.split("-");
	const f = parts.includes("front") ? 1 : parts.includes("back") ? -1 : 0;
	const r = parts.includes("right") ? 1 : parts.includes("left") ? -1 : 0;
	const df = f * reach(forward);
	const dr = r * reach(right);
	return {
		x: support.center.x + forward.x * df + right.x * dr,
		y: support.center.y + forward.y * df + right.y * dr,
	};
}

/** An object held at a spot of the floor plan, and the relation that asked for it. */
interface Spot {
	point: Vec2;
	path: ScenePath;
}

const MASK_CODES = new Set(["scene.terrain.slope", "scene.terrain.elevation"]);

function isMaskProblem(diagnostic: SceneDiagnostic): boolean {
	return MASK_CODES.has(diagnostic.code);
}

/** The objects standing on ground that breaks their limits. */
function offLimits(found: readonly SceneDiagnostic[]): Set<string> {
	return new Set(found.filter(isMaskProblem).flatMap((d) => d.objects ?? []));
}

/** An object's slope and elevation limits (all that apply, combined). */
interface Limits {
	slope?: number;
	min?: number;
	max?: number;
	/** The first relation that sets one, for messages. */
	path: ScenePath;
}

function limitsOf(spec: SceneSpec, id: string): Limits {
	const out: Limits = { path: [] };
	for (const relation of spec.relations) {
		if (relation.kind === "slope-limit" && relation.subject === id) {
			out.slope = Math.min(out.slope ?? 90, relation.max);
		} else if (relation.kind === "elevation-range" && relation.subject === id) {
			if (relation.min !== undefined) {
				out.min = Math.max(out.min ?? -Infinity, relation.min);
			}
			if (relation.max !== undefined) {
				out.max = Math.min(out.max ?? Infinity, relation.max);
			}
		} else {
			continue;
		}
		if (out.path.length === 0) out.path = relation.path;
	}
	return out;
}

/** Whether the ground under a footprint meets the limits. */
function meets(
	terrain: GridTerrain,
	shape: Footprint,
	limits: Limits,
): boolean {
	const range = terrain.rangeUnder(shape);
	return (
		range.covered &&
		(limits.slope === undefined || range.maxSlope <= limits.slope + 1e-9) &&
		(limits.min === undefined || range.minElevation >= limits.min - 1e-9) &&
		(limits.max === undefined || range.maxElevation <= limits.max + 1e-9)
	);
}

/**
 * The nearest spot (to where the object is now) whose ground meets its
 * limits, inside the scene's bounds and clear of everything else on the
 * floor (by `minGap`, or a `keep clear` distance). Candidates lie on a
 * grid as fine as half the terrain's spacing (coarser on a huge site),
 * tried nearest first, ties south then west.
 */
function findSpot(
	spec: SceneSpec,
	terrain: GridTerrain,
	item: Placement,
	limits: Limits,
	shapes: ReadonlyMap<string, Footprint>,
	placed: ReadonlyMap<string, Placement>,
): Vec2 | undefined {
	const probe = footprint({ x: 0, y: 0 }, item.object.size, item.yaw);
	const ex = halfExtent(probe, { x: 1, y: 0 });
	const ey = halfExtent(probe, { x: 0, y: 1 });
	const x0 = Math.max(ex, terrain.min.x + ex);
	const x1 = Math.min(spec.bounds.width - ex, terrain.max.x - ex);
	const y0 = Math.max(ey, terrain.min.y + ey);
	const y1 = Math.min(spec.bounds.depth - ey, terrain.max.y - ey);
	if (x1 < x0 || y1 < y0) return undefined;
	const { spacing } = terrain.grid;
	let step = Math.min(spacing.x, spacing.y) / 2;
	const area = (x1 - x0 + step) * (y1 - y0 + step);
	if (area / (step * step) > MASK_CANDIDATES) {
		step = Math.sqrt(area / MASK_CANDIDATES);
	}
	const columns = Math.floor((x1 - x0) / step) + 1;
	const rows = Math.floor((y1 - y0) / step) + 1;
	const candidates: Vec2[] = [];
	for (let j = 0; j < rows; j += 1) {
		for (let i = 0; i < columns; i += 1) {
			candidates.push({ x: x0 + i * step, y: y0 + j * step });
		}
	}
	const from = item.center;
	candidates.sort(
		(a, b) =>
			Math.hypot(a.x - from.x, a.y - from.y) -
				Math.hypot(b.x - from.x, b.y - from.y) ||
			a.y - b.y ||
			a.x - b.x,
	);
	const id = item.object.id;
	const clearance = new Map<string, number>();
	for (const relation of spec.relations) {
		if (relation.kind !== "keep-clear") continue;
		const [a, b] = relation.between;
		const other = a === id ? b : b === id ? a : undefined;
		if (other === undefined) continue;
		clearance.set(
			other,
			Math.max(clearance.get(other) ?? 0, relation.clearance),
		);
	}
	// Only things on the floor compete for ground.
	const others = [...shapes].filter(
		([other]) => other !== id && placed.get(other)?.support === undefined,
	);
	for (const center of candidates) {
		const shape = footprint(center, item.object.size, item.yaw);
		if (!meets(terrain, shape, limits)) continue;
		const clear = others.every(([other, theirs]) => {
			if (penetration(shape, theirs) > TOLERANCE) return false;
			const need = Math.max(spec.minGap, clearance.get(other) ?? 0);
			return need <= 0 || distance(shape, theirs) >= need - TOLERANCE;
		});
		if (clear) return center;
	}
	return undefined;
}

/**
 * Terrain checks: ground under every object on it, slope and elevation
 * limits, objects off the grid, leaning supports, and terrain relations
 * on objects that stand on something else.
 */
function checkTerrain(
	spec: SceneSpec,
	terrain: GridTerrain,
	placed: ReadonlyMap<string, Placement>,
	diagnostics: SceneDiagnostic[],
): void {
	const grounded = new Map<string, ScenePath>();
	for (const relation of spec.relations) {
		if (relation.kind === "ground" && !grounded.has(relation.subject)) {
			grounded.set(relation.subject, relation.path);
		}
	}
	for (const item of placed.values()) {
		const id = item.object.id;
		const range = terrain.rangeUnder(item.shape);
		if (item.support !== undefined) {
			const support = placed.get(item.support);
			if (grounded.has(id)) {
				diagnostics.push({
					severity: "warning",
					code: "scene.terrain.off-ground",
					message: `"${id}" stands on "${item.support}", not on the terrain; \`on terrain\` and \`align to slope\` do not apply.`,
					objects: [id],
					...pathOf(grounded.get(id)),
					hint: "Remove the terrain relation, or the `on` relation.",
				});
			}
			if (support?.tilt !== undefined) {
				diagnostics.push({
					severity: "error",
					code: "scene.terrain.leaning-support",
					message: `"${id}" stands on "${support.object.id}", which leans with the slope; objects stand only on level tops.`,
					objects: [id, support.object.id],
					path: item.object.path,
					hint: `Do not align "${support.object.id}" to the slope, or place "${id}" on the ground.`,
				});
			}
		} else if (!range.covered) {
			diagnostics.push({
				severity: "error",
				code: "scene.terrain.outside",
				message: `"${id}" stands partly off the terrain grid, where there is no ground.`,
				objects: [id],
				path: item.object.path,
				hint: "Move it onto the grid, or extend the terrain to cover it.",
			});
		} else if (item.tilt === undefined) {
			// Upright on uneven ground: one side floats, the other is buried.
			const rise = range.maxElevation - range.minElevation;
			if (rise > UNEVEN) {
				const ground = item.ground + terrain.grid.base;
				diagnostics.push({
					severity: "info",
					code: "scene.terrain.uneven",
					message: `The ground under "${id}" rises ${round(rise)} m across it: standing upright, it is ${round(ground - range.minElevation)} m above the ground at its lowest edge and ${round(range.maxElevation - ground)} m into it at its highest.`,
					objects: [id],
					path: item.object.path,
					hint: "Add `align to slope` to lean it with the ground, or find a flatter spot (`slope below …`).",
					detail: { rise: round(rise) },
				});
			}
		}
		const limits = limitsOf(spec, id);
		if (limits.path.length === 0 || !range.covered) continue;
		if (limits.slope !== undefined && range.maxSlope > limits.slope + 1e-9) {
			diagnostics.push({
				severity: "error",
				code: "scene.terrain.slope",
				message: `The ground under "${id}" is up to ${round(range.maxSlope)}° steep; it may be no steeper than ${round(limits.slope)}°.`,
				objects: [id],
				path: limits.path,
				hint: "Let it move (drop relations or pins that fix it), allow a steeper slope, or level the ground.",
				detail: { slope: round(range.maxSlope), max: round(limits.slope) },
			});
		}
		const low =
			limits.min !== undefined && range.minElevation < limits.min - 1e-9;
		const high =
			limits.max !== undefined && range.maxElevation > limits.max + 1e-9;
		if (low || high) {
			const span = `${limits.min === undefined ? "below" : limits.max === undefined ? "above" : "between"} ${[
				limits.min,
				limits.max,
			]
				.filter((value) => value !== undefined)
				.map((value) => `${round(value as number)} m`)
				.join(" and ")}`;
			diagnostics.push({
				severity: "error",
				code: "scene.terrain.elevation",
				message: `The ground under "${id}" lies at ${round(range.minElevation)}–${round(range.maxElevation)} m; it must be ${span}.`,
				objects: [id],
				path: limits.path,
				hint: "Let it move (drop relations or pins that fix it), or widen the elevation range.",
				detail: {
					min: round(range.minElevation),
					max: round(range.maxElevation),
				},
			});
		}
	}
}

function check(
	spec: SceneSpec,
	placed: ReadonlyMap<string, Placement>,
	diagnostics: SceneDiagnostic[],
): void {
	const list = [...placed.values()];
	const { width, depth, height } = spec.bounds;
	for (const item of list) {
		const id = item.object.id;
		const box = aabb(item);
		const past = Math.max(
			-box.min[0],
			-box.min[1],
			box.max[0] - width,
			box.max[1] - depth,
		);
		if (past > TOLERANCE) {
			diagnostics.push({
				severity: "error",
				code: "scene.out-of-bounds",
				message: `"${id}" reaches ${round(past)} m past the walls.`,
				objects: [id],
				path: item.object.path,
				hint: "Move it into the room, or make the room larger.",
				detail: { past: round(past) },
			});
		}
		// The ceiling is measured from the ground under the object.
		if (height !== undefined && box.max[2] - item.ground - height > TOLERANCE) {
			const over = box.max[2] - item.ground - height;
			diagnostics.push({
				severity: "error",
				code: "scene.above-ceiling",
				message: `"${id}" reaches ${round(over)} m above the ceiling.`,
				objects: [id],
				path: item.object.path,
				hint: "Use a lower object or support, or a taller room.",
				detail: { past: round(over) },
			});
		}
		const support =
			item.support === undefined ? undefined : placed.get(item.support);
		if (support !== undefined) {
			if (!contains(support.shape, item.center)) {
				diagnostics.push({
					severity: "error",
					code: "scene.support.unstable",
					message: `"${id}" stands with its center off "${support.object.id}" and would fall.`,
					objects: [id, support.object.id],
					path: item.object.path,
					hint: "Move it onto the support, or drop the pinned position.",
				});
			} else {
				const reach = overhang(item.shape, support.shape);
				if (reach > TOLERANCE) {
					diagnostics.push({
						severity: "warning",
						code: "scene.support.overhang",
						message: `"${id}" overhangs "${support.object.id}" by ${round(reach)} m.`,
						objects: [id, support.object.id],
						path: item.object.path,
						hint: "Use a smaller object or a larger support.",
						detail: { overhang: round(reach) },
					});
				}
			}
		}
	}

	for (let i = 0; i < list.length; i += 1) {
		const a = list[i] as Placement;
		for (let j = i + 1; j < list.length; j += 1) {
			const b = list[j] as Placement;
			const [a0, a1] = heightRange(a);
			const [b0, b1] = heightRange(b);
			const vertical = Math.min(a1, b1) - Math.max(a0, b0);
			if (vertical <= TOLERANCE) continue;
			const depthIn = penetration(a.shape, b.shape);
			if (depthIn > TOLERANCE) {
				diagnostics.push({
					severity: "error",
					code: "scene.collision",
					message: `"${a.object.id}" and "${b.object.id}" overlap by ${round(depthIn)} m.`,
					objects: [a.object.id, b.object.id],
					path: b.object.path,
					hint: "Move one of them, or remove a pinned position.",
					detail: { depth: round(depthIn) },
				});
				continue;
			}
			if (spec.minGap > 0 && a.support === b.support) {
				const gap = distance(a.shape, b.shape);
				if (gap < spec.minGap - TOLERANCE) {
					diagnostics.push({
						severity: "warning",
						code: "scene.min-gap",
						message: `"${a.object.id}" and "${b.object.id}" are ${round(gap)} m apart, under minGap ${round(spec.minGap)} m.`,
						objects: [a.object.id, b.object.id],
						path: b.object.path,
						hint: "Move them apart.",
						detail: { gap: round(gap), minGap: round(spec.minGap) },
					});
				}
			}
		}
	}

	for (const relation of spec.relations) {
		if (relation.kind !== "keep-clear") continue;
		const [a, b] = relation.between.map((id) => placed.get(id));
		if (a === undefined || b === undefined) continue;
		const gap = distance(a.shape, b.shape);
		if (gap < relation.clearance - TOLERANCE) {
			diagnostics.push({
				severity: "error",
				code: "scene.keep-clear",
				message: `"${a.object.id}" and "${b.object.id}" are ${round(gap)} m apart; ${round(relation.clearance)} m must stay clear.`,
				objects: [a.object.id, b.object.id],
				path: relation.path,
				hint: `Move them ${round(relation.clearance - gap)} m further apart.`,
				detail: { gap: round(gap), clearance: round(relation.clearance) },
			});
		}
	}
}

function output(item: Placement): PlacedSceneObject {
	const { object } = item;
	const box = aabb(item);
	return {
		id: object.id,
		position: [round(item.center.x), round(item.center.y), round(item.z)],
		yaw: round(item.yaw),
		// A lean is written to 1e-9: rounded to 1e-4 like lengths, it would
		// move the far corner of a few-metre object by tenths of a millimetre.
		quaternion: rotationOf(item).map(
			item.tilt === undefined ? round : fine,
		) as [number, number, number, number],
		...(item.tilt === undefined
			? {}
			: { up: item.tilt.up.map(fine) as [number, number, number] }),
		size: object.size.map(round) as [number, number, number],
		front: object.front,
		...(item.support === undefined ? {} : { supportedBy: item.support }),
		aabb: {
			min: box.min.map(round) as [number, number, number],
			max: box.max.map(round) as [number, number, number],
		},
		...(object.label === undefined ? {} : { label: object.label }),
		...(object.asset === undefined ? {} : { asset: object.asset }),
		...(object.group === undefined ? {} : { group: object.group }),
	};
}

/** Lowest and highest z the object reaches. */
function heightRange(item: Placement): [number, number] {
	if (item.tilt === undefined) return [item.z, item.z + item.object.size[2]];
	const box = aabb(item);
	return [box.min[2], box.max[2]];
}

function aabb(item: Placement): {
	min: [number, number, number];
	max: [number, number, number];
} {
	if (item.tilt !== undefined) {
		// The eight corners of the leaning box, turned about its bottom center.
		const q = rotationOf(item);
		const [w, d, h] = item.object.size;
		const min: [number, number, number] = [Infinity, Infinity, Infinity];
		const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
		for (const sx of [-1, 1]) {
			for (const sy of [-1, 1]) {
				for (const sz of [0, 1]) {
					const [x, y, z] = rotate(q, [(sx * w) / 2, (sy * d) / 2, sz * h]);
					const at = [item.center.x + x, item.center.y + y, item.z + z];
					for (let k = 0; k < 3; k += 1) {
						min[k] = Math.min(min[k] as number, at[k] as number);
						max[k] = Math.max(max[k] as number, at[k] as number);
					}
				}
			}
		}
		return { min, max };
	}
	const ex = halfExtent(item.shape, { x: 1, y: 0 });
	const ey = halfExtent(item.shape, { x: 0, y: 1 });
	return {
		min: [item.center.x - ex, item.center.y - ey, item.z],
		max: [item.center.x + ex, item.center.y + ey, item.z + item.object.size[2]],
	};
}

function clamp(value: number, half: number): number {
	return Math.max(-half, Math.min(half, value));
}

function angleGap(a: number, b: number): number {
	return Math.abs(normalizeDegrees(a - b));
}

function pathOf(path: ScenePath | undefined): { path?: ScenePath } {
	return path === undefined ? {} : { path };
}

/** The projection as the document gives it, with its EPSG code. */
function outputProjection(
	projection: NonNullable<SceneSpec["frame"]>["projection"],
): NonNullable<SolvedScene["geo"]>["projection"] {
	if (projection.kind === "enu") return { kind: "enu" };
	if (projection.kind === "web-mercator") {
		return { kind: "web-mercator", epsg: 3857 };
	}
	return {
		kind: "utm",
		zone: projection.zone,
		hemisphere: projection.south ? "S" : "N",
		epsg: utmEpsg(projection),
	};
}

/**
 * Notes on a projected frame: which UTM zone a large site was put in, and
 * whether it reaches into other zones (still projected in its own, with
 * the scale there).
 */
function projectionNotes(spec: SceneSpec, frame: GeoFrame): SceneDiagnostic[] {
	const projection = spec.frame?.projection;
	if (projection === undefined || projection.kind !== "utm") return [];
	const out: SceneDiagnostic[] = [];
	const name = `${projection.zone}${projection.south ? "S" : "N"}`;
	const { width, depth } = spec.bounds;
	const points = [
		frame.toGeo(0, 0),
		frame.toGeo(width, 0),
		frame.toGeo(0, depth),
		frame.toGeo(width, depth),
		...(spec.landmarks ?? []).map((landmark) => landmark.geo),
	];
	// Grid scale at the point farthest from the central meridian.
	const scale = Math.max(
		...points.map((point) => utmScale(point.lat, point.lon, projection)),
	);
	if (spec.frame?.auto === true) {
		out.push({
			severity: "info",
			code: "scene.geo.projection",
			message: `The site reaches past ${GEO_REACH / 1000} km from its origin, more than one local east-north-up frame serves; it is laid out on UTM zone ${name} (EPSG:${utmEpsg(projection)}). Scene metres are grid metres there (scale up to ${Math.round(scale * 1e6) / 1e6}).`,
			path: ["frame"],
			hint: "Set `frame.projection` to choose the frame yourself.",
			detail: { zone: projection.zone, epsg: utmEpsg(projection) },
		});
	}
	const zones = new Set(
		points.map((point) => {
			const zone = utmZone(point.lat, point.lon);
			return `${zone.zone}${zone.south ? "S" : "N"}`;
		}),
	);
	zones.delete(name);
	if (zones.size > 0) {
		out.push({
			severity: "warning",
			code: "scene.geo.zone-crossing",
			message: `The site reaches into UTM zone${zones.size > 1 ? "s" : ""} ${[...zones].sort().join(", ")}; it is laid out on zone ${name} throughout (grid scale up to ${Math.round(scale * 1e6) / 1e6} at its far edge).`,
			path: ["frame"],
			hint: "Fine for one site; to match maps of the other zone, give that part its own scene (or set `frame.zone`).",
			detail: { zone: projection.zone, scale: Math.round(scale * 1e6) / 1e6 },
		});
	}
	return out;
}

/** Nine decimals, without -0 (unit vectors and rotations). */
function fine(value: number): number {
	const rounded = Math.round(value * 1e9) / 1e9;
	return rounded === 0 ? 0 : rounded;
}

/** Four decimals, without -0 (huge values as they are). */
function round(value: number): number {
	if (!Number.isFinite(value * 1e4)) return value;
	const rounded = Math.round(value * 1e4) / 1e4;
	return rounded === 0 ? 0 : rounded;
}
