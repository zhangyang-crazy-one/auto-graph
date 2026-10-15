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

/** Later starts tried for a suggestion, in half-second steps. */
const DELAYS = 240;

/**
 * Agents on paths that overlap in time touch when their centers come
 * closer than the sum of their radii. The check is exact: each agent's
 * walk is a run of phases (speeding up, cruising, braking along one
 * segment) in which its position is a quadratic in time, so over the time
 * two phases share, the squared distance between the agents is a quartic
 * whose first dip below the touching distance is found by splitting it
 * where its slope turns. The later of the two is tried with later starts
 * in half-second steps to suggest a delay.
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

/** A stretch of a walk in which the position is p0 + u·(v0·τ + a·τ²/2). */
interface Phase {
	/** Scene time it begins and ends. */
	t0: number;
	t1: number;
	p0: Vec2;
	u: Vec2;
	v0: number;
	a: number;
}

function phases(
	points: readonly Vec2[],
	timing: PathTiming,
	start: number,
): Phase[] {
	const out: Phase[] = [];
	for (let k = 0; k + 1 < points.length; k += 1) {
		const p = points[k] as Vec2;
		const q = points[k + 1] as Vec2;
		const length = distance(p, q);
		if (length === 0) continue;
		const u = { x: (q.x - p.x) / length, y: (q.y - p.y) / length };
		const profile = segmentProfile(
			length,
			timing.speeds[k] as number,
			timing.speeds[k + 1] as number,
			timing.speed,
			timing.accel,
		);
		const t = start + (timing.elapsed[k] as number);
		const upTo = (profile.peak ** 2 - profile.v0 ** 2) / (2 * timing.accel);
		const at = (s: number) => ({ x: p.x + u.x * s, y: p.y + u.y * s });
		const pieces: [number, number, number, number][] = [
			// duration, distance at its start, speed at its start, accel
			[profile.up, 0, profile.v0, timing.accel],
			[profile.cruise, upTo, profile.peak, 0],
			[
				profile.down,
				upTo + profile.peak * profile.cruise,
				profile.peak,
				-timing.accel,
			],
		];
		let t0 = t;
		for (const [span, s0, v0, a] of pieces) {
			if (span <= 0) continue;
			out.push({ t0, t1: t0 + span, p0: at(s0), u, v0, a });
			t0 += span;
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
	// A standing agent (an empty walk) is a phase that never moves.
	const still = (p: readonly Vec2[], t0: number, t1: number): Phase[] => [
		{ t0, t1, p0: p[0] as Vec2, u: { x: 0, y: 0 }, v0: 0, a: 0 },
	];
	const pa = phases(a.points, a.timing, a.timing.start);
	const pb = phases(b.points, b.timing, bStart);
	const listA = pa.length > 0 ? pa : still(a.points, a.timing.start, to);
	const listB = pb.length > 0 ? pb : still(b.points, bStart, to);
	let i = 0;
	let j = 0;
	while (i < listA.length && j < listB.length) {
		const x = listA[i] as Phase;
		const y = listB[j] as Phase;
		const w0 = Math.max(x.t0, y.t0, from);
		const w1 = Math.min(x.t1, y.t1, to);
		if (w1 >= w0) {
			const tau = firstDip(x, y, w0, w1 - w0, reach);
			if (tau !== undefined) {
				const t = w0 + tau;
				const p = phaseAt(x, t);
				const q = phaseAt(y, t);
				return {
					at: roundTime(t),
					where: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
				};
			}
		}
		if (x.t1 < y.t1) i += 1;
		else j += 1;
	}
	return undefined;
}

function phaseAt(phase: Phase, t: number): Vec2 {
	const tau = t - phase.t0;
	const s = phase.v0 * tau + (phase.a * tau * tau) / 2;
	return { x: phase.p0.x + phase.u.x * s, y: phase.p0.y + phase.u.y * s };
}

/**
 * The first τ in [0, span] (from w0) at which two phases are closer than
 * `reach`, or undefined. Their difference is D0 + D1·τ + D2·τ², so
 * |d|² − reach² is a quartic; it is split where its derivative changes
 * sign and each monotone piece is checked in order.
 */
function firstDip(
	x: Phase,
	y: Phase,
	w0: number,
	span: number,
	reach: number,
): number | undefined {
	// Position over τ from w0: p0 + u·(c0 + c1·τ + c2·τ²).
	const coeffs = (phase: Phase) => {
		const k = w0 - phase.t0;
		return [
			phase.v0 * k + (phase.a * k * k) / 2,
			phase.v0 + phase.a * k,
			phase.a / 2,
		];
	};
	const [a0, a1, a2] = coeffs(x) as [number, number, number];
	const [b0, b1, b2] = coeffs(y) as [number, number, number];
	const D0 = {
		x: x.p0.x - y.p0.x + x.u.x * a0 - y.u.x * b0,
		y: x.p0.y - y.p0.y + x.u.y * a0 - y.u.y * b0,
	};
	const D1 = { x: x.u.x * a1 - y.u.x * b1, y: x.u.y * a1 - y.u.y * b1 };
	const D2 = { x: x.u.x * a2 - y.u.x * b2, y: x.u.y * a2 - y.u.y * b2 };
	const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.y * q.y;
	const q4 = dot(D2, D2);
	const q3 = 2 * dot(D1, D2);
	const q2 = dot(D1, D1) + 2 * dot(D0, D2);
	const q1 = 2 * dot(D0, D1);
	const q0 = dot(D0, D0) - reach * reach;
	const f = (t: number) => (((q4 * t + q3) * t + q2) * t + q1) * t + q0;
	const df = (t: number) => ((4 * q4 * t + 3 * q3) * t + 2 * q2) * t + q1;
	if (f(0) < 0) return 0;
	// Roots of f' in (0, span): split f'' (a quadratic) first.
	const turns = quadraticRoots(12 * q4, 6 * q3, 2 * q2).filter(
		(t) => t > 0 && t < span,
	);
	const knots = [0, ...turns.sort((p, q) => p - q), span];
	const stationary: number[] = [];
	for (let k = 0; k + 1 < knots.length; k += 1) {
		const lo = knots[k] as number;
		const hi = knots[k + 1] as number;
		const root = bisect(df, lo, hi);
		if (root !== undefined) stationary.push(root);
	}
	const pieces = [0, ...stationary, span];
	for (let k = 0; k + 1 < pieces.length; k += 1) {
		const lo = pieces[k] as number;
		const hi = pieces[k + 1] as number;
		if (f(hi) < 0) return bisect(f, lo, hi) ?? hi;
	}
	return undefined;
}

/** A sign change of g on [lo, hi], by bisection; undefined if none. */
function bisect(
	g: (t: number) => number,
	lo: number,
	hi: number,
): number | undefined {
	let gl = g(lo);
	const gh = g(hi);
	if (gl === 0) return lo;
	if (Math.sign(gl) === Math.sign(gh)) return gh === 0 ? hi : undefined;
	let a = lo;
	let b = hi;
	for (let step = 0; step < 80 && b - a > 1e-12; step += 1) {
		const m = (a + b) / 2;
		const gm = g(m);
		if (Math.sign(gm) === Math.sign(gl)) {
			a = m;
			gl = gm;
		} else {
			b = m;
		}
	}
	return b;
}

function quadraticRoots(a: number, b: number, c: number): number[] {
	if (Math.abs(a) < 1e-15) return Math.abs(b) < 1e-15 ? [] : [-c / b];
	const disc = b * b - 4 * a * c;
	if (disc < 0) return [];
	const root = Math.sqrt(disc);
	return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
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
