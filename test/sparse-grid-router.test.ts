import { describe, expect, it } from "vitest";
import type { Box, Point } from "../src/ir/index.js";
import { findSparseGridPath } from "../src/routing/sparse-grid-router.js";

function entersInterior(points: readonly Point[], box: Box): boolean {
	for (let index = 0; index + 1 < points.length; index += 1) {
		const a = points[index] as Point;
		const b = points[index + 1] as Point;
		if (
			Math.max(a.x, b.x) > box.x &&
			Math.min(a.x, b.x) < box.x + box.width &&
			Math.max(a.y, b.y) > box.y &&
			Math.min(a.y, b.y) < box.y + box.height
		) {
			return true;
		}
	}
	return false;
}

function isOrthogonal(points: readonly Point[]): boolean {
	return points.every((point, index) => {
		const next = points[index + 1];
		return next === undefined || point.x === next.x || point.y === next.y;
	});
}

describe("sparse grid router", () => {
	const sourceBox: Box = { x: 0, y: 0, width: 80, height: 40 };
	const targetBox: Box = { x: 600, y: 0, width: 80, height: 40 };
	const source = { x: 80, y: 20 };
	const target = { x: 600, y: 20 };

	it("routes around a wall between the endpoints", () => {
		const wall: Box = { x: 280, y: -200, width: 80, height: 400 };
		const path = findSparseGridPath(source, target, [wall], {
			sourceBox,
			targetBox,
		});
		expect(path).not.toBeNull();
		const points = path as Point[];
		expect(points[0]).toEqual(source);
		expect(points.at(-1)).toEqual(target);
		expect(isOrthogonal(points)).toBe(true);
		expect(entersInterior(points, wall)).toBe(false);
		// Leaves the source and enters the target along the flow.
		expect(points[1]?.y).toBe(source.y);
		expect(points.at(-2)?.y).toBe(target.y);
	});

	it("crosses a soft obstacle only when going around costs more", () => {
		const cheap: Box = { x: 280, y: 0, width: 80, height: 40 };
		const around = findSparseGridPath(source, target, [], {
			softObstacles: [cheap],
			sourceBox,
			targetBox,
		}) as Point[];
		expect(entersInterior(around, cheap)).toBe(false);
		const tall: Box = { x: 280, y: -2000, width: 80, height: 4000 };
		const through = findSparseGridPath(source, target, [], {
			softObstacles: [tall],
			sourceBox,
			targetBox,
		}) as Point[];
		expect(entersInterior(through, tall)).toBe(true);
	});

	it("returns null when the target is walled in", () => {
		const walls: Box[] = [
			{ x: 560, y: -60, width: 160, height: 20 },
			{ x: 560, y: 60, width: 160, height: 20 },
			{ x: 560, y: -60, width: 20, height: 140 },
			{ x: 720, y: -60, width: 20, height: 140 },
		];
		expect(
			findSparseGridPath(source, target, walls, { sourceBox, targetBox }),
		).toBeNull();
	});

	it("is deterministic", () => {
		const walls: Box[] = [
			{ x: 200, y: -100, width: 60, height: 180 },
			{ x: 400, y: -20, width: 60, height: 200 },
		];
		const first = findSparseGridPath(source, target, walls, {
			sourceBox,
			targetBox,
		});
		expect(
			findSparseGridPath(source, target, walls, { sourceBox, targetBox }),
		).toEqual(first);
	});
});
