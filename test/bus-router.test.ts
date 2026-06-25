import { describe, expect, it } from "vitest";
import { computeFanOutPorts } from "../src/routing/bus-router.js";

describe("bus-router", () => {
	it("returns single centered anchor for a lone edge", () => {
		const result = computeFanOutPorts(
			["e1"],
			{ x: 0, y: 0, width: 80, height: 40 },
			"bottom",
			8,
		);
		expect(result.get("e1")?.anchor).toEqual({ x: 40, y: 40 });
	});

	it("fans out two edges along bottom edge", () => {
		const result = computeFanOutPorts(
			["e1", "e2"],
			{ x: 0, y: 0, width: 80, height: 40 },
			"bottom",
			8,
		);
		const a1 = result.get("e1")?.anchor;
		const a2 = result.get("e2")?.anchor;
		expect(a1).toBeDefined();
		expect(a2).toBeDefined();
		expect(a1!.y).toBe(40);
		expect(a2!.y).toBe(40);
		// e1 left of center, e2 right of center
		expect(a1!.x).toBeLessThan(a2!.x);
		expect(Math.abs(a2!.x - a1!.x)).toBe(8);
	});

	it("fans out along right edge (vertical spread)", () => {
		const result = computeFanOutPorts(
			["a", "b", "c"],
			{ x: 0, y: 0, width: 80, height: 100 },
			"right",
			12,
		);
		const a = result.get("a")?.anchor;
		const b = result.get("b")?.anchor;
		const c = result.get("c")?.anchor;
		expect(a!.x).toBe(80);
		expect(b!.x).toBe(80);
		expect(c!.x).toBe(80);
		// Spread along y: a above b above c
		expect(a!.y).toBeLessThan(b!.y);
		expect(b!.y).toBeLessThan(c!.y);
		expect(b!.y - a!.y).toBe(12);
	});

	it("fans out along top edge (horizontal spread)", () => {
		const result = computeFanOutPorts(
			["e1", "e2", "e3"],
			{ x: 10, y: 20, width: 80, height: 40 },
			"top",
			10,
		);
		const a1 = result.get("e1")?.anchor;
		const a2 = result.get("e2")?.anchor;
		const a3 = result.get("e3")?.anchor;
		expect(a1!.y).toBe(20);
		expect(a2!.y).toBe(20);
		expect(a3!.y).toBe(20);
		// Spread horizontally
		expect(a1!.x).toBeLessThan(a2!.x);
		expect(a2!.x).toBeLessThan(a3!.x);
		expect(a2!.x - a1!.x).toBe(10);
	});

	it("fans out along left edge (vertical spread)", () => {
		const result = computeFanOutPorts(
			["e1", "e2"],
			{ x: 10, y: 20, width: 80, height: 40 },
			"left",
			8,
		);
		const a1 = result.get("e1")?.anchor;
		const a2 = result.get("e2")?.anchor;
		expect(a1!.x).toBe(10);
		expect(a2!.x).toBe(10);
		expect(a1!.y).toBeLessThan(a2!.y);
		expect(a2!.y - a1!.y).toBe(8);
	});

	it("clamps anchors when fan-out span exceeds node width", () => {
		// 10 edges with spacing=8 on a node of width=40
		// totalSpan = 9*8 = 72, which exceeds node width (40)
		const nodeBox = { x: 0, y: 0, width: 40, height: 40 };
		const result = computeFanOutPorts(
			["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"],
			nodeBox,
			"bottom",
			8,
		);
		const minX = nodeBox.x;
		const maxX = nodeBox.x + nodeBox.width;
		for (const id of ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"]) {
			const anchor = result.get(id)?.anchor;
			expect(anchor).toBeDefined();
			expect(anchor!.x).toBeGreaterThanOrEqual(minX);
			expect(anchor!.x).toBeLessThanOrEqual(maxX);
		}
	});
});
