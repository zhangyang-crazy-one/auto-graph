import { describe, expect, it } from "vitest";
import {
	boxCenter,
	expandBox,
	intersectsAabb,
	normalizeInsets,
	unionBoxes,
	validateBox,
} from "../src/geometry/index.js";
import { stringifyCanonical } from "../src/serialization/index.js";

describe("box geometry", () => {
	it("normalizes uniform and side-specific insets", () => {
		expect(normalizeInsets(4)).toEqual({
			top: 4,
			right: 4,
			bottom: 4,
			left: 4,
		});
		expect(
			normalizeInsets({ top: 1, right: 2, bottom: 3, left: 4 }),
		).toEqual({
			top: 1,
			right: 2,
			bottom: 3,
			left: 4,
		});
	});

	it("computes box centers and expansions without mutating input", () => {
		const box = { x: 10, y: 20, width: 80, height: 40 };

		expect(boxCenter(box)).toEqual({ x: 50, y: 40 });
		expect(expandBox(box, 5)).toEqual({
			x: 5,
			y: 15,
			width: 90,
			height: 50,
		});
		expect(expandBox(box, { top: 1, right: 2, bottom: 3, left: 4 })).toEqual({
			x: 6,
			y: 19,
			width: 86,
			height: 44,
		});
		expect(box).toEqual({ x: 10, y: 20, width: 80, height: 40 });
	});

	it("unions boxes and serializes repeated output byte-identically", () => {
		const boxes = [
			{ x: 10, y: 20, width: 80, height: 40 },
			{ x: -5, y: 15, width: 20, height: 20 },
		];
		const output = unionBoxes(boxes);

		expect(output).toEqual({ x: -5, y: 15, width: 95, height: 45 });
		expect(stringifyCanonical(output)).toBe(stringifyCanonical(unionBoxes(boxes)));
		expect(() => unionBoxes([])).toThrow(/empty|box/i);
	});

	it("detects overlapping and edge-touching axis-aligned boxes", () => {
		const base = { x: 0, y: 0, width: 10, height: 10 };

		expect(intersectsAabb(base, { x: 5, y: 5, width: 10, height: 10 })).toBe(
			true,
		);
		expect(intersectsAabb(base, { x: 10, y: 0, width: 10, height: 10 })).toBe(
			true,
		);
		expect(intersectsAabb(base, { x: 11, y: 0, width: 10, height: 10 })).toBe(
			false,
		);
	});

	it("rejects non-finite boxes and negative dimensions", () => {
		const invalidBoxes = [
			{ x: Number.NaN, y: 0, width: 10, height: 10 },
			{ x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
			{ x: 0, y: 0, width: -1, height: 10 },
			{ x: 0, y: 0, width: 10, height: -1 },
		];

		for (const box of invalidBoxes) {
			expect(() => validateBox(box)).toThrow(TypeError);
		}
		expect(() => normalizeInsets(-1)).toThrow(TypeError);
	});
});
