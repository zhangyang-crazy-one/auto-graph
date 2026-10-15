import { centreSegmentsInChannels } from "../routing/channel-centre.js";
import type { Vec2 } from "./geometry.js";

/**
 * Refining planned paths: the shortest path skims every corner it turns
 * at, which is legal (the agent's radius is kept) but not how people walk.
 *
 * - Any-angle paths: each corner is relaxed away from what it turns
 *   around, raising the path's least extra clearance up to `comfort`,
 *   then pulled tight again where a corner is no longer needed.
 * - Right-angle paths: auto-graph's channel centring (the pass that moves
 *   diagram edges to the middle of the free channel between nodes).
 * - Lanes: paths that share a run are moved apart, keeping to the right
 *   of their direction of travel, so two people pass instead of
 *   overlapping.
 *
 * Every move is checked against the grown obstacles (the configuration
 * space) and kept only if it lowers no clearance and the path stays
 * within its length budget.
 */

export interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** The configuration space of one agent: grown boxes and the pulled-in room. */
export interface FreeSpace {
	boxes: readonly Rect[];
	room: Rect;
}

/** Length a refined path may reach, as a share of the shortest one. */
export const LENGTH_BUDGET = 1.15;
const EPS = 1e-6;
/** Obstacles this close to a fixed end are what it stands next to. */
const BESIDE = 0.01;
const MAX_PASSES = 40;

export function insideOpen(point: Vec2, box: Rect): boolean {
	return (
		point.x > box.x0 + EPS / 2 &&
		point.x < box.x1 - EPS / 2 &&
		point.y > box.y0 + EPS / 2 &&
		point.y < box.y1 - EPS / 2
	);
}

/** Whether segment ab passes through the open interior of a box. */
export function segmentEntersBox(a: Vec2, b: Vec2, box: Rect): boolean {
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

/** Whether a segment stays in the free space. */
export function segmentFree(a: Vec2, b: Vec2, space: FreeSpace): boolean {
	const { room } = space;
	for (const p of [a, b]) {
		if (
			p.x < room.x0 - EPS ||
			p.x > room.x1 + EPS ||
			p.y < room.y0 - EPS ||
			p.y > room.y1 + EPS
		) {
			return false;
		}
	}
	return !space.boxes.some((box) => segmentEntersBox(a, b, box));
}

/**
 * How far a segment keeps from the grown obstacles and the pulled-in
 * walls: the clearance beyond what the agent needs. Obstacles beside a
 * fixed end (what the agent walks up to) do not count for that segment.
 */
export function extraClearance(
	a: Vec2,
	b: Vec2,
	space: FreeSpace,
	fixedA = false,
	fixedB = false,
): number {
	const ends = [...(fixedA ? [a] : []), ...(fixedB ? [b] : [])];
	const beside = (gap: (p: Vec2) => number) =>
		ends.some((end) => gap(end) < BESIDE);
	let best = Number.POSITIVE_INFINITY;
	for (const box of space.boxes) {
		if (beside((p) => pointRect(p, box))) continue;
		best = Math.min(best, segmentRect(a, b, box));
	}
	const { room } = space;
	for (const gap of [
		(p: Vec2) => p.x - room.x0,
		(p: Vec2) => room.x1 - p.x,
		(p: Vec2) => p.y - room.y0,
		(p: Vec2) => room.y1 - p.y,
	]) {
		if (beside(gap)) continue;
		// The room is convex: a segment is nearest a wall at an end.
		best = Math.min(best, gap(a), gap(b));
	}
	return Math.max(0, best);
}

/** Least extra clearance over a leg's segments (its ends are fixed). */
export function legClearance(
	points: readonly Vec2[],
	space: FreeSpace,
): number {
	let best = Number.POSITIVE_INFINITY;
	for (let k = 0; k + 1 < points.length; k += 1) {
		best = Math.min(
			best,
			extraClearance(
				points[k] as Vec2,
				points[k + 1] as Vec2,
				space,
				k === 0,
				k + 2 === points.length,
			),
		);
	}
	return best;
}

/**
 * Relax an any-angle leg's corners away from what they turn around until
 * its least extra clearance reaches `comfort` (or nothing more can be
 * gained), then pull it tight where a corner is no longer needed.
 */
export function centreAnyAngle(
	leg: readonly Vec2[],
	space: FreeSpace,
	comfort: number,
	budget: number,
): Vec2[] {
	if (leg.length < 3 || comfort <= 0) return [...leg];
	const points = leg.map((point) => ({ ...point }));
	const capped = (k: number, at: readonly Vec2[]) =>
		Math.min(
			comfort,
			extraClearance(
				at[k] as Vec2,
				at[k + 1] as Vec2,
				space,
				k === 0,
				k + 2 === at.length,
			),
		);
	const directions = Array.from({ length: 16 }, (_, k) => {
		const angle = (k * Math.PI) / 8;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	});
	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		let moved = false;
		for (let i = 1; i + 1 < points.length; i += 1) {
			const local = Math.min(capped(i - 1, points), capped(i, points));
			if (local >= comfort - EPS) continue;
			let best: { at: Vec2; score: number } | undefined;
			for (const step of [comfort, comfort / 2, comfort / 4, comfort / 8]) {
				for (const direction of directions) {
					const at = {
						x: (points[i] as Vec2).x + direction.x * step,
						y: (points[i] as Vec2).y + direction.y * step,
					};
					const prev = points[i - 1] as Vec2;
					const next = points[i + 1] as Vec2;
					if (!segmentFree(prev, at, space) || !segmentFree(at, next, space)) {
						continue;
					}
					const trial = [...points];
					trial[i] = at;
					if (pathLength(trial) > budget + EPS) continue;
					const score = Math.min(capped(i - 1, trial), capped(i, trial));
					if (score > (best?.score ?? local) + 1e-5) best = { at, score };
				}
			}
			if (best !== undefined) {
				points[i] = best.at;
				moved = true;
			}
		}
		if (!moved) break;
	}
	return pullTight(points, space, comfort);
}

/**
 * Drop corners whose neighbours see each other through free space without
 * losing clearance (up to `comfort`).
 */
export function pullTight(
	leg: readonly Vec2[],
	space: FreeSpace,
	comfort: number,
): Vec2[] {
	const points = [...leg];
	let changed = true;
	while (changed) {
		changed = false;
		const floor = Math.min(comfort, legClearance(points, space));
		for (let i = 1; i + 1 < points.length; i += 1) {
			const a = points[i - 1] as Vec2;
			const b = points[i + 1] as Vec2;
			if (!segmentFree(a, b, space)) continue;
			const shortcut = [...points.slice(0, i), ...points.slice(i + 1)];
			if (Math.min(comfort, legClearance(shortcut, space)) < floor - 1e-9) {
				continue;
			}
			points.splice(i, 1);
			changed = true;
			break;
		}
	}
	return points;
}

/**
 * Right-angle legs of agents with the same reach, centred together in
 * their free channels by auto-graph's channel centring (which also spaces
 * legs sharing a channel evenly across it). A leg keeps its centred form
 * only when it stays free, loses no clearance and keeps to its budget.
 */
export function centreOrthogonal(
	legs: readonly (readonly Vec2[])[],
	space: FreeSpace,
	budgets: readonly number[],
): Vec2[][] {
	const MM = 1000;
	const { room } = space;
	const far = 1;
	// The pulled-in walls as boxes just outside the room: the channel
	// centring treats walls and nodes alike.
	const walls = [
		...space.boxes,
		{ x0: room.x0 - far, y0: room.y0 - far, x1: room.x1 + far, y1: room.y0 },
		{ x0: room.x0 - far, y0: room.y1, x1: room.x1 + far, y1: room.y1 + far },
		{ x0: room.x0 - far, y0: room.y0, x1: room.x0, y1: room.y1 },
		{ x0: room.x1, y0: room.y0, x1: room.x1 + far, y1: room.y1 },
	].map((rect) => ({
		x: rect.x0 * MM,
		y: rect.y0 * MM,
		width: (rect.x1 - rect.x0) * MM,
		height: (rect.y1 - rect.y0) * MM,
	}));
	const edges = legs.map((leg, index) => ({
		id: `leg-${String(index).padStart(6, "0")}`,
		points: leg.map((point) => ({ x: point.x * MM, y: point.y * MM })),
	}));
	const centred = centreSegmentsInChannels(
		edges as never,
		walls,
		[],
		new Set(),
		1,
	);
	return legs.map((leg, index) => {
		const moved = (centred[index]?.points ?? []).map((point) => ({
			x: point.x / MM,
			y: point.y / MM,
		}));
		const ok =
			moved.length === leg.length &&
			moved
				.slice(1)
				.every((point, k) => segmentFree(moved[k] as Vec2, point, space)) &&
			legClearance(moved, space) >= legClearance(leg, space) - 1e-9 &&
			pathLength(moved) <= (budgets[index] ?? 0) + EPS;
		return ok ? moved : [...leg];
	});
}

export function pathLength(points: readonly Vec2[]): number {
	let sum = 0;
	for (let k = 0; k + 1 < points.length; k += 1) {
		const a = points[k] as Vec2;
		const b = points[k + 1] as Vec2;
		sum += Math.hypot(a.x - b.x, a.y - b.y);
	}
	return sum;
}

function pointRect(p: Vec2, box: Rect): number {
	const dx = Math.max(box.x0 - p.x, 0, p.x - box.x1);
	const dy = Math.max(box.y0 - p.y, 0, p.y - box.y1);
	return Math.hypot(dx, dy);
}

/** Distance between a segment and a box (0 when they meet). */
function segmentRect(a: Vec2, b: Vec2, box: Rect): number {
	if (
		segmentEntersBox(a, b, box) ||
		pointRect(a, box) === 0 ||
		pointRect(b, box) === 0
	) {
		return 0;
	}
	let best = Math.min(pointRect(a, box), pointRect(b, box));
	for (const corner of [
		{ x: box.x0, y: box.y0 },
		{ x: box.x1, y: box.y0 },
		{ x: box.x1, y: box.y1 },
		{ x: box.x0, y: box.y1 },
	]) {
		best = Math.min(best, pointSegment(corner, a, b));
	}
	return best;
}

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = dx * dx + dy * dy;
	const t =
		length === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length),
				);
	return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export interface LanePath {
	points: Vec2[];
	/** Points that may not move: stands at objects, openings and vias. */
	fixed: boolean[];
	width: number;
	space: FreeSpace;
	/** Steps aside at right angles, keeping every turn square. */
	orthogonal: boolean;
	/** Longest it may become (15 % over its shortest route). */
	budget: number;
	/** False keeps it on its route (`comfort 0`). */
	movable: boolean;
}

/**
 * Why a head-on shared run was left: too narrow to step aside, stepping
 * aside would break a length budget, neither path may move, or the lanes
 * were not worked out within the round limit.
 */
export type SharedReason = "narrow" | "budget" | "fixed" | "unresolved";

export interface LanesResult {
	paths: LanePath[];
	/** Pairs of paths left meeting head-on on a shared run. */
	shared: { paths: [number, number]; at: Vec2; reason: SharedReason }[];
}

/** Segments closer than this to parallel run together. */
const PARALLEL = Math.sin((5 * Math.PI) / 180);
/** Overlaps shorter than this are a crossing, not a shared run. */
const SHARED_RUN = 0.2;

/**
 * Paths meeting head-on on a shared run (antiparallel segments whose bands
 * overlap) pass each other: runs step to the right of their direction of
 * travel until the bands just touch (see `pass`). A fixed end (a stand)
 * keeps its place and the run steps aside just after it. A path never
 * grows past its budget, and one that may not move stays put. Rounds go
 * on while anything moves (up to a limit that grows with the paths);
 * every run still shared at the end is reported with the reason. Paths
 * going the same way are left alone: one walks behind the other.
 */
export function separateLanes(input: readonly LanePath[]): LanesResult {
	const paths = input.map((path) => ({
		...path,
		points: path.points.map((point) => ({ ...point })),
		fixed: [...path.fixed],
	}));
	const reasons = new Map<string, SharedReason>();
	const rounds =
		6 + input.reduce((sum, path) => sum + path.points.length, 0) * 2;
	for (let round = 0; round < rounds; round += 1) {
		let moved = false;
		for (let i = 0; i < paths.length; i += 1) {
			for (let j = i + 1; j < paths.length; j += 1) {
				const a = paths[i] as LanePath;
				const b = paths[j] as LanePath;
				const conflict = findSharedRun(a, b);
				if (conflict === undefined) continue;
				const passed = pass(a, b, conflict);
				if ("reason" in passed) {
					reasons.set(`${i}:${j}`, passed.reason);
					continue;
				}
				paths[i] = passed.paths[0];
				paths[j] = passed.paths[1];
				reasons.delete(`${i}:${j}`);
				moved = true;
			}
		}
		if (!moved) break;
	}
	// Every pair is checked again on the final paths, so a run left over
	// (say when the rounds ran out) is never passed over in silence.
	const shared: LanesResult["shared"] = [];
	for (let i = 0; i < paths.length; i += 1) {
		for (let j = i + 1; j < paths.length; j += 1) {
			const b = paths[j] as LanePath;
			const conflict = findSharedRun(paths[i] as LanePath, b);
			if (conflict === undefined) continue;
			shared.push({
				paths: [i, j],
				at: conflict.at,
				reason: reasons.get(`${i}:${j}`) ?? "unresolved",
			});
		}
	}
	return { paths, shared };
}

type Step =
	| { path: LanePath }
	| { reason: Exclude<SharedReason, "unresolved"> };

/**
 * The later path steps to its right; failing that, the earlier one to its
 * right; failing that, each half way (a gap just wide enough for both).
 */
function pass(
	a: LanePath,
	b: LanePath,
	conflict: SharedRun,
): { paths: [LanePath, LanePath] } | { reason: SharedReason } {
	const failed: SharedReason[] = [];
	const later = stepAside(b, conflict);
	if ("path" in later) return { paths: [a, later.path] };
	failed.push(later.reason);
	const back = findSharedRun(b, a);
	if (back !== undefined) {
		const earlier = stepAside(a, back);
		if ("path" in earlier) return { paths: [earlier.path, b] };
		failed.push(earlier.reason);
	}
	const half = stepAside(b, { ...conflict, offset: conflict.offset / 2 });
	if ("path" in half) {
		const rest = findSharedRun(half.path, a);
		if (rest === undefined) return { paths: [a, half.path] };
		const other = stepAside(a, rest);
		if ("path" in other) return { paths: [other.path, half.path] };
		failed.push(other.reason);
	} else {
		failed.push(half.reason);
	}
	if (failed.includes("budget")) return { reason: "budget" };
	// A path kept on its route (comfort 0) is the cause whenever one is
	// involved: giving it comfort may let the two pass.
	if (failed.includes("fixed")) return { reason: "fixed" };
	return { reason: "narrow" };
}

interface SharedRun {
	/** Segment of the moving path. */
	segment: number;
	/** Unit normal to step along. */
	normal: Vec2;
	/** How far to step. */
	offset: number;
	/** Middle of the stretch the two share. */
	at: Vec2;
}

function findSharedRun(a: LanePath, b: LanePath): SharedRun | undefined {
	const need = (a.width + b.width) / 2 + 0.01;
	for (let s = 0; s + 1 < b.points.length; s += 1) {
		const p = b.points[s] as Vec2;
		const q = b.points[s + 1] as Vec2;
		const length = Math.hypot(q.x - p.x, q.y - p.y);
		if (length < SHARED_RUN) continue;
		const dir = { x: (q.x - p.x) / length, y: (q.y - p.y) / length };
		for (let t = 0; t + 1 < a.points.length; t += 1) {
			const u = a.points[t] as Vec2;
			const v = a.points[t + 1] as Vec2;
			const other = Math.hypot(v.x - u.x, v.y - u.y);
			if (other < SHARED_RUN) continue;
			const odir = { x: (v.x - u.x) / other, y: (v.y - u.y) / other };
			if (Math.abs(dir.x * odir.y - dir.y * odir.x) > PARALLEL) continue;
			// Overlap along the moving segment's direction.
			const along = (point: Vec2) =>
				(point.x - p.x) * dir.x + (point.y - p.y) * dir.y;
			// Beside a stand both are at the same spot anyway: only the part of
			// the run clear of the stands is where they would pass.
			const lo = Math.max(b.fixed[s] ? need : 0, Math.min(along(u), along(v)));
			const hi = Math.min(
				b.fixed[s + 1] ? length - need : length,
				Math.max(along(u), along(v)),
			);
			if (hi - lo < SHARED_RUN) continue;
			// People going the same way walk one after the other; only those
			// meeting head-on need room to pass.
			if (dir.x * odir.x + dir.y * odir.y >= 0) continue;
			// Signed side of the moving segment relative to the other line, at
			// both ends of the shared stretch (runs up to 5° apart converge).
			const right = { x: dir.y, y: -dir.x };
			const sideAt = (d: number) => {
				const point = { x: p.x + dir.x * d, y: p.y + dir.y * d };
				const t = Math.max(
					0,
					Math.min(other, (point.x - u.x) * odir.x + (point.y - u.y) * odir.y),
				);
				const foot = { x: u.x + odir.x * t, y: u.y + odir.y * t };
				return (point.x - foot.x) * right.x + (point.y - foot.y) * right.y;
			};
			const lateral = Math.min(sideAt(lo), sideAt(hi));
			const far = Math.max(sideAt(lo), sideAt(hi));
			if (lateral >= need - 1e-3 || far <= -(need - 1e-3)) continue;
			const middle = (lo + hi) / 2;
			return {
				segment: s,
				normal: right,
				offset: need - lateral,
				at: { x: p.x + dir.x * middle, y: p.y + dir.y * middle },
			};
		}
	}
	return undefined;
}

/**
 * The whole run steps aside; failing that, only its middle. A step that
 * makes the path longer than its budget does not count.
 */
function stepAside(path: LanePath, run: SharedRun): Step {
	if (!path.movable) return { reason: "fixed" };
	let reason: "narrow" | "budget" = "narrow";
	for (const middleOnly of [false, true]) {
		const moved = shiftRun(path, run, middleOnly);
		if (moved === undefined) continue;
		if (pathLength(moved.points) <= path.budget + EPS) return { path: moved };
		reason = "budget";
	}
	return { reason };
}

function shiftRun(
	path: LanePath,
	run: SharedRun,
	middleOnly: boolean,
): LanePath | undefined {
	const { segment, normal, offset } = run;
	const p = path.points[segment] as Vec2;
	const q = path.points[segment + 1] as Vec2;
	const length = Math.hypot(q.x - p.x, q.y - p.y);
	const dir = { x: (q.x - p.x) / length, y: (q.y - p.y) / length };
	const shift = (point: Vec2) => ({
		x: point.x + normal.x * offset,
		y: point.y + normal.y * offset,
	});
	// Fixed ends (and with `middleOnly` both corners) stay; the run steps
	// aside a little way in from them.
	const ease = Math.min(length / 3, 2 * offset + 0.05);
	const replacement: Vec2[] = [];
	const fixedOut: boolean[] = [];
	if (middleOnly || path.fixed[segment]) {
		const from = { x: p.x + dir.x * ease, y: p.y + dir.y * ease };
		replacement.push(p, ...(path.orthogonal ? [from] : []), shift(from));
		fixedOut.push(
			path.fixed[segment] === true,
			...(path.orthogonal ? [false] : []),
			false,
		);
	} else {
		replacement.push(shift(p));
		fixedOut.push(false);
	}
	if (middleOnly || path.fixed[segment + 1]) {
		const to = { x: q.x - dir.x * ease, y: q.y - dir.y * ease };
		replacement.push(shift(to), ...(path.orthogonal ? [to] : []), q);
		fixedOut.push(
			false,
			...(path.orthogonal ? [false] : []),
			path.fixed[segment + 1] === true,
		);
	} else {
		replacement.push(shift(q));
		fixedOut.push(false);
	}
	const points = [
		...path.points.slice(0, segment),
		...replacement,
		...path.points.slice(segment + 2),
	];
	const fixed = [
		...path.fixed.slice(0, segment),
		...fixedOut,
		...path.fixed.slice(segment + 2),
	];
	for (let k = 0; k + 1 < points.length; k += 1) {
		if (!segmentFree(points[k] as Vec2, points[k + 1] as Vec2, path.space)) {
			return undefined;
		}
	}
	return { ...path, points, fixed };
}
