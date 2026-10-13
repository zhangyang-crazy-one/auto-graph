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

type Solved = ReturnType<typeof solveScene>;

/** World-axis boxes of two placed objects are apart (touching allowed). */
function apart(scene: Solved, a: string, b: string): boolean {
	const pa = scene.objects.find((object) => object.id === a);
	const pb = scene.objects.find((object) => object.id === b);
	if (pa === undefined || pb === undefined) return false;
	return [0, 1].some(
		(k) =>
			(pa.aabb.max[k] as number) <= (pb.aabb.min[k] as number) + 1e-4 ||
			(pb.aabb.max[k] as number) <= (pa.aabb.min[k] as number) + 1e-4,
	);
}

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
		// Pinned seats listed counter-clockwise from the south hold `around`.
		expect(codes(scene, "error")).toEqual([]);
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
		for (const name of [
			"study-pinned",
			"study-broken",
			"study",
			"meeting",
			"showroom",
		]) {
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

describe("scene layout from relations", () => {
	it("places the #119 study from relations alone", () => {
		const scene = solveFixture("study");
		expect(scene.valid).toBe(true);
		expect(scene.diagnostics).toEqual([]);
		expect(placed(scene, "desk")).toMatchObject({
			position: [2, 4.65, 0],
			yaw: 0,
		});
		// In front of the desk (south), 0.1 m clear of it, facing it.
		expect(placed(scene, "chair")).toMatchObject({
			position: [2, 3.95, 0],
			yaw: 180,
		});
		expect(placed(scene, "lamp")?.position).toEqual([2.6, 4.9, 0.75]);
		expect(placed(scene, "table")?.position).toEqual([2, 2.5, 0]);
		// Counter-clockwise from the south, 0.9 m from the table, facing it.
		expect(
			["seat1", "seat2", "seat3", "seat4"].map((id) => [
				placed(scene, id)?.position.slice(0, 2),
				placed(scene, id)?.yaw,
			]),
		).toEqual([
			[[2, 1.6], 180],
			[[2.9, 2.5], -90],
			[[2, 3.4], 0],
			[[1.1, 2.5], 90],
		]);
	});

	it("spreads objects that share a side and faces the side of a long table", () => {
		const scene = solveFixture("meeting");
		expect(scene.valid).toBe(true);
		expect(
			["chair1", "chair2", "chair3", "chair4", "chair5", "chair6"].map((id) => [
				placed(scene, id)?.position.slice(0, 2),
				placed(scene, id)?.yaw,
			]),
		).toEqual([
			[[2.4, 1.25], 180],
			[[3, 1.25], 180],
			[[3.6, 1.25], 180],
			[[2.4, 3.25], 0],
			[[3, 3.25], 0],
			[[3.6, 3.25], 0],
		]);
		// The credenza's back is to the west wall: seen from the east, its
		// left is south.
		expect(placed(scene, "plant1")?.position).toEqual([0.225, 1.15, 0]);
		expect(placed(scene, "plant2")?.position).toEqual([0.225, 3.35, 0]);
		expect(placed(scene, "screen")).toMatchObject({
			position: [5.95, 2.25, 0],
			yaw: -90,
		});
	});

	it("lays out grids, rows along a wall, corners and mirror pairs", () => {
		const scene = solveFixture("showroom");
		expect(scene.valid).toBe(true);
		expect(
			["plinth1", "plinth2", "plinth3", "plinth4"].map((id) =>
				placed(scene, id)?.position.slice(0, 2),
			),
		).toEqual([
			[2.2, 3.9],
			[4, 3.9],
			[5.8, 3.9],
			[2.2, 2.1],
		]);
		expect(
			["bench1", "bench2", "bench3"].map((id) =>
				placed(scene, id)?.position.slice(0, 2),
			),
		).toEqual([
			[1.6, 0.25],
			[4, 0.25],
			[6.4, 0.25],
		]);
		expect(placed(scene, "reception")?.position).toEqual([6.7, 5.25, 0]);
		const a = placed(scene, "kiosk_a")?.position ?? [];
		const b = placed(scene, "kiosk_b")?.position ?? [];
		expect((a[0] ?? 0) + (b[0] ?? 0)).toBeCloseTo(8, 4);
		expect(a[1]).toBe(b[1]);
	});

	it("follows a turned reference", () => {
		const scene = solve({
			objects: {
				desk: { size: [1.4, 0.7, 0.75] },
				chair: { size: [0.5, 0.5, 0.9] },
				bin: { size: [0.3, 0.3, 0.4] },
			},
			relations: [
				"desk against wall east",
				"chair in-front-of desk, gap 0.2",
				"bin right-of desk",
			],
		});
		expect(scene.valid).toBe(true);
		// Back to the east wall: the desk faces west, the chair is west of
		// it; seen from the west (looking east), the desk's right is south.
		expect(placed(scene, "desk")).toMatchObject({ yaw: -90 });
		const desk = placed(scene, "desk")?.position ?? [];
		expect(placed(scene, "chair")?.position).toEqual([2.85, desk[1], 0]);
		expect(placed(scene, "bin")?.position.slice(0, 2)).toEqual([
			3.65,
			(desk[1] ?? 0) - 0.7 - 0.15,
		]);
	});

	it("keeps unconstrained objects apart and inside", () => {
		const scene = solve({
			minGap: 0.1,
			objects: { box: { size: [0.8, 0.6, 0.5], count: 8 } },
		});
		expect(scene.valid).toBe(true);
		const ids = scene.objects.map((object) => object.id);
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				expect(apart(scene, ids[i] as string, ids[j] as string)).toBe(true);
			}
		}
	});

	it("reports relations that cannot hold together", () => {
		const scene = solve({
			objects: { a: { size: [1, 1, 1] } },
			relations: ["a center-of room", "a corner ne"],
		});
		expect(scene.valid).toBe(false);
		expect(codes(scene)).toContain("scene.layout.conflict");
		expect(
			scene.diagnostics.find((d) => d.code === "scene.layout.conflict"),
		).toMatchObject({ objects: ["a"] });

		const narrow = solve({
			objects: { long: { size: [5, 1, 1] } },
			relations: ["long against wall west"],
		});
		expect(narrow.valid).toBe(false);
		expect(codes(narrow)).toContain("scene.out-of-bounds");
	});

	it("aligns, centers on objects and distributes along an axis", () => {
		const scene = solve({
			objects: {
				a: { size: [1, 1, 1] },
				b: { size: [0.5, 0.5, 0.5] },
				c: { size: [0.4, 0.4, 0.4] },
				row: { size: [0.5, 0.5, 0.5], count: 3 },
			},
			relations: [
				"a corner sw",
				"b align x with a",
				"b against wall north",
				"row distribute evenly along x",
				"c center-of a",
			],
		});
		expect(placed(scene, "b")?.position.slice(0, 2)).toEqual([0.5, 3.75]);
		expect(placed(scene, "c")?.position).toEqual([0.5, 0.5, 0]);
		expect(codes(scene)).toContain("scene.collision");
		const xs = ["row1", "row2", "row3"].map(
			(id) => placed(scene, id)?.position[0],
		);
		expect(xs).toEqual([0.875, 2, 3.125]);
	});

	it("does not apply floor relations to objects on supports", () => {
		const scene = solve({
			objects: {
				desk: { size: [1.4, 0.7, 0.75] },
				lamp: { size: [0.2, 0.2, 0.5] },
				chair: { size: [0.5, 0.5, 0.9] },
			},
			relations: ["lamp on desk", "chair in-front-of lamp"],
		});
		expect(codes(scene, "warning")).toEqual(["scene.relation.off-floor"]);
	});
});
