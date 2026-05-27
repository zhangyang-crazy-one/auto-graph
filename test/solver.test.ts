import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import type { NormalizedDiagram } from "../src/ir/index.js";
import { solveDiagram } from "../src/solver/index.js";

describe("solveDiagram", () => {
	it("returns coordinated nodes, routed edges, groups, bounds, and diagnostics", () => {
		const result = solveDiagram(sampleDiagram());

		expect(result.id).toBe("sample");
		expect(result.nodes).toHaveLength(3);
		expect(result.edges).toHaveLength(2);
		expect(result.groups).toHaveLength(1);
		expect(result.diagnostics).toEqual([]);
		expect(result.bounds.width).toBeGreaterThan(0);
		expect(result.bounds.height).toBeGreaterThan(0);
		for (const node of result.nodes) {
			expect(Number.isFinite(node.box.x)).toBe(true);
			expect(node.anchors.length).toBeGreaterThan(0);
		}
		for (const edge of result.edges) {
			expect(edge.points.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("keeps fixed position nodes while automatic nodes receive finite boxes", () => {
		const result = solveDiagram(sampleDiagram());
		const fixed = result.nodes.find((node) => node.id === "a");
		const automatic = result.nodes.find((node) => node.id === "b");

		expect(fixed?.box).toMatchObject({ x: 10, y: 20 });
		expect(Number.isFinite(automatic?.box.x)).toBe(true);
	});

	it("supports straight routing through options.routeKind and defaults to orthogonal", () => {
		const input = {
			...sampleDiagram(),
			constraints: [
				{
					kind: "relative-position" as const,
					sourceId: "b",
					referenceId: "a",
					relation: "right-of" as const,
					offset: { x: 80, y: 80 },
				},
			],
		};
		const orthogonal = solveDiagram(input);
		const straight = solveDiagram(input, { routeKind: "straight" });

		expect(orthogonal.edges[0]?.points.length).toBeGreaterThanOrEqual(3);
		expect(straight.edges[0]?.points).toHaveLength(2);
	});

	it("returns a partial diagram plus error diagnostics for malformed input", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			nodes: [
				node("a", { x: 0, y: 0 }),
				node("b", { x: 300, y: 300 }),
				node("c"),
			],
			edges: [
				{
					id: "bad-edge",
					source: { nodeId: "a" },
					target: { nodeId: "missing" },
				},
			],
			groups: [
				{
					id: "bad-group",
					nodeIds: ["missing"],
					groupIds: [],
					padding: { top: 4, right: 4, bottom: 4, left: 4 },
				},
			],
			constraints: [
				{
					kind: "containment",
					containerId: "a",
					childIds: ["b"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.nodes.length).toBeGreaterThan(0);
		expect(result.edges).toHaveLength(0);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining([
				"solver.edge-reference.missing",
				"solver.group-reference.missing",
				"constraints.containment.impossible",
			]),
		);
	});

	it("solves boundary ports and shifted same-side attachments", () => {
		const source = readFileSync(
			new URL(
				"./fixtures/phase-08/sysml-structure.auto-graph.yaml",
				import.meta.url,
			),
			"utf8",
		);

		const result = renderDiagramDsl(source, { format: "svg" });

		expect(result.diagnostics).toEqual([]);
		const processing = result.diagram?.nodes.find(
			(node) => node.id === "processing_block",
		);
		expect(processing?.ports?.map((port) => port.id)).toEqual([
			"cmd_in",
			"cooling_out",
			"heating_out",
		]);
		const rightSidePorts = processing?.ports?.filter(
			(port) => port.side === "right",
		);
		expect(new Set(rightSidePorts?.map((port) => port.box.y)).size).toBe(2);
		expect(
			Math.abs(
				(rightSidePorts?.[1]?.anchor.y ?? 0) -
					(rightSidePorts?.[0]?.anchor.y ?? 0),
			),
		).toBe(14);
		const cooling = result.diagram?.edges.find(
			(edge) => edge.id === "cooling_flow",
		);
		expect(cooling?.source.portId).toBe("cooling_out");
		expect(cooling?.points.at(0)).toEqual(
			processing?.ports?.find((port) => port.id === "cooling_out")?.anchor,
		);
	});

	it("routes port edges when auto anchor selection chooses a different side", () => {
		const result = solveDiagram({
			id: "vertical-port-edge",
			direction: "LR",
			nodes: [
				{
					...node("source", { x: 0, y: 0 }),
					ports: [{ id: "out", side: "right", kind: "proxy" }],
				},
				{
					...node("target", { x: 0, y: 200 }),
					ports: [{ id: "in", side: "left", kind: "proxy" }],
				},
			],
			edges: [
				{
					id: "source-target",
					source: { nodeId: "source", portId: "out" },
					target: { nodeId: "target", portId: "in" },
				},
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.edges[0]?.points.at(0)).toEqual(
			result.nodes
				.find((coordinatedNode) => coordinatedNode.id === "source")
				?.ports?.find((port) => port.id === "out")?.anchor,
		);
		expect(result.edges[0]?.points.at(-1)).toEqual(
			result.nodes
				.find((coordinatedNode) => coordinatedNode.id === "target")
				?.ports?.find((port) => port.id === "in")?.anchor,
		);
	});

	it("includes boundary ports and port labels in diagram bounds", () => {
		const result = solveDiagram({
			id: "port-bounds",
			direction: "LR",
			nodes: [
				{
					...node("source", { x: 0, y: 0 }),
					ports: [
						{
							id: "left",
							side: "left",
							kind: "proxy",
							label: { text: "external" },
						},
					],
				},
			],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [],
		});
		const source = result.nodes.find(
			(coordinatedNode) => coordinatedNode.id === "source",
		);
		const port = source?.ports?.[0];

		expect(port).toBeDefined();
		expect(result.bounds.x).toBeLessThanOrEqual(port?.box.x ?? 0);
		expect(result.bounds.x).toBeLessThan(port?.box.x ?? 0);
	});

	it("solves empty swimlanes without crashing", () => {
		const result = solveDiagram({
			id: "empty-swimlane",
			direction: "LR",
			nodes: [node("a", { x: 0, y: 0 })],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "empty",
					label: { text: "Empty" },
					orientation: "vertical",
					lanes: [],
				},
			],
			constraints: [],
			diagnostics: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.swimlanes?.[0]?.box).toMatchObject({
			x: expect.any(Number),
			y: expect.any(Number),
			width: expect.any(Number),
			height: expect.any(Number),
		});
		expect(result.swimlanes?.[0]?.lanes).toEqual([]);
	});

	it("ignores empty lanes when deriving populated swimlane extents", () => {
		const result = solveDiagram({
			id: "mixed-swimlane",
			direction: "LR",
			nodes: [node("a", { x: 300, y: 200 })],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "lanes",
					orientation: "vertical",
					lanes: [
						{ id: "empty", children: [] },
						{ id: "populated", children: ["a"] },
					],
				},
			],
			constraints: [],
			diagnostics: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.swimlanes?.[0]?.box?.x).toBeGreaterThan(200);
		expect(result.swimlanes?.[0]?.box?.y).toBeGreaterThan(100);
	});

	it("treats contract swimlanes as physical lane regions with reserved headers", () => {
		const result = solveDiagram({
			id: "contract-swimlane",
			direction: "LR",
			nodes: [
				node("source_a", { x: 40, y: 40 }),
				node("source_b", { x: 40, y: 120 }),
				node("target_a", { x: 320, y: 40 }),
				node("target_b", { x: 320, y: 120 }),
			],
			edges: [
				{
					id: "source_a-target_a",
					source: { nodeId: "source_a" },
					target: { nodeId: "target_a" },
				},
				{
					id: "source_b-target_b",
					source: { nodeId: "source_b" },
					target: { nodeId: "target_b" },
				},
			],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					label: { text: "Behavior Triad" },
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [
						{
							id: "left",
							label: { text: "Source" },
							children: ["source_a", "source_b"],
						},
						{
							id: "right",
							label: { text: "Target" },
							children: ["target_a", "target_b"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
		});

		const swimlane = result.swimlanes?.[0];
		const firstLane = swimlane?.lanes[0];
		const secondLane = swimlane?.lanes[1];

		expect(swimlane?.box).toBeDefined();
		expect(firstLane?.headerBox?.height).toBe(24);
		expect(secondLane?.headerBox?.height).toBe(24);
		expect(firstLane?.contentBox?.y).toBeGreaterThan(
			(firstLane?.headerBox?.y ?? 0) + 20,
		);
		expect(secondLane?.contentBox?.y).toBeGreaterThan(
			(secondLane?.headerBox?.y ?? 0) + 20,
		);
		expect(
			result.nodes.find((node) => node.id === "source_a")?.box.y,
		).toBeGreaterThanOrEqual(firstLane?.contentBox?.y ?? 0);
		expect(
			result.nodes.find((node) => node.id === "target_a")?.box.x,
		).toBeGreaterThan(
			result.nodes.find((node) => node.id === "source_a")?.box.x ?? 0,
		);
		expect(result.edges[0]?.points.at(0)).toEqual(
			result.nodes
				.find((node) => node.id === "source_a")
				?.anchors.find((anchor) => anchor.name === "right")?.point,
		);
	});

	it("preserves empty contract lane slots before populated lanes", () => {
		const result = solveDiagram({
			id: "contract-swimlane-empty-slot",
			direction: "LR",
			nodes: [node("work", { x: 300, y: 120 })],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [
						{ id: "empty", children: [] },
						{ id: "populated", children: ["work"] },
					],
				},
			],
			constraints: [],
			diagnostics: [],
		});

		const swimlane = result.swimlanes?.[0];
		const emptyLane = swimlane?.lanes.find((lane) => lane.id === "empty");
		const populatedLane = swimlane?.lanes.find(
			(lane) => lane.id === "populated",
		);
		const work = result.nodes.find(
			(coordinatedNode) => coordinatedNode.id === "work",
		);

		expect(result.diagnostics).toEqual([]);
		if (work === undefined || populatedLane?.contentBox === undefined) {
			throw new Error("Expected populated lane and work node");
		}
		expect(emptyLane?.box?.width).toBe(populatedLane?.box?.width);
		expect(populatedLane?.box?.x).toBeGreaterThan(emptyLane?.box?.x ?? 0);
		expect(work.box.x).toBeGreaterThanOrEqual(populatedLane.contentBox.x);
		expect(work.box.x + work.box.width).toBeLessThanOrEqual(
			populatedLane.contentBox.x + populatedLane.contentBox.width,
		);
		expect(work.box.y).toBeGreaterThanOrEqual(populatedLane.contentBox.y);
	});
});

function sampleDiagram(): NormalizedDiagram {
	return {
		id: "sample",
		title: "Sample",
		direction: "LR",
		nodes: [node("a", { x: 10, y: 20 }), node("b"), node("c")],
		edges: [
			{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
			{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
		],
		groups: [
			{
				id: "group",
				nodeIds: ["a", "b"],
				groupIds: [],
				padding: { top: 8, right: 8, bottom: 8, left: 8 },
			},
		],
		constraints: [
			{
				kind: "relative-position",
				sourceId: "b",
				referenceId: "a",
				relation: "right-of",
				offset: { x: 80, y: 0 },
			},
			{
				kind: "relative-position",
				sourceId: "c",
				referenceId: "b",
				relation: "right-of",
				offset: { x: 80, y: 0 },
			},
		],
		diagnostics: [],
		metadata: { fixture: "solver" },
	};
}

function node(id: string, position?: { x: number; y: number }) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		...(position === undefined ? {} : { position }),
	};
}
