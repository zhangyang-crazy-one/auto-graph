import { describe, expect, it } from "vitest";
import type { DiagramDirection } from "../src/ir/index.js";
import { runDagreInitialLayout } from "../src/layout/index.js";

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
});
