/**
 * WGS84 geodetic coordinates, Earth-centred Earth-fixed (ECEF) coordinates
 * and a local east-north-up (ENU) frame at an origin.
 *
 * Latitude and longitude are degrees, heights metres above the ellipsoid.
 * Everything is double precision; geodetic → ENU → geodetic round trips
 * stay well under a millimetre within tens of kilometres of the origin.
 */

/** Semi-major axis, metres. */
export const WGS84_A = 6378137;
/** Flattening. */
export const WGS84_F = 1 / 298.257223563;
/** Semi-minor axis, metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
/** First eccentricity squared. */
const E2 = WGS84_F * (2 - WGS84_F);

export interface Geodetic {
	lat: number;
	lon: number;
	/** Height above the ellipsoid, metres (default 0). */
	alt?: number | undefined;
}

/** A geodetic point with its height. */
export interface GeodeticPoint {
	lat: number;
	lon: number;
	alt: number;
}

export interface Ecef {
	x: number;
	y: number;
	z: number;
}

export interface Enu {
	east: number;
	north: number;
	up: number;
}

const RAD = Math.PI / 180;

export function toEcef({ lat, lon, alt = 0 }: Geodetic): Ecef {
	const phi = lat * RAD;
	const lambda = lon * RAD;
	const sinPhi = Math.sin(phi);
	const cosPhi = Math.cos(phi);
	const n = WGS84_A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
	return {
		x: (n + alt) * cosPhi * Math.cos(lambda),
		y: (n + alt) * cosPhi * Math.sin(lambda),
		z: (n * (1 - E2) + alt) * sinPhi,
	};
}

/**
 * ECEF to geodetic. Bowring's starting latitude, then Newton steps on the
 * latitude until it no longer changes (a handful, to below 1e-12 rad).
 */
export function fromEcef({ x, y, z }: Ecef): GeodeticPoint {
	const lambda = Math.atan2(y, x);
	const p = Math.hypot(x, y);
	if (p < 1e-9) {
		// On the axis: a pole.
		const lat = z >= 0 ? 90 : -90;
		return { lat, lon: lambda / RAD, alt: Math.abs(z) - WGS84_B };
	}
	const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
	const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
	let phi = Math.atan2(
		z + ep2 * WGS84_B * Math.sin(theta) ** 3,
		p - E2 * WGS84_A * Math.cos(theta) ** 3,
	);
	let alt = 0;
	for (let step = 0; step < 10; step += 1) {
		const sinPhi = Math.sin(phi);
		const n = WGS84_A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
		alt = p / Math.cos(phi) - n;
		const next = Math.atan2(z, p * (1 - (E2 * n) / (n + alt)));
		if (Math.abs(next - phi) < 1e-14) {
			phi = next;
			break;
		}
		phi = next;
	}
	const sinPhi = Math.sin(phi);
	const n = WGS84_A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
	// Height from whichever form is better conditioned at this latitude.
	alt =
		Math.abs(phi) < Math.PI / 4
			? p / Math.cos(phi) - n
			: z / sinPhi - n * (1 - E2);
	return { lat: phi / RAD, lon: lambda / RAD, alt };
}

/** A local east-north-up frame tangent to the ellipsoid at `origin`. */
export class EnuFrame {
	readonly origin: GeodeticPoint;
	private readonly center: Ecef;
	private readonly sinPhi: number;
	private readonly cosPhi: number;
	private readonly sinLambda: number;
	private readonly cosLambda: number;

	constructor(origin: Geodetic) {
		this.origin = { lat: origin.lat, lon: origin.lon, alt: origin.alt ?? 0 };
		this.center = toEcef(this.origin);
		this.sinPhi = Math.sin(origin.lat * RAD);
		this.cosPhi = Math.cos(origin.lat * RAD);
		this.sinLambda = Math.sin(origin.lon * RAD);
		this.cosLambda = Math.cos(origin.lon * RAD);
	}

	toEnu(point: Geodetic): Enu {
		const e = toEcef(point);
		const dx = e.x - this.center.x;
		const dy = e.y - this.center.y;
		const dz = e.z - this.center.z;
		return {
			east: -this.sinLambda * dx + this.cosLambda * dy,
			north:
				-this.sinPhi * this.cosLambda * dx -
				this.sinPhi * this.sinLambda * dy +
				this.cosPhi * dz,
			up:
				this.cosPhi * this.cosLambda * dx +
				this.cosPhi * this.sinLambda * dy +
				this.sinPhi * dz,
		};
	}

	fromEnu({ east, north, up }: Enu): GeodeticPoint {
		const dx =
			-this.sinLambda * east -
			this.sinPhi * this.cosLambda * north +
			this.cosPhi * this.cosLambda * up;
		const dy =
			this.cosLambda * east -
			this.sinPhi * this.sinLambda * north +
			this.cosPhi * this.sinLambda * up;
		const dz = this.cosPhi * north + this.sinPhi * up;
		return fromEcef({
			x: this.center.x + dx,
			y: this.center.y + dy,
			z: this.center.z + dz,
		});
	}
}
