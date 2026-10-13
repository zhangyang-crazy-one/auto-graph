import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	parseSceneDsl,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";
import {
	distance,
	footprint,
	overhang,
	penetration,
} from "../src/scene/geometry.js";

const FIXTURES = new URL("./fixtures/scene/", import.meta.url);

function solveFixture(name: string) {
	const parsed = parseSceneDsl(
		readFileSync(new URL(`${name}.yaml`, FIXTURES), "utf8"),
	);
	expect(parsed.diagnostics).toEqual([]);
	if (parsed.scene === undefined) throw new Error("no scene");
	return solveScene(parsed.scene);
}

function solve(value: Record<string, unknown>) {
	const result = normalizeSceneDsl({
		scene: "t",
		bounds: { width: 4, depth: 4, height: 2.5 },
		...value,
	});
	expect(result.diagnostics).toEqual([]);
	if (result.scene === undefined) throw new Error("no scene");
	return solveScene(result.scene);
}

const codes = (scene: ReturnType<typeof solveScene>, severity = "error") =>
	scene.diagnostics
		.filter((diagnostic) => diagnostic.severity === severity)
		.map((diagnostic) => diagnostic.code);

const placed = (scene: ReturnType<typeof solveScene>, id: string) =>
	scene.objects.find((object) => object.id === id);

describe("scene footprints", () => {
	it("separates rotated rectangles their bounding boxes would merge", () => {
		const a = footprint({ x: 0, y: 0 }, [1, 0.2, 1], 45);
		const b = footprint({ x: 0.6, y: -0.6 }, [1, 0.2, 1], 45);
		expect(penetration(a, b)).toBe(0);
		expect(distance(a, b)).toBeGreaterThan(0.6);
		const c = footprint({ x: 0.3, y: 0.3 }, [1, 0.2, 1], -45);
		expect(penetration(a, c)).toBeGreaterThan(0);
	});

	it("measures touching boxes as apart and overhangs past an edge", () => {
		const a = footprint({ x: 0, y: 0 }, [1, 1, 1], 0);
		const b = footprint({ x: 1, y: 0 }, [1, 1, 1], 0);
		expect(penetration(a, b)).toBe(0);
		expect(distance(a, b)).toBe(0);
		const top = footprint({ x: 0.3, y: 0 }, [0.6, 0.6, 1], 0);
		expect(overhang(top, a)).toBeCloseTo(0.1);
	});
});

describe("scene solve", () => {
	it("places the pinned study and checks it clean", () => {
		const scene = solveFixture("study-pinned");
		expect(scene.valid).toBe(true);
		expect(scene.unplaced).toEqual([]);
		expect(codes(scene, "error")).toEqual([]);
		expect(codes(scene, "warning")).toEqual([]);
		// The desk has its back to the north wall: front (-y) faces south.
		expect(placed(scene, "desk")?.yaw).toBe(0);
		// The chair, south of the desk, faces north.
		expect(placed(scene, "chair")).toMatchObject({
			yaw: 180,
			quaternion: [0, 0, 1, 0],
		});
		// Right-back as seen facing the desk's front: north-east corner, on top.
		expect(placed(scene, "lamp")).toMatchObject({
			position: [1.8, 4.9, 0.75],
			supportedBy: "desk",
			aabb: { min: [1.7, 4.8, 0.75], max: [1.9, 5, 1.25] },
		});
		expect(placed(scene, "laptop")?.position).toEqual([1.2, 4.425, 0.75]);
		// Around the table, each seat faces the center.
		expect(
			["seat_s", "seat_n", "seat_w", "seat_e"].map(
				(id) => placed(scene, id)?.yaw,
			),
		).toEqual([180, 0, 90, -90]);
		// The shelf against the east wall faces west.
		expect(placed(scene, "shelf")?.aabb).toEqual({
			min: [3.6, 2.8, 0],
			max: [4, 4.4, 2],
		});
	});

	it("reports every failed check on the broken scene", () => {
		const scene = solveFixture("study-broken");
		expect(scene.valid).toBe(false);
		expect(codes(scene, "error")).toEqual([
			"scene.yaw.conflict",
			"scene.out-of-bounds",
			"scene.support.unstable",
			"scene.collision",
			"scene.collision",
			"scene.collision",
			"scene.keep-clear",
		]);
		expect(codes(scene, "warning")).toEqual(["scene.support.overhang"]);
		const collisions = scene.diagnostics.filter(
			(diagnostic) => diagnostic.code === "scene.collision",
		);
		expect(collisions.map((d) => [d.objects, d.detail?.depth])).toEqual([
			[["desk", "chair"], 0.1],
			[["sofa", "table"], 0.1],
			[["sofa", "box"], 0.2],
		]);
	});

	it("draws the top views byte for byte", () => {
		for (const name of ["study-pinned", "study-broken"]) {
			const svg = sceneTopViewSvg(solveFixture(name));
			const golden = new URL(`${name}.top.svg`, FIXTURES);
			if (process.env.UPDATE_SCENE_GOLDEN === "1") {
				writeFileSync(golden, svg);
			}
			expect(svg).toBe(readFileSync(golden, "utf8"));
		}
	});

	it("is deterministic", () => {
		expect(JSON.stringify(solveFixture("study-pinned"))).toBe(
			JSON.stringify(solveFixture("study-pinned")),
		);
	});

	it("stacks supports and turns objects with them", () => {
		const scene = solve({
			objects: {
				desk: { size: [1.4, 0.7, 0.75], position: [1, 2], yaw: 90 },
				tray: { size: [0.4, 0.3, 0.05] },
				cup: { size: [0.1, 0.1, 0.1] },
			},
			relations: ["tray on desk, at right-back", "cup on tray"],
		});
		expect(scene.valid).toBe(true);
		// Turned 90°, the desk's front faces east; seen from the east its
		// right is north and its back west.
		expect(placed(scene, "tray")).toMatchObject({
			yaw: 90,
			position: [0.8, 2.5, 0.75],
			supportedBy: "desk",
		});
		expect(placed(scene, "cup")).toMatchObject({
			position: [0.8, 2.5, 0.8],
			supportedBy: "tray",
		});
	});

	it("faces compass directions with any front axis", () => {
		const scene = solve({
			objects: {
				a: { size: [1, 1, 1], position: [1, 1] },
				b: { size: [1, 1, 1], position: [3, 1], front: "+x" },
			},
			relations: ["a facing east", "b facing north"],
		});
		expect(placed(scene, "a")?.yaw).toBe(90);
		expect(placed(scene, "b")?.yaw).toBe(90);
	});

	it("reports support loops and two supports", () => {
		const loop = solve({
			objects: {
				a: { size: [1, 1, 1], position: [1, 1] },
				b: { size: [1, 1, 1] },
				c: { size: [1, 1, 1] },
			},
			relations: ["b on c", "c on b"],
		});
		expect(codes(loop)).toContain("scene.support.cycle");
		const two = solve({
			objects: {
				a: { size: [1, 1, 1], position: [1, 1] },
				b: { size: [1, 1, 1], position: [3, 1] },
				c: { size: [0.2, 0.2, 0.2] },
			},
			relations: ["c on a", "c on b"],
		});
		expect(two.diagnostics[0]).toMatchObject({
			code: "scene.support.multiple",
			path: ["relations", 1],
		});
		expect(placed(two, "c")?.supportedBy).toBe("a");
	});

	it("lists objects it cannot place yet", () => {
		const scene = solve({
			objects: {
				table: { size: [1, 1, 0.75] },
				seat: { size: [0.4, 0.4, 0.9], count: 2 },
				vase: { size: [0.1, 0.1, 0.3] },
			},
			relations: ["seat around table, radius 0.8", "vase on table"],
		});
		expect(scene.valid).toBe(true);
		expect(scene.objects).toEqual([]);
		expect(scene.unplaced).toEqual(["table", "seat1", "seat2", "vase"]);
		expect(codes(scene, "info")).toEqual([
			"scene.position.missing",
			"scene.position.missing",
			"scene.position.missing",
			"scene.position.missing",
			"scene.relation.unchecked",
		]);
	});

	it("warns under minGap only on the same surface", () => {
		const scene = solve({
			minGap: 0.1,
			objects: {
				a: { size: [1, 1, 1], position: [1, 1] },
				b: { size: [1, 1, 1], position: [2.05, 1] },
				c: { size: [0.2, 0.2, 0.2] },
			},
			relations: ["c on a, at right"],
		});
		expect(scene.valid).toBe(true);
		expect(
			scene.diagnostics
				.filter((d) => d.code === "scene.min-gap")
				.map((d) => d.objects),
		).toEqual([["a", "b"]]);
	});

	it("checks the ceiling", () => {
		const scene = solve({
			objects: {
				shelf: { size: [1, 0.4, 2], position: [1, 1] },
				box: { size: [0.5, 0.4, 0.6] },
			},
			relations: ["box on shelf"],
		});
		expect(codes(scene)).toEqual(["scene.above-ceiling"]);
	});
});
