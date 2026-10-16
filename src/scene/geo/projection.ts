/**
 * Map projections on WGS84: transverse Mercator (Krüger's series to
 * sixth order in n, as in Karney 2011, "Transverse Mercator with an
 * accuracy of a few nanometers"; good to a few nanometres within 4000 km
 * of the central meridian), UTM on top of it, and Web Mercator (EPSG:3857).
 */
import { WGS84_A, WGS84_F } from "./wgs84.js";

const RAD = Math.PI / 180;
const N = WGS84_F / (2 - WGS84_F);
const E2 = WGS84_F * (2 - WGS84_F);
const E = Math.sqrt(E2);
/** The rectifying radius. */
const A = (WGS84_A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64 + N ** 6 / 256);

const ALPHA = [
	N / 2 -
		(2 * N ** 2) / 3 +
		(5 * N ** 3) / 16 +
		(41 * N ** 4) / 180 -
		(127 * N ** 5) / 288 +
		(7891 * N ** 6) / 37800,
	(13 * N ** 2) / 48 -
		(3 * N ** 3) / 5 +
		(557 * N ** 4) / 1440 +
		(281 * N ** 5) / 630 -
		(1983433 * N ** 6) / 1935360,
	(61 * N ** 3) / 240 -
		(103 * N ** 4) / 140 +
		(15061 * N ** 5) / 26880 +
		(167603 * N ** 6) / 181440,
	(49561 * N ** 4) / 161280 -
		(179 * N ** 5) / 168 +
		(6601661 * N ** 6) / 7257600,
	(34729 * N ** 5) / 80640 - (3418889 * N ** 6) / 1995840,
	(212378941 * N ** 6) / 319334400,
];

const BETA = [
	N / 2 -
		(2 * N ** 2) / 3 +
		(37 * N ** 3) / 96 -
		N ** 4 / 360 -
		(81 * N ** 5) / 512 +
		(96199 * N ** 6) / 604800,
	N ** 2 / 48 +
		N ** 3 / 15 -
		(437 * N ** 4) / 1440 +
		(46 * N ** 5) / 105 -
		(1118711 * N ** 6) / 3870720,
	(17 * N ** 3) / 480 -
		(37 * N ** 4) / 840 -
		(209 * N ** 5) / 4480 +
		(5569 * N ** 6) / 90720,
	(4397 * N ** 4) / 161280 - (11 * N ** 5) / 504 - (830251 * N ** 6) / 7257600,
	(4583 * N ** 5) / 161280 - (108847 * N ** 6) / 3991680,
	(20648693 * N ** 6) / 638668800,
];

/** Conformal latitude's tangent τ' from the geodetic one τ. */
function tauPrime(tau: number): number {
	const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.hypot(1, tau)));
	return tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
}

/** τ from τ' by Newton's method (Karney 2011, eqs. 19–21). */
function tauFromPrime(prime: number): number {
	let tau = prime;
	for (let k = 0; k < 8; k += 1) {
		const p = tauPrime(tau);
		const step =
			((prime - p) * (1 + (1 - E2) * tau * tau)) /
			((1 - E2) * Math.hypot(1, p) * Math.hypot(1, tau));
		tau += step;
		if (Math.abs(step) <= 1e-15 * Math.max(1, Math.abs(tau))) break;
	}
	return tau;
}

/**
 * Transverse Mercator about `meridian` (degrees) with scale `k0` on it:
 * x east of the meridian, y north of the equator, metres.
 */
export function transverseMercator(
	lat: number,
	lon: number,
	meridian: number,
	k0: number,
): { x: number; y: number } {
	let dl = (((lon - meridian + 540) % 360) - 180) * RAD;
	// At the poles every longitude is the same point.
	if (Math.abs(lat) === 90) dl = 0;
	const tau = Math.tan(lat * RAD);
	const tp = Math.abs(lat) === 90 ? Math.sign(lat) * Infinity : tauPrime(tau);
	const xiP = Math.atan2(tp, Math.cos(dl));
	const etaP = Math.asinh(Math.sin(dl) / Math.hypot(tp, Math.cos(dl)));
	let xi = xiP;
	let eta = etaP;
	ALPHA.forEach((alpha, k) => {
		const j = 2 * (k + 1);
		xi += alpha * Math.sin(j * xiP) * Math.cosh(j * etaP);
		eta += alpha * Math.cos(j * xiP) * Math.sinh(j * etaP);
	});
	return { x: k0 * A * eta, y: k0 * A * xi };
}

/** The inverse of {@link transverseMercator}. */
export function inverseTransverseMercator(
	x: number,
	y: number,
	meridian: number,
	k0: number,
): { lat: number; lon: number } {
	const xi = y / (k0 * A);
	const eta = x / (k0 * A);
	let xiP = xi;
	let etaP = eta;
	BETA.forEach((beta, k) => {
		const j = 2 * (k + 1);
		xiP -= beta * Math.sin(j * xi) * Math.cosh(j * eta);
		etaP -= beta * Math.cos(j * xi) * Math.sinh(j * eta);
	});
	const tp = Math.sin(xiP) / Math.hypot(Math.sinh(etaP), Math.cos(xiP));
	const dl = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
	const lat = Math.atan(tauFromPrime(tp)) / RAD;
	return { lat, lon: normalizeLon(meridian + dl / RAD) };
}

function normalizeLon(lon: number): number {
	const value = ((((lon + 180) % 360) + 360) % 360) - 180;
	return value === -180 && lon > 0 ? 180 : value;
}

/** A UTM zone: 1–60, and the hemisphere (false northing 10 000 km in the south). */
export interface UtmZone {
	zone: number;
	south: boolean;
}

/**
 * The UTM zone of a point, with the Norway and Svalbard exceptions.
 * UTM covers 80°S to 84°N; beyond that is UPS, which is not supported.
 */
export function utmZone(lat: number, lon: number): UtmZone {
	const l = normalizeLon(lon);
	let zone = Math.min(60, Math.floor((l + 180) / 6) + 1);
	if (lat >= 56 && lat < 64 && l >= 3 && l < 12) zone = 32;
	if (lat >= 72 && lat <= 84 && l >= 0 && l < 42) {
		zone = l < 9 ? 31 : l < 21 ? 33 : l < 33 ? 35 : 37;
	}
	return { zone, south: lat < 0 };
}

export function utmMeridian(zone: number): number {
	return -183 + 6 * zone;
}

/** EPSG code of a UTM zone on WGS84 (326zz north, 327zz south). */
export function utmEpsg({ zone, south }: UtmZone): number {
	return (south ? 32700 : 32600) + zone;
}

const UTM_K0 = 0.9996;
const FALSE_EASTING = 500_000;
const FALSE_NORTHING_SOUTH = 10_000_000;

/** UTM easting and northing (metres) in a given zone. */
export function toUtm(
	lat: number,
	lon: number,
	{ zone, south }: UtmZone,
): { easting: number; northing: number } {
	const { x, y } = transverseMercator(lat, lon, utmMeridian(zone), UTM_K0);
	return {
		easting: FALSE_EASTING + x,
		northing: (south ? FALSE_NORTHING_SOUTH : 0) + y,
	};
}

export function fromUtm(
	easting: number,
	northing: number,
	{ zone, south }: UtmZone,
): { lat: number; lon: number } {
	return inverseTransverseMercator(
		easting - FALSE_EASTING,
		northing - (south ? FALSE_NORTHING_SOUTH : 0),
		utmMeridian(zone),
		UTM_K0,
	);
}

/**
 * UTM's point scale (grid metres per ground metre) at a point: from the
 * projected length of a small step along the parallel over its length on
 * the ellipsoid.
 */
export function utmScale(lat: number, lon: number, zone: UtmZone): number {
	const step = 1e-6;
	const a = toUtm(lat, lon, zone);
	const b = toUtm(lat, lon + step, zone);
	const phi = lat * RAD;
	const radius = WGS84_A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
	const ground = radius * Math.cos(phi) * step * RAD;
	return Math.hypot(b.easting - a.easting, b.northing - a.northing) / ground;
}

/** Latitudes Web Mercator reaches (the square map's edge). */
export const WEB_MERCATOR_MAX_LAT = 85.0511287798066;

/** Web Mercator (EPSG:3857): the spherical formulas on the WGS84 semi-major axis. */
export function toWebMercator(
	lat: number,
	lon: number,
): { x: number; y: number } {
	return {
		x: WGS84_A * normalizeLon(lon) * RAD,
		y: WGS84_A * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)),
	};
}

export function fromWebMercator(
	x: number,
	y: number,
): { lat: number; lon: number } {
	return {
		lat: (2 * Math.atan(Math.exp(y / WGS84_A)) - Math.PI / 2) / RAD,
		lon: normalizeLon(x / WGS84_A / RAD),
	};
}
