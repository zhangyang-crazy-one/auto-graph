import { readFileSync } from "node:fs";
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
	LabelLayout,
	NormalizedDiagram,
	Point,
	ShapeGeometry,
	TextMeasurer,
} from "../src/index.js";
import {
	applyLayoutConstraints,
	computeContainerGeometry,
	computeShapeGeometry,
	DeterministicTextMeasurer,
	expandBox,
	fitLabel,
	routeEdge,
	runDagreInitialLayout,
	simplifyRoute,
	solveDiagram,
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

	it("imports Phase 2 APIs from the package entrypoint", () => {
		const measurer: TextMeasurer = new DeterministicTextMeasurer();
		const labelLayout: LabelLayout = fitLabel(
			"Root API",
			{
				font: { fontFamily: "Inter", fontSize: 16, lineHeight: 20 },
				padding: 4,
			},
			measurer,
		);
		const shapeGeometry: ShapeGeometry = computeShapeGeometry({
			shape: "rectangle",
			box: { x: 0, y: 0, width: 100, height: 60 },
			obstacleMargin: 4,
		});
		const containerGeometry = computeContainerGeometry({
			id: "container-a",
			childBoxes: [shapeGeometry.box],
			padding: 8,
			labelLayout,
		});

		expect(expandBox(shapeGeometry.box, 4)).toEqual(shapeGeometry.obstacleBox);
		expect(containerGeometry.labelLayout).toBe(labelLayout);
		expect(containerGeometry.anchors.length).toBe(9);
	});

	it("imports Phase 3 APIs from the package entrypoint", () => {
		const diagram: NormalizedDiagram = {
			id: "phase-3-public",
			direction: "LR",
			nodes: [
				{
					id: "a",
					shape: "rectangle",
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 0 },
				},
				{
					id: "b",
					shape: "rectangle",
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
			edges: [{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } }],
			groups: [],
			constraints: [
				{
					kind: "relative-position",
					sourceId: "b",
					referenceId: "a",
					relation: "right-of",
					offset: { x: 80, y: 0 },
				},
			],
			diagnostics: [],
		};
		const solved = solveDiagram(diagram);
		const routed = routeEdge({
			kind: "straight",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 40 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 160, y: 0, width: 80, height: 40 },
			}),
		});
		const initialLayout = runDagreInitialLayout({
			direction: "LR",
			nodes: diagram.nodes.map((node) => ({ id: node.id, size: node.size })),
			edges: [{ id: "a-b", sourceId: "a", targetId: "b" }],
		});
		const constrained = applyLayoutConstraints({
			direction: "LR",
			boxes: initialLayout.boxes,
			nodes: diagram.nodes,
			groups: [],
			constraints: diagram.constraints,
		});

		expect(solved.nodes[0]?.box).toBeDefined();
		expect(solved.edges[0]?.points).toBeDefined();
		expect(solved.diagnostics).toBeDefined();
		expect(simplifyRoute(routed.points).length).toBeGreaterThan(0);
		expect(constrained.boxes.size).toBe(2);
	});

	it("keeps package exports root-only", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { exports: Record<string, unknown> };

		expect(Object.keys(packageJson.exports)).toEqual(["."]);
	});
});
