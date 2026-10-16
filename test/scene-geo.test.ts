import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	type SceneSpec,
	type SolvedScene,
	solveScene,
} from "../src/index.js";
import {
	bd09ToWgs84,
	EnuFrame,
	fromEcef,
	gcj02ToBd09,
	gcj02ToWgs84,
	geodesicDirect,
	geodesicInverse,
	SceneGeoFrame,
	toEcef,
	wgs84ToBd09,
	wgs84ToGcj02,
} from "../src/scene/geo/index.js";

// Reference implementations, only for these tests.
const require = createRequire(import.meta.url);
const { Geodesic } = require("geographiclib-geodesic") as {
	Geodesic: {
		WGS84: {
			Inverse: (
				lat1: number,
				lon1: number,
				lat2: number,
				lon2: number,
			) => { s12: number; azi1: number; azi2: number };
			Direct: (
				lat1: number,
				lon1: number,
				azi1: number,
				s12: number,
			) => { lat2: number; lon2: number };
		};
	};
};
const coordtransform = require("coordtransform") as {
	wgs84togcj02: (lon: number, lat: number) => [number, number];
	gcj02tobd09: (lon: number, lat: number) => [number, number];
};

function random(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

const SITES = [
	{ lat: 39.9087, lon: 116.3975, alt: 44 }, // Beijing
	{ lat: -33.8568, lon: 151.2153, alt: 5 }, // Sydney
	{ lat: 64.1466, lon: -21.9426, alt: 30 }, // Reykjavík
	{ lat: 0.0001, lon: 179.9999, alt: 0 }, // equator, antimeridian
	{ lat: 89.5, lon: 10, alt: 2800 }, // near the pole
];

describe("WGS84 and local east-north-up", () => {
	it("matches known ECEF coordinates", () => {
		// The equator at the prime meridian, and the north pole.
		expect(toEcef({ lat: 0, lon: 0 })).toEqual({ x: 6378137, y: 0, z: 0 });
		const pole = toEcef({ lat: 90, lon: 0 });
		expect(pole.z).toBeCloseTo(6356752.314245, 5);
		expect(Math.abs(pole.x)).toBeLessThan(1e-6);
	});

	it.each(
		SITES,
	)("round-trips through ECEF and ENU under 1 mm within 10 km (%o)", (site) => {
		const frame = new EnuFrame(site);
		const next = random(Math.round(site.lat * 1000 + 7));
		for (let k = 0; k < 200; k += 1) {
			const east = (next() - 0.5) * 20_000;
			const north = (next() - 0.5) * 20_000;
			const up = (next() - 0.5) * 400;
			const back = frame.toEnu(frame.fromEnu({ east, north, up }));
			expect(
				Math.hypot(back.east - east, back.north - north, back.up - up),
			).toBeLessThan(1e-3);
			const geodetic = frame.fromEnu({ east, north, up });
			const again = fromEcef(toEcef(geodetic));
			expect(Math.abs(again.lat - geodetic.lat)).toBeLessThan(1e-11);
			expect(Math.abs(again.alt - geodetic.alt)).toBeLessThan(1e-4);
		}
	});

	it("puts north up the meridian and east along the parallel", () => {
		const frame = new EnuFrame(SITES[0] as (typeof SITES)[number]);
		const north = frame.toEnu({ lat: 39.9087 + 0.001, lon: 116.3975, alt: 44 });
		expect(north.north).toBeGreaterThan(110);
		expect(Math.abs(north.east)).toBeLessThan(1e-6);
		const east = frame.toEnu({ lat: 39.9087, lon: 116.3975 + 0.001, alt: 44 });
		expect(east.east).toBeGreaterThan(85);
		expect(Math.abs(east.north)).toBeLessThan(0.01);
	});
});

describe("geodesics against GeographicLib", () => {
	it.each(SITES)("inverse and direct agree to 1e-6 (%o)", (site) => {
		const next = random(Math.round(site.lon * 1000 + 11));
		for (let k = 0; k < 200; k += 1) {
			const distance = next() * 10_000;
			const bearing = next() * 360;
			const ref = Geodesic.WGS84.Direct(site.lat, site.lon, bearing, distance);
			const ours = geodesicDirect(site, bearing, distance);
			expect(Math.abs(ours.lat - ref.lat2)).toBeLessThan(1e-9);
			expect(Math.abs(((ours.lon - ref.lon2 + 540) % 360) - 180)).toBeLessThan(
				1e-9,
			);
			const inv = geodesicInverse(site, { lat: ref.lat2, lon: ref.lon2 });
			const refInv = Geodesic.WGS84.Inverse(
				site.lat,
				site.lon,
				ref.lat2,
				ref.lon2,
			);
			expect(Math.abs(inv.distance - refInv.s12)).toBeLessThan(1e-6);
			if (distance > 1) {
				const azi = (refInv.azi1 + 360) % 360;
				expect(Math.abs(((inv.bearing - azi + 540) % 360) - 180)).toBeLessThan(
					1e-6,
				);
			}
		}
	});

	it("stays within Vincenty's half millimetre on long lines (Beijing to Sydney)", () => {
		const a = SITES[0] as (typeof SITES)[number];
		const b = SITES[1] as (typeof SITES)[number];
		const ours = geodesicInverse(a, b);
		const ref = Geodesic.WGS84.Inverse(a.lat, a.lon, b.lat, b.lon);
		expect(Math.abs(ours.distance - ref.s12)).toBeLessThan(5e-4);
		expect(ours.bearing).toBeCloseTo(ref.azi1, 6);
	});
});

describe("GCJ-02 and BD-09 against coordtransform", () => {
	it("matches the published forward formulas", () => {
		const next = random(5);
		for (let k = 0; k < 500; k += 1) {
			const lat = 18 + next() * 35;
			const lon = 75 + next() * 58;
			const [gLon, gLat] = coordtransform.wgs84togcj02(lon, lat);
			const gcj = wgs84ToGcj02({ lat, lon });
			expect(Math.abs(gcj.lat - gLat)).toBeLessThan(1e-12);
			expect(Math.abs(gcj.lon - gLon)).toBeLessThan(1e-12);
			const [bLon, bLat] = coordtransform.gcj02tobd09(gLon, gLat);
			const bd = gcj02ToBd09(gcj);
			expect(Math.abs(bd.lat - bLat)).toBeLessThan(1e-12);
			expect(Math.abs(bd.lon - bLon)).toBeLessThan(1e-12);
		}
	});

	it("inverts them to well under a millimetre", () => {
		const next = random(9);
		for (let k = 0; k < 500; k += 1) {
			const point = { lat: 18 + next() * 35, lon: 75 + next() * 58 };
			const viaGcj = gcj02ToWgs84(wgs84ToGcj02(point));
			const viaBd = bd09ToWgs84(wgs84ToBd09(point));
			for (const back of [viaGcj, viaBd]) {
				// 1e-9 degrees is about 0.1 mm.
				expect(Math.abs(back.lat - point.lat)).toBeLessThan(1e-9);
				expect(Math.abs(back.lon - point.lon)).toBeLessThan(1e-9);
			}
		}
	});

	it("leaves points outside China alone", () => {
		expect(wgs84ToGcj02({ lat: 48.8584, lon: 2.2945 })).toEqual({
			lat: 48.8584,
			lon: 2.2945,
		});
	});
});

// The scene frame's inverse must hold at the poles as anywhere (#145).
describe("scene frame round trips", () => {
	const origins = [
		{ lat: 89.999, lon: 0, alt: 0 },
		{ lat: 90, lon: 0, alt: 0 },
		{ lat: -90, lon: 30, alt: 120 },
		{ lat: -89.9995, lon: -170, alt: 2800 },
		{ lat: 89.5, lon: 10, alt: 0 },
		{ lat: 39.99, lon: 116.39, alt: 45 },
		{ lat: 0, lon: 179.999, alt: 0 },
	];
	it("returns every point within 10 km to its scene position, to a millimetre", () => {
		for (const origin of origins) {
			for (const [heading, anchor] of [
				[0, { x: 0, y: 0 }],
				[37, { x: 120, y: -45 }],
				[-150, { x: -3000, y: 2500 }],
			] as const) {
				const frame = new SceneGeoFrame({ origin, anchor, heading });
				for (let i = -2; i <= 2; i += 1) {
					for (let j = -2; j <= 2; j += 1) {
						const x = anchor.x + i * 3500;
						const y = anchor.y + j * 3500;
						if (Math.hypot(x - anchor.x, y - anchor.y) > 10_000) continue;
						const geo = frame.toGeo(x, y, 2);
						const back = frame.toScene(geo);
						const miss = Math.hypot(back.x - x, back.y - y, back.z - 2);
						expect(
							miss,
							`${origin.lat},${origin.lon} h${heading} (${x}, ${y})`,
						).toBeLessThan(1e-3);
					}
				}
			}
		}
	});

	it("handles the reported polar cases", () => {
		for (const [lat, x, y] of [
			[89.999, 5000, 5000],
			[89.999, 1000, 1000],
			[90, 1000, 1000],
			[90, 5000, 5000],
		] as const) {
			const frame = new SceneGeoFrame({
				origin: { lat, lon: 0, alt: 0 },
				anchor: { x: 0, y: 0 },
				heading: 0,
			});
			const back = frame.toScene(frame.toGeo(x, y));
			expect(Math.hypot(back.x - x, back.y - y)).toBeLessThan(1e-3);
		}
	});
});

describe("scenes placed on the Earth", () => {
	const park = (extra: Record<string, unknown> = {}) => {
		const result = normalizeSceneDsl({
			scene: "park",
			bounds: { width: 120, depth: 90, height: 20 },
			frame: { origin: { lat: 39.99, lon: 116.39, alt: 45 } },
			landmarks: {
				gate: { lat: 39.99009, lon: 116.39035 },
				fountain: { lat: 39.99045, lon: 116.3907 },
			},
			objects: {
				pavilion: { size: [12, 10, 6], geo: { lat: 39.9907, lon: 116.3911 } },
				kiosk: { size: [4, 3, 3] },
				info: { size: [1.5, 0.4, 2] },
				bench: { size: [2, 0.6, 0.8], count: 6 },
				lamp: { size: [0.4, 0.4, 4] },
			},
			relations: [
				"kiosk 25m bearing 60 from gate",
				"info at gate, facing fountain",
				"bench around fountain, radius 12",
				"lamp 8m north-of pavilion",
			],
			...extra,
		});
		expect(result.diagnostics).toEqual([]);
		return solveScene(result.scene as SceneSpec);
	};
	const object = (scene: SolvedScene, id: string) =>
		scene.objects.find(
			(item) => item.id === id,
		) as SolvedScene["objects"][number];

	it("pins an object by latitude and longitude, and reports it back", () => {
		const scene = park();
		expect(scene.valid).toBe(true);
		const pavilion = object(scene, "pavilion");
		// 0.1 mm of position rounding is 1e-9 degrees.
		expect(Math.abs((pavilion.geo?.lat ?? 0) - 39.9907)).toBeLessThan(2e-9);
		expect(Math.abs((pavilion.geo?.lon ?? 0) - 116.3911)).toBeLessThan(2e-9);
		expect(pavilion.geo?.alt).toBe(45);
		// The scene frame is east-north at the origin: about 94 m east and
		// 78 m north.
		expect(pavilion.position[0]).toBeCloseTo(93.95, 1);
		expect(pavilion.position[1]).toBeCloseTo(77.73, 1);
	});

	it("places a distance and bearing from a landmark along the geodesic", () => {
		const scene = park();
		const ref = Geodesic.WGS84.Direct(39.99009, 116.39035, 60, 25);
		const kiosk = object(scene, "kiosk");
		expect(Math.abs((kiosk.geo?.lat ?? 0) - ref.lat2)).toBeLessThan(2e-9);
		expect(Math.abs((kiosk.geo?.lon ?? 0) - ref.lon2)).toBeLessThan(2e-9);
		const inverse = Geodesic.WGS84.Inverse(
			39.99009,
			116.39035,
			kiosk.geo?.lat ?? 0,
			kiosk.geo?.lon ?? 0,
		);
		expect(inverse.s12).toBeCloseTo(25, 3);
		expect(inverse.azi1).toBeCloseTo(60, 3);
	});

	it("puts things at, around and facing landmarks", () => {
		const scene = park();
		const gate = scene.landmarks?.find((item) => item.id === "gate");
		const info = object(scene, "info");
		expect(info.position.slice(0, 2)).toEqual(gate?.position);
		const fountain = scene.landmarks?.find((item) => item.id === "fountain");
		const [fx = 0, fy = 0] = fountain?.position ?? [];
		for (let k = 1; k <= 6; k += 1) {
			const bench = object(scene, `bench${k}`);
			expect(
				Math.hypot(bench.position[0] - fx, bench.position[1] - fy),
			).toBeCloseTo(12, 3);
		}
		// The info board's front (-y) turns toward the fountain.
		const toward =
			(Math.atan2(fy - info.position[1], fx - info.position[0]) * 180) /
			Math.PI;
		// To the rounding of the output positions.
		expect(Math.abs(((info.yaw - 90 - toward + 540) % 360) - 180)).toBeLessThan(
			1e-3,
		);
	});

	it("turns object-to-object bearings into the scene frame by its heading", () => {
		for (const heading of [0, 30, -90]) {
			const scene = park({
				frame: {
					origin: { lat: 39.99, lon: 116.39, alt: 45 },
					anchor: [60, 45],
					heading,
				},
			});
			const pavilion = object(scene, "pavilion");
			const lamp = object(scene, "lamp");
			const dx = lamp.position[0] - pavilion.position[0];
			const dy = lamp.position[1] - pavilion.position[1];
			// True north is `heading` degrees counter-clockwise of the scene's +y.
			const angle = (-heading * Math.PI) / 180;
			expect(dx).toBeCloseTo(8 * Math.sin(angle), 3);
			expect(dy).toBeCloseTo(8 * Math.cos(angle), 3);
			// And on the Earth, the lamp is 8 m true north of the pavilion.
			const inverse = Geodesic.WGS84.Inverse(
				pavilion.geo?.lat ?? 0,
				pavilion.geo?.lon ?? 0,
				lamp.geo?.lat ?? 0,
				lamp.geo?.lon ?? 0,
			);
			expect(inverse.s12).toBeCloseTo(8, 3);
			// Between objects the bearing is taken on the site's plane, whose
			// north is true north at the origin; meridians converge by about a
			// thousandth of a degree 100 m east of it.
			expect(Math.abs(((inverse.azi1 + 540) % 360) - 180)).toBeLessThan(0.01);
		}
	});

	it("reads GCJ-02 and BD-09 coordinates and stores WGS84", () => {
		const wgs = { lat: 39.9907, lon: 116.3911 };
		for (const [datum, convert] of [
			["GCJ02", wgs84ToGcj02],
			["BD09", wgs84ToBd09],
		] as const) {
			const origin = convert({ lat: 39.99, lon: 116.39 });
			const at = convert(wgs);
			const result = normalizeSceneDsl({
				scene: "t",
				bounds: { width: 120, depth: 90 },
				frame: { origin: { ...origin, alt: 45 }, datum },
				objects: { pavilion: { size: [12, 10, 6], geo: at } },
			});
			const scene = solveScene(result.scene as SceneSpec);
			expect(scene.geo?.datum).toBe(datum);
			expect(Math.abs((scene.geo?.origin.lat ?? 0) - 39.99)).toBeLessThan(1e-9);
			const pavilion = object(scene, "pavilion");
			expect(Math.abs((pavilion.geo?.lat ?? 0) - wgs.lat)).toBeLessThan(2e-9);
			expect(Math.abs((pavilion.geo?.lon ?? 0) - wgs.lon)).toBeLessThan(2e-9);
		}
	});

	it("says what is wrong with a frame, a landmark or a bearing", () => {
		const base = {
			scene: "t",
			bounds: { width: 10, depth: 10 },
			objects: { a: { size: [1, 1, 1] }, b: { size: [1, 1, 1] } },
		};
		const codes = (value: Record<string, unknown>) =>
			normalizeSceneDsl({ ...base, ...value }).diagnostics.map((d) => d.code);
		expect(
			codes({ objects: { a: { size: [1, 1, 1], geo: { lat: 1, lon: 1 } } } }),
		).toContain("validate.scene.geo-without-frame");
		const framed = { frame: { origin: { lat: 30, lon: 120 } } };
		expect(codes({ ...framed, relations: ["a at nowhere"] })).toContain(
			"validate.scene.unknown-landmark",
		);
		expect(
			codes({ ...framed, landmarks: { a: { lat: 30, lon: 120 } } }),
		).toContain("validate.scene.duplicate-id");
		expect(
			codes({ ...framed, relations: ["a 5m bearing north from b"] }),
		).toContain("validate.scene.relation-value");
		expect(codes({ ...framed, relations: ["a 5m up-of b"] })).toContain(
			"validate.scene.relation-value",
		);
		// Without a frame, bearings are from the scene's north.
		const plain = solveScene(
			normalizeSceneDsl({ ...base, relations: ["b 3m bearing 90 from a"] })
				.scene as SceneSpec,
		);
		const [a, b] = plain.objects;
		expect((b?.position[0] ?? 0) - (a?.position[0] ?? 0)).toBeCloseTo(3, 6);
		expect(plain.geo).toBeUndefined();
	});

	// A far point would fold onto the origin if it were projected (#146).
	it("refuses points too far from the origin before projecting them", () => {
		const base = {
			scene: "t",
			bounds: { width: 100, depth: 100 },
			objects: { a: { size: [1, 1, 1] }, b: { size: [1, 1, 1] } },
		};
		const far = (
			origin: { lat: number; lon: number },
			value: Record<string, unknown>,
			projection = "enu",
		) =>
			normalizeSceneDsl({ ...base, frame: { origin, projection }, ...value })
				.diagnostics.filter((d) => d.code === "validate.scene.geo-extent")
				.map((d) => d.path?.join("."));
		const zero = { lat: 0, lon: 0 };
		// The antipode and other far-side points, on objects and landmarks.
		for (const point of [
			{ lat: 0, lon: 180 },
			{ lat: 0, lon: -180 },
			{ lat: 0, lon: 90 },
			{ lat: 60, lon: -120 },
			{ lat: -0.0001, lon: 179.9 },
		]) {
			expect(
				far(zero, {
					objects: { ...base.objects, a: { size: [1, 1, 1], geo: point } },
				}),
			).toEqual(["objects.a.geo"]);
			expect(far(zero, { landmarks: { gate: point } })).toEqual([
				"landmarks.gate",
			]);
			// Too far for UTM too, so also refused when the frame is chosen
			// automatically.
			expect(far(zero, { landmarks: { gate: point } }, "auto")).toEqual([
				"landmarks.gate",
			]);
		}
		// Just inside and just outside 10 km, due east on the equator.
		const east = (metres: number) =>
			geodesicDirect({ lat: 0, lon: 0 }, 90, metres);
		expect(far(zero, { landmarks: { gate: east(9_990) } })).toEqual([]);
		expect(far(zero, { landmarks: { gate: east(10_010) } })).toEqual([
			"landmarks.gate",
		]);
		// Left to choose, the frame goes to UTM instead.
		expect(far(zero, { landmarks: { gate: east(10_010) } }, "auto")).toEqual(
			[],
		);
		// A distance from a landmark that lands too far.
		expect(
			far(zero, {
				landmarks: { gate: { lat: 0, lon: 0.0001 } },
				relations: ["a 20km bearing 90 from gate"],
			}),
		).toEqual(["relations.0"]);
		expect(
			far(
				zero,
				{
					landmarks: { gate: { lat: 0, lon: 0.0001 } },
					relations: ["a 20km bearing 90 from gate"],
				},
				"auto",
			),
		).toEqual([]);
		// A short hop across the antimeridian is fine and lands where it should.
		const result = normalizeSceneDsl({
			...base,
			frame: { origin: { lat: 0, lon: 179.9995 } },
			landmarks: { gate: { lat: 0, lon: -179.9995 } },
			objects: {
				...base.objects,
				a: { size: [1, 1, 1], geo: { lat: 0.0002, lon: -179.9998 } },
			},
			relations: ["b at gate"],
		});
		expect(result.diagnostics).toEqual([]);
		const scene = solveScene(result.scene as SceneSpec);
		const b = scene.objects.find((item) => item.id === "b");
		expect(b?.position[0]).toBeCloseTo(111.3, 0);
		expect(scene.diagnostics.map((d) => d.code)).not.toContain(
			"scene.geo.extent",
		);
	});

	it("warns when a local frame reaches past 10 km", () => {
		const result = normalizeSceneDsl({
			scene: "t",
			bounds: { width: 12_000, depth: 100 },
			frame: { origin: { lat: 30, lon: 120 }, projection: "enu" },
			objects: { a: { size: [1, 1, 1] } },
		});
		const scene = solveScene(result.scene as SceneSpec);
		expect(scene.diagnostics.map((d) => d.code)).toContain("scene.geo.extent");
	});
});
