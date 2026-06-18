import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import { computeArrowhead } from "../src/exporters/arrow.js";
import {
	DELIVERABILITY_DIAGNOSTIC_CODES,
	type Diagnostic,
	type NormalizedDiagram,
} from "../src/ir/index.js";
import { solveDiagram, solveDiagramSafe } from "../src/solver/index.js";
import type {
	PreparedText,
	TextLayout,
	TextMeasurer,
	TextStyleOptions,
} from "../src/text/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

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

	it("emits page_overflow when content exceeds pageBounds", () => {
		const result = solveDiagram(sampleDiagram(), {
			pageBounds: { width: 1, height: 1 },
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "page_overflow",
				detail: expect.objectContaining({
					page: { width: 1, height: 1 },
				}),
			}),
		);
	});

	it("does not emit page_overflow when content fits pageBounds", () => {
		const result = solveDiagram(sampleDiagram(), {
			pageBounds: { width: 1_000_000, height: 1_000_000 },
		});

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "page_overflow" }),
		);
	});

	it("does not emit page_overflow when pageBounds is unset", () => {
		const result = solveDiagram(sampleDiagram());

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "page_overflow" }),
		);
	});

	it("does not clip bounds when content exceeds pageBounds", () => {
		const baseline = solveDiagram(sampleDiagram());
		const result = solveDiagram(sampleDiagram(), {
			pageBounds: { width: 1, height: 1 },
		});

		expect(result.bounds).toEqual(baseline.bounds);
	});

	it("includes edge arrowhead geometry in diagram bounds", () => {
		const diagram = {
			id: "arrowhead-bounds",
			direction: "TB" as const,
			nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 0, y: 200 })],
			edges: [{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } }],
			groups: [],
			constraints: [],
			diagnostics: [],
		};
		const result = solveDiagram(diagram, {
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const edge = result.edges[0];
		expect(edge).toBeDefined();
		const arrowhead = computeArrowhead(edge?.points ?? []);
		// The returned bounds must cover every arrowhead polygon vertex, so the
		// exported SVG arrowhead can never fall outside the diagram bounds
		// (regression guard for codex review on arrowhead overflow).
		for (const vertex of [arrowhead.tip, arrowhead.left, arrowhead.right]) {
			expect(vertex.x).toBeGreaterThanOrEqual(result.bounds.x);
			expect(vertex.x).toBeLessThanOrEqual(
				result.bounds.x + result.bounds.width,
			);
			expect(vertex.y).toBeGreaterThanOrEqual(result.bounds.y);
			expect(vertex.y).toBeLessThanOrEqual(
				result.bounds.y + result.bounds.height,
			);
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

	it("reports explicit evidence block overlaps with content and other evidence blocks", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 300, y: 0 })],
			edges: [],
			groups: [],
			constraints: [],
			matrices: [
				{
					id: "overlapping-matrix",
					rows: ["need"],
					cols: ["function"],
					cells: [[{ text: "covered" }]],
					position: { x: 20, y: 20 },
					size: { width: 120, height: 72 },
				},
			],
			tables: [
				{
					id: "overlapping-table",
					columns: [{ id: "parameter", label: { text: "Parameter" } }],
					rows: [
						{
							id: "mass",
							cells: { parameter: { text: "mass_kg" } },
						},
					],
					position: { x: 40, y: 40 },
					size: { width: 128, height: 68 },
				},
			],
		});

		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "constraints.overlap.unresolved",
					detail: expect.objectContaining({
						evidenceBlockId: "overlapping-matrix",
						conflictingObjectId: "a",
					}),
				}),
				expect.objectContaining({
					code: "constraints.overlap.unresolved",
					detail: expect.objectContaining({
						evidenceBlockId: "overlapping-matrix",
						conflictingObjectId: "overlapping-table",
					}),
				}),
			]),
		);
	});

	it("reports explicit evidence block overlaps with earlier auto-placed evidence blocks", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			nodes: [node("a", { x: 0, y: 0 })],
			edges: [],
			groups: [],
			constraints: [],
			matrices: [
				{
					id: "auto-matrix",
					rows: ["need"],
					cols: ["function"],
					cells: [[{ text: "covered" }]],
					size: { width: 120, height: 72 },
				},
			],
			tables: [
				{
					id: "explicit-table",
					columns: [{ id: "parameter", label: { text: "Parameter" } }],
					rows: [
						{
							id: "mass",
							cells: { parameter: { text: "mass_kg" } },
						},
					],
					position: { x: 120, y: 0 },
					size: { width: 128, height: 68 },
				},
			],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.overlap.unresolved",
				detail: expect.objectContaining({
					evidenceBlockId: "explicit-table",
					conflictingObjectId: "auto-matrix",
				}),
			}),
		);
	});

	it("deduplicates repeated node ids before solving and reports an error diagnostic", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			nodes: [
				node("duplicate", { x: 0, y: 0 }),
				{ ...node("duplicate", { x: 400, y: 400 }), label: { text: "later" } },
				node("target", { x: 180, y: 0 }),
			],
			edges: [
				{
					id: "duplicate-target",
					source: { nodeId: "duplicate" },
					target: { nodeId: "target" },
				},
			],
			groups: [],
			constraints: [],
		});

		expect(result.nodes.map((item) => item.id)).toEqual([
			"duplicate",
			"target",
		]);
		expect(result.nodes.find((item) => item.id === "duplicate")?.label).toBe(
			undefined,
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "duplicate_node_id",
				detail: expect.objectContaining({ id: "duplicate" }),
			}),
		);
	});

	it("wraps a vertical runaway stack when maxStackDepth is configured", () => {
		const result = solveDiagram(
			{
				...sampleDiagram(),
				nodes: Array.from({ length: 7 }, (_, index) => node(`n-${index}`)),
				edges: [],
				groups: [],
				constraints: [],
			},
			{ maxStackDepth: 3, preferredAspectRatio: 1 },
		);

		const uniqueXPositions = new Set(result.nodes.map((item) => item.box.x));
		expect(uniqueXPositions.size).toBeGreaterThan(1);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "vertical_runaway",
				detail: expect.objectContaining({ maxStackDepth: 3, columns: 3 }),
			}),
		);
	});

	it("wraps right-to-left vertical runaway stacks when configured", () => {
		const result = solveDiagram(
			{
				...sampleDiagram(),
				direction: "RL",
				nodes: Array.from({ length: 7 }, (_, index) => node(`n-${index}`)),
				edges: [],
				groups: [],
				constraints: [],
			},
			{ maxStackDepth: 3, preferredAspectRatio: 1 },
		);

		const uniqueXPositions = new Set(result.nodes.map((item) => item.box.x));
		expect(uniqueXPositions.size).toBeGreaterThan(1);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "vertical_runaway",
				detail: expect.objectContaining({ maxStackDepth: 3, columns: 3 }),
			}),
		);
	});

	it("re-clamps containment after later constraints push a child outside", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			nodes: [
				{
					...node("container"),
					size: { width: 220, height: 160 },
				},
				node("child"),
				node("reference"),
			],
			edges: [],
			groups: [],
			constraints: [
				{
					kind: "exact-position",
					targetId: "container",
					position: { x: 0, y: 0 },
				},
				{
					kind: "exact-position",
					targetId: "reference",
					position: { x: 500, y: 500 },
				},
				{
					kind: "containment",
					containerId: "container",
					childIds: ["child"],
					padding: { top: 12, right: 12, bottom: 12, left: 12 },
				},
				{
					kind: "relative-position",
					sourceId: "child",
					referenceId: "reference",
					relation: "below",
					offset: { x: 0, y: 40 },
				},
			],
		});
		const container = result.nodes.find((item) => item.id === "container");
		const child = result.nodes.find((item) => item.id === "child");

		if (container === undefined || child === undefined) {
			throw new Error("Expected container and child nodes");
		}
		expect(child.box.x).toBeGreaterThanOrEqual(container.box.x + 12);
		expect(child.box.y).toBeGreaterThanOrEqual(container.box.y + 12);
		expect(child.box.x + child.box.width).toBeLessThanOrEqual(
			container.box.x + container.box.width - 12,
		);
		expect(child.box.y + child.box.height).toBeLessThanOrEqual(
			container.box.y + container.box.height - 12,
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "containment_overflow",
				detail: expect.objectContaining({
					nodeId: "child",
					containerId: "container",
				}),
			}),
		);
	});

	it("emits an error diagnostic and expands fallback route points when obstacles are present", () => {
		const result = solveDiagram(
			{
				...sampleDiagram(),
				nodes: [
					node("source", { x: 0, y: 0 }),
					node("target", { x: 300, y: 0 }),
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
				tables: [
					{
						id: "obstacle",
						columns: [{ id: "c", label: { text: "C" } }],
						rows: [{ id: "r", cells: { c: { text: "R" } } }],
						position: { x: 120, y: -20 },
						size: { width: 120, height: 80 },
					},
				],
			},
			{ routeKind: "straight" },
		);

		expect(result.edges[0]?.points.length).toBeGreaterThanOrEqual(3);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "route_obstacle_fallback",
				detail: expect.objectContaining({ edgeId: "source-target" }),
			}),
		);
	});

	it("rejects negative programmatic frame padding objects", () => {
		expect(() =>
			solveDiagram({
				...sampleDiagram(),
				frame: {
					kind: "block",
					titleTab: "System",
					padding: { top: -1, right: 16, bottom: 16, left: 16 },
				},
			}),
		).toThrow("insets.top must be non-negative");
	});

	it("preserves frame and group semantic fields in coordinated output", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			groups: [
				{
					id: "semantic-group",
					nodeIds: ["a", "b"],
					groupIds: [],
					padding: { top: 8, right: 8, bottom: 8, left: 8 },
					headerHeight: 36,
					labelPosition: "inside",
					direction: "vertical",
				},
			],
			frame: {
				kind: "sysml",
				titleTab: "System Frame",
				headerHeight: 44,
				padding: { top: 20, right: 24, bottom: 28, left: 32 },
				labelPosition: "top",
				direction: "horizontal",
			},
		});

		expect(result.groups[0]).toMatchObject({
			id: "semantic-group",
			headerHeight: 36,
			labelPosition: "inside",
			direction: "vertical",
		});
		expect(result.frame).toMatchObject({
			headerHeight: 44,
			padding: { top: 20, right: 24, bottom: 28, left: 32 },
			labelPosition: "top",
			direction: "horizontal",
		});
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

	it("defaults public evidence block sizes and places positionless blocks outside content", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			matrices: [
				{
					id: "matrix-without-position",
					rows: ["need"],
					cols: ["function"],
					cells: [[{ text: "covered" }]],
				},
			],
			tables: [
				{
					id: "table-without-position",
					columns: [{ id: "parameter", label: { text: "Parameter" } }],
					rows: [
						{
							id: "mass",
							cells: { parameter: { text: "mass_kg" } },
						},
					],
				},
			],
			evidencePanels: [
				{
					id: "panel-without-position",
					kind: "note",
					items: [{ label: { text: "Check" } }],
				},
			],
		});

		const matrix = result.matrices?.[0];
		const table = result.tables?.[0];
		const panel = result.evidencePanels?.[0];

		expect(matrix?.box).toMatchObject({ width: 216, height: 72 });
		expect(table?.box).toMatchObject({ width: 128, height: 68 });
		expect(panel?.box).toMatchObject({ width: 320, height: 28 });
		expect(matrix?.box.x).toBeGreaterThan(0);
		expect(table?.box.x).toBe(matrix?.box.x);
		expect(panel?.box.x).toBe(matrix?.box.x);
		expect(table?.box.y).toBeGreaterThan(matrix?.box.y ?? 0);
		expect(panel?.box.y).toBeGreaterThan(table?.box.y ?? 0);
		expect(new Set([matrix?.box.y, table?.box.y, panel?.box.y]).size).toBe(3);
	});

	it("spaces automatic evidence blocks by opposing obstacle margins", () => {
		const result = solveDiagram(
			{
				id: "evidence-obstacle-margin",
				direction: "LR",
				nodes: [node("a", { x: 0, y: 0 })],
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
				matrices: [
					{
						id: "matrix",
						rows: ["need"],
						cols: ["function"],
						cells: [[{ text: "covered" }]],
						size: { width: 120, height: 72 },
					},
				],
				tables: [
					{
						id: "table",
						columns: [{ id: "parameter", label: { text: "Parameter" } }],
						rows: [
							{
								id: "mass",
								cells: { parameter: { text: "mass_kg" } },
							},
						],
						size: { width: 128, height: 68 },
					},
				],
			},
			{ obstacleMargin: 40 },
		);

		const nodeBox = result.nodes[0]?.box;
		const matrix = result.matrices?.[0];
		const table = result.tables?.[0];

		expect(matrix?.box.x).toBe((nodeBox?.x ?? 0) + (nodeBox?.width ?? 0) + 80);
		expect(table?.box.y).toBe(
			(matrix?.box.y ?? 0) + (matrix?.box.height ?? 0) + 80,
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

	it("includes routed edge detour points in diagram bounds", () => {
		const result = solveDiagram({
			id: "route-bounds",
			direction: "LR",
			nodes: [node("source", { x: 0, y: 0 }), node("target", { x: 260, y: 0 })],
			edges: [
				{
					id: "source-target",
					source: { nodeId: "source" },
					target: { nodeId: "target" },
				},
			],
			groups: [],
			constraints: [],
			tables: [
				{
					id: "obstacle-table",
					columns: [{ id: "parameter", label: { text: "Parameter" } }],
					rows: [{ id: "mass", cells: { parameter: { text: "mass" } } }],
					position: { x: 120, y: 20 },
					size: { width: 80, height: 24 },
				},
			],
			diagnostics: [],
		});
		const minRouteY = Math.min(
			...(result.edges[0]?.points.map((point) => point.y) ?? [0]),
		);

		expect(minRouteY).toBeLessThan(result.tables?.[0]?.box.y ?? 0);
		expect(result.bounds.y).toBeLessThanOrEqual(minRouteY);
	});

	it("precomputes measured evidence text wrapping before SVG export", () => {
		const result = solveDiagram(
			{
				id: "evidence-text-measurement",
				direction: "LR",
				nodes: [node("source", { x: 0, y: 0 })],
				edges: [],
				groups: [],
				constraints: [],
				tables: [
					{
						id: "wide-glyph-table",
						columns: [{ id: "parameter", label: { text: "Parameter" } }],
						rows: [
							{
								id: "wide",
								cells: { parameter: { text: "WWWWWWWW" } },
							},
						],
						position: { x: 160, y: 0 },
						size: { width: 48, height: 68 },
					},
				],
				diagnostics: [],
			},
			{ textMeasurer: new WideGlyphTextMeasurer() },
		);

		expect(result.tables?.[0]?.cellLabelLayouts?.[0]?.[0]?.lines).toEqual([
			"WWWW",
			"WWWW",
		]);
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

	it("clamps port anchors within the node edge when ports outnumber the available extent", () => {
		const result = solveDiagram({
			id: "port-clamp",
			direction: "LR",
			nodes: [
				{
					...node("dense", { x: 0, y: 0 }),
					ports: [
						{ id: "p0", side: "right", kind: "proxy" },
						{ id: "p1", side: "right", kind: "proxy" },
						{ id: "p2", side: "right", kind: "proxy" },
						{ id: "p3", side: "right", kind: "proxy" },
						{ id: "p4", side: "right", kind: "proxy" },
					],
				},
			],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [],
		});

		const dense = result.nodes.find((n) => n.id === "dense");
		const top = dense?.box.y ?? 0;
		const bottom = top + (dense?.box.height ?? 0);
		const anchorYs: number[] = [];
		for (const port of dense?.ports ?? []) {
			expect(port.anchor.y).toBeGreaterThanOrEqual(top);
			expect(port.anchor.y).toBeLessThanOrEqual(bottom);
			anchorYs.push(port.anchor.y);
		}
		// Each overflowing port must get a distinct anchor (regression guard for
		// codex review: naive clamp collapsed several ports onto the same point).
		expect(new Set(anchorYs).size).toBe(anchorYs.length);
	});

	it("keeps edge label boxes clear of node boxes", () => {
		const result = solveDiagram(
			{
				id: "edge-label-node-clearance",
				direction: "LR",
				nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 })],
				edges: [
					{
						id: "a-b",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						label: { text: "edge label" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ textMeasurer: new DeterministicTextMeasurer() },
		);

		const labelAnnotation = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "edge-label",
		);
		expect(labelAnnotation).toBeDefined();
		const labelBox = labelAnnotation?.box;
		for (const coordinatedNode of result.nodes) {
			const overlaps =
				labelBox !== undefined &&
				labelBox.x < coordinatedNode.box.x + coordinatedNode.box.width &&
				labelBox.x + labelBox.width > coordinatedNode.box.x &&
				labelBox.y < coordinatedNode.box.y + coordinatedNode.box.height &&
				labelBox.y + labelBox.height > coordinatedNode.box.y;
			expect(overlaps).toBe(false);
		}
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
		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "routing.text-clearance.unresolved" &&
					diagnostic.detail?.edgeId === "source-target" &&
					diagnostic.detail?.conflictingObjectId === "source-target",
			),
		).toBe(false);
	});

	it("reports unresolved overlap between externally placed solved text boxes", () => {
		const result = solveDiagram(
			{
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
			},
			{ textMeasurer: new DeterministicTextMeasurer() },
		);

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

	it("applies minLaneGutter between contract swimlane lanes", () => {
		const diagram = {
			id: "gutter-swimlane",
			direction: "LR" as const,
			nodes: [
				node("source_a"),
				node("source_b"),
				node("target_a"),
				node("target_b"),
			],
			edges: [
				{
					id: "e1",
					source: { nodeId: "source_a" },
					target: { nodeId: "target_a" },
				},
				{
					id: "e2",
					source: { nodeId: "source_b" },
					target: { nodeId: "target_b" },
				},
			],
			groups: [],
			swimlanes: [
				{
					id: "behavior",
					label: { text: "Behavior" },
					layout: "contract" as const,
					headerHeight: 24,
					padding: 16,
					orientation: "vertical" as const,
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
		};
		const base = solveDiagram(diagram);
		const withGutter = solveDiagram(diagram, { minLaneGutter: 50 });

		expect(withGutter.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "lane_gutter_applied",
				detail: expect.objectContaining({ laneGutter: 50 }),
			}),
		);
		expect(base.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "lane_gutter_applied" }),
		);
		expect(withGutter.swimlanes?.[0]?.box?.width).toBeGreaterThan(
			base.swimlanes?.[0]?.box?.width ?? 0,
		);

		// Lane boxes must follow the gutter-shifted children, not stay
		// contiguous (regression guard for codex review on laneStep).
		const baseLanes = base.swimlanes?.[0]?.lanes ?? [];
		const gutterLanes = withGutter.swimlanes?.[0]?.lanes ?? [];
		const baseSecondX = baseLanes[1]?.box?.x ?? 0;
		const gutterSecondX = gutterLanes[1]?.box?.x ?? 0;
		expect(gutterSecondX - baseSecondX).toBeCloseTo(50, 5);
		// Second lane's box should contain its child node (alignment).
		const targetA = withGutter.nodes.find((n) => n.id === "target_a");
		const secondLaneBox = gutterLanes[1]?.box;
		expect(secondLaneBox).toBeDefined();
		expect(targetA?.box.x).toBeGreaterThanOrEqual(secondLaneBox?.x ?? 0);
		expect(targetA?.box.x).toBeLessThanOrEqual(
			(secondLaneBox?.x ?? 0) + (secondLaneBox?.width ?? 0),
		);
	});

	it("expands node size to fit its label when prefitLabelSize is set", () => {
		const result = solveDiagram(
			{
				id: "prefit-label",
				direction: "LR",
				nodes: [
					{
						...node("wide"),
						label: {
							text: "a sufficiently long label to exceed the default node width",
						},
					},
				],
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ prefitLabelSize: true },
		);

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "prefit_label_resized",
				detail: expect.objectContaining({ nodeId: "wide" }),
			}),
		);
		const wideNode = result.nodes[0];
		expect(wideNode?.box.width).toBeGreaterThan(80);
		// The rendered node-label must use the same fitted (wrapped) layout the
		// size was derived from, so it stays within the resized box (regression
		// guard for codex review on dropped prefit layout).
		const nodeLabel = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "node-label",
		);
		expect(nodeLabel).toBeDefined();
		expect(nodeLabel?.box.width).toBeLessThanOrEqual(wideNode?.box.width ?? 0);
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

	it("applies CJK font family and minimum font size to solved labels", () => {
		const result = solveDiagram({
			...sampleDiagram(),
			nodes: [
				{
					...node("a", { x: 0, y: 0 }),
					label: { text: "中文节点" },
					style: { fontSize: 12 },
					ports: [
						{
							id: "in",
							side: "left",
							kind: "flow",
							label: { text: "输入" },
							style: { fontSize: 10 },
						},
					],
				},
				{ ...node("b", { x: 200, y: 0 }), label: { text: "English" } },
			],
			edges: [
				{
					id: "a-b",
					source: { nodeId: "a", portId: "in" },
					target: { nodeId: "b" },
					label: { text: "接口流" },
				},
			],
			groups: [
				{
					id: "group",
					label: { text: "分组" },
					nodeIds: ["a", "b"],
					groupIds: [],
					padding: { top: 8, right: 8, bottom: 8, left: 8 },
				},
			],
			constraints: [],
		});

		const cjkNode = result.nodes.find((item) => item.id === "a");
		expect(cjkNode?.style).toMatchObject({
			fontFamily: "YaHei,SimSun,sans-serif",
			fontSize: 14,
		});
		expect(cjkNode?.label?.metadata).toMatchObject({
			cjkTypography: {
				fontFamily: "YaHei,SimSun,sans-serif",
				fontSize: 14,
			},
		});
		expect(cjkNode?.ports?.[0]?.style).toMatchObject({
			fontFamily: "YaHei,SimSun,sans-serif",
			fontSize: 14,
		});
		expect(result.edges[0]?.label?.metadata).toMatchObject({
			cjkTypography: {
				fontFamily: "YaHei,SimSun,sans-serif",
				fontSize: 14,
			},
		});
		expect(
			result.textAnnotations?.find(
				(annotation) =>
					annotation.surfaceKind === "node-label" && annotation.ownerId === "a",
			),
		).toMatchObject({
			fontFamily: "YaHei,SimSun,sans-serif",
			fontSize: 14,
		});
		expect(
			result.textAnnotations?.find(
				(annotation) =>
					annotation.surfaceKind === "edge-label" &&
					annotation.ownerId === "a-b",
			),
		).toMatchObject({
			fontFamily: "YaHei,SimSun,sans-serif",
			fontSize: 14,
		});
		expect(result.nodes.find((item) => item.id === "b")?.style).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "cjk_font_family_applied" }),
				expect.objectContaining({ code: "cjk_font_size_boosted" }),
			]),
		);
	});

	it("respects custom CJK typography options and does not reduce larger font sizes", () => {
		const result = solveDiagram(
			{
				...sampleDiagram(),
				nodes: [
					{
						...node("a", { x: 0, y: 0 }),
						label: { text: "中文节点" },
						style: { fontSize: 18 },
					},
				],
				edges: [],
				groups: [],
				constraints: [],
			},
			{ cjkFontFamily: "Noto Sans CJK SC", minCjkFontSize: 16 },
		);

		expect(result.nodes[0]?.style).toMatchObject({
			fontFamily: "Noto Sans CJK SC",
			fontSize: 18,
		});
		expect(
			result.diagnostics.some(
				(diagnostic) => diagnostic.code === "cjk_font_size_boosted",
			),
		).toBe(false);
	});

	it("can disable automatic CJK typography enhancement", () => {
		const result = solveDiagram(
			{
				...sampleDiagram(),
				nodes: [{ ...node("a", { x: 0, y: 0 }), label: { text: "中文节点" } }],
				edges: [],
				groups: [],
				constraints: [],
			},
			{ cjkFontFamily: false, minCjkFontSize: false },
		);

		expect(result.nodes[0]?.style).toBeUndefined();
		expect(result.nodes[0]?.label?.metadata).toBeUndefined();
		expect(
			result.diagnostics.some((diagnostic) =>
				diagnostic.code.startsWith("cjk_"),
			),
		).toBe(false);
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

function lockedChildDiagram(): ReturnType<typeof sampleDiagram> {
	return {
		id: "locked-child",
		direction: "TB",
		nodes: [
			{
				id: "container",
				shape: "rectangle" as const,
				size: { width: 200, height: 100 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 0, y: 0 },
			},
			{
				id: "child",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 999, y: 999 },
			},
		],
		edges: [],
		groups: [],
		constraints: [
			{
				kind: "containment" as const,
				containerId: "container",
				childIds: ["child"],
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
			},
		],
		diagnostics: [],
	};
}

function diagramWithDiagnostic(diagnostic: Diagnostic): NormalizedDiagram {
	return {
		...sampleDiagram(),
		id: `diagnostic-${diagnostic.code}`,
		diagnostics: [diagnostic],
	};
}

it("sets degraded when a deliverability diagnostic is emitted", () => {
	const result = solveDiagram(lockedChildDiagram());
	expect(result.degraded).toBe(true);
});

it("promotes deliverability warnings to errors when strict is set", () => {
	const result = solveDiagram(lockedChildDiagram(), { strict: true });
	expect(result.degraded).toBe(true);
	const locked = result.diagnostics.filter(
		(d) => d.code === "constraints.locked-target-not-moved",
	);
	expect(locked.length).toBeGreaterThan(0);
	for (const d of locked) {
		expect(d.severity).toBe("error");
	}
});

it("keeps degraded false when no deliverability diagnostics are emitted", () => {
	const result = solveDiagram(sampleDiagram());
	expect(result.degraded).toBe(false);
});

it("does not promote severity when strict is unset", () => {
	const result = solveDiagram(lockedChildDiagram());
	const locked = result.diagnostics.filter(
		(d) => d.code === "constraints.locked-target-not-moved",
	);
	for (const d of locked) {
		expect(d.severity).toBe("warning");
	}
});

it("certifies the deliverability diagnostics strict mode gates on", () => {
	expect(Array.from(DELIVERABILITY_DIAGNOSTIC_CODES).sort()).toEqual([
		"constraints.locked-target-not-moved",
		"route_obstacle_fallback",
		"routing.obstacle.unavoidable",
		"routing.text-clearance.unresolved",
	]);
});

it("promotes every deliverability diagnostic code in strict mode", () => {
	for (const code of DELIVERABILITY_DIAGNOSTIC_CODES) {
		const result = solveDiagram(
			diagramWithDiagnostic({
				severity: "warning",
				code,
				message: `Seeded deliverability diagnostic: ${code}`,
			}),
			{ strict: true },
		);

		expect(result.degraded).toBe(true);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code, severity: "error" }),
		);
	}
});

it("does not promote non-deliverability warnings in strict mode", () => {
	const result = solveDiagram(
		diagramWithDiagnostic({
			severity: "warning",
			code: "page_overflow",
			message: "Seeded non-deliverability warning.",
		}),
		{ strict: true },
	);

	expect(result.degraded).toBe(false);
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({ code: "page_overflow", severity: "warning" }),
	);
});

it("does not mutate input diagnostics when strict promotes the result", () => {
	const inputDiagnostic: Diagnostic = {
		severity: "warning",
		code: "routing.obstacle.unavoidable",
		message: "Seeded deliverability warning.",
	};
	const diagram = diagramWithDiagnostic(inputDiagnostic);
	const result = solveDiagram(diagram, { strict: true });

	expect(inputDiagnostic.severity).toBe("warning");
	expect(diagram.diagnostics[0]?.severity).toBe("warning");
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "routing.obstacle.unavoidable",
			severity: "error",
		}),
	);
});

it("solveDiagramSafe enables prefitLabelSize by default", () => {
	const result = solveDiagramSafe({
		id: "safe-test",
		direction: "TB",
		nodes: [
			{
				id: "safe-node",
				shape: "rectangle" as const,
				size: { width: 50, height: 20 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				label: {
					text: "this is a very long label that should expand the node",
				},
			},
		],
		edges: [],
		groups: [],
		constraints: [],
		diagnostics: [],
	});

	const node = result.nodes[0];
	expect(node).toBeDefined();
	expect(node?.box.width).toBeGreaterThan(50);
	expect(node?.box.height).toBeGreaterThan(20);
});

function node(id: string, position?: { x: number; y: number }) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		...(position === undefined ? {} : { position }),
	};
}

class WideGlyphTextMeasurer implements TextMeasurer {
	prepare(text: string, style: TextStyleOptions): PreparedText {
		return {
			text,
			font: `${style.fontSize}px ${style.fontFamily}`,
			style: { ...style },
			backend: "deterministic",
		};
	}

	layout(
		prepared: PreparedText,
		maxWidth: number,
		lineHeight = prepared.style.lineHeight ?? prepared.style.fontSize * 1.2,
	): TextLayout {
		const charWidth = prepared.style.fontSize;
		const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
		const lines = Array.from(
			{ length: Math.ceil(prepared.text.length / maxChars) },
			(_, index) => {
				const text = prepared.text.slice(
					index * maxChars,
					index * maxChars + maxChars,
				);
				return {
					text,
					width: this.naturalWidth(this.prepare(text, prepared.style)),
					start: { segmentIndex: 0, graphemeIndex: index * maxChars },
					end: {
						segmentIndex: 0,
						graphemeIndex: index * maxChars + text.length,
					},
				};
			},
		);
		return {
			width: Math.max(0, ...lines.map((line) => line.width)),
			height: lines.length * lineHeight,
			lineHeight,
			lineCount: lines.length,
			lines,
			diagnostics: [],
		};
	}

	naturalWidth(prepared: PreparedText): number {
		return prepared.text.length * prepared.style.fontSize;
	}
}
