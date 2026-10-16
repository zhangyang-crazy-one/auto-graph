// proj4 is the reference, only for these tests.
import proj4 from "proj4";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	type SceneSpec,
	type SolvedScene,
	solveScene,
} from "../src/index.js";
import {
	fromUtm,
	fromWebMercator,
	geodesicDirect,
	geodesicInverse,
	geoFrame,
	toUtm,
	toWebMercator,
	utmScale,
	utmZone,
} from "../src/scene/geo/index.js";
import { mulberry32 } from "./support/synthetic.js";

function utmDef(zone: number, south: boolean): string {
	return `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

describe("UTM and Web Mercator against proj4", () => {
	it("projects and inverts UTM to well under a millimetre", () => {
		const random = mulberry32(11);
		let forward = 0;
		let inverse = 0;
		for (let k = 0; k < 3000; k += 1) {
			const lat = -80 + random() * 164;
			const lon = -180 + random() * 360;
			const zone = utmZone(lat, lon);
			const ours = toUtm(lat, lon, zone);
			const [e, n] = proj4("EPSG:4326", utmDef(zone.zone, zone.south), [
				lon,
				lat,
			]) as [number, number];
			forward = Math.max(
				forward,
				Math.hypot(ours.easting - e, ours.northing - n),
			);
			const back = fromUtm(e, n, zone);
			const [blon, blat] = proj4(utmDef(zone.zone, zone.south), "EPSG:4326", [
				e,
				n,
			]) as [number, number];
			inverse = Math.max(
				inverse,
				Math.abs(back.lat - blat),
				Math.abs(((back.lon - blon + 540) % 360) - 180),
			);
		}
		expect(forward).toBeLessThan(1e-6);
		expect(inverse).toBeLessThan(1e-10);
	});

	it("matches EPSG:3857", () => {
		const random = mulberry32(12);
		for (let k = 0; k < 1000; k += 1) {
			const lat = -85 + random() * 170;
			const lon = -180 + random() * 360;
			const ours = toWebMercator(lat, lon);
			const [x, y] = proj4("EPSG:4326", "EPSG:3857", [lon, lat]) as [
				number,
				number,
			];
			expect(Math.hypot(ours.x - x, ours.y - y)).toBeLessThan(1e-6);
			const back = fromWebMercator(x, y);
			expect(back.lat).toBeCloseTo(lat, 10);
			expect(back.lon).toBeCloseTo(lon, 10);
		}
	});

	it("knows the zones, with Norway and Svalbard", () => {
		expect(utmZone(39.99, 116.39)).toEqual({ zone: 50, south: false });
		expect(utmZone(-33.86, 151.21)).toEqual({ zone: 56, south: true });
		expect(utmZone(60.39, 5.32).zone).toBe(32); // Bergen
		expect(utmZone(78.22, 15.65).zone).toBe(33); // Longyearbyen
		expect(utmZone(0, 180).zone).toBe(60);
		expect(utmZone(0, -180).zone).toBe(1);
		// Scale 0.9996 on the central meridian, about 1.001 3° off it.
		expect(utmScale(0, 117, { zone: 50, south: false })).toBeCloseTo(0.9996, 8);
		expect(utmScale(0, 120, { zone: 50, south: false })).toBeCloseTo(
			1.00098,
			5,
		);
	});
});

describe("projected scene frames", () => {
	const origins = [
		{ lat: 39.99, lon: 116.39, alt: 45 },
		{ lat: -33.86, lon: 151.21, alt: 5 },
		{ lat: 60.39, lon: 5.32, alt: 10 },
		{ lat: 78.22, lon: 15.65, alt: 0 },
		{ lat: 0.5, lon: -179.9, alt: 0 },
	];

	it("round-trips scene points within 100 km to a millimetre", () => {
		for (const origin of origins) {
			for (const [heading, anchor] of [
				[0, { x: 0, y: 0 }],
				[-35, { x: 5000, y: -2000 }],
			] as const) {
				for (const projection of [
					{ kind: "utm" as const, ...utmZone(origin.lat, origin.lon) },
					{ kind: "web-mercator" as const },
				]) {
					const frame = geoFrame({ origin, anchor, heading, projection });
					for (let i = -2; i <= 2; i += 1) {
						for (let j = -2; j <= 2; j += 1) {
							const x = anchor.x + i * 25_000;
							const y = anchor.y + j * 25_000;
							const back = frame.toScene(frame.toGeo(x, y, 3));
							expect(
								Math.hypot(back.x - x, back.y - y, back.z - 3),
								`${origin.lat},${origin.lon} ${projection.kind} h${heading} (${x}, ${y})`,
							).toBeLessThan(1e-3);
						}
					}
				}
			}
		}
	});

	it("points the scene's +y axis along true bearing `heading` at the origin", () => {
		for (const origin of origins.slice(0, 3)) {
			for (const heading of [0, 30, -120]) {
				const frame = geoFrame({
					origin,
					anchor: { x: 0, y: 0 },
					heading,
					projection: { kind: "utm", ...utmZone(origin.lat, origin.lon) },
				});
				// 100 m along the scene's +y lands 100 m along the true bearing.
				const at = frame.toScene(geodesicDirect(origin, heading, 100));
				expect(at.x).toBeCloseTo(0, 2);
				// Grid metres: within UTM's scale of 100.
				expect(Math.abs(at.y - 100)).toBeLessThan(0.1);
			}
		}
	});

	it("refuses what a projection cannot place", () => {
		const utm = geoFrame({
			origin: { lat: 40, lon: 117 },
			anchor: { x: 0, y: 0 },
			heading: 0,
			projection: { kind: "utm", zone: 50, south: false },
		});
		expect(utm.refuse({ lat: 40, lon: 125 })).toBeUndefined();
		expect(utm.refuse({ lat: 40, lon: 140 })?.message).toMatch(/23° from/);
		expect(utm.refuse({ lat: 85, lon: 117 })?.message).toMatch(/UTM/);
		const mercator = geoFrame({
			origin: { lat: 40, lon: 117 },
			anchor: { x: 0, y: 0 },
			heading: 0,
			projection: { kind: "web-mercator" },
		});
		expect(mercator.refuse({ lat: 86, lon: 0 })?.message).toMatch(
			/Web Mercator/,
		);
		expect(mercator.refuse({ lat: -85, lon: 0 })).toBeUndefined();
	});
});

describe("choosing the frame", () => {
	const solve = (value: Record<string, unknown>): SolvedScene => {
		const result = normalizeSceneDsl({ scene: "t", ...value });
		expect(result.diagnostics).toEqual([]);
		return solveScene(result.scene as SceneSpec);
	};
	const codes = (scene: SolvedScene) => scene.diagnostics.map((d) => d.code);

	it("keeps a site within 10 km on a local frame", () => {
		const scene = solve({
			bounds: { width: 2000, depth: 2000 },
			frame: { origin: { lat: 39.99, lon: 116.39 } },
			objects: { a: { size: [1, 1, 1], position: [100, 100] } },
		});
		expect(scene.geo?.projection).toEqual({ kind: "enu" });
		expect(codes(scene)).not.toContain("scene.geo.projection");
	});

	it("puts a larger site on the origin's UTM zone and says so", () => {
		const scene = solve({
			bounds: { width: 30_000, depth: 20_000 },
			frame: { origin: { lat: 39.99, lon: 116.39, alt: 45 } },
			landmarks: { tower: { lat: 40.1, lon: 116.5 } },
			objects: {
				a: { size: [10, 10, 10], geo: { lat: 40.05, lon: 116.45 } },
				b: { size: [10, 10, 10] },
			},
			relations: ["b at tower"],
		});
		expect(scene.geo?.projection).toEqual({
			kind: "utm",
			zone: 50,
			hemisphere: "N",
			epsg: 32650,
		});
		const note = scene.diagnostics.find(
			(d) => d.code === "scene.geo.projection",
		);
		expect(note?.severity).toBe("info");
		expect(note?.message).toContain("UTM zone 50N (EPSG:32650)");
		// Positions come back where they were given, to the output's rounding.
		const a = scene.objects.find((o) => o.id === "a");
		expect(a?.geo?.lat).toBeCloseTo(40.05, 8);
		expect(a?.geo?.lon).toBeCloseTo(116.45, 8);
		const b = scene.objects.find((o) => o.id === "b");
		expect(b?.geo?.lat).toBeCloseTo(40.1, 8);
		expect(b?.geo?.lon).toBeCloseTo(116.5, 8);
		// The scene's metres are UTM's: the origin's easting and northing
		// are the anchor's.
		const origin = toUtm(39.99, 116.39, { zone: 50, south: false });
		const at = toUtm(a?.geo?.lat ?? 0, a?.geo?.lon ?? 0, {
			zone: 50,
			south: false,
		});
		const grid = Math.hypot(
			at.easting - origin.easting,
			at.northing - origin.northing,
		);
		const [x = 0, y = 0] = a?.position ?? [];
		expect(Math.hypot(x, y)).toBeCloseTo(grid, 2);
	});

	it("switches when a distance from a landmark reaches past 10 km", () => {
		const scene = solve({
			bounds: { width: 100, depth: 100 },
			frame: { origin: { lat: 30, lon: 120 } },
			landmarks: { gate: { lat: 30, lon: 120 } },
			objects: { mast: { size: [1, 1, 1] } },
			relations: ["mast 25km bearing 45 from gate"],
		});
		expect(scene.geo?.projection.kind).toBe("utm");
		const mast = scene.objects[0] as SolvedScene["objects"][number];
		const back = geodesicInverse(
			{ lat: 30, lon: 120 },
			{ lat: mast.geo?.lat ?? 0, lon: mast.geo?.lon ?? 0 },
		);
		expect(back.distance).toBeCloseTo(25_000, 1);
		expect(back.bearing).toBeCloseTo(45, 4);
	});

	it("warns when a UTM site reaches into the next zone", () => {
		const scene = solve({
			bounds: { width: 40_000, depth: 10_000 },
			frame: { origin: { lat: 30, lon: 119.9 } },
			objects: { a: { size: [1, 1, 1], position: [100, 100] } },
		});
		const warning = scene.diagnostics.find(
			(d) => d.code === "scene.geo.zone-crossing",
		);
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toContain("UTM zone 51N");
		expect(warning?.message).toContain("laid out on zone 50N");
		expect(Number(warning?.detail?.scale)).toBeGreaterThan(1.0008);
		// Inside one zone: no warning.
		const inside = solve({
			bounds: { width: 40_000, depth: 10_000 },
			frame: { origin: { lat: 30, lon: 117 } },
			objects: { a: { size: [1, 1, 1], position: [100, 100] } },
		});
		expect(codes(inside)).not.toContain("scene.geo.zone-crossing");
	});

	it("takes a projection and zone when given", () => {
		const scene = solve({
			bounds: { width: 100, depth: 100 },
			frame: { origin: { lat: 30, lon: 119.9 }, zone: 51 },
			objects: { a: { size: [1, 1, 1], position: [10, 10] } },
		});
		expect(scene.geo?.projection).toMatchObject({ zone: 51, epsg: 32651 });
		expect(codes(scene)).not.toContain("scene.geo.projection");
		const mercator = solve({
			bounds: { width: 100, depth: 100 },
			frame: { origin: { lat: 30, lon: 120 }, projection: "web-mercator" },
			objects: { a: { size: [1, 1, 1], position: [50, 50] } },
		});
		expect(mercator.geo?.projection).toEqual({
			kind: "web-mercator",
			epsg: 3857,
		});
		// True metres at the origin's latitude: 50 m north is 50 m north.
		const a = mercator.objects[0] as SolvedScene["objects"][number];
		const back = geodesicInverse(
			{ lat: 30, lon: 120 },
			{ lat: a.geo?.lat ?? 0, lon: a.geo?.lon ?? 0 },
		);
		expect(back.distance).toBeCloseTo(Math.hypot(50, 50), 1);
	});

	it("says what is wrong with a frame", () => {
		const issues = (frame: Record<string, unknown>, extra = {}) =>
			normalizeSceneDsl({
				scene: "t",
				bounds: { width: 10, depth: 10 },
				objects: { a: { size: [1, 1, 1] } },
				frame,
				...extra,
			}).diagnostics.map((d) => d.code);
		expect(
			issues({ origin: { lat: 30, lon: 120 }, projection: "enu", zone: 50 }),
		).toEqual(["validate.scene.frame-zone"]);
		expect(
			issues(
				{ origin: { lat: 80, lon: 0 }, projection: "web-mercator" },
				{ landmarks: { pole: { lat: 89, lon: 0 } } },
			),
		).toEqual(["validate.scene.geo-extent"]);
		expect(
			issues(
				{ origin: { lat: 80, lon: 0 }, projection: "utm" },
				{ landmarks: { pole: { lat: 85, lon: 0 } } },
			),
		).toEqual(["validate.scene.geo-extent"]);
	});
});

describe("specs from before projections", () => {
	it("solves a frame without `projection` on a local frame", () => {
		const result = normalizeSceneDsl({
			scene: "t",
			bounds: { width: 10, depth: 10 },
			frame: { origin: { lat: 30, lon: 120 } },
			objects: { a: { size: [1, 1, 1], position: [5, 5] } },
		});
		const spec = result.scene as SceneSpec;
		const { projection: _, ...frame } = spec.frame as NonNullable<
			SceneSpec["frame"]
		>;
		const scene = solveScene({ ...spec, frame } as SceneSpec);
		expect(scene.geo?.projection).toEqual({ kind: "enu" });
		expect(scene.objects[0]?.geo?.lat).toBeCloseTo(30 + 5 / 110_000, 4);
	});
});
