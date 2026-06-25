import { describe, expect, it } from "vitest";
import type { CoordinatedEdge, CoordinatedNode } from "../src/ir/elements.js";
import { scoreLayoutQuality } from "../src/solver/pipeline/quality.js";

function node(
	id: string,
	x: number,
	y: number,
	w = 80,
	h = 40,
): CoordinatedNode {
	return {
		id,
		shape: "rectangle",
		box: { x, y, width: w, height: h },
		anchors: [],
	} as CoordinatedNode;
}

function edge(id: string, points: { x: number; y: number }[]): CoordinatedEdge {
	return {
		id,
		points,
		source: { nodeId: "a" },
		target: { nodeId: "b" },
	} as CoordinatedEdge;
}

describe("quality scoring", () => {
	it("scores 100 for a clean layout", () => {
		const nodes = [node("a", 0, 0), node("b", 200, 0)];
		const edges = [
			edge("a-b", [
				{ x: 40, y: 20 },
				{ x: 200, y: 20 },
			]),
		];
		const report = scoreLayoutQuality(nodes, edges);
		expect(report.score).toBe(100);
	});

	it("penalizes overlapping nodes", () => {
		const nodes = [node("a", 0, 0), node("b", 30, 10)];
		const edges: CoordinatedEdge[] = [];
		const report = scoreLayoutQuality(nodes, edges);
		expect(report.score).toBeLessThan(100);
		expect(
			report.metrics.find((m) => m.kind === "node-overlap")?.value,
		).toBeGreaterThan(0);
	});

	it("penalizes edge crossings", () => {
		const nodes = [node("a", 0, 0), node("b", 200, 200)];
		const edges = [
			edge("e1", [
				{ x: 0, y: 100 },
				{ x: 200, y: 100 },
			]),
			edge("e2", [
				{ x: 100, y: 0 },
				{ x: 100, y: 200 },
			]),
		];
		const report = scoreLayoutQuality(nodes, edges);
		expect(report.score).toBeLessThan(100);
		expect(
			report.metrics.find((m) => m.kind === "edge-crossing")?.value,
		).toBeGreaterThan(0);
	});

	it("counts bends correctly", () => {
		const nodes = [node("a", 0, 0), node("b", 200, 200)];
		const edges = [
			edge("e1", [
				{ x: 40, y: 20 },
				{ x: 240, y: 20 },
				{ x: 240, y: 220 },
				{ x: 200, y: 220 },
			]),
		];
		const report = scoreLayoutQuality(nodes, edges);
		expect(report.metrics.find((m) => m.kind === "bend-count")?.value).toBe(2);
	});

	it("returns diagnostics for issues", () => {
		const nodes = [node("a", 0, 0), node("b", 30, 10)];
		const edges: CoordinatedEdge[] = [];
		const report = scoreLayoutQuality(nodes, edges);
		expect(report.diagnostics.length).toBeGreaterThan(0);
	});

	it("detects backtracking edges (path > 3x direct)", () => {
		const nodes = [node("a", 0, 0), node("b", 200, 0)];
		// Direct distance ≈ 160, route length ≈ 760 (> 3×160) so it
		// backtracks.
		const edges = [
			edge("a-b", [
				{ x: 40, y: 20 },
				{ x: 240, y: 20 },
				{ x: 240, y: 200 },
				{ x: 40, y: 200 },
				{ x: 40, y: 20 },
				{ x: 200, y: 20 },
			]),
		];
		const report = scoreLayoutQuality(nodes, edges);
		const backtrack = report.metrics.find((m) => m.kind === "route-backtrack");
		expect(backtrack?.value).toBeGreaterThan(0);
		expect(
			report.diagnostics.some((d) => d.code === "quality.route_backtrack"),
		).toBe(true);
	});

	it("counts label collisions when labels overlap node boxes", () => {
		// Node "a" has a wide label whose box extends above the node
		// and overlaps node "b"'s box.  Node "b" is iterated first so
		// its box is already in the label-collision index when "a"'s
		// label is checked.
		const b = {
			id: "b",
			shape: "rectangle",
			box: { x: 0, y: -20, width: 80, height: 40 },
			anchors: [],
		} as CoordinatedNode;
		const a = {
			id: "a",
			shape: "rectangle",
			box: { x: 0, y: 0, width: 80, height: 40 },
			anchors: [],
			label: { text: "LongLabelThatExtendsWide" },
		} as CoordinatedNode;
		const report = scoreLayoutQuality([b, a], []);
		const labelMetric = report.metrics.find(
			(m) => m.kind === "label-collision",
		);
		expect(labelMetric?.value).toBeGreaterThan(0);
	});
});
