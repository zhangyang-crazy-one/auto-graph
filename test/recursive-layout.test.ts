import { describe, expect, it } from "vitest";
import type {
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
} from "../src/ir/elements.js";
import {
	buildContainerTree,
	runRecursiveContainerLayout,
} from "../src/layout/recursive.js";

function makeNode(id: string, width: number, height: number): NormalizedNode {
	return {
		id,
		shape: "rectangle",
		size: { width, height },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
	};
}

function makeGroup(
	id: string,
	nodeIds: string[] = [],
	groupIds: string[] = [],
): NormalizedGroup {
	return {
		id,
		nodeIds,
		groupIds,
		padding: { top: 8, right: 8, bottom: 8, left: 8 },
	};
}

function makeEdge(
	id: string,
	sourceId: string,
	targetId: string,
): NormalizedEdge {
	return {
		id,
		source: { nodeId: sourceId },
		target: { nodeId: targetId },
	};
}

describe("buildContainerTree", () => {
	it("records direct children from group.nodeIds / group.groupIds", () => {
		const groups = [makeGroup("g1", ["a", "b"]), makeGroup("g2", [], ["g1"])];
		const { childrenOf, rootIds, edgesInGroup } = buildContainerTree(
			groups,
			[],
			[],
		);
		expect(childrenOf.get("g1")).toEqual(["a", "b"]);
		expect(childrenOf.get("g2")).toEqual(["g1"]);
		expect(rootIds.has("g2")).toBe(true);
		expect(rootIds.has("g1")).toBe(false);
		expect(edgesInGroup.size).toBe(0);
	});

	it("supplements membership from containment constraints", () => {
		const groups = [makeGroup("g1", [], [])];
		const { childrenOf } = buildContainerTree(
			groups,
			[
				{
					kind: "containment",
					containerId: "g1",
					childIds: ["x"],
				},
			],
			[],
		);
		expect(childrenOf.get("g1")).toEqual(["x"]);
	});
});

describe("runRecursiveContainerLayout", () => {
	it("produces a padded box for an empty group", () => {
		const groups = [makeGroup("g1")];
		const result = runRecursiveContainerLayout({
			direction: "TB",
			nodes: [],
			groups,
			edges: [],
			constraints: [],
		});
		const box = result.groupBoxes.get("g1");
		expect(box).toBeDefined();
		// min width = 8 + 8 + 40 = 56, min height = 8 + 8 + 20 = 36
		expect(box?.width).toBe(56);
		expect(box?.height).toBe(36);
	});

	it("lays out two leaf nodes inside their container", () => {
		const groups = [makeGroup("g1", ["a", "b"])];
		const nodes = [makeNode("a", 80, 40), makeNode("b", 80, 40)];
		const edges = [makeEdge("a-b", "a", "b")];
		const result = runRecursiveContainerLayout({
			direction: "TB",
			nodes,
			groups,
			edges,
			constraints: [],
		});

		// The container itself gets a box
		const containerBox = result.groupBoxes.get("g1");
		expect(containerBox).toBeDefined();
		expect(containerBox?.width).toBeGreaterThan(0);
		expect(containerBox?.height).toBeGreaterThan(0);

		// Both children are present
		expect(result.boxes.has("a")).toBe(true);
		expect(result.boxes.has("b")).toBe(true);
		expect(result.boxes.has("g1")).toBe(true);

		// Children are inside the container (relative coords)
		const aBox = result.boxes.get("a");
		const bBox = result.boxes.get("b");
		if (
			aBox === undefined ||
			bBox === undefined ||
			containerBox === undefined
		) {
			throw new Error("expected boxes to be defined");
		}
		expect(aBox.x).toBeGreaterThanOrEqual(containerBox.x);
		expect(aBox.y).toBeGreaterThanOrEqual(containerBox.y);
		expect(bBox.x).toBeGreaterThanOrEqual(containerBox.x);
		expect(bBox.y).toBeGreaterThanOrEqual(containerBox.y);
		expect(aBox.x + aBox.width).toBeLessThanOrEqual(
			containerBox.x + containerBox.width,
		);
		expect(bBox.x + bBox.width).toBeLessThanOrEqual(
			containerBox.x + containerBox.width,
		);
	});

	it("falls through to flat layout when no groups are provided", () => {
		const nodes = [makeNode("a", 80, 40), makeNode("b", 80, 40)];
		const edges = [makeEdge("a-b", "a", "b")];
		const result = runRecursiveContainerLayout({
			direction: "TB",
			nodes,
			groups: [],
			edges,
			constraints: [],
		});
		expect(result.boxes.has("a")).toBe(true);
		expect(result.boxes.has("b")).toBe(true);
		expect(result.groupBoxes.size).toBe(0);
		// Flat layout places boxes at non-zero positions
		const aBox = result.boxes.get("a");
		const bBox = result.boxes.get("b");
		if (aBox === undefined || bBox === undefined) {
			throw new Error("expected boxes to be defined");
		}
		expect(Number.isFinite(aBox.x)).toBe(true);
		expect(Number.isFinite(aBox.y)).toBe(true);
		expect(Number.isFinite(bBox.x)).toBe(true);
		expect(Number.isFinite(bBox.y)).toBe(true);
	});
});
