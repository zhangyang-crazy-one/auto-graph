import { describe, expect, it } from "vitest";
import { computeArrowhead } from "../src/exporters/index.js";

describe("exporters", () => {
	it("computes arrowhead geometry from the final non-zero segment", () => {
		const arrowhead = computeArrowhead([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 20 },
		]);

		expect(arrowhead.tip).toEqual({ x: 10, y: 20 });
		expect(arrowhead.direction).toEqual({ x: 0, y: 1 });
		expect(arrowhead.left).toEqual({ x: 6, y: 10 });
		expect(arrowhead.right).toEqual({ x: 14, y: 10 });
	});

	it("throws when no non-zero segment exists", () => {
		expect(() =>
			computeArrowhead([
				{ x: 2, y: 3 },
				{ x: 2, y: 3 },
			]),
		).toThrow("Arrowhead requires at least one non-zero segment");
	});
});
