import { describe, expect, it } from "vitest";
import {
	parseSceneDsl,
	sceneDocumentSchema,
	sceneToJson,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";

// #158: a line with a width is a strip on the ground (a road); objects on
// the floor keep off it.
function solve(lines: string[]) {
	const parsed = parseSceneDsl(lines.join("\n"));
	expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
	if (parsed.scene === undefined) throw new Error("does not parse");
	return solveScene(parsed.scene);
}

const ROOM = ["scene: yard", "bounds: { width: 40, depth: 20 }"];
const ROAD = ["lines:", "  road: { points: [[0, 10], [40, 10]], width: 6 }"];

describe("lines with a width (#158)", () => {
	it("reports a building pinned on a road", () => {
		const scene = solve([
			...ROOM,
			...ROAD,
			"objects:",
			"  shed: { size: [8, 6, 3], position: [20, 13] }",
		]);
		const overlap = scene.diagnostics.find(
			(d) => d.code === "scene.line.overlap",
		);
		expect(overlap).toMatchObject({
			severity: "error",
			objects: ["shed"],
			detail: { line: "road", depth: 3 },
		});
		expect(scene.valid).toBe(false);
	});

	it("leaves a line without a width alone", () => {
		const scene = solve([
			...ROOM,
			"lines:",
			"  road: { points: [[0, 10], [40, 10]] }",
			"objects:",
			"  shed: { size: [8, 6, 3], position: [20, 13] }",
		]);
		expect(scene.diagnostics.map((d) => d.code)).not.toContain(
			"scene.line.overlap",
		);
		expect(scene.valid).toBe(true);
	});

	it("covers the corners of a bent road", () => {
		const scene = solve([
			...ROOM,
			"lines:",
			"  road: { points: [[0, 4], [20, 4], [20, 20]], width: 4 }",
			"objects:",
			// Just outside the bend's outer corner along both legs' edges,
			// but on the strip's corner square.
			"  post: { size: [0.4, 0.4, 1], position: [21.9, 2.1] }",
		]);
		expect(scene.diagnostics.map((d) => d.code)).toContain(
			"scene.line.overlap",
		);
	});

	it("moves a free object off the road", () => {
		const scene = solve([
			...ROOM,
			...ROAD,
			"objects:",
			"  crate: { size: [2, 2, 1] }",
		]);
		const crate = scene.objects.find((item) => item.id === "crate");
		expect(scene.valid).toBe(true);
		expect(scene.diagnostics.map((d) => d.code)).toContain("scene.line.moved");
		const [, y] = crate?.position ?? [];
		// Clear of the 6 m strip round y = 10.
		expect(Math.abs((y as number) - 10)).toBeGreaterThanOrEqual(4 - 1e-6);
	});

	it("keeps terrain-limited objects off the road when it moves them", () => {
		// Steep up to y = 10, flat beyond: the pole must stand north of
		// y = 10, and off the 6 m road there.
		const heights = [100, 102, 105, 105, 105].map((h) =>
			Array.from({ length: 9 }, () => h),
		);
		const scene = solve([
			...ROOM,
			"terrain:",
			"  grid:",
			"    spacing: 5",
			"    heights:",
			...heights.map((row) => `      - [${row.join(", ")}]`),
			...ROAD,
			"objects:",
			"  mast: { size: [2, 2, 10], position: [5, 10] }",
			"  pole: { size: [1, 1, 6] }",
			"relations:",
			"  - pole slope below 5",
			"  - pole elevation above 104",
		]);
		const pole = scene.objects.find((item) => item.id === "pole");
		const [, y] = pole?.position ?? [];
		expect(y as number).toBeGreaterThanOrEqual(13.5 - 1e-6);
		expect(
			scene.diagnostics
				.filter((d) => d.code === "scene.line.overlap")
				.flatMap((d) => d.objects),
		).toEqual(["mast"]);
	});

	it("reports things placed along a road too close to it", () => {
		const close = solve([
			...ROOM,
			...ROAD,
			"objects:",
			"  lamp: { size: [0.4, 0.4, 6], count: 3 }",
			"relations:",
			"  - lamp along road, spacing 10, from 10, offset 2",
		]);
		expect(
			close.diagnostics.filter((d) => d.code === "scene.line.overlap"),
		).toHaveLength(3);
		const clear = solve([
			...ROOM,
			...ROAD,
			"objects:",
			"  lamp: { size: [0.4, 0.4, 6], count: 3 }",
			"relations:",
			"  - lamp along road, spacing 10, from 10, offset 3.5",
		]);
		expect(clear.valid).toBe(true);
	});

	it("writes the width to the JSON and draws it in the top view", () => {
		const scene = solve([
			...ROOM,
			...ROAD,
			"objects:",
			"  shed: { size: [4, 4, 3], position: [5, 3] }",
		]);
		const document = JSON.parse(sceneToJson(scene));
		expect(() => sceneDocumentSchema.parse(document)).not.toThrow();
		expect(document.lines[0]).toMatchObject({ id: "road", width: 6 });
		expect(sceneTopViewSvg(scene)).toMatch(
			/data-line="road"[^>]*stroke-width="/,
		);
	});

	it("rejects a width that is not positive", () => {
		const parsed = parseSceneDsl(
			[
				...ROOM,
				"lines:",
				"  road: { points: [[0, 10], [40, 10]], width: 0 }",
				"objects: {}",
			].join("\n"),
		);
		expect(parsed.scene).toBeUndefined();
	});
});
