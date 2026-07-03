import { describe, expect, it } from "vitest";
import { computeShapeGeometry } from "../src/geometry/index.js";
import type { Box } from "../src/ir/index.js";
import {
	resolveMaxCorners,
	resolveMaxNodes,
	routeEdge,
} from "../src/routing/index.js";

describe("routing budget", () => {
	it("scales automatic corner and grid budgets with corridor margin", () => {
		expect(
			resolveMaxCorners(undefined, { corridorMargin: 32, obstacleCount: 30 }),
		).toBe(600);
		expect(
			resolveMaxCorners("auto", { corridorMargin: 600, obstacleCount: 300 }),
		).toBe(3000);
		expect(
			resolveMaxNodes(undefined, { corridorMargin: 32, obstacleCount: 10 }),
		).toBe(4000);
		expect(
			resolveMaxNodes("auto", { corridorMargin: 600, obstacleCount: 40 }),
		).toBe(48000);
	});

	it("respects explicit routeEdge corner and grid budgets", () => {
		const result = routeEdge({
			kind: "obstacle-avoiding",
			direction: "LR",
			source: shape(0, 0),
			target: shape(500, 0),
			obstacles: denseObstacles(),
			corridorMargin: 600,
			maxCorners: 5,
			maxNodes: 10,
		});

		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "routing.visibility.corner_overflow" &&
					diagnostic.detail?.maxCorners === 5,
			),
		).toBe(true);
		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "routing.astar.grid_overflow" &&
					diagnostic.detail?.maxNodes === 10,
			),
		).toBe(true);
	});
});

function shape(x: number, y: number) {
	return computeShapeGeometry({
		shape: "rectangle",
		box: { x, y, width: 80, height: 40 },
	});
}

function denseObstacles(): Box[] {
	const obstacles: Box[] = [];
	for (let index = 0; index < 20; index += 1) {
		obstacles.push({
			x: 120 + (index % 5) * 70,
			y: -120 + Math.floor(index / 5) * 70,
			width: 36,
			height: 36,
		});
	}
	return obstacles;
}
