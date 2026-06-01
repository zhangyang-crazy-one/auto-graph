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

	it("coordinates evidence block boxes and includes them in diagram bounds", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			matrices: [
				{
					id: "verification-matrix",
					rows: ["R1"],
					cols: ["C1"],
					cells: [[{ text: "covered" }]],
					position: { x: 520, y: 40 },
					size: { width: 180, height: 96 },
				},
			],
			tables: [
				{
					id: "parameter-table",
					columns: [
						{ id: "param", label: { text: "Parameter" } },
						{ id: "value", label: { text: "Value" } },
					],
					rows: [
						{
							id: "mass",
							cells: {
								param: { text: "mass" },
								value: { text: "12kg" },
							},
						},
					],
					position: { x: -220, y: 160 },
					size: { width: 240, height: 88 },
				},
			],
			evidencePanels: [
				{
					id: "legend",
					kind: "legend",
					items: [{ label: { text: "solid = verified" } }],
					position: { x: 140, y: 360 },
					size: { width: 220, height: 64 },
				},
			],
		});

		expect(result.matrices?.[0]).toMatchObject({
			id: "verification-matrix",
			box: { x: 520, y: 40, width: 180, height: 96 },
		});
		expect(result.tables?.[0]).toMatchObject({
			id: "parameter-table",
			box: { x: -220, y: 160, width: 240, height: 88 },
		});
		expect(result.evidencePanels?.[0]).toMatchObject({
			id: "legend",
			box: { x: 140, y: 360, width: 220, height: 64 },
		});
		expect(result.bounds.x).toBeLessThanOrEqual(-220);
		expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(700);
		expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(424);
	});

	it("keeps table column offsets stable when rows and cell text change", () => {
		const baseTable = {
			id: "parameters",
			columns: [
				{ id: "name", label: { text: "Name" } },
				{ id: "value", label: { text: "Value" } },
				{ id: "source", label: { text: "Source" } },
			],
			rows: [
				{
					id: "row-1",
					cells: {
						name: { text: "mass" },
						value: { text: "12kg" },
						source: { text: "test" },
					},
				},
			],
			position: { x: 320, y: 220 },
			size: { width: 360, height: 96 },
		};
		const result = solveDiagram({
			...sampleDiagram(),
			tables: [baseTable],
		});
		const mutated = solveDiagram({
			...sampleDiagram(),
			tables: [
				{
					...baseTable,
					rows: [
						{
							id: "row-1",
							cells: {
								name: { text: "mass with a much longer label" },
								value: { text: "12kg plus tolerance and source note" },
								source: { text: "verification document section 3.2" },
							},
						},
						{
							id: "row-2",
							cells: {
								name: { text: "power" },
								value: { text: "80W" },
								source: { text: "analysis" },
							},
						},
					],
				},
			],
		});

		expect(result.tables?.[0]?.columnXOffsets).toEqual([320, 440, 560]);
		expect(mutated.tables?.[0]?.columnXOffsets).toEqual(
			result.tables?.[0]?.columnXOffsets,
		);
		expect(JSON.stringify(mutated.tables?.[0]?.columnXOffsets)).toBe(
			JSON.stringify(result.tables?.[0]?.columnXOffsets),
		);
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

	it("emits indexed solved text annotations for compartment rows", () => {
		const result = solveDiagram({
			id: "compartment-annotations",
			direction: "LR",
			nodes: [
				{
					...node("block", { x: 0, y: 0 }),
					compartments: {
						stereotype: "«block»",
						name: "Block",
						properties: ["alpha", "beta"],
					},
				},
			],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [],
		});

		const compartmentRows = result.textAnnotations?.filter(
			(annotation) => annotation.surfaceKind === "compartment-row",
		);

		expect(compartmentRows).toHaveLength(4);
		expect(
			compartmentRows?.map((annotation) => annotation.surfaceIndex),
		).toEqual([0, 1, 2, 3]);
		expect(
			result.textAnnotations?.some(
				(annotation) => annotation.surfaceKind === "node-label",
			),
		).toBe(false);
		for (const row of compartmentRows ?? []) {
			expect(row.box.x + row.box.width / 2).toBeCloseTo(
				(row.anchor.x ?? 0) +
					("width" in row.anchor ? row.anchor.width / 2 : 0),
			);
		}
	});

	it("includes solved text boxes in bounds and suppresses intentional internal label collisions", () => {
		const result = solveDiagram({
			id: "text-bounds",
			direction: "LR",
			nodes: [
				{
					...node("source", { x: 0, y: 0 }),
					ports: [
						{
							id: "out",
							side: "left",
							kind: "proxy",
							label: { text: "very long external command port" },
						},
					],
				},
			],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [],
		});
		const portLabel = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "port-label",
		);

		expect(portLabel).toBeDefined();
		expect(result.bounds.x).toBeLessThanOrEqual(portLabel?.box.x ?? 0);
		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.detail?.textSurfaceKind === "node-label" &&
					diagnostic.detail?.conflictingObjectKind === "port-label",
			),
		).toBe(false);
	});

	it("anchors solved port label annotations to the external label box", () => {
		const result = solveDiagram({
			id: "port-label-anchor",
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
		const source = result.nodes.find((item) => item.id === "source");
		const port = source?.ports?.find((item) => item.id === "left");
		const portLabel = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "port-label",
		);

		expect(port).toBeDefined();
		expect(portLabel).toBeDefined();
		expect(portLabel?.anchor.x).toBeLessThan(port?.box.x ?? 0);
		expect(portLabel?.box.x).toBeLessThan(port?.box.x ?? 0);
		expect(portLabel?.box.x).toBeLessThan(source?.box.x ?? 0);
	});

	it("centers solved edge label annotation boxes on the routed label placement", () => {
		const result = solveDiagram({
			id: "edge-label-anchor",
			direction: "LR",
			nodes: [node("source", { x: 0, y: 0 }), node("target", { x: 200, y: 0 })],
			edges: [
				{
					id: "source-target",
					source: { nodeId: "source" },
					target: { nodeId: "target" },
					label: { text: "realizes" },
				},
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		});
		const edgeLabel = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "edge-label",
		);

		expect(edgeLabel).toBeDefined();
		expect(edgeLabel?.box.width).toBeGreaterThan(0);
		expect(edgeLabel?.box.height).toBeGreaterThan(0);
		expect(edgeLabel?.box.x).toBeCloseTo(
			(edgeLabel?.anchor.x ?? 0) - (edgeLabel?.box.width ?? 0) / 2,
		);
		expect(edgeLabel?.box.y).toBeCloseTo(
			(edgeLabel?.anchor.y ?? 0) - (edgeLabel?.box.height ?? 0) / 2,
		);
	});

	it("reports unresolved overlap between externally placed solved text boxes", () => {
		const result = solveDiagram({
			id: "text-overlap",
			direction: "LR",
			nodes: [
				{
					...node("left", { x: 0, y: 0 }),
					ports: [
						{
							id: "out",
							side: "right",
							kind: "proxy",
							label: { text: "shared interface" },
						},
					],
				},
				{
					...node("right", { x: 115, y: 0 }),
					ports: [
						{
							id: "in",
							side: "left",
							kind: "proxy",
							label: { text: "shared interface" },
						},
					],
				},
			],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.overlap.unresolved",
				detail: expect.objectContaining({
					textSurfaceKind: "port-label",
					conflictingObjectKind: "port-label",
				}),
			}),
		);
	});

	it("routes around externally placed port-label text obstacles", () => {
		const result = solveDiagram({
			id: "port-label-route-clearance",
			direction: "TB",
			nodes: [
				{
					...node("label_owner", { x: 0, y: 0 }),
					ports: [
						{
							id: "labeled",
							side: "right",
							kind: "proxy",
							label: { text: "blocking route label" },
						},
					],
				},
				node("source", { x: 80, y: -100 }),
				node("target", { x: 80, y: 80 }),
			],
			edges: [
				{
					id: "source-target",
					source: { nodeId: "source" },
					target: { nodeId: "target" },
				},
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		});
		const portLabel = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "port-label",
		);
		const route = result.edges.find((edge) => edge.id === "source-target");

		expect(portLabel).toBeDefined();
		expect(route).toBeDefined();
		expect(route?.points.some((point) => point.x !== 120)).toBe(true);
		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "routing.text-clearance.unresolved" &&
					diagnostic.detail?.textSurfaceKind === "port-label",
			),
		).toBe(false);
	});

	it("reports edge-label clearance conflicts after route placement", () => {
		const result = solveDiagram({
			id: "edge-label-clearance",
			direction: "LR",
			nodes: [
				node("source_a", { x: 0, y: 0 }),
				node("target_a", { x: 240, y: 0 }),
				node("source_b", { x: 120, y: -120 }),
				node("target_b", { x: 120, y: 120 }),
			],
			edges: [
				{
					id: "labeled",
					source: { nodeId: "source_a" },
					target: { nodeId: "target_a" },
					label: { text: "route label" },
				},
				{
					id: "crossing",
					source: { nodeId: "source_b" },
					target: { nodeId: "target_b" },
				},
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "crossing",
					textSurfaceKind: "edge-label",
					conflictingObjectId: "labeled",
				}),
			}),
		);
	});

	it("does not report straight-route text clearance when only segment AABB overlaps", () => {
		const result = solveDiagram(
			{
				id: "straight-route-text-clearance-aabb",
				direction: "LR",
				nodes: [
					node("source", { x: 0, y: 0 }),
					node("target", { x: 240, y: 160 }),
					{
						...node("label_owner", { x: 120, y: 110 }),
						ports: [
							{
								id: "label",
								side: "top",
								kind: "proxy",
								label: { text: "near but not crossed" },
							},
						],
					},
				],
				edges: [
					{
						id: "source-target",
						source: { nodeId: "source" },
						target: { nodeId: "target" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				routeKind: "straight",
			},
		);

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "source-target",
					textSurfaceKind: "port-label",
					conflictingObjectId: "label_owner.label",
				}),
			}),
		);
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
				node("source_a"),
				node("source_b"),
				node("target_a"),
				node("target_b"),
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

	it("distributes vertical contract swimlane children by top-to-bottom flow rank", () => {
		const result = solveDiagram({
			id: "vertical-flow-swimlane",
			direction: "LR",
			nodes: [
				node("init"),
				node("scan"),
				node("recv"),
				node("decide"),
				node("final"),
			],
			edges: [
				{
					id: "init-scan",
					source: { nodeId: "init" },
					target: { nodeId: "scan" },
				},
				{
					id: "scan-recv",
					source: { nodeId: "scan" },
					target: { nodeId: "recv" },
				},
				{
					id: "recv-decide",
					source: { nodeId: "recv" },
					target: { nodeId: "decide" },
				},
				{
					id: "decide-final",
					source: { nodeId: "decide" },
					target: { nodeId: "final" },
				},
			],
			groups: [],
			swimlanes: [
				{
					id: "activity",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [
						{
							id: "radar",
							label: { text: "Radar" },
							children: ["init", "scan", "decide"],
						},
						{
							id: "fire_control",
							label: { text: "Fire Control" },
							children: ["recv", "final"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
			metadata: { primaryReadingDirection: "top_to_bottom" },
		});
		const y = (id: string) => {
			const box = result.nodes.find(
				(coordinatedNode) => coordinatedNode.id === id,
			)?.box;
			if (box === undefined) {
				throw new Error(`Expected node ${id}`);
			}
			return box.y;
		};
		const firstLane = result.swimlanes?.[0]?.lanes.find(
			(lane) => lane.id === "radar",
		);
		const secondLane = result.swimlanes?.[0]?.lanes.find(
			(lane) => lane.id === "fire_control",
		);

		expect(result.diagnostics).toEqual([]);
		expect(y("scan")).toBeGreaterThan(y("init"));
		expect(y("recv")).toBeGreaterThan(y("scan"));
		expect(y("decide")).toBeGreaterThan(y("recv"));
		expect(y("final")).toBeGreaterThan(y("decide"));
		expect(new Set(["init", "scan", "decide"].map(y)).size).toBe(3);
		expect(result.swimlanes?.[0]?.box?.height).toBeGreaterThan(400);
		expect(firstLane?.contentBox?.height).toBeGreaterThan(380);
		expect(secondLane?.contentBox?.height).toBe(firstLane?.contentBox?.height);
		for (const id of ["init", "scan", "recv", "decide", "final"]) {
			const box = result.nodes.find(
				(coordinatedNode) => coordinatedNode.id === id,
			)?.box;
			const lane = firstLane?.children.includes(id) ? firstLane : secondLane;
			if (box === undefined || lane?.contentBox === undefined) {
				throw new Error(`Expected lane content for ${id}`);
			}
			expect(box.y).toBeGreaterThanOrEqual(lane.contentBox.y);
			expect(box.y + box.height).toBeLessThanOrEqual(
				lane.contentBox.y + lane.contentBox.height,
			);
		}
	});

	it("stacks same-rank vertical swimlane children instead of collapsing them", () => {
		const result = solveDiagram({
			id: "vertical-flow-swimlane-same-rank",
			direction: "LR",
			nodes: [
				node("independent_a"),
				node("independent_b"),
				node("start"),
				node("finish"),
			],
			edges: [
				{
					id: "start-finish",
					source: { nodeId: "start" },
					target: { nodeId: "finish" },
				},
			],
			groups: [],
			swimlanes: [
				{
					id: "activity",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [
						{
							id: "independent",
							children: ["independent_a", "independent_b"],
						},
						{
							id: "flow",
							children: ["start", "finish"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
			metadata: { primaryReadingDirection: "top_to_bottom" },
		});
		const independentA = result.nodes.find(
			(coordinatedNode) => coordinatedNode.id === "independent_a",
		);
		const independentB = result.nodes.find(
			(coordinatedNode) => coordinatedNode.id === "independent_b",
		);
		const flowLane = result.swimlanes?.[0]?.lanes.find(
			(lane) => lane.id === "flow",
		);

		if (independentA === undefined || independentB === undefined) {
			throw new Error("Expected independent nodes");
		}
		expect(result.diagnostics).toEqual([]);
		expect(independentB.box.y).toBeGreaterThanOrEqual(
			independentA.box.y + independentA.box.height,
		);
		expect(flowLane?.contentBox?.height).toBeGreaterThan(
			(independentA.box.height + independentB.box.height) * 2,
		);
	});

	it("preserves empty contract lane slots before populated lanes", () => {
		const result = solveDiagram({
			id: "contract-swimlane-empty-slot",
			direction: "LR",
			nodes: [node("work")],
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

	it("does not move locked nodes into contract swimlane slots", () => {
		const result = solveDiagram({
			id: "contract-swimlane-locked-node",
			direction: "LR",
			nodes: [
				node("locked", { x: 300, y: 120 }),
				node("free", { x: 420, y: 120 }),
			],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [{ id: "lane", children: ["locked", "free"] }],
				},
			],
			constraints: [],
			diagnostics: [],
		});

		expect(
			result.nodes.find((coordinatedNode) => coordinatedNode.id === "locked")
				?.box,
		).toMatchObject({
			x: 300,
			y: 120,
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.locked-target-not-moved",
				detail: expect.objectContaining({ nodeId: "locked" }),
			}),
		);
	});

	it("reports overlaps introduced by contract swimlane placement", () => {
		const result = solveDiagram({
			id: "contract-swimlane-overlap",
			direction: "LR",
			nodes: [node("lane_child"), node("outside", { x: 40, y: 80 })],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [{ id: "lane", children: ["lane_child"] }],
				},
			],
			constraints: [],
			diagnostics: [],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.overlap.unresolved",
				detail: expect.objectContaining({
					firstId: "lane_child",
					secondId: "outside",
				}),
			}),
		);
	});

	it("does not emit swimlane overlap diagnostics without contract placement", () => {
		const result = solveDiagram({
			id: "plain-overlap",
			direction: "LR",
			nodes: [
				node("first", { x: 40, y: 80 }),
				node("second", { x: 40, y: 80 }),
			],
			edges: [],
			groups: [],
			swimlanes: [],
			constraints: [],
			diagnostics: [],
		});

		expect(
			result.diagnostics.some((diagnostic) =>
				diagnostic.path?.includes("swimlanes"),
			),
		).toBe(false);
	});

	it("filters overlap diagnostics resolved by contract swimlane placement", () => {
		const result = solveDiagram({
			id: "contract-swimlane-resolved-overlap",
			direction: "LR",
			nodes: [node("left"), node("right")],
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
						{ id: "left_lane", children: ["left"] },
						{ id: "right_lane", children: ["right"] },
					],
				},
			],
			constraints: [
				{
					kind: "align",
					axis: "x",
					targetIds: ["left", "right"],
				},
				{
					kind: "align",
					axis: "y",
					targetIds: ["left", "right"],
				},
			],
			diagnostics: [],
		});

		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.code === "constraints.overlap.unresolved",
			),
		).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.swimlane-contract.invalidated",
				detail: expect.objectContaining({ constraintKind: "align" }),
			}),
		);
	});

	it("places horizontal contract swimlane headers beside row content", () => {
		const result = solveDiagram({
			id: "horizontal-contract-swimlane",
			direction: "TB",
			nodes: [node("observe"), node("decide")],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "horizontal",
					lanes: [
						{
							id: "observe_lane",
							label: { text: "Observe" },
							children: ["observe"],
						},
						{
							id: "decide_lane",
							label: { text: "Decide" },
							children: ["decide"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
		});
		const firstLane = result.swimlanes?.[0]?.lanes[0];
		const observe = result.nodes.find(
			(coordinatedNode) => coordinatedNode.id === "observe",
		);

		if (
			firstLane?.headerBox === undefined ||
			firstLane.contentBox === undefined ||
			observe === undefined
		) {
			throw new Error("Expected horizontal contract lane and observe node");
		}
		expect(firstLane.headerBox).toMatchObject({
			x: firstLane.box?.x,
			y: firstLane.box?.y,
			width: 24,
			height: firstLane.box?.height,
		});
		expect(firstLane.contentBox).toMatchObject({
			x: (firstLane.box?.x ?? 0) + 24,
			y: firstLane.box?.y,
			height: firstLane.box?.height,
		});
		expect(observe.box.x).toBeGreaterThanOrEqual(firstLane.contentBox.x);
		expect(observe.box.y).toBeGreaterThanOrEqual(firstLane.contentBox.y);
		expect(observe.box.y + observe.box.height).toBeLessThanOrEqual(
			firstLane.contentBox.y + firstLane.contentBox.height,
		);
	});

	it("centers horizontal swimlane labels in headers and measures them against header height", () => {
		const result = solveDiagram({
			id: "horizontal-swimlane-label-annotation",
			direction: "TB",
			nodes: [node("observe", { x: 100, y: 120 })],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "horizontal",
					lanes: [
						{
							id: "observe_lane",
							label: { text: "Long Horizontal Lane Label" },
							children: ["observe"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
		});
		const lane = result.swimlanes?.[0]?.lanes[0];
		const label = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "swimlane-label",
		);

		if (lane?.headerBox === undefined || label === undefined) {
			throw new Error(
				"Expected horizontal swimlane header and label annotation",
			);
		}
		expect(label.box.x + label.box.width / 2).toBeCloseTo(
			lane.headerBox.x + lane.headerBox.width / 2,
		);
		expect(label.box.y + label.box.height / 2).toBeCloseTo(
			lane.headerBox.y + lane.headerBox.height / 2,
		);
		expect(label.box.width).toBeLessThanOrEqual(lane.headerBox.height);
		expect(label.lines.length).toBeGreaterThan(1);
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
