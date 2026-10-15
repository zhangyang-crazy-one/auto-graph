import type { Vec2 } from "./geometry.js";

/**
 * Timing for planned paths: when an agent reaches each corner.
 *
 * An agent starts and stops at rest, speeds up and brakes at `accel` and
 * never goes faster than `speed`. At a corner it slows to
 * `speed · (1 + cos θ) / 2`, where θ is how far it turns: full speed
 * straight on, half speed round a right angle, a stop for a turn back.
 * Speeds at the corners come from a forward pass (how fast it can be
 * after accelerating from the last corner) and a backward pass (how fast
 * it may be to still brake for the next); each segment is then a
 * trapezoid (or triangle) in speed.
 */
export interface PathTiming {
	/** Seconds at each point, from the scene's time 0. */
	times: number[];
	/**
	 * Seconds at each point from setting off. Motion is computed on these,
	 * so a large `start` costs no precision.
	 */
	elapsed: number[];
	/** Speed at each point, m/s. */
	speeds: number[];
	start: number;
	duration: number;
	speed: number;
	accel: number;
}

export function timePath(
	points: readonly Vec2[],
	speed: number,
	accel: number,
	start: number,
): PathTiming {
	const n = points.length;
	const lengths = points
		.slice(1)
		.map((point, k) => distance(points[k] as Vec2, point));
	const cap = points.map((_, k) => {
		if (k === 0 || k === n - 1) return 0;
		const a = points[k - 1] as Vec2;
		const b = points[k] as Vec2;
		const c = points[k + 1] as Vec2;
		const u = unit(a, b);
		const v = unit(b, c);
		const cos = u.x * v.x + u.y * v.y;
		return (speed * (1 + cos)) / 2;
	});
	const speeds = [...cap];
	for (let k = 1; k < n; k += 1) {
		speeds[k] = Math.min(
			speeds[k] as number,
			Math.sqrt(
				(speeds[k - 1] as number) ** 2 + 2 * accel * (lengths[k - 1] as number),
			),
		);
	}
	for (let k = n - 2; k >= 0; k -= 1) {
		speeds[k] = Math.min(
			speeds[k] as number,
			Math.sqrt(
				(speeds[k + 1] as number) ** 2 + 2 * accel * (lengths[k] as number),
			),
		);
	}
	const elapsed = [0];
	lengths.forEach((length, k) => {
		const profile = segmentProfile(
			length,
			speeds[k] as number,
			speeds[k + 1] as number,
			speed,
			accel,
		);
		elapsed.push((elapsed[k] as number) + profile.total);
	});
	return {
		times: elapsed.map((e) => start + e),
		elapsed,
		speeds,
		start,
		duration: elapsed.at(-1) as number,
		speed,
		accel,
	};
}

/** Where the agent is at time t; undefined before it sets off or after it arrives. */
export function positionAt(
	points: readonly Vec2[],
	timing: PathTiming,
	t: number,
): Vec2 | undefined {
	const since = t - timing.start;
	if (since < -1e-9 || since > timing.duration + 1e-9) return undefined;
	return positionAfter(points, timing, since);
}

/**
 * Where the agent is `since` seconds after setting off (clamped to the
 * walk: at the start before it, at the end after it).
 */
export function positionAfter(
	points: readonly Vec2[],
	timing: PathTiming,
	since: number,
): Vec2 {
	const { elapsed, speeds } = timing;
	const s = Math.min(Math.max(since, 0), timing.duration);
	for (let k = 0; k + 1 < points.length; k += 1) {
		const e0 = elapsed[k] as number;
		const e1 = elapsed[k + 1] as number;
		if (s > e1 && k + 2 < points.length) continue;
		const a = points[k] as Vec2;
		const b = points[k + 1] as Vec2;
		const length = distance(a, b);
		if (length === 0) return { ...b };
		const along = distanceAt(
			segmentProfile(
				length,
				speeds[k] as number,
				speeds[k + 1] as number,
				timing.speed,
				timing.accel,
			),
			Math.min(Math.max(s - e0, 0), e1 - e0),
			timing.accel,
		);
		const f = Math.min(1, along / length);
		return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
	}
	return { ...(points[0] as Vec2) };
}

/** At most this many samples per path, however long the walk. */
const MAX_SAMPLES = 20_000;

/**
 * Seconds from setting off to sample a path at: evenly, at most `step`
 * apart (and at most MAX_SAMPLES of them), plus every corner, so a
 * piecewise-linear track through them passes through every corner.
 */
export function sampleElapsed(timing: PathTiming, step: number): number[] {
	const count = Math.min(
		MAX_SAMPLES,
		Math.max(1, Math.ceil(timing.duration / step)),
	);
	const all = [...timing.elapsed];
	for (let k = 0; k <= count; k += 1) all.push((timing.duration * k) / count);
	all.sort((a, b) => a - b);
	const out: number[] = [];
	for (const e of all) {
		if (out.length === 0 || e - (out.at(-1) as number) > 1e-9) out.push(e);
	}
	return out;
}

export interface TimedPath {
	id: string;
	points: readonly Vec2[];
	timing: PathTiming;
	radius: number;
}

export interface Meeting {
	a: string;
	b: string;
	/** First moment the two agents touch. */
	at: number;
	where: Vec2;
	/** How much later `b` could set off to miss `a` (undefined: none found). */
	delay?: number;
}

/** Intervals shorter than this (s) are decided by their middle. */
const SHORTEST = 1e-4;
/** Work limit per pair (interval visits). */
const BUDGET = 400_000;
/** Later starts tried for a suggestion, in half-second steps. */
const DELAYS = 240;

/**
 * Agents on paths that overlap in time touch when their centers come
 * closer than the sum of their radii. The check is continuous: an
 * interval is safe when the two agents are far enough apart at its ends
 * that, at their top speeds, they could not have met in between;
 * otherwise it is halved, earliest half first. The later of the two is
 * tried with later starts in half-second steps to suggest a delay.
 */
export function findMeetings(paths: readonly TimedPath[]): Meeting[] {
	const out: Meeting[] = [];
	for (let i = 0; i < paths.length; i += 1) {
		for (let j = i + 1; j < paths.length; j += 1) {
			const a = paths[i] as TimedPath;
			const b = paths[j] as TimedPath;
			const first = firstTouch(a, b, 0);
			if (first === undefined) continue;
			let delay: number | undefined;
			for (let k = 1; k <= DELAYS; k += 1) {
				const d = k * 0.5;
				if (b.timing.start + d > a.timing.start + a.timing.duration + 0.5) {
					break;
				}
				if (firstTouch(a, b, d) === undefined) {
					delay = d;
					break;
				}
			}
			out.push({
				a: a.id,
				b: b.id,
				at: first.at,
				where: first.where,
				...(delay === undefined ? {} : { delay }),
			});
		}
	}
	return out;
}

function firstTouch(
	a: TimedPath,
	b: TimedPath,
	delay: number,
): { at: number; where: Vec2 } | undefined {
	const bStart = b.timing.start + delay;
	const from = Math.max(a.timing.start, bStart);
	const to = Math.min(
		a.timing.start + a.timing.duration,
		bStart + b.timing.duration,
	);
	if (to < from) return undefined;
	const reach = a.radius + b.radius - 1e-6;
	const speed = a.timing.speed + b.timing.speed;
	const at = (t: number) => {
		const p = positionAfter(a.points, a.timing, t - a.timing.start);
		const q = positionAfter(b.points, b.timing, t - bStart);
		return { p, q, gap: distance(p, q) };
	};
	const touch = (t: number, p: Vec2, q: Vec2) => ({
		at: roundTime(t),
		where: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
	});
	const start = at(from);
	if (start.gap < reach) return touch(from, start.p, start.q);
	// Depth first, earliest half first, so intervals are settled in time
	// order: the first one found touching holds the earliest touch (to
	// within SHORTEST).
	let best: { t: number; p: Vec2; q: Vec2 } | undefined;
	const stack: [number, number, number, number][] = [
		[from, to, start.gap, at(to).gap],
	];
	for (let visits = 0; stack.length > 0 && visits < BUDGET; visits += 1) {
		const [t0, t1, g0, g1] = stack.pop() as [number, number, number, number];
		if (best !== undefined && t0 >= best.t) continue;
		// Closest the two can come in between, moving at top speed.
		if ((g0 + g1 - speed * (t1 - t0)) / 2 >= reach) continue;
		const middle = (t0 + t1) / 2;
		const mid = at(middle);
		if (mid.gap < reach) best = { t: middle, p: mid.p, q: mid.q };
		if (t1 - t0 < SHORTEST) {
			if (best !== undefined) break;
			continue;
		}
		// A touch in the middle leaves only the first half to search.
		if (mid.gap >= reach) stack.push([middle, t1, mid.gap, g1]);
		stack.push([t0, middle, g0, mid.gap]);
	}
	if (best !== undefined) return touch(best.t, best.p, best.q);
	const end = at(to);
	return end.gap < reach ? touch(to, end.p, end.q) : undefined;
}

interface Profile {
	v0: number;
	v1: number;
	peak: number;
	/** Seconds speeding up, cruising, braking. */
	up: number;
	cruise: number;
	down: number;
	total: number;
}

function segmentProfile(
	length: number,
	v0: number,
	v1: number,
	speed: number,
	accel: number,
): Profile {
	// Highest speed reachable between the ends, capped at `speed`.
	const peak = Math.min(
		speed,
		Math.sqrt(Math.max((2 * accel * length + v0 * v0 + v1 * v1) / 2, 0)),
	);
	const up = Math.max(peak - v0, 0) / accel;
	const down = Math.max(peak - v1, 0) / accel;
	const covered =
		(peak * peak - v0 * v0) / (2 * accel) +
		(peak * peak - v1 * v1) / (2 * accel);
	const cruise = peak > 0 ? Math.max(length - covered, 0) / peak : 0;
	return { v0, v1, peak, up, cruise, down, total: up + cruise + down };
}

function distanceAt(profile: Profile, t: number, accel: number): number {
	const { v0, peak, up, cruise } = profile;
	if (t <= up) return v0 * t + (accel * t * t) / 2;
	const afterUp = (peak * peak - v0 * v0) / (2 * accel);
	if (t <= up + cruise) return afterUp + peak * (t - up);
	const s = t - up - cruise;
	return afterUp + peak * cruise + peak * s - (accel * s * s) / 2;
}

function roundTime(t: number): number {
	return Math.round(t * 1e4) / 1e4;
}

function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function unit(a: Vec2, b: Vec2): Vec2 {
	const length = distance(a, b) || 1;
	return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}
