/**
 * The scene frame on the Earth: scene metres ↔ local east-north-up at the
 * frame origin ↔ WGS84. The scene point `anchor` is at the origin; the
 * scene's +y axis points along true bearing `heading`.
 */
import { geodesicDirect } from "./geodesic.js";
import {
	EnuFrame,
	type Geodetic,
	type GeodeticPoint,
	WGS84_A,
	WGS84_F,
} from "./wgs84.js";

export interface FrameSpec {
	origin: Geodetic;
	anchor: { x: number; y: number };
	/** Degrees clockwise from true north. */
	heading: number;
}

const RAD = Math.PI / 180;
const E2 = WGS84_F * (2 - WGS84_F);

export class SceneGeoFrame {
	private readonly enu: EnuFrame;
	private readonly cos: number;
	private readonly sin: number;

	constructor(private readonly spec: FrameSpec) {
		this.enu = new EnuFrame(spec.origin);
		this.cos = Math.cos(spec.heading * RAD);
		this.sin = Math.sin(spec.heading * RAD);
	}

	/**
	 * Scene metres to WGS84. The scene's floor is the level surface at the
	 * origin's height: x and y are the east and north (turned by
	 * `heading`) of the point at that height in the local frame, and z is
	 * height above it. So latitude and longitude round-trip exactly, and
	 * `alt` is the origin's height plus z.
	 */
	toGeo(x: number, y: number, z = 0): GeodeticPoint {
		const dx = x - this.spec.anchor.x;
		const dy = y - this.spec.anchor.y;
		const east = dx * this.cos + dy * this.sin;
		const north = -dx * this.sin + dy * this.cos;
		const height = this.enu.origin.alt;
		// Start on the tangent plane, then correct with the local radii of
		// curvature until the point at the origin's height lands on target.
		let at = this.enu.fromEnu({ east, north, up: 0 });
		for (let step = 0; step < 8; step += 1) {
			const got = this.enu.toEnu({ lat: at.lat, lon: at.lon, alt: height });
			const dn = north - got.north;
			const de = east - got.east;
			if (Math.abs(dn) < 1e-10 && Math.abs(de) < 1e-10) break;
			const sin = Math.sin(at.lat * RAD);
			const w = Math.sqrt(1 - E2 * sin * sin);
			const meridian = (WGS84_A * (1 - E2)) / (w * w * w);
			const normal = WGS84_A / w;
			at = {
				lat: at.lat + dn / meridian / RAD,
				lon: at.lon + de / (normal * Math.cos(at.lat * RAD)) / RAD,
				alt: height,
			};
		}
		return { lat: at.lat, lon: at.lon, alt: height + z };
	}

	/** WGS84 to scene metres (the inverse of `toGeo`). */
	toScene(point: Geodetic): { x: number; y: number; z: number } {
		const height = this.enu.origin.alt;
		const { east, north } = this.enu.toEnu({
			lat: point.lat,
			lon: point.lon,
			alt: height,
		});
		return {
			x: this.spec.anchor.x + east * this.cos - north * this.sin,
			y: this.spec.anchor.y + east * this.sin + north * this.cos,
			z: (point.alt ?? height) - height,
		};
	}

	/**
	 * The scene-frame offset of `distance` metres along true `bearing`, on
	 * the local plane (for distances between objects within a site).
	 */
	offset(bearing: number, distance: number): { x: number; y: number } {
		const angle = (bearing - this.spec.heading) * RAD;
		return { x: distance * Math.sin(angle), y: distance * Math.cos(angle) };
	}

	/**
	 * The scene point `distance` metres from `from` along true `bearing`,
	 * along the ellipsoid's geodesic (for distances from a landmark).
	 */
	along(
		from: Geodetic,
		bearing: number,
		distance: number,
	): { x: number; y: number } {
		const at = this.toScene(geodesicDirect(from, bearing, distance));
		return { x: at.x, y: at.y };
	}
}
