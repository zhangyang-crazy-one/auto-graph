import { describe, expect, it } from "vitest";
import type { CoordinatedEdge, SolvedTextAnnotation } from "../src/ir/index.js";
import { isRouteTextObstacleFor } from "../src/solver/route-edges.js";

const edge = {
	id: "e",
	source: { nodeId: "a", portId: "out" },
	target: { nodeId: "b" },
	points: [],
} as unknown as CoordinatedEdge;

const text = (
	surfaceKind: SolvedTextAnnotation["surfaceKind"],
	ownerId: string,
) => ({ surfaceKind, ownerId }) as unknown as SolvedTextAnnotation;

describe("short-route text obstacles (channel nudge acceptance too)", () => {
	it("keeps the edge's own port label as an obstacle", () => {
		expect(isRouteTextObstacleFor(edge, text("port-label", "a.out"))).toBe(
			true,
		);
	});

	it("exempts the edge's own label and its endpoints' node labels", () => {
		expect(isRouteTextObstacleFor(edge, text("edge-label", "e"))).toBe(false);
		expect(isRouteTextObstacleFor(edge, text("node-label", "a"))).toBe(false);
		expect(isRouteTextObstacleFor(edge, text("node-label", "b"))).toBe(false);
	});

	it("keeps other edges' labels and other nodes' labels", () => {
		expect(isRouteTextObstacleFor(edge, text("edge-label", "f"))).toBe(true);
		expect(isRouteTextObstacleFor(edge, text("node-label", "c"))).toBe(true);
	});
});
