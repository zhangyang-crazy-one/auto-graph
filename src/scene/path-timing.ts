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
	const times = [start];
	lengths.forEach((length, k) => {
		const profile = segmentProfile(
			length,
			speeds[k] as number,
			speeds[k + 1] as number,
			speed,
			accel,
		);
		times.push((times[k] as number) + profile.total);
	});
	return {
		times,
		speeds,
		start,
		duration: (times.at(-1) as number) - start,
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
	const { times, speeds } = timing;
	if (
		t < (times[0] as number) - 1e-12 ||
		t > (times.at(-1) as number) + 1e-12
	) {
		return undefined;
	}
	for (let k = 0; k + 1 < points.length; k += 1) {
		const t0 = times[k] as number;
		const t1 = times[k + 1] as number;
		if (t > t1 + 1e-12 && k + 2 < points.length) continue;
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
			Math.min(Math.max(t - t0, 0), t1 - t0),
			timing.accel,
		);
		const f = Math.min(1, along / length);
		return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
	}
	return { ...(points.at(-1) as Vec2) };
}

/**
 * Times to sample a path at: every `step` seconds plus every corner, so
 * a piecewise-linear track through them passes through every corner.
 */
export function sampleTimes(timing: PathTiming, step: number): number[] {
	const out = new Set<number>(timing.times.map(roundTime));
	const end = timing.start + timing.duration;
	for (let t = timing.start; t < end; t += step) out.add(roundTime(t));
	out.add(roundTime(end));
	return [...out].sort((a, b) => a - b);
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

/** Sampling step for meetings, seconds. */
const STEP = 0.05;

/**
 * Agents on paths that overlap in time touch when their centers come
 * closer than the sum of their radii. The later of the two is tried with
 * later starts in half-second steps to suggest a delay.
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
			const limit = a.timing.start + a.timing.duration - b.timing.start + 0.5;
			for (let d = 0.5; d <= limit + 1e-9; d += 0.5) {
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
	const reach = a.radius + b.radius;
	for (let t = from; t <= to + 1e-9; t += STEP) {
		const p = positionAt(a.points, a.timing, Math.min(t, to));
		const q = positionAt(b.points, b.timing, Math.min(t, to) - delay);
		if (p === undefined || q === undefined) continue;
		if (distance(p, q) < reach - 1e-6) {
			return {
				at: roundTime(t),
				where: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
			};
		}
	}
	return undefined;
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
	return Math.round(t * 1e6) / 1e6;
}

function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function unit(a: Vec2, b: Vec2): Vec2 {
	const length = distance(a, b) || 1;
	return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}
