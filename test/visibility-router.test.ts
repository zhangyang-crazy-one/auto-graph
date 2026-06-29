import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/ir/diagnostics.js";
import type { Box, Point } from "../src/ir/index.js";
import { filterObstaclesByCorridor } from "../src/routing/astar.js";
import { findCornerGraphPath } from "../src/routing/visibility-router.js";

/**
 * Returns true if any segment of `points` enters the INTERIOR of
 * `obstacle`. Tangent touches along the obstacle boundary are NOT
 * counted — a visibility-graph path that hugs an obstacle edge is
 * still considered obstacle-free.
 */
function routeEntersObstacle(points: readonly Point[], obstacle: Box): boolean {
	const left = obstacle.x;
	const right = obstacle.x + obstacle.width;
	const top = obstacle.y;
	const bottom = obstacle.y + obstacle.height;
	const strictlyInside = (p: Point): boolean =>
		p.x > left && p.x < right && p.y > top && p.y < bottom;
	const overlapsRange = (
		lo: number,
		hi: number,
		a: number,
		b: number,
	): boolean => {
		const min = Math.min(a, b);
		const max = Math.max(a, b);
		return max > lo && min < hi;
	};
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (a === undefined || b === undefined) continue;
		if (strictlyInside(a) || strictlyInside(b)) return true;
		if (a.x === b.x) {
			if (a.x > left && a.x < right && overlapsRange(top, bottom, a.y, b.y)) {
				return true;
			}
		} else if (a.y === b.y) {
			if (a.y > top && a.y < bottom && overlapsRange(left, right, a.x, b.x)) {
				return true;
			}
		}
	}
	return false;
}

describe("findCornerGraphPath", () => {
	it("routes source/target whose coordinates are NOT aligned with any obstacle corner", () => {
		// Obstacle at integer coordinates; source.x is NOT aligned
		// with any obstacle edge. The Steiner-point extension must
		// add projections so the router can leave source/target
		// perpendicular to an obstacle edge.
		const obstacle: Box = { x: 100, y: 100, width: 80, height: 80 };
		const source: Point = { x: 143, y: 40 };
		const target: Point = { x: 280, y: 200 };

		const path = findCornerGraphPath(source, target, [obstacle]);

		expect(path).not.toBeNull();
		if (path === null) return;
		expect(path.length).toBeGreaterThanOrEqual(2);
		expect(path[0]).toEqual(source);
		expect(path[path.length - 1]).toEqual(target);
		expect(routeEntersObstacle(path, obstacle)).toBe(false);
	});

	it("produces a path that goes around a simple obstacle between source and target", () => {
		// Source to the left of the obstacle, target to the right,
		// both at the same y. The obstacle blocks the straight
		// horizontal connection, so the router must produce a path
		// with at least one bend.
		const obstacle: Box = { x: 150, y: 90, width: 60, height: 60 };
		const source: Point = { x: 40, y: 120 };
		const target: Point = { x: 280, y: 120 };

		const path = findCornerGraphPath(source, target, [obstacle]);

		expect(path).not.toBeNull();
		if (path === null) return;
		expect(path.length).toBeGreaterThanOrEqual(3);
		expect(path[0]).toEqual(source);
		expect(path[path.length - 1]).toEqual(target);
		// Every segment is horizontal or vertical (orthogonal).
		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i] as Point;
			const b = path[i + 1] as Point;
			expect(a.x === b.x || a.y === b.y).toBe(true);
		}
		expect(routeEntersObstacle(path, obstacle)).toBe(false);
	});

	it("returns direct source-to-target when there are no obstacles", () => {
		const source: Point = { x: 0, y: 0 };
		const target: Point = { x: 100, y: 100 };

		const path = findCornerGraphPath(source, target, []);

		expect(path).not.toBeNull();
		if (path === null) return;
		expect(path[0]).toEqual(source);
		expect(path[path.length - 1]).toEqual(target);
	});

	it("emits corner_overflow diagnostic when vertex count exceeds maxCorners", () => {
		// 20 obstacles → 80 corner vertices + many Steiner projections
		// will exceed a tiny maxCorners cap.
		const obstacles: Box[] = [];
		for (let i = 0; i < 20; i++) {
			obstacles.push({
				x: 200 + (i % 5) * 100,
				y: 100 + Math.floor(i / 5) * 100,
				width: 40,
				height: 40,
			});
		}
		const diagnostics: Diagnostic[] = [];
		const path = findCornerGraphPath(
			{ x: 50, y: 50 },
			{ x: 1500, y: 50 },
			obstacles,
			{ maxCorners: 5 },
			diagnostics,
		);

		expect(path).toBeNull();
		expect(
			diagnostics.some((d) => d.code === "routing.visibility.corner_overflow"),
		).toBe(true);
	});

	it("succeeds with corridor prefilter on dense obstacle sets that would otherwise overflow", () => {
		// 30 obstacles spread across a wide area — without corridor filter
		// the vertex count would exceed maxCorners=300.
		const obstacles: Box[] = [];
		for (let i = 0; i < 30; i++) {
			obstacles.push({
				x: 50 + (i % 6) * 150,
				y: 50 + Math.floor(i / 6) * 150,
				width: 60,
				height: 60,
			});
		}
		const source: Point = { x: 0, y: 400 };
		const target: Point = { x: 200, y: 400 };

		// Without corridor filter: likely overflow at maxCorners=300.
		const diagsRaw: Diagnostic[] = [];
		findCornerGraphPath(
			source,
			target,
			obstacles,
			{ maxCorners: 300 },
			diagsRaw,
		);

		// With corridor filter: only local obstacles remain.
		const filtered = filterObstaclesByCorridor(
			source,
			target,
			obstacles,
			[],
			32,
		);
		const diagsFiltered: Diagnostic[] = [];
		const filteredPath = findCornerGraphPath(
			source,
			target,
			filtered,
			{ maxCorners: 300 },
			diagsFiltered,
		);

		// Corridor filter should reduce obstacle count significantly.
		expect(filtered.length).toBeLessThan(obstacles.length);
		// The filtered route must NOT overflow — that is the whole point of
		// corridor prefiltering. Assert it directly so a regression that
		// reintroduces overflow fails here instead of silently skipping the
		// path assertions below (Codex P3).
		const overflowed = diagsFiltered.some(
			(d) => d.code === "routing.visibility.corner_overflow",
		);
		expect(overflowed).toBe(false);
		expect(filteredPath).not.toBeNull();
		if (filteredPath === null) return;
		expect(filteredPath[0]).toEqual(source);
		expect(filteredPath[filteredPath.length - 1]).toEqual(target);
	});

	it("filterObstaclesByCorridor retains only obstacles intersecting the corridor", () => {
		const source: Point = { x: 0, y: 100 };
		const target: Point = { x: 200, y: 100 };
		const margin = 32;

		const inside: Box = { x: 80, y: 80, width: 40, height: 40 };
		const outside: Box = { x: 500, y: 500, width: 40, height: 40 };
		const edgeCase: Box = { x: 190, y: 60, width: 50, height: 50 }; // overlaps corridor

		const result = filterObstaclesByCorridor(
			source,
			target,
			[inside, outside, edgeCase],
			[],
			margin,
		);

		expect(result).toContain(inside);
		expect(result).not.toContain(outside);
		expect(result).toContain(edgeCase);
	});
});
