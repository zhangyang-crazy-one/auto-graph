import type { SceneAxis } from "./ir.js";

/**
 * Floor-plan geometry for objects that turn only about z: a footprint is
 * an oriented rectangle, an object an oriented rectangle times a height
 * interval.
 */

export interface Vec2 {
	x: number;
	y: number;
}

export interface Footprint {
	center: Vec2;
	/** Unit vector of the object's local x axis in the world. */
	axisX: Vec2;
	/** Unit vector of the object's local y axis in the world. */
	axisY: Vec2;
	/** Half width (local x) and half depth (local y). */
	halfX: number;
	halfY: number;
}

const AXIS_ANGLE: Record<SceneAxis, number> = {
	"+x": 0,
	"+y": 90,
	"-x": 180,
	"-y": -90,
};

/** Angle (degrees, counter-clockwise from east) of a local front axis. */
export function axisAngle(axis: SceneAxis): number {
	return AXIS_ANGLE[axis];
}

/** An angle in (-180, 180], with -0 and float noise cleaned up. */
export function normalizeDegrees(degrees: number): number {
	let value = degrees % 360;
	if (value <= -180) value += 360;
	if (value > 180) value -= 360;
	const rounded = Math.round(value * 1e9) / 1e9;
	return rounded === 0 ? 0 : rounded;
}

export function direction(degrees: number): Vec2 {
	// Exact at multiples of 90°, so axis-aligned boxes stay axis-aligned.
	const quarter = degrees / 90;
	if (Number.isInteger(quarter)) {
		const turns = ((quarter % 4) + 4) % 4;
		return [
			{ x: 1, y: 0 },
			{ x: 0, y: 1 },
			{ x: -1, y: 0 },
			{ x: 0, y: -1 },
		][turns] as Vec2;
	}
	const radians = (degrees * Math.PI) / 180;
	return { x: Math.cos(radians), y: Math.sin(radians) };
}

export function footprint(
	center: Vec2,
	size: readonly [number, number, number],
	yaw: number,
): Footprint {
	const axisX = direction(yaw);
	return {
		center,
		axisX,
		axisY: { x: -axisX.y, y: axisX.x },
		halfX: size[0] / 2,
		halfY: size[1] / 2,
	};
}

/** Half the footprint's extent along a unit vector. */
export function halfExtent(shape: Footprint, along: Vec2): number {
	return (
		shape.halfX * Math.abs(dot(shape.axisX, along)) +
		shape.halfY * Math.abs(dot(shape.axisY, along))
	);
}

/** Corners counter-clockwise, starting at local (-x, -y). */
export function corners(shape: Footprint): Vec2[] {
	const { center: c, axisX: ax, axisY: ay, halfX: hx, halfY: hy } = shape;
	return [
		[-1, -1],
		[1, -1],
		[1, 1],
		[-1, 1],
	].map(([sx = 0, sy = 0]) => ({
		x: c.x + ax.x * hx * sx + ay.x * hy * sy,
		y: c.y + ax.y * hx * sx + ay.y * hy * sy,
	}));
}

/**
 * Separating-axis test: how deep two footprints overlap (the smallest
 * overlap over the four edge normals), or 0 when they are apart or touch.
 */
export function penetration(a: Footprint, b: Footprint): number {
	let depth = Number.POSITIVE_INFINITY;
	const offset = sub(b.center, a.center);
	for (const axis of [a.axisX, a.axisY, b.axisX, b.axisY]) {
		const overlap =
			halfExtent(a, axis) + halfExtent(b, axis) - Math.abs(dot(offset, axis));
		if (overlap <= 0) return 0;
		depth = Math.min(depth, overlap);
	}
	return depth;
}

/** Shortest distance between two footprints (0 when they overlap). */
export function distance(a: Footprint, b: Footprint): number {
	if (penetration(a, b) > 0) return 0;
	const ca = corners(a);
	const cb = corners(b);
	let best = Number.POSITIVE_INFINITY;
	for (const [points, edges] of [
		[ca, cb],
		[cb, ca],
	] as const) {
		for (const point of points) {
			for (let index = 0; index < 4; index += 1) {
				best = Math.min(
					best,
					pointSegmentDistance(
						point,
						edges[index] as Vec2,
						edges[(index + 1) % 4] as Vec2,
					),
				);
			}
		}
	}
	return best;
}

/** How far `inner` reaches past `outer`'s edges (0 when inside). */
export function overhang(inner: Footprint, outer: Footprint): number {
	let worst = 0;
	for (const corner of corners(inner)) {
		const local = sub(corner, outer.center);
		worst = Math.max(
			worst,
			Math.abs(dot(local, outer.axisX)) - outer.halfX,
			Math.abs(dot(local, outer.axisY)) - outer.halfY,
		);
	}
	return worst;
}

export function contains(shape: Footprint, point: Vec2): boolean {
	const local = sub(point, shape.center);
	return (
		Math.abs(dot(local, shape.axisX)) <= shape.halfX + 1e-9 &&
		Math.abs(dot(local, shape.axisY)) <= shape.halfY + 1e-9
	);
}

export function dot(a: Vec2, b: Vec2): number {
	return a.x * b.x + a.y * b.y;
}

export function sub(a: Vec2, b: Vec2): Vec2 {
	return { x: a.x - b.x, y: a.y - b.y };
}

function pointSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
	const ab = sub(b, a);
	const length = dot(ab, ab);
	const t =
		length === 0
			? 0
			: Math.max(0, Math.min(1, dot(sub(point, a), ab) / length));
	return Math.hypot(point.x - (a.x + ab.x * t), point.y - (a.y + ab.y * t));
}
