import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	parseSceneDsl,
	type SceneSpec,
	type SolvedScene,
	sceneDocumentSchema,
	sceneToJson,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";
import { geodesicInverse } from "../src/scene/geo/index.js";
import {
	geodesicPolyline,
	layWaypoints,
	pointAlong,
	polylineLength,
	segmentHitsBox,
} from "../src/scene/lines.js";
import {
	GridTerrain,
	sampleTerrain,
	type TerrainGrid,
} from "../src/scene/terrain/index.js";
import { sceneSource } from "./support/scene-files.js";

// GeographicLib, the reference for geodesics, only for these tests.
const require = createRequire(import.meta.url);
const { Geodesic } = require("geographiclib-geodesic") as {
	Geodesic: {
		WGS84: {
			Inverse: (
				lat1: number,
				lon1: number,
				lat2: number,
				lon2: number,
			) => { s12: number; azi1: number };
		};
	};
};

function solve(value: Record<string, unknown>): SolvedScene {
	const result = normalizeSceneDsl({ scene: "t", ...value });
	expect(result.diagnostics).toEqual([]);
	return solveScene(result.scene as SceneSpec);
}

const object = (scene: SolvedScene, id: string) =>
	scene.objects.find(
		(item) => item.id === id,
	) as SolvedScene["objects"][number];

describe("polylines", () => {
	it("measures and walks a polyline by arc length", () => {
		const line = [
			{ x: 0, y: 0 },
			{ x: 3, y: 4 },
			{ x: 3, y: 10 },
		];
		expect(polylineLength(line)).toBe(11);
		expect(pointAlong(line, 2.5)).toEqual({
			point: { x: 1.5, y: 2 },
			angle: (Math.atan2(4, 3) * 180) / Math.PI,
		});
		// At a corner: the next segment's direction.
		expect(pointAlong(line, 5)).toEqual({ point: { x: 3, y: 4 }, angle: 90 });
		expect(pointAlong(line, 99).point).toEqual({ x: 3, y: 10 });
	});

	it("follows the geodesic (the great circle) between geographic points", () => {
		const a = { lat: 39.9, lon: 116.4 };
		const b = { lat: 31.2, lon: 121.5 };
		const line = geodesicPolyline([a, b], 10_000);
		const total = Geodesic.WGS84.Inverse(a.lat, a.lon, b.lat, b.lon).s12;
		expect(line.length).toBeGreaterThan(100);
		for (const point of line.slice(1, -1)) {
			// On the geodesic: the two parts add up to the whole.
			const first = Geodesic.WGS84.Inverse(a.lat, a.lon, point.lat, point.lon);
			const second = Geodesic.WGS84.Inverse(point.lat, point.lon, b.lat, b.lon);
			expect(Math.abs(first.s12 + second.s12 - total)).toBeLessThan(1e-3);
		}
		// Not the straight line in latitude and longitude: the great circle
		// bulges north of it.
		const middle = line[Math.floor(line.length / 2)] as {
			lat: number;
			lon: number;
		};
		const chordLat =
			a.lat + ((b.lat - a.lat) * (middle.lon - a.lon)) / (b.lon - a.lon);
		expect(middle.lat).toBeGreaterThan(chordLat);
	});

	it("tells a segment through a box from one beside it", () => {
		const box = { min: [0, 0, 0], max: [1, 1, 1] };
		expect(segmentHitsBox([-1, 0.5, 0.5], [2, 0.5, 0.5], box)).toBe(true);
		expect(segmentHitsBox([-1, 0.5, 1.5], [2, 0.5, 1.5], box)).toBe(false);
		expect(segmentHitsBox([-1, -1, 0.5], [-0.5, 2, 0.5], box)).toBe(false);
		expect(segmentHitsBox([0.5, 0.5, 5], [0.5, 0.5, 0.9], box)).toBe(true);
	});
});

describe("placing along a line", () => {
	const road = {
		points: [
			[0, 0],
			[40, 0],
			[40, 30],
		],
	};

	it("spaces objects by arc length, to one side, facing the line", () => {
		const scene = solve({
			bounds: { width: 50, depth: 40 },
			lines: { road },
			objects: { lamp: { size: [0.3, 0.3, 5], count: 5 } },
			relations: ["lamp along road, spacing 15, offset 2, from 5"],
		});
		// 5, 20, 35, 50, 65 m along: the last two are on the north leg.
		const want = [
			[5, -2],
			[20, -2],
			[35, -2],
			[42, 10],
			[42, 25],
		];
		want.forEach(([x, y], k) => {
			const lamp = object(scene, `lamp${k + 1}`);
			expect(lamp.position[0]).toBeCloseTo(x as number, 6);
			expect(lamp.position[1]).toBeCloseTo(y as number, 6);
		});
		// Offset 2 is to the right of travel; the front (-y) faces the road.
		expect(object(scene, "lamp1").yaw).toBeCloseTo(180, 6);
		expect(object(scene, "lamp4").yaw).toBeCloseTo(-90, 6);
	});

	it("spreads evenly without a spacing, and follows the ground", () => {
		const grid = sampleTerrain((x, y) => 0.1 * x + 0.05 * y, {
			spacing: 5,
			columns: 11,
			rows: 9,
		});
		const scene = solve({
			bounds: { width: 50, depth: 40 },
			terrain: {
				grid: { spacing: 5, heights: grid.heights },
			},
			lines: { road },
			objects: { post: { size: [0.2, 0.2, 1], count: 3 } },
			relations: ["post along road"],
		});
		const terrain = new GridTerrain(grid);
		const at = [
			[0, 0],
			[35, 0],
			[40, 30],
		];
		at.forEach(([x, y], k) => {
			const post = object(scene, `post${k + 1}`);
			expect(post.position[0]).toBeCloseTo(x as number, 6);
			expect(post.position[1]).toBeCloseTo(y as number, 6);
			expect(post.position[2]).toBeCloseTo(
				terrain.height(x as number, y as number),
				4,
			);
		});
		// The line itself lies on the ground in the output.
		expect(scene.lines?.[0]?.points[2]).toEqual([40, 30, 5.5]);
		expect(scene.lines?.[0]?.length).toBe(70);
	});

	it("keeps a turn the relation gives", () => {
		const scene = solve({
			bounds: { width: 50, depth: 40 },
			lines: { road },
			objects: { sign: { size: [1, 0.1, 2], count: 2 } },
			relations: ["sign along road, spacing 10, rotate 45"],
		});
		expect(object(scene, "sign1").yaw).toBe(45);
		expect(object(scene, "sign2").yaw).toBe(45);
	});

	it("places along a line given by latitude and longitude", () => {
		const scene = solve({
			bounds: { width: 2000, depth: 2000 },
			frame: { origin: { lat: 30, lon: 120 } },
			lines: {
				canal: {
					geo: [
						{ lat: 30.001, lon: 120.001 },
						{ lat: 30.01, lon: 120.015 },
					],
				},
			},
			objects: { buoy: { size: [1, 1, 1], count: 4 } },
			relations: ["buoy along canal, spacing 300"],
		});
		// Each buoy 300 m further along the geodesic.
		const start = { lat: 30.001, lon: 120.001 };
		object(scene, "buoy1");
		for (let k = 0; k < 4; k += 1) {
			const geo = object(scene, `buoy${k + 1}`).geo;
			const along = geodesicInverse(start, {
				lat: geo?.lat ?? 0,
				lon: geo?.lon ?? 0,
			});
			expect(along.distance).toBeCloseTo(300 * k, 1);
		}
	});

	it("says what is wrong", () => {
		const codes = (value: Record<string, unknown>) =>
			normalizeSceneDsl({
				scene: "t",
				bounds: { width: 50, depth: 40 },
				objects: { lamp: { size: [0.3, 0.3, 5], count: 5 } },
				...value,
			}).diagnostics.map((d) => d.code);
		expect(
			codes({ lines: { road }, relations: ["lamp along road, spacing 20"] }),
		).toEqual(["validate.scene.along-overflow"]);
		expect(codes({ lines: { road }, relations: ["lamp along raod"] })).toEqual([
			"validate.scene.unknown-line",
		]);
		expect(
			codes({
				lines: {
					road: {
						points: [
							[0, 0],
							[1, 1],
						],
						geo: [
							{ lat: 1, lon: 1 },
							{ lat: 1, lon: 2 },
						],
					},
				},
			}),
		).toEqual(["validate.scene.line-points"]);
		expect(codes({ lines: { lamp: road } })).toEqual([
			"validate.scene.duplicate-id",
		]);
		expect(
			codes({
				lines: {
					road: {
						geo: [
							{ lat: 1, lon: 1 },
							{ lat: 1, lon: 2 },
						],
					},
				},
			}),
		).toEqual(["validate.scene.geo-without-frame"]);
		expect(
			codes({ waypoints: { scan: { line: "nowhere", height: 30 } } }),
		).toEqual(["validate.scene.unknown-line"]);
		expect(
			codes({
				lines: { road },
				waypoints: { scan: { line: "road", height: 30, spacing: 5, count: 3 } },
			}),
		).toEqual(["validate.scene.relation-conflict"]);
	});
});

describe("drone waypoints", () => {
	const hill = (x: number, y: number) =>
		30 * Math.exp(-((x - 50) ** 2 + (y - 40) ** 2) / 400);
	const grid: TerrainGrid = sampleTerrain(hill, {
		spacing: 5,
		columns: 21,
		rows: 17,
	});

	it("flies at its height above the ground, every spacing and at the end", () => {
		const scene = solve({
			bounds: { width: 100, depth: 80 },
			terrain: { grid: { spacing: 5, heights: grid.heights } },
			lines: {
				pass: {
					points: [
						[0, 40],
						[100, 40],
					],
				},
			},
			waypoints: { scan: { line: "pass", spacing: 30, height: 40 } },
			objects: { a: { size: [1, 1, 1], position: [5, 5] } },
		});
		const scan = scene.waypoints?.[0];
		const terrain = new GridTerrain(grid);
		expect(scan?.points.map(([x]) => x)).toEqual([0, 30, 60, 90, 100]);
		for (const [x, y, z] of scan?.points ?? []) {
			expect(z - terrain.height(x, y)).toBeCloseTo(40, 3);
		}
		// Straight legs over a hill come closer to it than 40 m: the lowest
		// height above ground along them, checked against dense sampling.
		let lowest = Infinity;
		const points = scan?.points ?? [];
		for (let k = 1; k < points.length; k += 1) {
			const [x0 = 0, y0 = 0, z0 = 0] = points[k - 1] ?? [];
			const [x1 = 0, y1 = 0, z1 = 0] = points[k] ?? [];
			for (let t = 0; t <= 1; t += 0.0005) {
				const x = x0 + (x1 - x0) * t;
				const y = y0 + (y1 - y0) * t;
				lowest = Math.min(lowest, z0 + (z1 - z0) * t - terrain.height(x, y));
			}
		}
		expect(scan?.lowest).toBeLessThan(40);
		expect(Math.abs((scan?.lowest ?? 0) - lowest)).toBeLessThan(0.05);
	});

	it("warns when the legs come too low or fly through something", () => {
		const scene = solve({
			bounds: { width: 100, depth: 80 },
			terrain: { grid: { spacing: 5, heights: grid.heights } },
			lines: {
				pass: {
					points: [
						[0, 40],
						[100, 40],
					],
				},
			},
			waypoints: { scan: { line: "pass", count: 2, height: 10, min: 5 } },
			objects: { mast: { size: [2, 2, 40], position: [20, 40] } },
		});
		const codes = scene.diagnostics.map((d) => [d.code, d.objects]);
		expect(codes).toContainEqual(["scene.waypoint.low", undefined]);
		expect(codes).toContainEqual(["scene.waypoint.collision", ["mast"]]);
		// Two waypoints, 10 m up at each end; over the hill the leg is far
		// below the ground.
		expect(scene.waypoints?.[0]?.points.length).toBe(2);
		expect(scene.waypoints?.[0]?.lowest).toBeLessThan(0);
	});

	it("gives waypoints latitude, longitude and height in a scene on the Earth", () => {
		const scene = solve({
			bounds: { width: 500, depth: 500 },
			frame: { origin: { lat: 30, lon: 120, alt: 100 } },
			lines: {
				pass: {
					points: [
						[0, 0],
						[400, 300],
					],
				},
			},
			waypoints: { scan: { line: "pass", spacing: 100, height: 50 } },
			objects: { a: { size: [1, 1, 1], position: [5, 5] } },
		});
		const scan = scene.waypoints?.[0];
		expect(scan?.points.length).toBe(6);
		expect(scan?.geo?.every((g) => Math.abs(g.alt - 150) < 1e-4)).toBe(true);
		expect(() =>
			sceneDocumentSchema.parse(JSON.parse(sceneToJson(scene))),
		).not.toThrow();
	});

	it("lays waypoints at the line's vertices by default", () => {
		const laid = layWaypoints(
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 10, y: 10 },
			],
			{ height: 20 },
		);
		expect(laid.points).toEqual([
			[0, 0, 20],
			[10, 0, 20],
			[10, 10, 20],
		]);
		expect(laid.lowest).toBe(20);
	});
});

describe("the hillside with a road and a survey flight", () => {
	it("solves, with the lamps on the road and the survey clear of the ground", () => {
		const parsed = parseSceneDsl(sceneSource("hillside"));
		expect(parsed.diagnostics).toEqual([]);
		const scene = solveScene(parsed.scene as SceneSpec);
		expect(scene.valid).toBe(true);
		expect(scene.objects.filter((o) => o.id.startsWith("lamp")).length).toBe(6);
		const scan = scene.waypoints?.[0];
		expect(scan?.lowest).toBeGreaterThan(30);
		const svg = sceneTopViewSvg(scene);
		expect(svg).toContain('stroke="#7c3aed"');
		expect(svg).toContain(">road</text>");
	});
});
