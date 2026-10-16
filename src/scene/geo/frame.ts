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
	toEcef,
} from "./wgs84.js";

export interface FrameSpec {
	origin: Geodetic;
	anchor: { x: number; y: number };
	/** Degrees clockwise from true north. */
	heading: number;
}

const RAD = Math.PI / 180;

/** How far from its origin one local frame is meant to reach, in metres. */
export const GEO_REACH = 10_000;

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
		// The points with these east and north form a line along the
		// origin's up axis; walk along it to where the height above the
		// ellipsoid is the origin's. The slope of height along that line is
		// close to 1 within a site (it is the cosine of the angle between
		// the two up directions), so a few secant steps settle it, at the
		// poles as anywhere.
		const heightAt = (up: number) =>
			this.enu.fromEnu({ east, north, up }).alt - height;
		let up0 = 0;
		let g0 = heightAt(up0);
		let up1 = -g0;
		let g1 = heightAt(up1);
		for (let step = 0; step < 30 && Math.abs(g1) > 1e-10; step += 1) {
			const slope = up1 === up0 ? 1 : (g1 - g0) / (up1 - up0);
			up0 = up1;
			g0 = g1;
			up1 -= g1 / (Math.abs(slope) > 1e-6 ? slope : 1);
			g1 = heightAt(up1);
		}
		if (!(Math.abs(g1) <= 1e-6)) {
			throw new Error(
				`no point ${Math.round(Math.hypot(east, north))} m from the frame origin lies at its height`,
			);
		}
		const at = this.enu.fromEnu({ east, north, up: up1 });
		return { lat: at.lat, lon: at.lon, alt: height + z };
	}

	/**
	 * The straight-line distance from the origin to the point's latitude
	 * and longitude at the origin's height. Within a site it is the ground
	 * distance; unlike the scene position it never folds a far point (the
	 * far side of the Earth, say) back near the origin.
	 */
	reach(point: Geodetic): number {
		const height = this.enu.origin.alt;
		const a = toEcef({ ...this.enu.origin, alt: height });
		const b = toEcef({ lat: point.lat, lon: point.lon, alt: height });
		return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
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
