import { describe, expect, it } from "vitest";
import { computeContainerGeometry } from "../src/geometry/index.js";
import { fitLabel } from "../src/labels/index.js";
import { stringifyCanonical } from "../src/serialization/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

const childBoxes = [
	{ x: 40, y: 50, width: 100, height: 60 },
	{ x: 180, y: 120, width: 80, height: 40 },
];

describe("container geometry", () => {
	it("computes container boxes from known child boxes and padding", () => {
		const geometry = computeContainerGeometry({
			id: "group-a",
			childBoxes,
			padding: 20,
		});

		expect(geometry.childBounds).toEqual({ x: 40, y: 50, width: 220, height: 110 });
		expect(geometry.box).toEqual({ x: 20, y: 30, width: 260, height: 150 });
		expect(geometry.contentBox).toEqual({ x: 40, y: 50, width: 220, height: 110 });
		expect(stringifyCanonical(geometry.box)).toBe(
			stringifyCanonical(computeContainerGeometry({ id: "group-a", childBoxes, padding: 20 }).box),
		);
	});

	it("reserves optional label header height and returns label layout unchanged", () => {
		const labelLayout = fitLabel(
			"Group",
			{
				font: { fontFamily: "Inter", fontSize: 16, lineHeight: 20 },
				padding: 4,
			},
			new DeterministicTextMeasurer(),
		);
		const geometry = computeContainerGeometry({
			id: "group-a",
			childBoxes,
			padding: 20,
			labelLayout,
		});

		expect(geometry.labelLayout).toBe(labelLayout);
		expect(geometry.box.y).toBe(2);
		expect(geometry.box.height).toBe(178);
		expect(geometry.contentBox.y).toBe(50);
	});

	it("applies minSize without moving or mutating child boxes", () => {
		const before = stringifyCanonical(childBoxes);
		const geometry = computeContainerGeometry({
			id: "group-a",
			childBoxes,
			padding: 20,
			minSize: { width: 400, height: 240 },
		});

		expect(geometry.box).toEqual({ x: 20, y: 30, width: 400, height: 240 });
		expect(geometry.childBounds).toEqual({ x: 40, y: 50, width: 220, height: 110 });
		expect(stringifyCanonical(childBoxes)).toBe(before);
	});

	it("computes anchors and obstacle box", () => {
		const geometry = computeContainerGeometry({
			id: "group-a",
			childBoxes,
			padding: 20,
			obstacleMargin: 5,
		});

		expect(geometry.anchors.map((anchor) => anchor.name).sort()).toEqual([
			"bottom",
			"bottom-left",
			"bottom-right",
			"center",
			"left",
			"right",
			"top",
			"top-left",
			"top-right",
		]);
		expect(geometry.obstacleBox).toEqual({ x: 15, y: 25, width: 270, height: 160 });
	});

	it("rejects invalid input", () => {
		expect(() =>
			computeContainerGeometry({ id: "empty", childBoxes: [], padding: 0 }),
		).toThrow(TypeError);
		expect(() =>
			computeContainerGeometry({
				id: "bad-box",
				childBoxes: [{ x: Number.NaN, y: 0, width: 10, height: 10 }],
				padding: 0,
			}),
		).toThrow(TypeError);
		expect(() =>
			computeContainerGeometry({ id: "bad-padding", childBoxes, padding: -1 }),
		).toThrow(TypeError);
		expect(() =>
			computeContainerGeometry({
				id: "bad-min-size",
				childBoxes,
				padding: 0,
				minSize: { height: Number.POSITIVE_INFINITY },
			}),
		).toThrow(TypeError);
	});
});
