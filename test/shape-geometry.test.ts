import { describe, expect, it } from "vitest";
import {
	computeShapeGeometry,
	getEdgePort,
	type ShapeGeometry,
	type ShapeGeometryInput,
} from "../src/geometry/index.js";
import type { AnchorName } from "../src/ir/geometry.js";
import type { NodeShape } from "../src/ir/index.js";

const supportedShapes: NodeShape[] = [
	"rectangle",
	"rounded-rectangle",
	"ellipse",
	"diamond",
	"parallelogram",
	"hexagon",
	"cylinder",
];

const box = { x: 0, y: 0, width: 100, height: 60 };

describe("shape geometry", () => {
	it.each(supportedShapes)("computes anchors and obstacle box for %s", (shape) => {
		const geometry = computeShapeGeometry({
			shape,
			box,
			obstacleMargin: 5,
		});

		expect(geometry).toMatchObject({
			shape,
			box,
			center: { x: 50, y: 30 },
			obstacleBox: { x: -5, y: -5, width: 110, height: 70 },
		});
		expect(anchorNames(geometry)).toEqual([
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
	});

	it("computes rectangle ports by clipping toward the target", () => {
		const geometry = computeShapeGeometry({ shape: "rectangle", box });

		expect(getEdgePort(geometry, { x: 200, y: 30 })).toEqual({
			x: 100,
			y: 30,
		});
	});

	it("honors preferred anchors", () => {
		const geometry = computeShapeGeometry({ shape: "ellipse", box });

		expect(getEdgePort(geometry, { x: 200, y: 30 }, "top")).toEqual({
			x: 50,
			y: 0,
		});
	});

	it("returns finite deterministic ports for non-rectangular shapes", () => {
		for (const shape of supportedShapes.filter(
			(shape) => shape !== "rectangle" && shape !== "rounded-rectangle",
		)) {
			const geometry = computeShapeGeometry({ shape, box });
			const first = getEdgePort(geometry, { x: 200, y: -20 });
			const second = getEdgePort(geometry, { x: 200, y: -20 });

			expect(first).toEqual(second);
			expect(first.x).toBeGreaterThanOrEqual(box.x);
			expect(first.x).toBeLessThanOrEqual(box.x + box.width);
			expect(first.y).toBeGreaterThanOrEqual(box.y);
			expect(first.y).toBeLessThanOrEqual(box.y + box.height);
			expect(Number.isFinite(first.x)).toBe(true);
			expect(Number.isFinite(first.y)).toBe(true);
		}
	});

	it("rejects invalid inputs", () => {
		expect(() =>
			computeShapeGeometry({
				shape: "rectangle",
				box: { x: Number.NaN, y: 0, width: 100, height: 60 },
			}),
		).toThrow(TypeError);
		expect(() =>
			computeShapeGeometry({
				shape: "unsupported" as ShapeGeometryInput["shape"],
				box,
			}),
		).toThrow(TypeError);
	});
});

function anchorNames(geometry: ShapeGeometry): AnchorName[] {
	return geometry.anchors.map((anchor) => anchor.name).sort();
}
