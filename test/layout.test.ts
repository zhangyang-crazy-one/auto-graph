import { describe, expect, it } from "vitest";
import { intersectsAabb } from "../src/geometry/index.js";
import type { Box, DiagramDirection } from "../src/ir/index.js";
import {
	runComponentAwareDagreInitialLayout,
	runDagreInitialLayout,
} from "../src/layout/index.js";

const directions: DiagramDirection[] = ["TB", "LR", "BT", "RL"];

describe("dagre initial layout", () => {
	it.each(directions)("returns finite top-left boxes for %s", (direction) => {
		const result = runDagreInitialLayout({
			direction,
			nodes: [
				{ id: "a", size: { width: 80, height: 40 } },
				{ id: "b", size: { width: 100, height: 60 } },
			],
			edges: [{ id: "a-b", sourceId: "a", targetId: "b" }],
		});

		expect(result.diagnostics).toEqual([]);
		expect([...result.boxes.keys()].sort()).toEqual(["a", "b"]);
		for (const box of result.boxes.values()) {
			expect(Number.isFinite(box.x)).toBe(true);
			expect(Number.isFinite(box.y)).toBe(true);
			expect(Number.isFinite(box.width)).toBe(true);
			expect(Number.isFinite(box.height)).toBe(true);
		}
	});

	it("converts Dagre center coordinates to DGE top-left boxes", () => {
		const result = runDagreInitialLayout({
			direction: "TB",
			nodes: [{ id: "solo", size: { width: 80, height: 40 } }],
			edges: [],
			options: { marginx: 60, marginy: 40 },
		});

		expect(result.boxes.get("solo")).toEqual({
			x: 60,
			y: 40,
			width: 80,
			height: 40,
		});
	});

	it("rejects non-finite node dimensions before producing unsafe boxes", () => {
		const result = runDagreInitialLayout({
			direction: "LR",
			nodes: [{ id: "bad", size: { width: Number.NaN, height: 40 } }],
			edges: [],
		});

		expect(result.boxes.has("bad")).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "layout.node-size.invalid",
			}),
		);
	});

	it("packs disconnected Dagre components without overlap", () => {
		const result = runComponentAwareDagreInitialLayout({
			direction: "LR",
			nodes: [
				{ id: "a1", size: { width: 80, height: 40 } },
				{ id: "a2", size: { width: 80, height: 40 } },
				{ id: "b1", size: { width: 80, height: 40 } },
				{ id: "b2", size: { width: 80, height: 40 } },
			],
			edges: [
				{ id: "a1-a2", sourceId: "a1", targetId: "a2" },
				{ id: "b1-b2", sourceId: "b1", targetId: "b2" },
			],
		});

		expect(result.diagnostics).toEqual([]);
		expect(
			intersectsAabb(
				componentBounds(result.boxes, ["a1", "a2"]),
				componentBounds(result.boxes, ["b1", "b2"]),
			),
		).toBe(false);
		expect(result.boxes.get("a1")?.x).toBeLessThan(
			result.boxes.get("b1")?.x ?? 0,
		);
	});

	it("packs isolated nodes deterministically by id", () => {
		const first = runComponentAwareDagreInitialLayout({
			direction: "TB",
			nodes: [
				{ id: "z", size: { width: 80, height: 40 } },
				{ id: "a", size: { width: 80, height: 40 } },
				{ id: "m", size: { width: 80, height: 40 } },
			],
			edges: [],
		});
		const second = runComponentAwareDagreInitialLayout({
			direction: "TB",
			nodes: [
				{ id: "z", size: { width: 80, height: 40 } },
				{ id: "a", size: { width: 80, height: 40 } },
				{ id: "m", size: { width: 80, height: 40 } },
			],
			edges: [],
		});

		expect(first.boxes).toEqual(second.boxes);
		expect(first.boxes.get("a")?.y).toBeLessThan(first.boxes.get("m")?.y ?? 0);
		expect(first.boxes.get("m")?.y).toBeLessThan(first.boxes.get("z")?.y ?? 0);
		expect(
			intersectsAabb(
				componentBounds(first.boxes, ["a"]),
				componentBounds(first.boxes, ["m"]),
			),
		).toBe(false);
		expect(
			intersectsAabb(
				componentBounds(first.boxes, ["m"]),
				componentBounds(first.boxes, ["z"]),
			),
		).toBe(false);
	});
});

function componentBounds(
	boxes: ReadonlyMap<string, Box>,
	ids: readonly string[],
): Box {
	const componentBoxes = ids.map((id) => {
		const box = boxes.get(id);
		if (box === undefined) {
			throw new Error(`Expected box for ${id}`);
		}
		return box;
	});
	const minX = Math.min(...componentBoxes.map((box) => box.x));
	const minY = Math.min(...componentBoxes.map((box) => box.y));
	const maxX = Math.max(...componentBoxes.map((box) => box.x + box.width));
	const maxY = Math.max(...componentBoxes.map((box) => box.y + box.height));
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
