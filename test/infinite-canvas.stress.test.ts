import { describe, expect, it } from "vitest";
import type { NormalizedDiagram } from "../src/ir/index.js";
import { solveDiagram } from "../src/solver/index.js";

describe("infinite canvas stress", () => {
	it("solves a large sparse positioned grid without routing grid overflow", () => {
		const diagram = sparseGridDiagram(10, 10, 500);
		const first = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
		});
		const second = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
		});

		expect(first.nodes).toHaveLength(100);
		expect(first.edges).toHaveLength(90);
		expect(first.degraded).toBe(false);
		expect(first.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "routing.astar.grid_overflow" }),
		);
		expect(first.bounds.x).toBeLessThanOrEqual(-2_500);
		expect(first.bounds.y).toBeLessThanOrEqual(-2_500);
		for (const node of first.nodes) {
			expect(Number.isFinite(node.box.x)).toBe(true);
			expect(Number.isFinite(node.box.y)).toBe(true);
		}
		for (const edge of first.edges) {
			expect(edge.points.length).toBeGreaterThanOrEqual(2);
			for (const point of edge.points) {
				expect(Number.isFinite(point.x)).toBe(true);
				expect(Number.isFinite(point.y)).toBe(true);
			}
		}
		expect(first.nodes.map((node) => node.box)).toEqual(
			second.nodes.map((node) => node.box),
		);
		expect(first.edges.map((edge) => edge.points)).toEqual(
			second.edges.map((edge) => edge.points),
		);
	});
});

function sparseGridDiagram(
	rows: number,
	cols: number,
	pitch: number,
): NormalizedDiagram {
	const nodes: NormalizedDiagram["nodes"] = [];
	const edges: NormalizedDiagram["edges"] = [];
	const originX = -((cols * pitch) / 2);
	const originY = -((rows * pitch) / 2);
	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < cols; col += 1) {
			const id = `n-${row}-${col}`;
			nodes.push({
				id,
				shape: "rectangle",
				position: { x: originX + col * pitch, y: originY + row * pitch },
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
			});
			if (col > 0) {
				edges.push({
					id: `n-${row}-${col - 1}-n-${row}-${col}`,
					source: { nodeId: `n-${row}-${col - 1}` },
					target: { nodeId: id },
				});
			}
		}
	}

	return {
		id: "large-sparse-grid",
		direction: "LR",
		nodes,
		edges,
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}
