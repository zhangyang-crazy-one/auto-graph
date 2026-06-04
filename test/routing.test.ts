import { describe, expect, it } from "vitest";
import { computeShapeGeometry, intersectsAabb } from "../src/geometry/index.js";
import type { Box, Point } from "../src/ir/index.js";
import { routeEdge, simplifyRoute } from "../src/routing/index.js";

describe("routing", () => {
	it("removes duplicate and collinear points while preserving semantic route order", () => {
		const points = simplifyRoute([
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 20, y: 0 },
			{ x: 20, y: 10 },
			{ x: 10, y: 10 },
		]);

		expect(points).toEqual([
			{ x: 0, y: 0 },
			{ x: 20, y: 0 },
			{ x: 20, y: 10 },
			{ x: 10, y: 10 },
		]);
	});

	it("routes straight edges through shape ports", () => {
		const result = routeEdge({
			kind: "straight",
			direction: "LR",
			source: shape(0, 0),
			target: shape(200, 0),
		});

		expect(result.points).toEqual([
			{ x: 80, y: 20 },
			{ x: 200, y: 20 },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("defaults to orthogonal routes with horizontal or vertical segments", () => {
		const result = routeEdge({
			direction: "TB",
			source: shape(0, 0),
			target: shape(140, 120),
		});

		expect(result.points.length).toBeGreaterThanOrEqual(3);
		for (let index = 0; index < result.points.length - 1; index += 1) {
			const a = result.points[index];
			const b = result.points[index + 1];
			expect(a?.x === b?.x || a?.y === b?.y).toBe(true);
		}
	});

	it("uses diagram direction to choose default source and target anchor polarity", () => {
		const result = routeEdge({
			direction: "LR",
			source: shape(0, 0),
			target: shape(200, 100),
		});

		expect(result.points.at(0)).toEqual({ x: 80, y: 20 });
		expect(result.points.at(-1)).toEqual({ x: 200, y: 120 });
	});

	it("selects vertical default anchors from relative geometry when anchors are omitted", () => {
		const result = routeEdge({
			direction: "LR",
			source: shape(0, 0),
			target: shape(20, 180),
		});

		expect(result.points.at(0)).toEqual({ x: 40, y: 40 });
		expect(result.points.at(-1)).toEqual({ x: 60, y: 180 });
	});

	it("preserves explicit anchors over auto-port selection", () => {
		const result = routeEdge({
			direction: "LR",
			source: shape(0, 0),
			target: shape(20, 180),
			sourceAnchor: "right",
			targetAnchor: "left",
		});

		expect(result.points.at(0)).toEqual({ x: 80, y: 20 });
		expect(result.points.at(-1)).toEqual({ x: 20, y: 200 });
	});

	it("rejects blocked candidates and chooses a later deterministic obstacle-free route", () => {
		const result = routeEdge({
			kind: "orthogonal",
			direction: "LR",
			source: shape(0, 0),
			target: shape(200, 100),
			obstacles: [{ x: 120, y: 35, width: 40, height: 20 }],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.points).toEqual([
			{ x: 80, y: 20 },
			{ x: 200, y: 20 },
			{ x: 200, y: 120 },
		]);
	});

	it("routes around formerly unavoidable soft obstacles with outer doglegs", () => {
		const obstacles = [
			{ x: 70, y: 10, width: 30, height: 30 },
			{ x: 100, y: 35, width: 80, height: 20 },
			{ x: 75, y: 60, width: 20, height: 80 },
			{ x: 100, y: 95, width: 80, height: 20 },
		];
		const result = routeEdge({
			direction: "LR",
			source: shape(0, 0),
			target: shape(200, 100),
			obstacles,
		});

		expect(result.diagnostics).toEqual([]);
		for (const obstacle of obstacles) {
			expect(routeIntersectsObstacle(result.points, obstacle)).toBe(false);
		}
	});

	it("returns a bounded fallback diagnostic when explicit anchors keep soft obstacles unavoidable", () => {
		const result = routeEdge({
			direction: "LR",
			source: shape(0, 0),
			target: shape(200, 100),
			sourceAnchor: "right",
			targetAnchor: "left",
			obstacles: [{ x: -40, y: -60, width: 360, height: 240 }],
		});

		expect(result.points.length).toBeGreaterThanOrEqual(2);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "routing.obstacle.unavoidable" }),
		);
	});

	it("routes around a blocking obstacle when an expanded orthogonal lane is available", () => {
		const obstacle = { x: 120, y: 20, width: 120, height: 120 };
		const result = routeEdge({
			kind: "orthogonal",
			direction: "LR",
			source: shape(0, 0),
			target: shape(300, 100),
			obstacles: [obstacle],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.points.at(0)?.x).toBeCloseTo(80);
		expect(result.points.at(-1)?.x).toBeCloseTo(300);
		expect(routeIntersectsObstacle(result.points, obstacle)).toBe(false);
	});

	it("uses hard obstacles when generating expanded orthogonal lanes", () => {
		const hardObstacle = { x: 120, y: 20, width: 120, height: 120 };
		const result = routeEdge({
			kind: "orthogonal",
			direction: "LR",
			source: shape(0, 0),
			target: shape(300, 100),
			hardObstacles: [hardObstacle],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.points.at(0)?.x).toBeCloseTo(80);
		expect(result.points.at(-1)?.x).toBeCloseTo(300);
		expect(routeIntersectsObstacle(result.points, hardObstacle)).toBe(false);
	});

	it("rejects straight routes that cross hard evidence obstacles", () => {
		const result = routeEdge({
			kind: "straight",
			direction: "LR",
			source: shape(0, 0),
			target: shape(300, 0),
			hardObstacles: [{ x: 120, y: 10, width: 80, height: 20 }],
		});

		expect(result.points).toEqual([
			{ x: 80, y: 20 },
			{ x: 300, y: 20 },
		]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.evidence.crossing_forbidden",
			}),
		);
	});

	it("does not reject diagonal straight routes by segment bounding-box overlap alone", () => {
		const result = routeEdge({
			kind: "straight",
			direction: "LR",
			source: shape(0, 0),
			target: shape(300, 200),
			hardObstacles: [{ x: 160, y: 120, width: 20, height: 20 }],
		});

		expect(result.points).toEqual([
			{ x: 80, y: 20 },
			{ x: 300, y: 220 },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("keeps fallback geometry when hard evidence obstacles block all orthogonal candidates", () => {
		const result = routeEdge({
			kind: "orthogonal",
			direction: "LR",
			source: shape(0, 0),
			target: shape(200, 100),
			hardObstacles: [{ x: 60, y: -80, width: 260, height: 260 }],
		});

		expect(result.points.length).toBeGreaterThanOrEqual(2);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.evidence.crossing_forbidden",
			}),
		);
	});
});

function shape(x: number, y: number) {
	return computeShapeGeometry({
		shape: "rectangle",
		box: { x, y, width: 80, height: 40 },
	});
}

function routeIntersectsObstacle(
	points: readonly Point[],
	obstacle: Box,
): boolean {
	for (let index = 0; index < points.length - 1; index += 1) {
		const a = points[index];
		const b = points[index + 1];
		if (a === undefined || b === undefined) {
			continue;
		}

		if (intersectsAabb(segmentBox(a, b), obstacle)) {
			return true;
		}
	}

	return false;
}

function segmentBox(a: Point, b: Point): Box {
	const minX = Math.min(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	return {
		x: minX,
		y: minY,
		width: Math.max(1, Math.abs(a.x - b.x)),
		height: Math.max(1, Math.abs(a.y - b.y)),
	};
}
