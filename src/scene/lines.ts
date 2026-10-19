import { type Geodetic, geodesicDirect, geodesicInverse } from "./geo/index.js";
import type { Vec2 } from "./geometry.js";

/**
 * Polylines in the scene: roads, fences, flight lines. Things are placed
 * along them by arc length, and drone waypoints are laid out on them.
 */

/** Total length of a polyline. */
export function polylineLength(points: readonly Vec2[]): number {
	let length = 0;
	for (let k = 1; k < points.length; k += 1) {
		const a = points[k - 1] as Vec2;
		const b = points[k] as Vec2;
		length += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return length;
}

/**
 * The point `s` metres along a polyline (clamped to its ends) and the
 * direction of travel there, degrees counter-clockwise from east. At a
 * corner the direction is the next segment's (the last one's at the end).
 */
export function pointAlong(
	points: readonly Vec2[],
	s: number,
): { point: Vec2; angle: number } {
	let left = Math.max(0, s);
	for (let k = 1; k < points.length; k += 1) {
		const a = points[k - 1] as Vec2;
		const b = points[k] as Vec2;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length === 0) continue;
		const last = k === points.length - 1;
		if (left < length || last) {
			const t = Math.min(1, left / length);
			return {
				point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
				angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
			};
		}
		left -= length;
	}
	const only = points[0] ?? { x: 0, y: 0 };
	return { point: { ...only }, angle: 0 };
}

/**
 * A line through geographic points along the ellipsoid's geodesics (the
 * great circle, on the sphere): each leg gets points at most `step`
 * metres apart, so it keeps its curve once projected.
 */
export function geodesicPolyline(
	points: readonly Geodetic[],
	step: number,
): Geodetic[] {
	const out: Geodetic[] = [];
	for (let k = 0; k < points.length; k += 1) {
		const b = points[k] as Geodetic;
		if (k > 0) {
			const a = points[k - 1] as Geodetic;
			const leg = geodesicInverse(a, b);
			const count = Math.min(10_000, Math.ceil(leg.distance / step));
			for (let n = 1; n < count; n += 1) {
				const at = geodesicDirect(a, leg.bearing, (leg.distance * n) / count);
				out.push({ lat: at.lat, lon: at.lon });
			}
		}
		out.push({ lat: b.lat, lon: b.lon });
	}
	return out;
}

/**
 * Arc-length positions of `count` things along a line `length` long: from
 * `from`, `spacing` apart; or, without a spacing, spread evenly from
 * `from` to the end (one thing stands at `from`).
 */
export function stations(
	length: number,
	count: number,
	options: { spacing?: number; from?: number },
): number[] {
	const from = options.from ?? 0;
	if (options.spacing !== undefined) {
		return Array.from(
			{ length: count },
			(_, k) => from + k * (options.spacing as number),
		);
	}
	if (count === 1) return [from];
	return Array.from(
		{ length: count },
		(_, k) => from + ((length - from) * k) / (count - 1),
	);
}

/**
 * Waypoints on a line at `height` above the ground: `spacing` apart from
 * the start (and the end), `count` spread evenly, or one per vertex. The
 * lowest height above the ground along the straight legs between them is
 * measured every eighth of a grid cell (exact on a flat floor).
 */
export function layWaypoints(
	line: readonly Vec2[],
	options: {
		spacing?: number;
		count?: number;
		height: number;
		ground?: (x: number, y: number) => number;
		/** Sampling step for the legs (an eighth of a grid cell). */
		step?: number;
	},
): { points: [number, number, number][]; lowest: number } {
	const ground = options.ground ?? (() => 0);
	const length = polylineLength(line);
	let at: Vec2[];
	if (options.spacing !== undefined) {
		const count = Math.min(10_000, Math.floor(length / options.spacing + 1e-9));
		at = Array.from(
			{ length: count + 1 },
			(_, k) => pointAlong(line, k * (options.spacing as number)).point,
		);
		if (count * options.spacing < length - 1e-9) {
			at.push(pointAlong(line, length).point);
		}
	} else if (options.count !== undefined) {
		at = stations(length, options.count, {}).map(
			(s) => pointAlong(line, s).point,
		);
	} else {
		at = line.map((point) => ({ ...point }));
	}
	const points = at.map((p): [number, number, number] => [
		p.x,
		p.y,
		ground(p.x, p.y) + options.height,
	]);
	let lowest = Number.POSITIVE_INFINITY;
	for (let k = 0; k < points.length; k += 1) {
		const [x1, y1, z1] = points[k] as [number, number, number];
		lowest = Math.min(lowest, z1 - ground(x1, y1));
		if (k === 0) continue;
		const [x0, y0, z0] = points[k - 1] as [number, number, number];
		const leg = Math.hypot(x1 - x0, y1 - y0);
		const steps =
			options.step === undefined
				? 1
				: Math.min(100_000, Math.max(8, Math.ceil(leg / options.step)));
		for (let n = 1; n < steps; n += 1) {
			const t = n / steps;
			const x = x0 + (x1 - x0) * t;
			const y = y0 + (y1 - y0) * t;
			lowest = Math.min(lowest, z0 + (z1 - z0) * t - ground(x, y));
		}
	}
	return { points, lowest };
}

/**
 * Whether the segment from `a` to `b` passes through a box (slab test);
 * touching counts as passing through.
 */
export function segmentHitsBox(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
	box: { min: readonly number[]; max: readonly number[] },
): boolean {
	let t0 = 0;
	let t1 = 1;
	for (let k = 0; k < 3; k += 1) {
		const from = a[k] as number;
		const d = (b[k] as number) - from;
		const lo = box.min[k] as number;
		const hi = box.max[k] as number;
		if (Math.abs(d) < 1e-12) {
			if (from < lo || from > hi) return false;
			continue;
		}
		let near = (lo - from) / d;
		let far = (hi - from) / d;
		if (near > far) [near, far] = [far, near];
		t0 = Math.max(t0, near);
		t1 = Math.min(t1, far);
		if (t0 > t1) return false;
	}
	return true;
}
