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
import { type PathBottleneck, planPaths } from "./paths.js";

/** Lengths below this (0.1 mm) count as touching, not overlapping. */
const TOLERANCE = 1e-4;
/** Two turns closer than this (degrees) agree. */
const YAW_TOLERANCE = 0.01;
/** Turn-and-lay-out passes before the turns must have settled. */
const MAX_PASSES = 4;
/** Rounds of floor plan plus supports before turns must have settled. */
const MAX_ROUNDS = 4;
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
	yaw: number;
	shape: Footprint;
	support?: string;
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

	/**
	 * One round: lay out the floor plan, then stand every object on its
	 * support. Turns that face an object need that object's position, so a
	 * round reads the positions of the previous one (`prior`) wherever the
	 * current one has none yet; rounds repeat until no turn changes.
	 */
	const solveRound = (
		prior: ReadonlyMap<string, Placement> | undefined,
		aisles: readonly Aisle[],
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
				spec,
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
			placed.set(object.id, {
				object,
				center,
				z: support === undefined ? 0 : support.z + support.object.size[2],
				yaw,
				shape: footprint(center, object.size, yaw),
				...(supportId === undefined ? {} : { support: supportId }),
			});
		}
		return { placed, found };
	};

	/** Lay out, check and plan paths, with the given aisles held open. */
	const attempt = (aisles: readonly Aisle[]) => {
		let result = solveRound(undefined, aisles);
		for (let again = 1; again < MAX_ROUNDS; again += 1) {
			const next = solveRound(result.placed, aisles);
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
		const planned = planPaths(spec, placed);
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
			const tried = attempt(next);
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
		objects: spec.objects.flatMap((object) => {
			const placement = placed.get(object.id);
			return placement === undefined ? [] : [output(placement)];
		}),
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
			speed: round(speed),
			accel: round(accel),
		})),
		paths: best.planned.paths,
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
			const yaw = facingYaw(centerOf(relation.center));
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
		if (height !== undefined && box.max[2] - height > TOLERANCE) {
			const over = box.max[2] - height;
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
			const vertical =
				Math.min(a.z + a.object.size[2], b.z + b.object.size[2]) -
				Math.max(a.z, b.z);
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
	const half = (item.yaw * Math.PI) / 360;
	const box = aabb(item);
	return {
		id: object.id,
		position: [round(item.center.x), round(item.center.y), round(item.z)],
		yaw: round(item.yaw),
		quaternion: [0, 0, round(Math.sin(half)), round(Math.cos(half))],
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

function aabb(item: Placement): {
	min: [number, number, number];
	max: [number, number, number];
} {
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

/** Four decimals, without -0 (huge values as they are). */
function round(value: number): number {
	if (!Number.isFinite(value * 1e4)) return value;
	const rounded = Math.round(value * 1e4) / 1e4;
	return rounded === 0 ? 0 : rounded;
}
