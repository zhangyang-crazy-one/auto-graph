import { describe, expect, it } from "vitest";
import type { Point } from "../src/ir/index.js";
import { networkSimplexLayers, runGlobalLayout } from "../src/layout/index.js";

function totalLength(
	layers: ReadonlyMap<string, number>,
	edges: readonly { source: string; target: string }[],
): number {
	return edges.reduce(
		(sum, edge) =>
			sum + (layers.get(edge.target) ?? 0) - (layers.get(edge.source) ?? 0),
		0,
	);
}

describe("network simplex layering", () => {
	it("shortens edges that longest-path layering leaves long", () => {
		// x has one early predecessor and two late successors: longest path
		// puts it right after s (edges of length 1 + 3 + 3), the optimum
		// right before d1/d2 (3 + 1 + 1).
		const nodes = ["s", "c1", "c2", "c3", "d1", "d2", "x"];
		const edges = [
			{ source: "s", target: "c1" },
			{ source: "c1", target: "c2" },
			{ source: "c2", target: "c3" },
			{ source: "c3", target: "d1" },
			{ source: "c3", target: "d2" },
			{ source: "s", target: "x" },
			{ source: "x", target: "d1" },
			{ source: "x", target: "d2" },
		];
		const longest = new Map([
			["s", 0],
			["c1", 1],
			["c2", 2],
			["c3", 3],
			["d1", 4],
			["d2", 4],
			["x", 1],
		]);
		const layers = networkSimplexLayers(nodes, edges, longest);
		for (const edge of edges) {
			expect(
				(layers.get(edge.target) ?? 0) - (layers.get(edge.source) ?? 0),
			).toBeGreaterThanOrEqual(1);
		}
		expect(totalLength(longest, edges)).toBe(12);
		expect(totalLength(layers, edges)).toBe(10);
		expect(layers.get("x")).toBe(3);
	});

	it("pulls a sink fed by a skip edge next to its other predecessors", () => {
		const nodes = ["s", "m1", "m2", "m3", "t"];
		const edges = [
			{ source: "s", target: "m1" },
			{ source: "m1", target: "m2" },
			{ source: "m2", target: "m3" },
			{ source: "m3", target: "t" },
			{ source: "s", target: "t" },
		];
		const start = new Map([
			["s", 0],
			["m1", 1],
			["m2", 2],
			["m3", 3],
			["t", 4],
		]);
		// Already optimal: the chain fixes the span, nothing moves.
		expect(networkSimplexLayers(nodes, edges, start)).toEqual(start);
	});
});

function bends(points: readonly Point[]): number {
	return Math.max(0, points.length - 2);
}

describe("straight long edges", () => {
	it("draws an edge skipping several layers as one straight run", () => {
		// a → b → c → d → e, plus a → e across three layers, with side nodes
		// pulling the chain around.
		const ids = ["a", "b", "c", "d", "e", "p", "q"];
		const pairs: [string, string][] = [
			["a", "b"],
			["b", "c"],
			["c", "d"],
			["d", "e"],
			["a", "e"],
			["p", "c"],
			["c", "q"],
		];
		const result = runGlobalLayout({
			direction: "LR",
			nodes: ids.map((id) => ({ id, size: { width: 80, height: 40 } })),
			edges: pairs.map(([source, target], index) => ({
				id: `e${index}`,
				source,
				target,
			})),
			options: { fold: false },
		});
		const skip = result.routes.get("e4") as Point[];
		// At most one jog out of a and one into e.
		expect(bends(skip)).toBeLessThanOrEqual(4);
		// The middle of the route is one straight horizontal run.
		const horizontal = skip
			.slice(1)
			.map((point, index) => [skip[index] as Point, point] as const)
			.filter(([from, to]) => Math.abs(from.y - to.y) < 1e-6)
			.map(([from, to]) => Math.abs(to.x - from.x));
		const span =
			(result.boxes.get("e")?.x ?? 0) -
			((result.boxes.get("a")?.x ?? 0) + (result.boxes.get("a")?.width ?? 0));
		expect(Math.max(...horizontal)).toBeGreaterThan(span * 0.6);
	});
});
