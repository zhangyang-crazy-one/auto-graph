import { solveSeparationQp, type VpscConstraint } from "../constraints/vpsc.js";
import {
	axisAngle,
	direction,
	footprint,
	halfExtent,
	type Vec2,
} from "./geometry.js";
import type {
	SceneDiagnostic,
	SceneObject,
	ScenePath,
	SceneRelation,
	SceneSpec,
	WallSide,
} from "./ir.js";

/**
 * Floor-plan layout of the objects standing on the floor.
 *
 * Each axis is a separation-constrained quadratic program (see
 * `solveSeparationQp`): one variable per object plus the two walls. Every
 * relation becomes equalities or inequalities on one axis:
 *
 * - `against wall` / `corner`: an object side at the wall (plus `gap`);
 * - `center-of`: centers equal (the room's center is half its size from
 *   the wall);
 * - `in-front-of` / `behind` / `left-of` / `right-of`: the facing sides
 *   `gap` apart (or the centers `distance` apart) along the reference's
 *   side, snapped to the nearest world axis, centered on the other axis
 *   by a soft pull;
 * - `align`, `grid`, `around`, `distribute`, `symmetric`: fixed offsets
 *   between centers (the polar `around` offsets are r·cos θ, r·sin θ);
 * - pinned positions: fixed offsets from the wall.
 *
 * Overlaps are removed the way VPSC removes node overlaps: after each
 * solve, every pair of footprints closer than `minGap` (or their `keep
 * clear` distance) gets a separation constraint on the axis where it
 * overlaps least, and the programs are solved again. Rotated objects are
 * separated by their world-axis bounding boxes.
 *
 * Deterministic: everything iterates in declaration order.
 */

export interface FloorLayoutInput {
	spec: SceneSpec;
	/** Objects on the floor, in declaration order. */
	floor: readonly SceneObject[];
	yaw: ReadonlyMap<string, number>;
	/** Centers from the previous pass, for `symmetric` and tie-breaking. */
	previous?: ReadonlyMap<string, Vec2>;
}

export interface FloorLayoutResult {
	centers: Map<string, Vec2>;
	diagnostics: SceneDiagnostic[];
}

type Axis = "x" | "y";

interface Origin {
	path: ScenePath;
	/** What the constraint stands for, for messages. */
	what: string;
}

interface Equality {
	axis: Axis;
	left: number;
	right: number;
	gap: number;
	origin: Origin;
}

const MAX_ROUNDS = 60;
/** Equalities off by more than this (m) are reported as not holding. */
const RESIDUAL = 1e-3;
const WALL_WEIGHT = 1e6;
/** Every object drifts to the room center unless something holds it. */
const PULL_WEIGHT = 1;
/** Objects placed beside a reference center on it. */
const PAIR_WEIGHT = 10;

export function layoutFloor(input: FloorLayoutInput): FloorLayoutResult {
	const { spec, floor, yaw } = input;
	const diagnostics: SceneDiagnostic[] = [];
	const n = floor.length;
	const index = new Map(floor.map((object, i) => [object.id, i]));
	const low = n;
	const high = n + 1;
	const length = { x: spec.bounds.width, y: spec.bounds.depth };
	const extent = floor.map((object) => {
		const shape = footprint(
			{ x: 0, y: 0 },
			object.size,
			yaw.get(object.id) ?? 0,
		);
		return {
			x: halfExtent(shape, { x: 1, y: 0 }),
			y: halfExtent(shape, { x: 0, y: 1 }),
		};
	});
	const frontOf = (i: number): Vec2 => {
		const object = floor[i] as SceneObject;
		return direction((yaw.get(object.id) ?? 0) + axisAngle(object.front));
	};

	const equalities: Equality[] = [];
	const pulls: { axis: Axis; a: number; b: number }[] = [];
	const eq = (
		axis: Axis,
		left: number,
		right: number,
		gap: number,
		origin: Origin,
	) => {
		equalities.push(
			gap < 0
				? { axis, left: right, right: left, gap: -gap, origin }
				: { axis, left, right, gap, origin },
		);
	};

	// Pinned positions.
	floor.forEach((object, i) => {
		if (object.position === undefined) return;
		const origin = {
			path: [...object.path, "position"],
			what: "pinned position",
		};
		eq("x", low, i, object.position[0], origin);
		eq("y", low, i, object.position[1], origin);
	});

	const floorIndex = (
		id: string,
		relation: SceneRelation,
	): number | undefined => {
		const at = index.get(id);
		if (at === undefined) {
			diagnostics.push({
				severity: "warning",
				code: "scene.relation.off-floor",
				message: `The ${relation.kind} relation is not applied: "${id}" stands on another object.`,
				objects: [id],
				path: relation.path,
				hint: "Floor-plan relations apply between objects on the floor; place objects on a support with `at`.",
			});
		}
		return at;
	};
	const wallSide = (axisOf: WallSide) =>
		axisOf === "east" || axisOf === "west" ? ("x" as const) : ("y" as const);
	const toWall = (i: number, wall: WallSide, gap: number, origin: Origin) => {
		const axis = wallSide(wall);
		const offset = (extent[i] as Vec2)[axis] + gap;
		if (wall === "north" || wall === "east") eq(axis, i, high, offset, origin);
		else eq(axis, low, i, offset, origin);
	};

	const mirrors: Extract<SceneRelation, { kind: "symmetric" }>[] = [];
	for (const relation of spec.relations) {
		const origin = { path: relation.path, what: `${relation.kind} relation` };
		switch (relation.kind) {
			case "against-wall": {
				const i = floorIndex(relation.subject, relation);
				if (i !== undefined) toWall(i, relation.wall, relation.gap, origin);
				break;
			}
			case "corner": {
				const i = floorIndex(relation.subject, relation);
				if (i === undefined) break;
				toWall(
					i,
					relation.corner[0] === "n" ? "north" : "south",
					relation.gap,
					origin,
				);
				toWall(
					i,
					relation.corner[1] === "e" ? "east" : "west",
					relation.gap,
					origin,
				);
				break;
			}
			case "center-of": {
				const i = floorIndex(relation.subject, relation);
				if (i === undefined) break;
				if (relation.reference === "room") {
					eq("x", low, i, length.x / 2, origin);
					eq("y", low, i, length.y / 2, origin);
				} else {
					const j = floorIndex(relation.reference, relation);
					if (j === undefined) break;
					eq("x", j, i, 0, origin);
					eq("y", j, i, 0, origin);
				}
				break;
			}
			case "beside": {
				const i = floorIndex(relation.subject, relation);
				const j = floorIndex(relation.reference, relation);
				if (i === undefined || j === undefined) break;
				const forward = frontOf(j);
				const right = { x: -forward.y, y: forward.x };
				const side =
					relation.side === "front"
						? forward
						: relation.side === "back"
							? { x: -forward.x, y: -forward.y }
							: relation.side === "right"
								? right
								: { x: -right.x, y: -right.y };
				const axis: Axis = Math.abs(side.x) >= Math.abs(side.y) ? "x" : "y";
				const sign = Math.sign(side[axis]);
				const offset =
					relation.distance ??
					(extent[i] as Vec2)[axis] +
						(extent[j] as Vec2)[axis] +
						(relation.gap ?? spec.minGap);
				eq(axis, j, i, sign * offset, origin);
				pulls.push({ axis: axis === "x" ? "y" : "x", a: i, b: j });
				break;
			}
			case "align": {
				const j = floorIndex(relation.reference, relation);
				if (j === undefined) break;
				for (const subject of relation.subjects) {
					const i = floorIndex(subject, relation);
					if (i !== undefined) eq(relation.axis, j, i, 0, origin);
				}
				break;
			}
			case "around": {
				const c = floorIndex(relation.center, relation);
				if (c === undefined) break;
				const count = relation.subjects.length;
				relation.subjects.forEach((subject, k) => {
					const i = floorIndex(subject, relation);
					if (i === undefined) return;
					const at = direction(relation.start + (360 * k) / count);
					eq("x", c, i, relation.radius * at.x, origin);
					eq("y", c, i, relation.radius * at.y, origin);
				});
				break;
			}
			case "grid": {
				const members = relation.subjects.map((subject) =>
					floorIndex(subject, relation),
				);
				if (members.some((member) => member === undefined)) break;
				const ids = members as number[];
				const cellX = Math.max(...ids.map((i) => 2 * (extent[i] as Vec2).x));
				const cellY = Math.max(...ids.map((i) => 2 * (extent[i] as Vec2).y));
				const first = ids[0] as number;
				ids.forEach((i, k) => {
					if (k === 0) return;
					const row = Math.floor(k / relation.columns);
					const column = k % relation.columns;
					// Row 0 is the north row; columns run west to east.
					eq("x", first, i, column * (cellX + relation.gap), origin);
					eq("y", first, i, -row * (cellY + relation.gap), origin);
				});
				break;
			}
			case "distribute": {
				const members = relation.subjects.map((subject) =>
					floorIndex(subject, relation),
				);
				if (members.some((member) => member === undefined)) break;
				const ids = members as number[];
				const along: Axis =
					relation.along === "x" || relation.along === "y"
						? relation.along
						: wallSide(relation.along) === "x"
							? "y"
							: "x";
				const sizes = ids.map((i) => 2 * (extent[i] as Vec2)[along]);
				const total = sizes.reduce((sum, size) => sum + size, 0);
				const space = length[along] - total;
				const gap = relation.gap ?? Math.max(0, space / (ids.length + 1));
				let cursor =
					relation.gap === undefined
						? gap
						: (length[along] - total - gap * (ids.length - 1)) / 2;
				ids.forEach((i, k) => {
					eq(along, low, i, cursor + (sizes[k] as number) / 2, origin);
					cursor += (sizes[k] as number) + gap;
				});
				const cross: Axis = along === "x" ? "y" : "x";
				if (relation.along === "x" || relation.along === "y") {
					const first = ids[0] as number;
					for (const i of ids.slice(1)) eq(cross, first, i, 0, origin);
				} else {
					for (const i of ids) toWall(i, relation.along, 0, origin);
				}
				break;
			}
			case "symmetric":
				// After the other relations: the mirror distance comes from
				// whichever side they already hold in place.
				mirrors.push(relation);
				break;
			default:
				break;
		}
	}

	for (const relation of mirrors) {
		const origin = { path: relation.path, what: "symmetric relation" };
		const [a, b] = relation.subjects.map((subject) =>
			floorIndex(subject, relation),
		);
		if (a === undefined || b === undefined) continue;
		const c =
			relation.about === "room"
				? undefined
				: floorIndex(relation.about, relation);
		if (relation.about !== "room" && c === undefined) continue;
		const previous = input.previous;
		const pa = previous?.get(relation.subjects[0]);
		const pb = previous?.get(relation.subjects[1]);
		const pc =
			c === undefined
				? { x: length.x / 2, y: length.y / 2 }
				: previous?.get(relation.about);
		// The first pass places everything else; the mirror follows.
		if (pa === undefined || pb === undefined || pc === undefined) continue;
		const axis: Axis =
			relation.axis ??
			(Math.abs(pa.x - pb.x) >= Math.abs(pa.y - pb.y) ? "x" : "y");
		const cross: Axis = axis === "x" ? "y" : "x";
		// A side whose offset from the mirror line other equalities already
		// fix (a pin, a wall) decides the distance and its side; otherwise
		// keep the average distance the last pass found.
		const groups = components(axis);
		const reference = c ?? low;
		const held = (i: number) => groups[i] === groups[reference];
		const anchor =
			held(a) && !held(b) ? pa : held(b) && !held(a) ? pb : undefined;
		const half =
			anchor !== undefined
				? Math.abs(anchor[axis] - pc[axis])
				: Math.max(
						(Math.abs(pa[axis] - pc[axis]) + Math.abs(pb[axis] - pc[axis])) / 2,
						((extent[a] as Vec2)[axis] +
							(extent[b] as Vec2)[axis] +
							spec.minGap) /
							2,
					);
		const aSide =
			anchor === pb
				? pb[axis] - pc[axis] > 0
					? -1
					: 1
				: anchor === pa
					? pa[axis] - pc[axis] > 0
						? 1
						: -1
					: pa[axis] <= pb[axis]
						? -1
						: 1;
		if (c === undefined) {
			eq(axis, low, a, length[axis] / 2 + aSide * half, origin);
			eq(axis, low, b, length[axis] / 2 - aSide * half, origin);
		} else {
			eq(axis, c, a, aSide * half, origin);
			eq(axis, c, b, -aSide * half, origin);
		}
		eq(cross, a, b, 0, origin);
	}

	const clearance = new Map<string, { gap: number; path: ScenePath }>();
	for (const relation of spec.relations) {
		if (relation.kind !== "keep-clear") continue;
		const [a, b] = relation.between.map((id) => index.get(id));
		if (a === undefined || b === undefined) continue;
		const key = a < b ? `${a}:${b}` : `${b}:${a}`;
		const gap = Math.max(relation.clearance, clearance.get(key)?.gap ?? 0);
		clearance.set(key, { gap, path: relation.path });
	}
	// Pairs whose offset on an axis is fixed by equalities cannot be
	// separated on that axis (a separation there would only be dropped).
	const fixed = { x: components("x"), y: components("y") };
	const movable = (axis: Axis, i: number, j: number) =>
		fixed[axis][i] !== fixed[axis][j];

	// One separation per overlapping pair; a pair still overlapping after a
	// solve (its separation lost to other constraints, e.g. squeezed between
	// two fixed objects) is moved to the other axis once.
	const separations = new Map<
		string,
		{ axis: Axis; constraint: VpscConstraint; flipped: boolean }
	>();
	let positions: Record<Axis, number[]> = {
		x: floor.map(
			(object, i) =>
				input.previous?.get(object.id)?.x ??
				object.position?.[0] ??
				spreadStart(i, n, length.x),
		),
		y: floor.map(
			(object) =>
				input.previous?.get(object.id)?.y ??
				object.position?.[1] ??
				length.y / 2,
		),
	};

	// An object beside a reference drifts to the reference (as it stood
	// after the last solve), anything else to the room center.
	const references = new Map<string, number[]>();
	for (const pull of pulls) {
		const key = `${pull.axis}:${pull.a}`;
		references.set(key, [...(references.get(key) ?? []), pull.b]);
	}
	// Objects nothing holds on either axis start on a grid over the room
	// instead of piling up in the middle.
	const held = new Set<number>();
	for (const equality of equalities)
		held.add(equality.left).add(equality.right);
	for (const pull of pulls) held.add(pull.a).add(pull.b);
	const loose = floor.flatMap((_, i) => (held.has(i) ? [] : [i]));
	const home = new Map<number, Vec2>();
	if (loose.length > 0) {
		const columns = Math.ceil(Math.sqrt((loose.length * length.x) / length.y));
		const rows = Math.ceil(loose.length / columns);
		loose.forEach((i, k) => {
			const row = Math.floor(k / columns);
			const column = k % columns;
			home.set(i, {
				x: (length.x * (column + 0.5)) / columns,
				y: length.y - (length.y * (row + 0.5)) / rows,
			});
		});
	}
	const anchorTarget = (axis: Axis, i: number): number => {
		const at = home.get(i);
		if (at !== undefined) return at[axis];
		const refs = references.get(`${axis}:${i}`);
		if (refs === undefined) return length[axis] / 2;
		return (
			refs.reduce((sum, j) => sum + (positions[axis][j] ?? 0), 0) / refs.length
		);
	};

	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const before = { x: [...positions.x], y: [...positions.y] };
		positions = { x: solveAxis("x"), y: solveAxis("y") };

		let added = false;
		for (let i = 0; i < n; i += 1) {
			for (let j = i + 1; j < n; j += 1) {
				if (!movable("x", i, j) && !movable("y", i, j)) continue;
				const key = `${i}:${j}`;
				const earlier = separations.get(key);
				if (earlier?.flipped === true) continue;
				const need = Math.max(spec.minGap, clearance.get(key)?.gap ?? 0);
				const over = (axis: Axis) =>
					(extent[i] as Vec2)[axis] +
					(extent[j] as Vec2)[axis] +
					need -
					Math.abs((positions[axis][i] ?? 0) - (positions[axis][j] ?? 0));
				const ox = over("x");
				const oy = over("y");
				if (ox <= 1e-6 || oy <= 1e-6) continue;
				let axis: Axis = !movable("x", i, j)
					? "y"
					: !movable("y", i, j)
						? "x"
						: ox <= oy
							? "x"
							: "y";
				if (earlier !== undefined) {
					const other: Axis = earlier.axis === "x" ? "y" : "x";
					if (!movable(other, i, j)) {
						separations.set(key, { ...earlier, flipped: true });
						continue;
					}
					axis = other;
				}
				const [left, right] = goesFirst(axis, i, j) ? [i, j] : [j, i];
				separations.set(key, {
					axis,
					constraint: {
						left,
						right,
						gap: (extent[i] as Vec2)[axis] + (extent[j] as Vec2)[axis] + need,
					},
					flipped: earlier !== undefined,
				});
				added = true;
			}
		}
		const settled = (["x", "y"] as const).every((axis) =>
			positions[axis].every(
				(value, i) => Math.abs(value - (before[axis][i] ?? 0)) < 1e-7,
			),
		);
		if (!added && settled) break;
	}

	// Report equalities the solve could not hold.
	const failed = new Map<string, { origin: Origin; objects: Set<string> }>();
	for (const equality of equalities) {
		const at = positions[equality.axis];
		const value = (k: number) =>
			k === low ? 0 : k === high ? length[equality.axis] : (at[k] ?? 0);
		const residual = Math.abs(
			value(equality.right) - value(equality.left) - equality.gap,
		);
		if (residual > RESIDUAL) {
			const key = equality.origin.path.join(".");
			const entry = failed.get(key) ?? {
				origin: equality.origin,
				objects: new Set<string>(),
			};
			for (const k of [equality.left, equality.right]) {
				const object = floor[k];
				if (object !== undefined) entry.objects.add(object.id);
			}
			failed.set(key, entry);
		}
	}
	for (const { origin, objects } of failed.values()) {
		diagnostics.push({
			severity: "error",
			code: "scene.layout.conflict",
			message: `The ${origin.what} for ${[...objects].map((id) => `"${id}"`).join(", ")} cannot hold together with the other relations.`,
			objects: [...objects],
			path: origin.path,
			hint: "Relax or remove one of the conflicting relations, or make the room larger.",
		});
	}

	const centers = new Map<string, Vec2>();
	floor.forEach((object, i) => {
		centers.set(object.id, {
			x: positions.x[i] ?? 0,
			y: positions.y[i] ?? 0,
		});
	});
	return { centers, diagnostics };

	/**
	 * Whether i goes before j on an axis when they are pulled apart: as
	 * they stood in the previous pass (so passes and rounds keep one order),
	 * else as they stand now, else in declaration order. Objects pulled to
	 * one spot land a rounding error apart, which must not decide.
	 */
	function goesFirst(axis: Axis, i: number, j: number): boolean {
		const was = (k: number) =>
			input.previous?.get((floor[k] as SceneObject).id)?.[axis];
		const pi = was(i);
		const pj = was(j);
		if (pi !== undefined && pj !== undefined && Math.abs(pi - pj) > 1e-6) {
			return pi < pj;
		}
		const ni = positions[axis][i] ?? 0;
		const nj = positions[axis][j] ?? 0;
		if (Math.abs(ni - nj) > 1e-6) return ni < nj;
		return i < j;
	}

	/** Equality-connected component of every variable on one axis. */
	function components(axis: Axis): number[] {
		const parent = Array.from({ length: n + 2 }, (_, k) => k);
		const find = (k: number): number => {
			let root = k;
			while (parent[root] !== root) root = parent[root] as number;
			return root;
		};
		const join = (a: number, b: number) => {
			const ra = find(a);
			const rb = find(b);
			if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
		};
		join(low, high);
		for (const equality of equalities) {
			if (equality.axis === axis) join(equality.left, equality.right);
		}
		return parent.map((_, k) => find(k));
	}

	/** Positions on one axis, measured from the low wall. */
	function solveAxis(axis: Axis): number[] {
		const constraints: VpscConstraint[] = [];
		const add = (constraint: VpscConstraint) => constraints.push(constraint);
		add({ left: low, right: high, gap: length[axis], equality: true });
		for (const equality of equalities) {
			if (equality.axis !== axis) continue;
			add({
				left: equality.left,
				right: equality.right,
				gap: equality.gap,
				equality: true,
			});
		}
		for (let i = 0; i < n; i += 1) {
			const e = (extent[i] as Vec2)[axis];
			add({ left: low, right: i, gap: e });
			add({ left: i, right: high, gap: e });
		}
		for (const separation of separations.values()) {
			if (separation.axis === axis) add(separation.constraint);
		}
		const result = solveSeparationQp(
			{
				size: n + 2,
				pairs: pulls
					.filter((pull) => pull.axis === axis)
					.map((pull) => ({ a: pull.a, b: pull.b, weight: PAIR_WEIGHT })),
				anchors: [
					...floor.map((_, i) => ({
						v: i,
						target: anchorTarget(axis, i),
						weight: PULL_WEIGHT,
					})),
					{ v: low, target: 0, weight: WALL_WEIGHT },
					{ v: high, target: length[axis], weight: WALL_WEIGHT },
				],
				constraints,
				initial: [...positions[axis], 0, length[axis]],
			},
			{ maxIterations: 2000, tolerance: 1e-7 },
		);
		// The walls sit within a hair of 0 and the length; measure from them.
		const shift = result.positions[low] ?? 0;
		return result.positions.slice(0, n).map((value) => value - shift);
	}
}

/** Start objects with nothing to go on spread across the room. */
function spreadStart(i: number, n: number, length: number): number {
	return (length * (i + 1)) / (n + 1);
}
