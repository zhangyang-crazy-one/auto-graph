/**
 * The scene frame on the Earth: scene metres ↔ local east-north-up at the
 * frame origin ↔ WGS84. The scene point `anchor` is at the origin; the
 * scene's +y axis points along true bearing `heading`.
 */
import { geodesicDirect } from "./geodesic.js";
import {
	fromUtm,
	fromWebMercator,
	toUtm,
	toWebMercator,
	utmMeridian,
	WEB_MERCATOR_MAX_LAT,
} from "./projection.js";
import {
	EnuFrame,
	type Geodetic,
	type GeodeticPoint,
	toEcef,
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

/** How far from its origin one local frame is meant to reach, in metres. */
export const GEO_REACH = 10_000;

export class SceneGeoFrame implements GeoFrame {
	readonly projection: FrameProjection = { kind: "enu" };
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

	refuse(point: Geodetic): Refusal | undefined {
		const reach = this.reach(point);
		if (reach <= GEO_REACH) return undefined;
		return {
			message: `This point is ${Math.round(reach / 100) / 10} km from the frame origin; one local east-north-up frame places points within ${GEO_REACH / 1000} km.`,
			hint: "Check the coordinates (and the datum); for a large site set `frame.projection: utm` (or leave it `auto`).",
			detail: { reach: Math.round(reach) },
		};
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

/** How scene metres map to the Earth. */
export type FrameProjection =
	| { kind: "enu" }
	| { kind: "utm"; zone: number; south: boolean }
	| { kind: "web-mercator" };

/** Why a point cannot be placed in a frame, for a diagnostic. */
export interface Refusal {
	message: string;
	hint: string;
	detail: Record<string, number>;
}

/** What the scene needs from a frame on the Earth, whatever its projection. */
export interface GeoFrame {
	readonly projection: FrameProjection;
	toGeo(x: number, y: number, z?: number): GeodeticPoint;
	toScene(point: Geodetic): { x: number; y: number; z: number };
	offset(bearing: number, distance: number): { x: number; y: number };
	along(
		from: Geodetic,
		bearing: number,
		distance: number,
	): { x: number; y: number };
	/** Undefined when the point has a faithful place in the frame. */
	refuse(point: Geodetic): Refusal | undefined;
}

/** Farthest a UTM frame places a point from its zone's central meridian (degrees). */
export const UTM_REACH = 15;

/**
 * A scene frame on a map projection (UTM or Web Mercator): scene x, y
 * are the projected grid's metres from the origin, turned so the scene's
 * +y axis points along true bearing `heading` at the origin (grid north
 * differs from true north by the convergence there); z is height above
 * the origin's. Scene metres are grid metres: UTM's scale is 0.9996 on
 * the central meridian and grows away from it; Web Mercator is scaled to
 * true metres at the origin (east-west and north-south separately: on the
 * ellipsoid it is not conformal), and its longitudes are taken around the
 * origin's, so a site across the 180° meridian stays in one piece.
 */
export class ProjectedFrame implements GeoFrame {
	private readonly origin: { x: number; y: number };
	private readonly scale: { x: number; y: number };
	private readonly cos: number;
	private readonly sin: number;

	constructor(
		private readonly spec: FrameSpec,
		readonly projection: Exclude<FrameProjection, { kind: "enu" }>,
	) {
		const phi = spec.origin.lat * RAD;
		const w = 1 - E2 * Math.sin(phi) ** 2;
		// Web Mercator stretches east-west by a / (ν cos φ) and north-south
		// by a / (ρ cos φ) on the ellipsoid; undo both at the origin.
		this.scale =
			projection.kind === "web-mercator"
				? {
						x: Math.cos(phi) / Math.sqrt(w),
						y: (Math.cos(phi) * (1 - E2)) / w ** 1.5,
					}
				: { x: 1, y: 1 };
		this.origin = this.project(spec.origin.lat, spec.origin.lon);
		// Grid bearing of true north at the origin (the convergence), so the
		// scene's +y axis is at grid bearing heading + that.
		const step = spec.origin.lat > 0 ? -1e-5 : 1e-5;
		const ahead = this.project(spec.origin.lat + step, spec.origin.lon);
		const north = Math.atan2(
			(ahead.x - this.origin.x) * Math.sign(step),
			(ahead.y - this.origin.y) * Math.sign(step),
		);
		const theta = spec.heading * RAD + north;
		this.cos = Math.cos(theta);
		this.sin = Math.sin(theta);
	}

	/** The grid's coordinates of a point (metres, scaled for Web Mercator). */
	private project(lat: number, lon: number): { x: number; y: number } {
		if (this.projection.kind === "web-mercator") {
			const around =
				this.spec.origin.lon +
				((((lon - this.spec.origin.lon + 540) % 360) + 360) % 360) -
				180;
			const { y } = toWebMercator(lat, 0);
			return {
				x: WGS84_A * around * RAD * this.scale.x,
				y: y * this.scale.y,
			};
		}
		const { easting, northing } = toUtm(lat, lon, this.projection);
		return { x: easting, y: northing };
	}

	private unproject(x: number, y: number): { lat: number; lon: number } {
		if (this.projection.kind === "web-mercator") {
			return fromWebMercator(x / this.scale.x, y / this.scale.y);
		}
		return fromUtm(x, y, this.projection);
	}

	toGeo(x: number, y: number, z = 0): GeodeticPoint {
		const dx = x - this.spec.anchor.x;
		const dy = y - this.spec.anchor.y;
		const east = dx * this.cos + dy * this.sin;
		const north = -dx * this.sin + dy * this.cos;
		const at = this.unproject(this.origin.x + east, this.origin.y + north);
		const height = this.spec.origin.alt ?? 0;
		return { lat: at.lat, lon: at.lon, alt: height + z };
	}

	toScene(point: Geodetic): { x: number; y: number; z: number } {
		const at = this.project(point.lat, point.lon);
		const east = at.x - this.origin.x;
		const north = at.y - this.origin.y;
		const height = this.spec.origin.alt ?? 0;
		return {
			x: this.spec.anchor.x + east * this.cos - north * this.sin,
			y: this.spec.anchor.y + east * this.sin + north * this.cos,
			z: (point.alt ?? height) - height,
		};
	}

	offset(bearing: number, distance: number): { x: number; y: number } {
		const angle = (bearing - this.spec.heading) * RAD;
		return { x: distance * Math.sin(angle), y: distance * Math.cos(angle) };
	}

	along(
		from: Geodetic,
		bearing: number,
		distance: number,
	): { x: number; y: number } {
		const at = this.toScene(geodesicDirect(from, bearing, distance));
		return { x: at.x, y: at.y };
	}

	refuse(point: Geodetic): Refusal | undefined {
		return projectionRefusal(this.projection, point);
	}
}

/**
 * Why a map projection cannot place a point (undefined when it can): UTM
 * covers 80°S–84°N within 15° of the zone's central meridian, Web
 * Mercator ±85.05°. A pure check, so a frame's origin can be tested
 * before the frame is built.
 */
export function projectionRefusal(
	projection: Exclude<FrameProjection, { kind: "enu" }>,
	point: Geodetic,
): Refusal | undefined {
	if (projection.kind === "web-mercator") {
		if (Math.abs(point.lat) <= WEB_MERCATOR_MAX_LAT) return undefined;
		return {
			message: `Latitude ${point.lat}° is past Web Mercator's edge (±${WEB_MERCATOR_MAX_LAT.toFixed(4)}°).`,
			hint: "Use `projection: utm` or `enu` for places this far north or south.",
			detail: { lat: point.lat },
		};
	}
	if (point.lat < -80 || point.lat > 84) {
		return {
			message: `Latitude ${point.lat}° is outside UTM (80°S to 84°N); the polar UPS grid is not supported.`,
			hint: "Use `projection: enu` for a site near the poles.",
			detail: { lat: point.lat },
		};
	}
	const meridian = utmMeridian(projection.zone);
	const away = Math.abs(((point.lon - meridian + 540) % 360) - 180);
	if (away <= UTM_REACH) return undefined;
	return {
		message: `This point is ${Math.round(away * 10) / 10}° from UTM zone ${projection.zone}'s central meridian; one projected frame places points within ${UTM_REACH}°.`,
		hint: "Check the coordinates, or give a far site a scene with its own origin.",
		detail: { degrees: Math.round(away * 1e4) / 1e4 },
	};
}

/** The frame for a spec: local east-north-up unless a projection is named. */
export function geoFrame(
	spec: FrameSpec & { projection?: FrameProjection },
): GeoFrame {
	const projection = spec.projection ?? { kind: "enu" };
	return projection.kind === "enu"
		? new SceneGeoFrame(spec)
		: new ProjectedFrame(spec, projection);
}
