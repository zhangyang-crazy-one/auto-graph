import { describe, expect, it } from "vitest";
import type { CoordinatedEdge } from "../src/ir/index.js";
import { edgeLabelAnchor } from "../src/solver/labels.js";

describe("edge label backdrop placement", () => {
	it("keeps the label backdrop off a node the text box only just clears", () => {
		const edge = {
			id: "e",
			source: { nodeId: "s" },
			target: { nodeId: "t" },
			points: [
				{ x: 0, y: 0 },
				{ x: 200, y: 0 },
			],
		} as unknown as CoordinatedEdge;
		const layout = {
			box: { x: 0, y: 0, width: 40, height: 14 },
		} as never;
		const free = edgeLabelAnchor(edge, layout, [edge], [], []);
		const text = {
			x: free.center.x - 20,
			y: free.center.y - 7,
			width: 40,
			height: 14,
		};
		// A node 1px past the text box's far side (from the line): the text
		// clears it, the backdrop (4px / 2px margin) would not.
		const below = text.y > 0;
		const node = {
			x: text.x - 20,
			y: below ? text.y + text.height + 1 : text.y - 1 - 30,
			width: text.width + 40,
			height: 30,
		};
		const placed = edgeLabelAnchor(edge, layout, [edge], [node], []);
		const backdrop = {
			x: placed.center.x - 20 - 4,
			y: placed.center.y - 7 - 2,
			width: 48,
			height: 18,
		};
		const overlaps =
			backdrop.x < node.x + node.width &&
			node.x < backdrop.x + backdrop.width &&
			backdrop.y < node.y + node.height &&
			node.y < backdrop.y + backdrop.height;
		expect(overlaps).toBe(false);
	});
});
