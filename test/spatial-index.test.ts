import { describe, expect, it } from "vitest";
import {
	createBoxSpatialIndex,
	queryBoxSpatialIndex,
	querySegmentSpatialIndex,
} from "../src/geometry/index.js";

describe("box spatial index", () => {
	it("returns only boxes intersecting a query box", () => {
		const index = createBoxSpatialIndex(
			[
				{ id: "near", box: { x: 0, y: 0, width: 40, height: 40 } },
				{ id: "far", box: { x: 1_000, y: 1_000, width: 40, height: 40 } },
				{ id: "negative", box: { x: -100, y: -50, width: 20, height: 20 } },
			],
			64,
		);

		expect(
			queryBoxSpatialIndex(index, {
				x: -10,
				y: -10,
				width: 80,
				height: 80,
			}).map((entry) => entry.id),
		).toEqual(["near"]);
		expect(
			queryBoxSpatialIndex(index, {
				x: -120,
				y: -80,
				width: 60,
				height: 60,
			}).map((entry) => entry.id),
		).toEqual(["negative"]);
	});

	it("returns deterministic segment candidates across negative cells", () => {
		const index = createBoxSpatialIndex(
			[
				{ id: "b", box: { x: -50, y: -10, width: 20, height: 20 } },
				{ id: "a", box: { x: 20, y: -10, width: 20, height: 20 } },
				{ id: "miss", box: { x: 20, y: 100, width: 20, height: 20 } },
			],
			32,
		);

		expect(
			querySegmentSpatialIndex(index, { x: -80, y: 0 }, { x: 80, y: 0 }).map(
				(entry) => entry.id,
			),
		).toEqual(["a", "b"]);
	});
});
