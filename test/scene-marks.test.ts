import { Box3, type Mesh, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import {
	parseSceneDsl,
	sceneToBlenderScript,
	sceneToGlb,
	sceneToUsda,
	solveScene,
} from "../src/index.js";
import { sceneSource } from "./support/scene-files.js";

// #157: on a site a kilometre across, labels, pins and line markers were
// sized by the site (a 14 m label on a 4 m panel, a 36 m pin, a 7 m road
// tube) and buried what they mark.
const SITE = [
	"scene: campus",
	"bounds: { width: 1200, depth: 800 }",
	"frame:",
	"  origin: { lat: 40.55, lon: 115.2, alt: 1300 }",
	"landmarks:",
	"  gate: { lat: 40.5502, lon: 115.2004 }",
	"lines:",
	"  track: { points: [[20, 100], [600, 100]] }",
	"  road: { points: [[20, 300], [600, 300], [600, 700]], width: 6 }",
	"  survey: { points: [[50, 600], [1100, 600]] }",
	"waypoints:",
	"  scan: { line: survey, spacing: 100, height: 60 }",
	"objects:",
	"  hall: { size: [30, 18, 9], position: [100, 200] }",
	"  panel: { size: [4, 2, 0.1], position: [200, 200] }",
	"  lamp: { size: [0.4, 0.4, 8], position: [300, 200] }",
	"paths:",
	"  - person from hall to panel",
].join("\n");

function solved(source: string) {
	const parsed = parseSceneDsl(source);
	if (parsed.scene === undefined) throw new Error("does not parse");
	return solveScene(parsed.scene);
}

function marksOf(script: string) {
	const line = script.split("\n").find((row) => row.startsWith("MARKS = "));
	expect(line, "MARKS in the Blender script").toBeDefined();
	return JSON.parse(
		JSON.parse((line ?? "").slice("MARKS = json.loads(".length, -1)),
	);
}

function byExtra(root: Object3D, key: string, value: string): Object3D {
	let found: Object3D | undefined;
	root.traverse((node) => {
		if (found === undefined && node.userData[key] === value) found = node;
	});
	if (found === undefined) throw new Error(`no ${key} ${value}`);
	return found;
}

describe("marks follow the objects on a large site (#157)", () => {
	const scene = solved(SITE);

	it("keeps every label within its object and caps pins and markers", () => {
		const marks = marksOf(sceneToBlenderScript(scene));
		for (const item of scene.objects) {
			const side = Math.min(item.size[0], item.size[1]);
			expect(marks.labels[item.id], item.id).toBeLessThanOrEqual(
				Math.max(0.08, side * 0.3) + 1e-9,
			);
		}
		expect(marks.pin.height).toBeLessThanOrEqual(6);
		expect(marks.pin.radius).toBeLessThanOrEqual(0.3);
		expect(marks.line).toBeLessThanOrEqual(0.3);
		expect(marks.waypoint).toBeLessThanOrEqual(1);
		for (const path of scene.paths) {
			expect(marks.paths[path.id]).toBeLessThanOrEqual(path.width / 4);
		}
	});

	it("keeps room-sized scenes as they were", () => {
		const marks = marksOf(sceneToBlenderScript(solved(sceneSource("study"))));
		// max(0.08, min(0.18, side · 0.3)), as before.
		expect(marks.labels.desk).toBe(0.18);
		expect(marks.labels.lamp).toBe(0.08);
	});

	it("caps the glTF landmark pin and lays the road as its surface", async () => {
		const glb = sceneToGlb(scene);
		const buffer = glb.buffer.slice(
			glb.byteOffset,
			glb.byteOffset + glb.byteLength,
		) as ArrayBuffer;
		const gltf = await new GLTFLoader().parseAsync(buffer, "");
		gltf.scene.updateMatrixWorld(true);
		const pin = new Box3().setFromObject(
			byExtra(gltf.scene, "dge_landmark", "gate"),
			true,
		);
		// y is up in glTF.
		expect(pin.max.y - pin.min.y).toBeLessThanOrEqual(6 + 1e-6);
		const road = byExtra(gltf.scene, "dge_line", "road") as Mesh;
		expect(road.isMesh).toBe(true);
		expect(road.geometry.index?.count ?? 0).toBeGreaterThan(0);
		const bounds = new Box3().setFromObject(road, true);
		// The strip spans x 20…603 (the bend's outer corner, half the width
		// past 600) and scene y 297…700.
		expect(bounds.min.x).toBeCloseTo(20, 4);
		expect(bounds.max.x).toBeCloseTo(603, 4);
		expect(-bounds.max.z).toBeCloseTo(297, 4);
	});

	it("caps the USD curve widths and lays the road as its surface", () => {
		const usda = sceneToUsda(scene);
		const widths = [...usda.matchAll(/float\[\] widths = \[([\d.e-]+)\]/g)].map(
			(match) => Number(match[1]),
		);
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) expect(width).toBeLessThanOrEqual(2);
		expect(usda).toMatch(/custom (int|double) userProperties:dge_width = 6\n/);
		expect(usda).toContain('def Mesh "surface"');
	});
});
