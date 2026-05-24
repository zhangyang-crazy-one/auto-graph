import { describe, expect, it } from "vitest";
import type {
	Box,
	Constraint,
	CoordinatedDiagram,
	Diagnostic,
	IntentDiagram,
	IntentEdge,
	IntentNode,
	Label,
	NormalizedDiagram,
	Point,
} from "../src/index.js";

describe("public API", () => {
	it("imports core IR types from the package entrypoint", () => {
		const point: Point = { x: 4, y: 8 };
		const box: Box = { ...point, width: 120, height: 60 };
		const label: Label = { text: "Public API" };
		const node: IntentNode = { id: "node-a", label };
		const edge: IntentEdge = {
			id: "edge-a-b",
			sourceId: "node-a",
			targetId: "node-b",
		};
		const constraint: Constraint = {
			id: "place-node-a",
			kind: "exact-position",
			targetId: "node-a",
			position: point,
		};
		const diagnostic: Diagnostic = {
			severity: "info",
			code: "public-api.sample",
			message: "sample diagnostic",
		};
		const intent: IntentDiagram = {
			nodes: [node],
			edges: [edge],
			constraints: [constraint],
		};
		const normalized: NormalizedDiagram = {
			id: "normalized-sample",
			direction: "TB",
			nodes: [],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [diagnostic],
		};

		expect(intent.nodes[0]?.id).toBe("node-a");
		expect(normalized.id).toBe("normalized-sample");
		expect(box.width).toBe(120);
	});

	it("type-checks a coordinated diagram sample", () => {
		const sample: CoordinatedDiagram = {
			id: "coordinated-sample",
			direction: "LR",
			nodes: [
				{
					id: "node-a",
					shape: "rectangle",
					label: { text: "A" },
					box: { x: 0, y: 0, width: 120, height: 60 },
					anchors: [
						{
							name: "center",
							point: { x: 60, y: 30 },
						},
					],
				},
			],
			edges: [
				{
					id: "edge-a-b",
					source: { nodeId: "node-a" },
					target: { nodeId: "node-b" },
					points: [
						{ x: 120, y: 30 },
						{ x: 180, y: 30 },
					],
				},
			],
			groups: [],
			diagnostics: [],
			bounds: { x: 0, y: 0, width: 120, height: 60 },
		};

		expect(sample.bounds.width).toBe(120);
	});
});
