/**
 * The obfuscated coordinate systems used by map services in mainland
 * China: GCJ-02 (state survey offset) and BD-09 (Baidu, an offset of
 * GCJ-02). The forward formulas are the widely published ones; they are
 * approximations of the official transform, good to within a few metres.
 * The inverses are solved by fixed-point iteration on the forward
 * formula, to well under a millimetre of that formula. Outside mainland
 * China GCJ-02 equals WGS84.
 */
import type { Geodetic } from "./wgs84.js";

const A = 6378245;
const EE = 0.006693421622965943;
const X_PI = (Math.PI * 3000) / 180;

/** Rough mainland bounding box, as in the published formulas. */
export function outOfChina(lat: number, lon: number): boolean {
	return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

export function wgs84ToGcj02(point: Geodetic): Geodetic {
	const { lat, lon } = point;
	if (outOfChina(lat, lon)) return { ...point };
	const [dLat, dLon] = offset(lat, lon);
	return { ...point, lat: lat + dLat, lon: lon + dLon };
}

export function gcj02ToWgs84(point: Geodetic): Geodetic {
	return invert(point, wgs84ToGcj02);
}

export function gcj02ToBd09(point: Geodetic): Geodetic {
	const x = point.lon;
	const y = point.lat;
	const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * X_PI);
	const theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * X_PI);
	return {
		...point,
		lon: z * Math.cos(theta) + 0.0065,
		lat: z * Math.sin(theta) + 0.006,
	};
}

export function bd09ToGcj02(point: Geodetic): Geodetic {
	return invert(point, gcj02ToBd09);
}

export function wgs84ToBd09(point: Geodetic): Geodetic {
	return gcj02ToBd09(wgs84ToGcj02(point));
}

export function bd09ToWgs84(point: Geodetic): Geodetic {
	return gcj02ToWgs84(bd09ToGcj02(point));
}

/** Solve forward(x) = target for x, starting from the target itself. */
function invert(
	target: Geodetic,
	forward: (p: Geodetic) => Geodetic,
): Geodetic {
	let guess: Geodetic = { ...target };
	for (let step = 0; step < 30; step += 1) {
		const at = forward(guess);
		const dLat = target.lat - at.lat;
		const dLon = target.lon - at.lon;
		guess = { ...guess, lat: guess.lat + dLat, lon: guess.lon + dLon };
		if (Math.abs(dLat) < 1e-12 && Math.abs(dLon) < 1e-12) break;
	}
	return guess;
}

function offset(lat: number, lon: number): [number, number] {
	const x = lon - 105;
	const y = lat - 35;
	let dLat =
		-100 +
		2 * x +
		3 * y +
		0.2 * y * y +
		0.1 * x * y +
		0.2 * Math.sqrt(Math.abs(x)) +
		((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) /
			3 +
		((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3 +
		((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) *
			2) /
			3;
	let dLon =
		300 +
		x +
		2 * y +
		0.1 * x * x +
		0.1 * x * y +
		0.1 * Math.sqrt(Math.abs(x)) +
		((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) /
			3 +
		((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3 +
		((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) *
			2) /
			3;
	const radLat = (lat / 180) * Math.PI;
	let magic = Math.sin(radLat);
	magic = 1 - EE * magic * magic;
	const sqrtMagic = Math.sqrt(magic);
	dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
	dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
	return [dLat, dLon];
}
