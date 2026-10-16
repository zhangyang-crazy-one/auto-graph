import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	parseSceneDsl,
	type SceneSpec,
	type SolvedScene,
	sceneToBlenderScript,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";
import { corners, footprint } from "../src/scene/geometry.js";
import {
	contourSegments,
	GridTerrain,
	parseAsciiGrid,
	sampleTerrain,
	type TerrainGrid,
} from "../src/scene/terrain/index.js";
import { sceneSource, sceneTopViewUrl } from "./support/scene-files.js";
import { mulberry32 } from "./support/synthetic.js";

/** Smooth rolling ground: a few hills on a tilt. */
function rolling(seed: number) {
	const random = mulberry32(seed);
	const hills = Array.from({ length: 4 }, () => ({
		x: random() * 100,
		y: random() * 80,
		h: 4 + random() * 12,
		w: 10 + random() * 20,
	}));
	const tilt = { x: (random() - 0.5) * 0.1, y: (random() - 0.5) * 0.1 };
	return (x: number, y: number) =>
		50 +
		tilt.x * x +
		tilt.y * y +
		hills.reduce(
			(sum, hill) =>
				sum +
				hill.h *
					Math.exp(-((x - hill.x) ** 2 + (y - hill.y) ** 2) / hill.w ** 2),
			0,
		);
}

function terrainDsl(grid: TerrainGrid) {
	return {
		grid: {
			origin: [grid.origin.x, grid.origin.y],
			spacing: [grid.spacing.x, grid.spacing.y],
			heights: grid.heights,
		},
		base: grid.base,
	};
}

function solve(value: Record<string, unknown>): SolvedScene {
	const result = normalizeSceneDsl({ scene: "t", ...value });
	expect(result.diagnostics).toEqual([]);
	return solveScene(result.scene as SceneSpec);
}

/** The steepest slope and the elevation range on a dense grid of points. */
function sampled(terrain: GridTerrain, shape: ReturnType<typeof footprint>) {
	let slope = 0;
	let low = Infinity;
	let high = -Infinity;
	const n = 40;
	for (let a = 0; a <= n; a += 1) {
		for (let b = 0; b <= n; b += 1) {
			const u = (2 * a) / n - 1;
			const v = (2 * b) / n - 1;
			const x =
				shape.center.x +
				shape.axisX.x * shape.halfX * u +
				shape.axisY.x * shape.halfY * v;
			const y =
				shape.center.y +
				shape.axisX.y * shape.halfX * u +
				shape.axisY.y * shape.halfY * v;
			const h = terrain.elevation(x, y);
			low = Math.min(low, h);
			high = Math.max(high, h);
			slope = Math.max(slope, terrain.slope(x, y));
		}
	}
	return { slope, low, high };
}

describe("terrain grid", () => {
	it("reproduces planes and bilinear patches exactly", () => {
		const plane = (x: number, y: number) => 10 + 0.3 * x - 0.2 * y;
		const grid = sampleTerrain(plane, { spacing: 2.5, columns: 9, rows: 7 });
		const terrain = new GridTerrain(grid);
		for (const [x, y] of [
			[0, 0],
			[3.3, 7.1],
			[20, 15],
			[12.49, 0.01],
		] as const) {
			expect(terrain.elevation(x, y)).toBeCloseTo(plane(x, y), 10);
			expect(terrain.gradient(x, y).x).toBeCloseTo(0.3, 10);
			expect(terrain.gradient(x, y).y).toBeCloseTo(-0.2, 10);
		}
		expect(terrain.elevation(-1, 0)).toBeNaN();
		const saddle = (x: number, y: number) => x * y;
		const patch = new GridTerrain(
			sampleTerrain(saddle, { spacing: 1, columns: 2, rows: 2 }),
		);
		expect(patch.elevation(0.3, 0.7)).toBeCloseTo(0.21, 12);
	});

	it("finds the exact slope and elevation range under any footprint", () => {
		const random = mulberry32(7);
		for (let trial = 0; trial < 60; trial += 1) {
			const grid = sampleTerrain(rolling(trial), {
				spacing: 2 + random() * 6,
				columns: 12,
				rows: 10,
			});
			const terrain = new GridTerrain(grid);
			const shape = footprint(
				{
					x: 6 + random() * (terrain.max.x - 12),
					y: 6 + random() * (terrain.max.y - 12),
				},
				[1 + random() * 8, 1 + random() * 8, 1],
				random() * 360,
			);
			const exact = terrain.rangeUnder(shape);
			const dense = sampled(terrain, shape);
			expect(exact.covered).toBe(true);
			// Never less than any sample, and the samples close in on it.
			expect(exact.maxSlope).toBeGreaterThanOrEqual(dense.slope - 1e-9);
			expect(exact.maxElevation).toBeGreaterThanOrEqual(dense.high - 1e-9);
			expect(exact.minElevation).toBeLessThanOrEqual(dense.low + 1e-9);
			expect(exact.maxSlope - dense.slope).toBeLessThan(0.5);
			expect(exact.maxElevation - dense.high).toBeLessThan(0.02);
			expect(dense.low - exact.minElevation).toBeLessThan(0.02);
		}
	});

	it("draws contours where the ground is at the level", () => {
		const grid = sampleTerrain(rolling(3), {
			spacing: 5,
			columns: 21,
			rows: 17,
		});
		const terrain = new GridTerrain(grid);
		const segments = contourSegments(grid, 60);
		expect(segments.length).toBeGreaterThan(10);
		for (const [a, b] of segments) {
			expect(terrain.elevation(a.x, a.y)).toBeCloseTo(60, 9);
			expect(terrain.elevation(b.x, b.y)).toBeCloseTo(60, 9);
		}
	});

	it("reads ESRI ASCII grids, north row first", () => {
		const grid = parseAsciiGrid(
			[
				"ncols 3",
				"nrows 2",
				"xllcorner 100",
				"yllcorner 200",
				"cellsize 10",
				"NODATA_value -9999",
				"7 8 9",
				"1 2 3",
			].join("\n"),
		);
		expect(grid).toEqual({
			origin: [105, 205],
			spacing: 10,
			heights: [
				[1, 2, 3],
				[7, 8, 9],
			],
		});
		expect(() =>
			parseAsciiGrid(
				"ncols 2\nnrows 2\nxllcenter 0\nyllcenter 0\ncellsize 1\nNODATA_value -1\n1 -1\n2 3",
			),
		).toThrow(/no elevation at row 1, column 2/);
		expect(() =>
			parseAsciiGrid(
				"ncols 2\nnrows 2\nxllcenter 0\nyllcenter 0\ncellsize 1\n1 2 3",
			),
		).toThrow(/3 values for 2 × 2/);
	});
});

describe("objects on terrain", () => {
	it("stands every object on the ground to well under 1 cm", () => {
		for (let seed = 0; seed < 10; seed += 1) {
			const truth = rolling(seed);
			const grid = sampleTerrain(truth, {
				spacing: 0.5,
				columns: 201,
				rows: 161,
			});
			const random = mulberry32(seed + 100);
			const objects: Record<string, unknown> = {};
			for (let k = 0; k < 8; k += 1) {
				objects[`o${k}`] = {
					size: [1 + random() * 3, 1 + random() * 3, 2],
					position: [10 + k * 10, 10 + random() * 60],
					yaw: random() * 360,
				};
			}
			const scene = solve({
				bounds: { width: 100, depth: 80 },
				terrain: terrainDsl(grid),
				objects,
			});
			const terrain = new GridTerrain(grid);
			for (const object of scene.objects) {
				const [x, y, z] = object.position;
				// On the grid's ground to the output's 0.1 mm, and on the
				// smooth ground it was sampled from to under 1 cm.
				expect(Math.abs(z - terrain.height(x, y))).toBeLessThan(1e-4);
				expect(Math.abs(z - (truth(x, y) - grid.base))).toBeLessThan(0.01);
			}
		}
	});

	it("leans aligned objects square to a sloping plane", () => {
		const plane = (x: number, y: number) => 0.25 * x + 0.1 * y;
		const grid = sampleTerrain(plane, { spacing: 5, columns: 9, rows: 9 });
		const scene = solve({
			bounds: { width: 40, depth: 40 },
			terrain: terrainDsl(grid),
			objects: { panel: { size: [4, 2, 0.1], position: [20, 20], yaw: 30 } },
			relations: ["panel on terrain, align to slope"],
		});
		const panel = scene.objects[0] as SolvedScene["objects"][number];
		const norm = Math.hypot(0.25, 0.1, 1);
		expect(panel.up?.[0]).toBeCloseTo(-0.25 / norm, 8);
		expect(panel.up?.[1]).toBeCloseTo(-0.1 / norm, 8);
		expect(panel.up?.[2]).toBeCloseTo(1 / norm, 8);
		expect(panel.position[2]).toBeCloseTo(plane(20, 20), 4);
		// The bottom face lies on the plane: the lowest corner is on it.
		const low = panel.aabb.min[2];
		const shape = footprint({ x: 20, y: 20 }, [4, 2, 0.1], 30);
		const lowest = Math.min(...corners(shape).map((p) => plane(p.x, p.y)));
		expect(low).toBeLessThanOrEqual(lowest + 0.05);
		expect(scene.diagnostics.map((d) => d.code)).toEqual([]);
	});

	it("reports upright objects on uneven ground, objects off the grid and leaning supports", () => {
		const grid = sampleTerrain((x) => 0.2 * x, {
			spacing: 5,
			columns: 5,
			rows: 5,
		});
		const scene = solve({
			bounds: { width: 30, depth: 30 },
			terrain: terrainDsl(grid),
			objects: {
				shed: { size: [4, 3, 2.5], position: [10, 10] },
				far: { size: [2, 2, 2], position: [25, 10] },
				table: { size: [2, 1, 0.8], position: [10, 4] },
				cup: { size: [0.1, 0.1, 0.1] },
			},
			relations: ["table align to slope", "cup on table", "cup on terrain"],
		});
		const codes = scene.diagnostics.map((d) => `${d.severity}:${d.code}`);
		expect(codes).toContain("error:scene.terrain.outside");
		expect(codes).toContain("error:scene.terrain.leaning-support");
		expect(codes).toContain("warning:scene.terrain.off-ground");
		const uneven = scene.diagnostics.find(
			(d) => d.code === "scene.terrain.uneven" && d.objects?.[0] === "shed",
		);
		expect(uneven?.detail?.rise).toBeCloseTo(0.8, 4);
		expect(scene.valid).toBe(false);
	});

	it("measures the ceiling and agents' headroom from the ground", () => {
		const grid = sampleTerrain((x) => 0.5 * x, {
			spacing: 2,
			columns: 6,
			rows: 4,
		});
		const scene = solve({
			bounds: { width: 10, depth: 6, height: 3 },
			terrain: terrainDsl(grid),
			objects: {
				// 4 m up the slope, but only 1 m tall: under a 3 m ceiling.
				crate: { size: [1, 6, 1], position: [8, 3] },
				a: { size: [0.5, 0.5, 0.5], position: [1, 3] },
			},
			paths: ["person from a to crate"],
		});
		expect(scene.diagnostics.map((d) => d.code)).not.toContain(
			"scene.above-ceiling",
		);
		// The crate stands on the ground: it blocks the person, who walks
		// to it, not under it.
		const path = scene.paths[0];
		expect(path).toBeDefined();
		const last = path?.points.at(-1) as [number, number, number];
		expect(last[0]).toBeLessThan(8 - 0.5);
		for (const [x, , z] of path?.points ?? []) {
			expect(z).toBeCloseTo(0.5 * x, 4);
		}
	});
});

describe("slope and elevation limits", () => {
	it("never leaves an object on ground outside its limits without an error", () => {
		let moved = 0;
		for (let seed = 0; seed < 25; seed += 1) {
			const grid = sampleTerrain(rolling(seed), {
				spacing: 4,
				columns: 26,
				rows: 21,
			});
			const terrain = new GridTerrain(grid);
			const all = grid.heights.flat();
			const low = Math.min(...all);
			const high = Math.max(...all);
			const random = mulberry32(seed);
			const slope = 3 + random() * 8;
			const above = low + (high - low) * random() * 0.5;
			const scene = solve({
				bounds: { width: 100, depth: 80 },
				terrain: terrainDsl(grid),
				objects: {
					mast: { size: [2, 2, 10], count: 4 },
					hut: { size: [5, 4, 3], position: [50, 40] },
				},
				relations: [
					`mast slope below ${slope.toFixed(2)}`,
					`mast elevation above ${above.toFixed(2)}`,
					"hut slope below 0.5",
				],
			});
			for (const object of scene.objects) {
				const shape = footprint(
					{ x: object.position[0], y: object.position[1] },
					object.size,
					object.yaw,
				);
				const dense = sampled(terrain, shape);
				const limited = object.id.startsWith("mast")
					? dense.slope > slope + 1e-6 || dense.low < above - 1e-6
					: dense.slope > 0.5 + 1e-6;
				const reported = scene.diagnostics.some(
					(d) =>
						(d.code === "scene.terrain.slope" ||
							d.code === "scene.terrain.elevation") &&
						d.severity === "error" &&
						d.objects?.includes(object.id),
				);
				// Off limits only with an error saying so.
				if (limited) expect(reported).toBe(true);
				if (reported) expect(scene.valid).toBe(false);
			}
			moved += scene.diagnostics.filter(
				(d) => d.code === "scene.terrain.moved",
			).length;
		}
		// The limits do move objects onto ground that meets them.
		expect(moved).toBeGreaterThan(40);
	});

	it("moves free objects to ground that meets their limits, not held ones", () => {
		const hill = (x: number, y: number) =>
			20 * Math.exp(-((x - 30) ** 2 + (y - 30) ** 2) / 300);
		const grid = sampleTerrain(hill, { spacing: 2, columns: 31, rows: 31 });
		const scene = solve({
			bounds: { width: 60, depth: 60 },
			terrain: terrainDsl(grid),
			objects: { tower: { size: [3, 3, 20] }, hut: { size: [2, 2, 2] } },
			relations: [
				"tower center-of room",
				"tower elevation below 2",
				"hut elevation below 3",
			],
		});
		// The tower is held at the hilltop by a relation: it stays, and the
		// error says why. The hut is free: it moves down off the hill.
		const errors = scene.diagnostics.filter((d) => d.severity === "error");
		expect(errors.map((d) => [d.code, d.objects])).toEqual([
			["scene.terrain.elevation", ["tower"]],
		]);
		const moved = scene.diagnostics.filter(
			(d) => d.code === "scene.terrain.moved",
		);
		expect(moved.map((d) => d.objects)).toEqual([["hut"]]);
		const hut = scene.objects.find((object) => object.id === "hut");
		const terrain = new GridTerrain(grid);
		const [x, y] = hut?.position ?? [0, 0];
		const range = terrain.rangeUnder(footprint({ x, y }, [2, 2, 2], 0));
		expect(range.maxElevation).toBeLessThanOrEqual(3);
		// Clear of the tower.
		expect(Math.max(Math.abs(x - 30), Math.abs(y - 30))).toBeGreaterThanOrEqual(
			2.5,
		);
	});

	it("is deterministic", () => {
		const parsed = parseSceneDsl(sceneSource("hillside"));
		const a = solveScene(parsed.scene as SceneSpec);
		const b = solveScene(parsed.scene as SceneSpec);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(sceneToBlenderScript(a)).toBe(sceneToBlenderScript(b));
	});
});

describe("the hillside example", () => {
	const parsed = parseSceneDsl(sceneSource("hillside"));
	const scene = solveScene(parsed.scene as SceneSpec);

	it("solves, with the turbines on the ridge", () => {
		expect(parsed.diagnostics).toEqual([]);
		expect(scene.valid).toBe(true);
		const terrain = new GridTerrain(parsed.scene?.terrain as TerrainGrid);
		for (const id of ["turbine1", "turbine2", "turbine3"]) {
			const turbine = scene.objects.find((object) => object.id === id);
			const [x, y] = turbine?.position ?? [0, 0];
			const range = terrain.rangeUnder(footprint({ x, y }, [5, 5, 40], 0));
			expect(range.maxSlope).toBeLessThanOrEqual(8);
			expect(range.minElevation).toBeGreaterThanOrEqual(1425);
		}
		expect(scene.objects.filter((object) => object.up).length).toBe(6);
		// Heights on the Earth follow the ground.
		const station = scene.objects.find((object) => object.id === "station");
		expect(station?.geo?.alt).toBeCloseTo(
			1400 + (station?.position[2] ?? 0),
			4,
		);
	});

	it("draws its top view with contours, byte for byte", () => {
		const svg = sceneTopViewSvg(scene);
		expect(svg).toContain('stroke="#a8956d"');
		const golden = sceneTopViewUrl("hillside");
		if (process.env.UPDATE_SCENE_GOLDEN === "1") writeFileSync(golden, svg);
		expect(svg).toBe(readFileSync(golden, "utf8"));
	});
});

describe("terrain in the DSL", () => {
	const base = {
		scene: "t",
		bounds: { width: 10, depth: 10 },
		objects: { a: { size: [1, 1, 1] }, b: { size: [1, 1, 1] } },
	};
	const flat = {
		grid: {
			spacing: 5,
			heights: [
				[0, 0, 0],
				[0, 0, 0],
				[0, 0, 0],
			],
		},
	};
	const codes = (value: Record<string, unknown>) =>
		normalizeSceneDsl({ ...base, ...value }).diagnostics.map((d) => d.code);

	it("needs terrain for terrain relations", () => {
		for (const relation of [
			"a on terrain",
			"a align to slope",
			"a slope below 10",
			"a elevation above 5",
		]) {
			expect(codes({ relations: [relation] })).toEqual([
				"validate.scene.terrain-missing",
			]);
		}
	});

	it("checks the grid and the base", () => {
		expect(
			codes({ terrain: { grid: { spacing: 1, heights: [[0, 0], [0]] } } }),
		).toEqual(["validate.scene.terrain-grid"]);
		expect(
			codes({ terrain: { grid: { spacing: 1, heights: [[0, 0]] } } }),
		).toEqual(["validate.scene.terrain-grid"]);
		expect(
			codes({
				frame: { origin: { lat: 30, lon: 120, alt: 50 } },
				terrain: { ...flat, base: 50 },
			}),
		).toEqual(["validate.scene.terrain-base"]);
	});

	it("reads limits", () => {
		const relations = (list: string[]) =>
			normalizeSceneDsl({ ...base, terrain: flat, relations: list }).scene
				?.relations;
		expect(
			relations([
				"a and b slope below 12°",
				"a elevation between -5 and 20",
				"b elevation below 300cm",
				"a on terrain, align to slope",
			]),
		).toEqual([
			{ kind: "slope-limit", subject: "a", max: 12, path: ["relations", 0] },
			{ kind: "slope-limit", subject: "b", max: 12, path: ["relations", 0] },
			{
				kind: "elevation-range",
				subject: "a",
				min: -5,
				max: 20,
				path: ["relations", 1],
			},
			{ kind: "elevation-range", subject: "b", max: 3, path: ["relations", 2] },
			{ kind: "ground", subject: "a", align: true, path: ["relations", 3] },
		]);
		expect(codes({ terrain: flat, relations: ["a slope below 95"] })).toEqual([
			"validate.scene.relation-value",
		]);
		expect(
			codes({ terrain: flat, relations: ["a elevation between 9 and 3"] }),
		).toEqual(["validate.scene.relation-value"]);
		expect(codes({ terrain: flat, relations: ["a slope over 3"] })).toEqual([
			"validate.scene.relation-syntax",
		]);
		expect(codes({ objects: { terrain: { size: [1, 1, 1] } } })).toEqual([
			"validate.scene.reserved-id",
		]);
	});

	it("takes the frame origin's height as the base", () => {
		const scene = solve({
			bounds: { width: 10, depth: 10 },
			frame: { origin: { lat: 30, lon: 120, alt: 100 } },
			terrain: {
				grid: {
					spacing: 10,
					heights: [
						[100, 110],
						[100, 110],
					],
				},
			},
			objects: { a: { size: [1, 1, 1], position: [5, 5] } },
		});
		const a = scene.objects[0] as SolvedScene["objects"][number];
		expect(a.position[2]).toBeCloseTo(5, 6);
		expect(a.geo?.alt).toBeCloseTo(105, 4);
		expect(scene.terrain?.base).toBe(100);
	});
});
