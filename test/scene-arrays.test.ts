import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	parseSceneDsl,
	type SceneSpec,
	type SolvedScene,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";
import { distance, footprint } from "../src/scene/geometry.js";
import {
	GridTerrain,
	sampleTerrain,
	type TerrainGrid,
} from "../src/scene/terrain/index.js";
import { sceneSource, sceneTopViewUrl } from "./support/scene-files.js";

function solve(value: Record<string, unknown>): SolvedScene {
	const result = normalizeSceneDsl({ scene: "t", ...value });
	expect(result.diagnostics).toEqual([]);
	return solveScene(result.scene as SceneSpec);
}

const object = (scene: SolvedScene, id: string) =>
	scene.objects.find(
		(item) => item.id === id,
	) as SolvedScene["objects"][number];

describe("tilt", () => {
	it("leans an object toward its front, lowest edge on the ground", () => {
		const scene = solve({
			bounds: { width: 20, depth: 20 },
			objects: {
				panel: { size: [4, 2, 0.1], position: [10, 10] },
				sign: { size: [1, 0.2, 2], position: [4, 4] },
			},
			relations: ["panel facing south, tilt 30", "sign tilt 10, rotate 90"],
		});
		const panel = object(scene, "panel");
		// Facing south (-y): its up axis leans 30° to the south.
		expect(panel.up?.[0]).toBeCloseTo(0, 9);
		expect(panel.up?.[1]).toBeCloseTo(-Math.sin(Math.PI / 6), 9);
		expect(panel.up?.[2]).toBeCloseTo(Math.cos(Math.PI / 6), 9);
		// Lifted by half its depth × sin 30° so its low edge is on the floor.
		expect(panel.position[2]).toBeCloseTo(1 * 0.5, 4);
		expect(panel.aabb.min[2]).toBeCloseTo(0, 4);
		// Turned 90°, the sign's front faces east: it leans east.
		const sign = object(scene, "sign");
		expect(sign.up?.[0]).toBeCloseTo(Math.sin(Math.PI / 18), 9);
		expect(sign.aabb.min[2]).toBeCloseTo(0, 4);
		expect(scene.valid).toBe(true);
	});

	it("stands a tilted object on the ground at its center on terrain", () => {
		const grid = sampleTerrain((x, y) => 0.1 * x + 0.05 * y, {
			spacing: 5,
			columns: 5,
			rows: 5,
		});
		const scene = solve({
			bounds: { width: 20, depth: 20 },
			terrain: { grid: { spacing: 5, heights: grid.heights } },
			objects: { panel: { size: [4, 2, 0.1], position: [10, 10] } },
			relations: ["panel tilt 25"],
		});
		const panel = object(scene, "panel");
		const ground = new GridTerrain(grid).height(10, 10);
		expect(panel.aabb.min[2]).toBeCloseTo(ground, 4);
	});

	it("says what is wrong", () => {
		const grid = {
			spacing: 5,
			heights: [
				[0, 0],
				[0, 0],
			],
		};
		const result = normalizeSceneDsl({
			scene: "t",
			bounds: { width: 5, depth: 5 },
			terrain: { grid },
			objects: { a: { size: [1, 1, 1] } },
			relations: ["a align to slope", "a tilt 20"],
		});
		const scene = solveScene(result.scene as SceneSpec);
		expect(scene.diagnostics.map((d) => d.code)).toContain(
			"scene.tilt.conflict",
		);
		expect(
			normalizeSceneDsl({
				scene: "t",
				bounds: { width: 5, depth: 5 },
				objects: { a: { size: [1, 1, 1] } },
				relations: ["a tilt 95"],
			}).diagnostics.map((d) => d.code),
		).toEqual(["validate.scene.relation-value"]);
	});
});

describe("keep clear between a group", () => {
	it("keeps every pair apart", () => {
		const result = normalizeSceneDsl({
			scene: "t",
			bounds: { width: 50, depth: 50 },
			objects: { mast: { size: [1, 1, 3], count: 4 } },
			relations: ["keep clear 10 between mast"],
		});
		expect(
			result.scene?.relations.filter((r) => r.kind === "keep-clear").length,
		).toBe(6);
		const scene = solveScene(result.scene as SceneSpec);
		expect(scene.valid).toBe(true);
		for (let i = 1; i <= 4; i += 1) {
			for (let j = i + 1; j <= 4; j += 1) {
				const a = object(scene, `mast${i}`);
				const b = object(scene, `mast${j}`);
				const gap = distance(
					footprint({ x: a.position[0], y: a.position[1] }, a.size, a.yaw),
					footprint({ x: b.position[0], y: b.position[1] }, b.size, b.yaw),
				);
				expect(gap).toBeGreaterThanOrEqual(10 - 1e-4);
			}
		}
	});
});

describe("the wind farm", () => {
	const parsed = parseSceneDsl(sceneSource("windfarm"));
	const scene = solveScene(parsed.scene as SceneSpec);

	it("puts every turbine on ground within its limits, 350 m apart", () => {
		expect(parsed.diagnostics).toEqual([]);
		expect(scene.valid).toBe(true);
		const terrain = new GridTerrain(parsed.scene?.terrain as TerrainGrid);
		const turbines = scene.objects.filter((o) => o.id.startsWith("turbine"));
		expect(turbines.length).toBe(8);
		for (const turbine of turbines) {
			const shape = footprint(
				{ x: turbine.position[0], y: turbine.position[1] },
				turbine.size,
				turbine.yaw,
			);
			const range = terrain.rangeUnder(shape);
			expect(range.maxSlope).toBeLessThanOrEqual(5);
			expect(range.minElevation).toBeGreaterThanOrEqual(1450);
			for (const other of turbines) {
				if (other.id <= turbine.id) continue;
				const gap = distance(
					shape,
					footprint(
						{ x: other.position[0], y: other.position[1] },
						other.size,
						other.yaw,
					),
				);
				expect(gap).toBeGreaterThanOrEqual(350 - 1e-4);
			}
		}
		// Turbines already on good ground stayed; the others were moved and
		// say so.
		const moved = scene.diagnostics.filter(
			(d) => d.code === "scene.terrain.moved",
		);
		expect(moved.length).toBeGreaterThan(0);
		expect(moved.length).toBeLessThan(8);
	});
});

describe("the examples", () => {
	it.each([
		"windfarm",
		"solar",
		"streetlights",
	])("%s solves and draws its top view byte for byte", (name) => {
		const parsed = parseSceneDsl(sceneSource(name));
		expect(parsed.diagnostics).toEqual([]);
		const scene = solveScene(parsed.scene as SceneSpec);
		expect(scene.valid).toBe(true);
		const svg = sceneTopViewSvg(scene);
		const golden = sceneTopViewUrl(name);
		if (process.env.UPDATE_SCENE_GOLDEN === "1") writeFileSync(golden, svg);
		expect(svg).toBe(readFileSync(golden, "utf8"));
	});

	it("tilts the solar panels 25° to the south, low edge on the ground", () => {
		const parsed = parseSceneDsl(sceneSource("solar"));
		const scene = solveScene(parsed.scene as SceneSpec);
		const terrain = new GridTerrain(parsed.scene?.terrain as TerrainGrid);
		const panels = scene.objects.filter((o) => o.id.startsWith("panel"));
		expect(panels.length).toBe(32);
		for (const panel of panels) {
			expect(Math.acos(panel.up?.[2] ?? 1)).toBeCloseTo(
				(25 * Math.PI) / 180,
				8,
			);
			expect(panel.up?.[1]).toBeLessThan(0);
			expect(panel.aabb.min[2]).toBeCloseTo(
				terrain.height(panel.position[0], panel.position[1]),
				3,
			);
		}
	});

	it("lines the street with lamps on both sides, facing it", () => {
		const scene = solveScene(
			parseSceneDsl(sceneSource("streetlights")).scene as SceneSpec,
		);
		expect(scene.objects.filter((o) => o.id.startsWith("lamp")).length).toBe(7);
		expect(scene.objects.filter((o) => o.id.startsWith("lantern")).length).toBe(
			6,
		);
		expect(scene.lines?.[0]?.length).toBeGreaterThan(200);
	});
});
