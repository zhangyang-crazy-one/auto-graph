import { describe, expect, it } from "vitest";
import type { CoordinatedDiagram } from "../src/ir/index.js";
import { boxInsideShape, measureLayoutQuality } from "../src/quality/index.js";

const box = (x: number, y: number, width: number, height: number) => ({
	x,
	y,
	width,
	height,
});

function diagram(partial: Partial<CoordinatedDiagram>): CoordinatedDiagram {
	return {
		id: "metrics",
		direction: "LR",
		nodes: [],
		edges: [],
		groups: [],
		diagnostics: [],
		degraded: false,
		bounds: box(0, 0, 400, 200),
		...partial,
	};
}

function node(id: string, b: ReturnType<typeof box>) {
	return { id, shape: "rectangle" as const, box: b, anchors: [] };
}

describe("layout metrics", () => {
	it("detects text leaving a diamond outline", () => {
		const diamond = box(0, 0, 100, 60);
		expect(boxInsideShape(box(30, 20, 40, 20), "diamond", diamond)).toBe(true);
		expect(boxInsideShape(box(10, 20, 80, 20), "diamond", diamond)).toBe(false);
	});

	it("counts overlapping sibling groups and foreign nodes", () => {
		const metrics = measureLayoutQuality(
			diagram({
				nodes: [
					node("a", box(10, 10, 40, 20)),
					node("b", box(120, 10, 40, 20)),
					node("c", box(70, 10, 40, 20)),
				],
				groups: [
					{
						id: "left",
						nodeIds: ["a"],
						groupIds: [],
						padding: { top: 0, right: 0, bottom: 0, left: 0 },
						box: box(0, 0, 100, 40),
					},
					{
						id: "right",
						nodeIds: ["b"],
						groupIds: [],
						padding: { top: 0, right: 0, bottom: 0, left: 0 },
						box: box(80, 0, 100, 40),
					},
				],
			}),
		);
		expect(metrics.groupOverlaps).toBe(1);
		// c sits inside both groups without being a member of either.
		expect(metrics.foreignNodesInGroups).toBe(2);
	});

	it("measures shared endpoints, overlapping runs and crossings", () => {
		const edge = (id: string, points: Array<[number, number]>) => ({
			id,
			source: { nodeId: "s" },
			target: { nodeId: `t-${id}` },
			points: points.map(([x, y]) => ({ x, y })),
		});
		const metrics = measureLayoutQuality(
			diagram({
				nodes: [node("s", box(0, 0, 20, 20))],
				edges: [
					edge("a", [
						[20, 10],
						[60, 10],
						[60, 100],
					]),
					edge("b", [
						[20, 10],
						[60, 10],
						[60, 150],
					]),
					edge("c", [
						[0, 50],
						[120, 50],
					]),
				],
			}),
		);
		expect(metrics.sharedEndpoints).toBe(1);
		expect(metrics.overlappingSegmentLength).toBe(40 + 90);
		expect(metrics.crossings).toBe(2);
	});
});

describe("layout metrics review follow-ups", () => {
	it("does not count intentional node containment as overlap", () => {
		const d = diagram({
			nodes: [
				node("outer", box(0, 0, 200, 100)),
				node("inner", box(20, 20, 40, 20)),
			],
		});
		expect(measureLayoutQuality(d).nodeOverlaps).toBe(1);
		expect(
			measureLayoutQuality(d, {
				containment: [{ containerId: "outer", childIds: ["inner"] }],
			}).nodeOverlaps,
		).toBe(0);
	});

	it("counts an edge label on top of a group title", () => {
		const annotation = (
			surfaceKind: "edge-label" | "group-label",
			ownerId: string,
			b: ReturnType<typeof box>,
		) => ({
			text: ownerId,
			ownerId,
			surfaceKind,
			box: b,
			anchor: b,
			paddings: { top: 0, right: 0, bottom: 0, left: 0 },
			lines: [],
			fontFamily: "Arial",
			fontSize: 12,
		});
		const metrics = measureLayoutQuality(
			diagram({
				textAnnotations: [
					annotation("group-label", "services", box(0, 0, 100, 20)),
					annotation("edge-label", "e1", box(50, 5, 40, 14)),
				],
			}),
		);
		expect(metrics.edgeLabelCollisions).toBe(1);
	});
});
