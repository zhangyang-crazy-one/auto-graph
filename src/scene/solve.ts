import {
	axisAngle,
	contains,
	direction,
	distance,
	type Footprint,
	footprint,
	halfExtent,
	normalizeDegrees,
	overhang,
	penetration,
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

/** Lengths below this (0.1 mm) count as touching, not overlapping. */
const TOLERANCE = 1e-4;
/** Two turns closer than this (degrees) agree. */
const YAW_TOLERANCE = 0.01;

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

const PLANAR_KINDS = new Set<SceneRelation["kind"]>([
	"beside",
	"against-wall",
	"corner",
	"center-of",
	"align",
	"distribute",
	"grid",
	"around",
	"symmetric",
]);

interface Placement {
	object: SceneObject;
	center: Vec2;
	z: number;
	yaw: number;
	shape: Footprint;
	support?: string;
}

/**
 * Place what can be placed without a planar layout and check the result.
 *
 * - Supports: `on` relations form a forest; an object stands on top of its
 *   support (z = support top), the rest on the floor.
 * - Turns: a pinned `yaw`, `rotate` or `facing` decides; otherwise `around`
 *   faces the center, `against wall` turns the back to the wall, and an
 *   object on a support turns with it so their fronts agree.
 * - Floor-plan positions: pinned `position`, or the `at` spot on the
 *   support. Other objects are listed in `unplaced` (the planar layout
 *   that places them from relations comes next).
 * - Checks: interpenetration (separating axes), objects past the walls or
 *   ceiling, objects whose center is off their support, overhangs,
 *   `keep clear` and `minGap`.
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

	const placed = new Map<string, Placement>();
	const centerOf = (id: string): Vec2 | undefined => {
		const done = placed.get(id)?.center;
		if (done !== undefined) return done;
		const pinned = byId.get(id)?.position;
		return pinned === undefined ? undefined : { x: pinned[0], y: pinned[1] };
	};

	for (const object of sequence) {
		const supportId = supports.get(object.id);
		const support = supportId === undefined ? undefined : placed.get(supportId);
		if (supportId !== undefined && support === undefined) continue;
		const yaw = resolveYaw(object, spec, support, centerOf, diagnostics);
		let center: Vec2 | undefined = centerOf(object.id);
		if (center === undefined && support !== undefined) {
			const spot = spec.relations.find(
				(relation) => relation.kind === "on" && relation.subject === object.id,
			) as Extract<SceneRelation, { kind: "on" }> | undefined;
			center = spotCenter(
				support,
				byId.get(support.object.id) as SceneObject,
				footprint({ x: 0, y: 0 }, object.size, yaw),
				spot?.at ?? "center",
			);
		}
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

	check(spec, placed, diagnostics);

	const unplaced = spec.objects
		.filter((object) => !placed.has(object.id))
		.map((object) => object.id);
	for (const id of unplaced) {
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
			hint: "Pin it with `position: [x, y]`; placing objects from relations alone is not implemented yet.",
		});
	}
	for (const relation of spec.relations) {
		if (!PLANAR_KINDS.has(relation.kind)) continue;
		diagnostics.push({
			severity: "info",
			code: "scene.relation.unchecked",
			message: `The ${relation.kind} relation is not applied or checked yet.`,
			path: relation.path,
			hint: "Pinned positions are used as given.",
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
): number {
	const front = axisAngle(object.front);
	const own = centerOf(object.id);
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
					: facingYaw(centerOf(relation.target.object));
			if (yaw === undefined) {
				if ("object" in relation.target) {
					diagnostics.push({
						severity: "warning",
						code: "scene.facing.unresolved",
						message: `"${object.id}" cannot face "${relation.target.object}" before both have positions.`,
						objects: [object.id, relation.target.object],
						path: relation.path,
						hint: "Pin both positions, or face a direction (north, south, east, west).",
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

function angleGap(a: number, b: number): number {
	return Math.abs(normalizeDegrees(a - b));
}

function pathOf(path: ScenePath | undefined): { path?: ScenePath } {
	return path === undefined ? {} : { path };
}

/** Four decimals, without -0. */
function round(value: number): number {
	const rounded = Math.round(value * 1e4) / 1e4;
	return rounded === 0 ? 0 : rounded;
}
