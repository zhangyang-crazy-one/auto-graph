/**
 * Geodesics on the WGS84 ellipsoid by Vincenty's formulae: the distance
 * and initial bearing between two points (inverse problem) and the point
 * a distance along a bearing (direct problem). Accurate to well under a
 * millimetre; the inverse iteration can fail to converge only for nearly
 * antipodal points, far outside any site this is used for, and then
 * throws.
 */
import {
	type Geodetic,
	type GeodeticPoint,
	WGS84_A,
	WGS84_B,
	WGS84_F,
} from "./wgs84.js";

const RAD = Math.PI / 180;

export interface GeodesicInverse {
	/** Metres along the ellipsoid. */
	distance: number;
	/** Initial bearing, degrees clockwise from true north, in [0, 360). */
	bearing: number;
	/** Final bearing at the second point, degrees. */
	finalBearing: number;
}

export function geodesicInverse(from: Geodetic, to: Geodetic): GeodesicInverse {
	const f = WGS84_F;
	const L = (to.lon - from.lon) * RAD;
	const U1 = Math.atan((1 - f) * Math.tan(from.lat * RAD));
	const U2 = Math.atan((1 - f) * Math.tan(to.lat * RAD));
	const sinU1 = Math.sin(U1);
	const cosU1 = Math.cos(U1);
	const sinU2 = Math.sin(U2);
	const cosU2 = Math.cos(U2);
	let lambda = L;
	let sinSigma = 0;
	let cosSigma = 1;
	let sigma = 0;
	let cos2Alpha = 1;
	let cos2SigmaM = 0;
	let sinLambda = 0;
	let cosLambda = 1;
	let converged = false;
	for (let step = 0; step < 200; step += 1) {
		sinLambda = Math.sin(lambda);
		cosLambda = Math.cos(lambda);
		sinSigma = Math.hypot(
			cosU2 * sinLambda,
			cosU1 * sinU2 - sinU1 * cosU2 * cosLambda,
		);
		if (sinSigma === 0) {
			return { distance: 0, bearing: 0, finalBearing: 0 };
		}
		cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
		sigma = Math.atan2(sinSigma, cosSigma);
		const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
		cos2Alpha = 1 - sinAlpha * sinAlpha;
		cos2SigmaM =
			cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
		const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
		const next =
			L +
			(1 - C) *
				f *
				sinAlpha *
				(sigma +
					C *
						sinSigma *
						(cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
		if (Math.abs(next - lambda) < 1e-13) {
			lambda = next;
			converged = true;
			break;
		}
		lambda = next;
	}
	if (!converged)
		throw new Error("geodesic did not converge (near-antipodal points)");
	sinLambda = Math.sin(lambda);
	cosLambda = Math.cos(lambda);
	const u2 = (cos2Alpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
	const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
	const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
	const deltaSigma =
		B *
		sinSigma *
		(cos2SigmaM +
			(B / 4) *
				(cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
					(B / 6) *
						cos2SigmaM *
						(-3 + 4 * sinSigma * sinSigma) *
						(-3 + 4 * cos2SigmaM * cos2SigmaM)));
	const distance = WGS84_B * A * (sigma - deltaSigma);
	const alpha1 = Math.atan2(
		cosU2 * sinLambda,
		cosU1 * sinU2 - sinU1 * cosU2 * cosLambda,
	);
	const alpha2 = Math.atan2(
		cosU1 * sinLambda,
		-sinU1 * cosU2 + cosU1 * sinU2 * cosLambda,
	);
	return {
		distance,
		bearing: normalizeBearing(alpha1 / RAD),
		finalBearing: normalizeBearing(alpha2 / RAD),
	};
}

/** The point `distance` metres from `from` along initial `bearing` (degrees). */
export function geodesicDirect(
	from: Geodetic,
	bearing: number,
	distance: number,
): GeodeticPoint {
	const f = WGS84_F;
	const alpha1 = bearing * RAD;
	const sinAlpha1 = Math.sin(alpha1);
	const cosAlpha1 = Math.cos(alpha1);
	const tanU1 = (1 - f) * Math.tan(from.lat * RAD);
	const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
	const sinU1 = tanU1 * cosU1;
	const sigma1 = Math.atan2(tanU1, cosAlpha1);
	const sinAlpha = cosU1 * sinAlpha1;
	const cos2Alpha = 1 - sinAlpha * sinAlpha;
	const u2 = (cos2Alpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
	const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
	const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
	let sigma = distance / (WGS84_B * A);
	let sinSigma = 0;
	let cosSigma = 1;
	let cos2SigmaM = 0;
	for (let step = 0; step < 200; step += 1) {
		cos2SigmaM = Math.cos(2 * sigma1 + sigma);
		sinSigma = Math.sin(sigma);
		cosSigma = Math.cos(sigma);
		const deltaSigma =
			B *
			sinSigma *
			(cos2SigmaM +
				(B / 4) *
					(cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
						(B / 6) *
							cos2SigmaM *
							(-3 + 4 * sinSigma * sinSigma) *
							(-3 + 4 * cos2SigmaM * cos2SigmaM)));
		const next = distance / (WGS84_B * A) + deltaSigma;
		if (Math.abs(next - sigma) < 1e-14) {
			sigma = next;
			break;
		}
		sigma = next;
	}
	cos2SigmaM = Math.cos(2 * sigma1 + sigma);
	sinSigma = Math.sin(sigma);
	cosSigma = Math.cos(sigma);
	const x = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
	const lat = Math.atan2(
		sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
		(1 - f) * Math.hypot(sinAlpha, x),
	);
	const lambda = Math.atan2(
		sinSigma * sinAlpha1,
		cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1,
	);
	const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
	const L =
		lambda -
		(1 - C) *
			f *
			sinAlpha *
			(sigma +
				C *
					sinSigma *
					(cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
	return {
		lat: lat / RAD,
		lon: normalizeLongitude(from.lon + L / RAD),
		alt: from.alt ?? 0,
	};
}

function normalizeBearing(degrees: number): number {
	const value = ((degrees % 360) + 360) % 360;
	return value === 360 ? 0 : value;
}

function normalizeLongitude(degrees: number): number {
	return ((((degrees + 180) % 360) + 360) % 360) - 180;
}
