import { describe, expect, it } from "vitest";
import type { Box, Point } from "../src/ir/index.js";
import {
	type GlobalLayoutInput,
	type GlobalLayoutResult,
	runGlobalLayout,
} from "../src/layout/index.js";

function node(id: string, width = 80, height = 40) {
	return { id, size: { width, height } };
}

function edges(...pairs: [string, string][]) {
	return pairs.map(([source, target], index) => ({
		id: `e${index}`,
		source,
		target,
	}));
}

function onBorder(point: Point, box: Box): boolean {
	const near = (a: number, b: number) => Math.abs(a - b) < 0.6;
	const within =
		point.x >= box.x - 0.6 &&
		point.x <= box.x + box.width + 0.6 &&
		point.y >= box.y - 0.6 &&
		point.y <= box.y + box.height + 0.6;
	return (
		within &&
		(near(point.x, box.x) ||
			near(point.x, box.x + box.width) ||
			near(point.y, box.y) ||
			near(point.y, box.y + box.height))
	);
}

function crossesInterior(a: Point, b: Point, box: Box): boolean {
	const inner = {
		x: box.x + 1,
		y: box.y + 1,
		width: box.width - 2,
		height: box.height - 2,
	};
	return (
		Math.max(a.x, b.x) > inner.x &&
		Math.min(a.x, b.x) < inner.x + inner.width &&
		Math.max(a.y, b.y) > inner.y &&
		Math.min(a.y, b.y) < inner.y + inner.height
	);
}

/** Every route: orthogonal, ends on its nodes, never through another node. */
function expectSoundRoutes(
	input: GlobalLayoutInput,
	result: GlobalLayoutResult,
): void {
	for (const edge of input.edges) {
		const route = result.routes.get(edge.id);
		expect(route, edge.id).toBeDefined();
		const points = route as Point[];
		expect(points.length).toBeGreaterThanOrEqual(2);
		for (let index = 0; index + 1 < points.length; index += 1) {
			const a = points[index] as Point;
			const b = points[index + 1] as Point;
			expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6).toBe(
				true,
			);
			for (const [id, box] of result.boxes) {
				if (id === edge.source || id === edge.target) continue;
				expect(crossesInterior(a, b, box), `${edge.id} through ${id}`).toBe(
					false,
				);
			}
		}
		expect(
			onBorder(points[0] as Point, result.boxes.get(edge.source) as Box),
		).toBe(true);
		expect(
			onBorder(points.at(-1) as Point, result.boxes.get(edge.target) as Box),
		).toBe(true);
	}
}

describe("channel routing", () => {
	it("routes long edges through their layer slots without crossing nodes", () => {
		const input: GlobalLayoutInput = {
			direction: "LR",
			nodes: ["a", "b", "c", "d", "e", "f"].map((id) => node(id)),
			edges: edges(
				["a", "b"],
				["b", "c"],
				["c", "d"],
				["a", "d"],
				["a", "e"],
				["e", "f"],
				["b", "f"],
			),
			options: { fold: false },
		};
		expectSoundRoutes(input, runGlobalLayout(input));
	});

	it("draws a chain as straight lines", () => {
		const input: GlobalLayoutInput = {
			direction: "TB",
			nodes: ["a", "b", "c"].map((id) => node(id)),
			edges: edges(["a", "b"], ["b", "c"]),
		};
		const result = runGlobalLayout(input);
		for (const route of result.routes.values()) expect(route).toHaveLength(2);
	});

	it("routes a back edge against the flow", () => {
		const input: GlobalLayoutInput = {
			direction: "LR",
			nodes: ["a", "b", "c"].map((id) => node(id)),
			edges: edges(["a", "b"], ["b", "c"], ["c", "a"]),
		};
		const result = runGlobalLayout(input);
		expectSoundRoutes(input, result);
		const back = result.routes.get("e2") as Point[];
		// Starts at c and ends at a.
		expect(onBorder(back[0] as Point, result.boxes.get("c") as Box)).toBe(true);
	});

	it("detours between two nodes of one layer with a node between them", () => {
		const input: GlobalLayoutInput = {
			direction: "LR",
			nodes: ["x", "p", "q", "r", "y"].map((id) => node(id)),
			edges: edges(["x", "p"], ["x", "q"], ["x", "r"], ["p", "y"], ["p", "r"]),
			swimlanes: [
				{
					id: "s",
					orientation: "horizontal",
					headerHeight: 24,
					padding: 12,
					lanes: [
						{ id: "l1", children: ["x", "p"] },
						{ id: "l2", children: ["q"] },
						{ id: "l3", children: ["r", "y"] },
					],
				},
			],
		};
		const result = runGlobalLayout(input);
		expectSoundRoutes(input, result);
	});

	it("wraps edges between folded bands", () => {
		const ids = Array.from({ length: 24 }, (_, index) => `n${index}`);
		const input: GlobalLayoutInput = {
			direction: "LR",
			nodes: ids.map((id) => node(id, 160, 40)),
			edges: edges(
				...ids
					.slice(1)
					.map((id, index) => [ids[index] as string, id] as [string, string]),
			),
		};
		const result = runGlobalLayout(input);
		expect(result.diagnostics.map((d) => d.code)).toContain(
			"layout.global.folded",
		);
		expectSoundRoutes(input, result);
	});

	it("is deterministic", () => {
		const input: GlobalLayoutInput = {
			direction: "LR",
			nodes: ["a", "b", "c", "d"].map((id) => node(id)),
			edges: edges(["a", "c"], ["b", "c"], ["a", "d"], ["b", "d"]),
		};
		expect([...runGlobalLayout(input).routes]).toEqual([
			...runGlobalLayout(input).routes,
		]);
	});
});
