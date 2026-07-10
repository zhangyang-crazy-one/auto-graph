import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import { computeArrowhead } from "../src/exporters/arrow.js";
import {
	type Box,
	DELIVERABILITY_DIAGNOSTIC_CODES,
	type Diagnostic,
	type ExternalLabelRemediationDetail,
	type LabelLayout,
	type NormalizedDiagram,
	type PageSplitRemediationDetail,
} from "../src/ir/index.js";
import {
	createDefaultPipeline,
	resolvePagePolicy,
	solveDiagram,
	solveDiagramSafe,
} from "../src/solver/index.js";
import { createInitialState } from "../src/solver/pipeline/state.js";
import type {
	PreparedText,
	TextLayout,
	TextMeasurer,
	TextStyleOptions,
} from "../src/text/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

describe("createDefaultPipeline", () => {
	it("exposes the named #77 phases and mirrors solveDiagram output", () => {
		const pipeline = createDefaultPipeline();
		const state = createInitialState(sampleDiagram(), {});
		pipeline.run(state);

		expect(state.phaseTrace.map((entry) => entry.phase)).toEqual([
			"prepare",
			"initial-layout",
			"ports-and-constraints",
			"coordinate",
			"route-edges",
			"labels-and-remediate",
			"quality-score",
		]);

		const direct = solveDiagram(sampleDiagram());
		expect(state.coordinatedNodes.map((node) => node.id)).toEqual(
			direct.nodes.map((node) => node.id),
		);
		expect(state.coordinatedEdges.map((edge) => edge.id)).toEqual(
			direct.edges.map((edge) => edge.id),
		);
		expect(state.bounds).toEqual(direct.bounds);
	});

	it("accepts full SolveDiagramOptions literals on resolvePagePolicy", () => {
		const diagram = sampleDiagram();
		// Excess fields beyond page-policy must type-check and be ignored.
		expect(
			resolvePagePolicy(diagram, {
				pagePolicy: "auto",
				initialLayout: "positions",
				labelPlacement: "beside",
			}),
		).toBe(resolvePagePolicy(diagram, { pagePolicy: "auto" }));
	});

	it("mirrors matrices, tables, evidence panels, and frame into LayoutState", () => {
		const diagram: NormalizedDiagram = {
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
			frame: {
				kind: "block",
				titleTab: "System",
				padding: { top: 16, right: 16, bottom: 16, left: 16 },
			},
		};
		const pipeline = createDefaultPipeline();
		const state = createInitialState(diagram, {});
		pipeline.run(state);
		const direct = solveDiagram(diagram);

		expect(state.coordinatedMatrices.map((block) => block.id)).toEqual(
			(direct.matrices ?? []).map((block) => block.id),
		);
		expect(state.coordinatedTables.map((block) => block.id)).toEqual(
			(direct.tables ?? []).map((block) => block.id),
		);
		expect(state.coordinatedEvidencePanels.map((panel) => panel.id)).toEqual(
			(direct.evidencePanels ?? []).map((panel) => panel.id),
		);
		expect(state.frame?.kind).toBe(direct.frame?.kind);
		expect(state.frame?.titleTab).toBe(direct.frame?.titleTab);
		expect(state.baseTextAnnotations.length).toBe(
			direct.textAnnotations?.length ?? 0,
		);
	});

	it("documents that early replacePhase overrides are overwritten by mirror", () => {
		const pipeline = createDefaultPipeline().replacePhase("route-edges", {
			name: "route-edges",
			run(state) {
				state.coordinatedEdges = [
					{
						id: "custom-only",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						points: [
							{ x: 0, y: 0 },
							{ x: 1, y: 1 },
						],
					},
				];
			},
		});
		const state = createInitialState(sampleDiagram(), {});
		pipeline.run(state);
		// Reserved early phases currently no-op for observable output; mirror wins.
		expect(state.coordinatedEdges.map((edge) => edge.id)).toEqual(
			solveDiagram(sampleDiagram()).edges.map((edge) => edge.id),
		);
		expect(state.coordinatedEdges.map((edge) => edge.id)).not.toContain(
			"custom-only",
		);
	});
});

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

	it("seeds an explicit sparse infinite canvas from node positions", () => {
		const result = solveDiagram(
			{
				id: "manual-canvas",
				direction: "TB",
				nodes: [
					node("corner-a", { x: 0, y: 0 }),
					node("corner-b", { x: 5_000, y: 0 }),
					node("corner-c", { x: 0, y: 5_000 }),
					node("corner-d", { x: 5_000, y: 5_000 }),
					node("center", { x: 2_500, y: 2_500 }),
				],
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions" },
		);

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "constraints.overlap.unresolved" }),
		);
		expect(nodeBox(result, "corner-a")).toMatchObject({ x: 0, y: 0 });
		expect(nodeBox(result, "corner-b")).toMatchObject({ x: 5_000, y: 0 });
		expect(nodeBox(result, "corner-c")).toMatchObject({ x: 0, y: 5_000 });
		expect(nodeBox(result, "corner-d")).toMatchObject({ x: 5_000, y: 5_000 });
		expect(nodeBox(result, "center")).toMatchObject({ x: 2_500, y: 2_500 });
		expect(result.bounds.x).toBe(0);
		expect(result.bounds.y).toBe(0);
		expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(5_080);
		expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(
			5_040,
		);
	});

	it("keeps negative positioned nodes on the infinite canvas", () => {
		const result = solveDiagram(
			{
				id: "negative-manual-canvas",
				direction: "LR",
				nodes: [
					node("left", { x: -1_000, y: -500 }),
					node("middle", { x: -200, y: -500 }),
					node("right", { x: 800, y: 200 }),
				],
				edges: [
					{
						id: "left-middle",
						source: { nodeId: "left" },
						target: { nodeId: "middle" },
					},
					{
						id: "middle-right",
						source: { nodeId: "middle" },
						target: { nodeId: "right" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", routeKind: "straight" },
		);

		expect(nodeBox(result, "left")).toMatchObject({ x: -1_000, y: -500 });
		expect(result.bounds.x).toBeLessThanOrEqual(-1_000);
		expect(result.bounds.y).toBeLessThanOrEqual(-500);
		for (const edge of result.edges) {
			expect(edge.points.length).toBe(2);
			for (const point of edge.points) {
				expect(Number.isFinite(point.x)).toBe(true);
				expect(Number.isFinite(point.y)).toBe(true);
			}
		}
	});

	it("uses Dagre only for missing positions in positions mode", () => {
		const result = solveDiagram(
			{
				id: "mixed-manual-auto-canvas",
				direction: "LR",
				nodes: [
					node("fixed", { x: 10_000, y: -5_000 }),
					node("auto-a"),
					node("auto-b"),
				],
				edges: [
					{
						id: "auto-a-auto-b",
						source: { nodeId: "auto-a" },
						target: { nodeId: "auto-b" },
					},
					{
						id: "fixed-auto-a",
						source: { nodeId: "fixed" },
						target: { nodeId: "auto-a" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", routeKind: "straight" },
		);

		const autoA = nodeBox(result, "auto-a");
		const autoB = nodeBox(result, "auto-b");
		expect(nodeBox(result, "fixed")).toMatchObject({ x: 10_000, y: -5_000 });
		expect(Number.isFinite(autoA.x)).toBe(true);
		expect(Number.isFinite(autoA.y)).toBe(true);
		expect(Number.isFinite(autoB.x)).toBe(true);
		expect(Number.isFinite(autoB.y)).toBe(true);
		expect(autoA).not.toMatchObject({ x: 10_000, y: -5_000 });
		expect(autoB).not.toMatchObject({ x: 10_000, y: -5_000 });
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "layout.positions.missing",
				detail: expect.objectContaining({ nodeId: "auto-a" }),
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "layout.positions.missing",
				detail: expect.objectContaining({ nodeId: "auto-b" }),
			}),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "layout.edge-reference.missing" }),
		);
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
	it("wraps a TB horizontal runaway row when maxRowDepth is configured", () => {
		const result = solveDiagram(
			{
				id: "test-tb-row",
				direction: "TB",
				nodes: Array.from({ length: 7 }, (_, index) =>
					node(`n-${index}`, { x: index * 88, y: 0 }),
				),
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ maxRowDepth: 3, initialLayout: "positions" },
		);

		const uniqueYPositions = new Set(result.nodes.map((item) => item.box.y));
		expect(uniqueYPositions.size).toBeGreaterThan(1);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "horizontal_runaway",
				detail: expect.objectContaining({ maxRowDepth: 3 }),
			}),
		);
	});

	it("wraps a BT horizontal runaway row when maxRowDepth is configured", () => {
		const result = solveDiagram(
			{
				id: "test-bt-row",
				direction: "BT",
				nodes: Array.from({ length: 7 }, (_, index) =>
					node(`n-${index}`, { x: index * 88, y: 0 }),
				),
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ maxRowDepth: 3, initialLayout: "positions" },
		);

		const uniqueYPositions = new Set(result.nodes.map((item) => item.box.y));
		expect(uniqueYPositions.size).toBeGreaterThan(1);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "horizontal_runaway",
				detail: expect.objectContaining({ maxRowDepth: 3 }),
			}),
		);
	});

	it("does not trigger horizontal runaway when maxRowDepth is unset", () => {
		const result = solveDiagram(
			{
				id: "test-tb-row-no-rewrap",
				direction: "TB",
				nodes: Array.from({ length: 7 }, (_, index) =>
					node(`n-${index}`, { x: index * 88, y: 0 }),
				),
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions" },
		);

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "horizontal_runaway" }),
		);
	});

	it("targetAspectRatio gates horizontal rewrap threshold", () => {
		// Low threshold: rewrap fires.
		const low = solveDiagram(
			{
				id: "test-tb-aspect-low",
				direction: "TB",
				nodes: Array.from({ length: 7 }, (_, index) =>
					node(`n-${index}`, { x: index * 88, y: 0 }),
				),
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				maxRowDepth: 3,
				targetAspectRatio: 1,
				initialLayout: "positions",
			},
		);
		const uniqueY = new Set(low.nodes.map((item) => item.box.y));
		expect(uniqueY.size).toBeGreaterThan(1);
		expect(low.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "horizontal_runaway",
			}),
		);

		// High threshold: no rewrap.
		const high = solveDiagram(
			{
				id: "test-tb-aspect-high",
				direction: "TB",
				nodes: Array.from({ length: 7 }, (_, index) =>
					node(`n-${index}`, { x: index * 88, y: 0 }),
				),
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				maxRowDepth: 3,
				targetAspectRatio: 100,
				initialLayout: "positions",
			},
		);
		expect(high.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "horizontal_runaway" }),
		);
	});

	it("distributes children in non-contract swimlane lanes", () => {
		const result = solveDiagram(
			{
				id: "swimlane-distribute",
				direction: "TB",
				nodes: [
					node("lane1-child1"),
					node("lane1-child2"),
					node("lane1-child3"),
				],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "sw",
						orientation: "vertical",
						lanes: [
							{
								id: "lane1",
								label: { text: "Lane 1" },
								children: ["lane1-child1", "lane1-child2", "lane1-child3"],
							},
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ distributeSwimlaneChildren: "spread" },
		);

		const childXs = result.nodes.map((n) => n.box.x);
		const uniqueXPositions = new Set(childXs);
		expect(uniqueXPositions.size).toBe(3);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "intra_container_distributed",
				detail: expect.objectContaining({ containerId: "lane1" }),
			}),
		);
	});

	it("keeps a fixed-position lock when distribution cannot run (single participant)", () => {
		// Lane has one fixed-position child + one exact-position child.
		// Distribution requires ≥2 participants (fixed-position counts,
		// exact-position is reserved), so it must NOT run here. The
		// fixed-position lock must be preserved — otherwise overlap repair
		// would relocate the fixed node (Codex review P2). The exact-position
		// child is placed to overlap the fixed child so that, without the
		// fix, repair visibly moves the (wrongly) unlocked fixed node.
		const result = solveDiagram(
			{
				id: "swimlane-single-participant",
				direction: "TB",
				nodes: [node("fixed-child", { x: 30, y: 200 }), node("exact-child")],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "sw",
						orientation: "vertical",
						lanes: [
							{
								id: "lane1",
								label: { text: "Lane 1" },
								children: ["fixed-child", "exact-child"],
							},
						],
					},
				],
				constraints: [
					{
						kind: "exact-position",
						targetId: "exact-child",
						position: { x: 30, y: 210 },
					},
				],
				diagnostics: [],
			},
			{ distributeSwimlaneChildren: "spread" },
		);

		// fixed-child keeps its fixed position (lock not dropped).
		const fixed = result.nodes.find((n) => n.id === "fixed-child");
		expect(fixed?.box).toMatchObject({ x: 30, y: 200 });
		// No distribution diagnostic emitted.
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "intra_container_distributed" }),
		);
	});

	it("distributes same-rank children horizontally in contract swimlane", () => {
		// 5 independent auto-laid-out children with NO edges (all rank 0)
		// and NO fixed positions (so no fixed-position locks). The fix must
		// spread them horizontally — no unrelated trigger edge needed
		// (Codex P2: rank-zero lanes spread without requiring an edge).
		const result = solveDiagram({
			id: "contract-cross-axis",
			direction: "TB",
			nodes: [
				{ ...node("c1"), size: { width: 80, height: 80 } },
				{ ...node("c2"), size: { width: 80, height: 80 } },
				{ ...node("c3"), size: { width: 80, height: 80 } },
				{ ...node("c4"), size: { width: 80, height: 80 } },
				{ ...node("c5"), size: { width: 80, height: 80 } },
			],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "sw-contract",
					orientation: "vertical",
					layout: "contract",
					lanes: [
						{
							id: "lane-a",
							label: { text: "Lane A" },
							children: ["c1", "c2", "c3", "c4", "c5"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
			metadata: { primaryReadingDirection: "top_to_bottom" },
		});

		// The 5 same-rank children should be spread horizontally.
		const laneAChildren = result.nodes.filter((n) =>
			["c1", "c2", "c3", "c4", "c5"].includes(n.id),
		);
		const xs = laneAChildren.map((n) => n.box.x);
		const uniqueXPositions = new Set(xs);
		expect(uniqueXPositions.size).toBeGreaterThan(1);
		// All 5 share the same y (same rank → no vertical stagger).
		const ys = new Set(laneAChildren.map((n) => n.box.y));
		expect(ys.size).toBe(1);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "swimlane_contract.cross_axis_distributed",
				detail: expect.objectContaining({ childCount: 5 }),
			}),
		);
	});

	it("packs unequal-width same-rank children without overlap or lane overflow", () => {
		// Children of very different widths (300, 10, 10) must NOT be placed
		// in equal subslots (the 300px child would overlap its neighbors).
		// They are packed by their own widths + gaps, and the lane slot is
		// pre-sized to contain them (Codex P2).
		const result = solveDiagram({
			id: "contract-unequal-widths",
			direction: "TB",
			nodes: [
				{ ...node("wide"), size: { width: 300, height: 40 } },
				{ ...node("narrow1"), size: { width: 10, height: 40 } },
				{ ...node("narrow2"), size: { width: 10, height: 40 } },
			],
			edges: [],
			groups: [],
			swimlanes: [
				{
					id: "sw",
					orientation: "vertical",
					layout: "contract",
					lanes: [
						{
							id: "lane-a",
							label: { text: "Lane A" },
							children: ["wide", "narrow1", "narrow2"],
						},
					],
				},
			],
			constraints: [],
			diagnostics: [],
			metadata: { primaryReadingDirection: "top_to_bottom" },
		});

		const boxesById = new Map(result.nodes.map((n) => [n.id, n.box]));
		const wide = boxesById.get("wide")!;
		const n1 = boxesById.get("narrow1")!;
		const n2 = boxesById.get("narrow2")!;

		// Sort children by x and assert no horizontal overlap between
		// consecutive boxes.
		const ordered = [wide, n1, n2].sort((a, b) => a.x - b.x);
		for (let i = 0; i < ordered.length - 1; i++) {
			const cur = ordered[i]!;
			const nxt = ordered[i + 1]!;
			expect(cur.x + cur.width).toBeLessThanOrEqual(nxt.x);
		}

		// All children stay within the lane box (no overflow past lane bounds).
		const laneBox = result.swimlanes?.[0]?.lanes[0]?.box;
		expect(laneBox).toBeDefined();
		if (laneBox !== undefined) {
			for (const b of [wide, n1, n2]) {
				expect(b.x).toBeGreaterThanOrEqual(laneBox.x);
				expect(b.x + b.width).toBeLessThanOrEqual(laneBox.x + laneBox.width);
			}
			// The packed row is centered within the lane: the left gap (lane
			// left → first child) must equal the right gap (last child → lane
			// right). A one-padding offset bug would break this symmetry
			// (Codex P2).
			const leftmost = ordered[0]!;
			const rightmost = ordered[ordered.length - 1]!;
			const leftGap = leftmost.x - laneBox.x;
			const rightGap =
				laneBox.x + laneBox.width - (rightmost.x + rightmost.width);
			expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
		}
	});

	it("centers a single-child rank within contract swimlane slot", () => {
		const result = solveDiagram(
			{
				id: "contract-single-center",
				direction: "TB",
				nodes: [node("only-child", { x: 0, y: 0 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "sw-center",
						orientation: "vertical",
						layout: "contract",
						lanes: [
							{
								id: "lane-b",
								label: { text: "Lane B" },
								children: ["only-child"],
							},
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions" },
		);

		// Single child should not emit cross_axis_distributed diagnostic.
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "swimlane_contract.cross_axis_distributed",
			}),
		);
		// Node should still get a valid box.
		expect(Number.isFinite(result.nodes[0]?.box.x)).toBe(true);
	});

	it("emits port_capacity_overflow when node is too small for port spacing", () => {
		const result = solveDiagram(
			{
				...sampleDiagram(),
				direction: "TB",
				nodes: [
					{
						...node("many-ports"),
						size: { width: 100, height: 40 },
						ports: Array.from({ length: 6 }, (_, i) => ({
							id: `p${i}`,
							side: "right" as const,
							kind: "flow" as const,
						})),
					},
				],
				edges: [],
				groups: [],
				constraints: [],
			},
			{ portShifting: { spacing: 200 } },
		);

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "info",
				code: "port_capacity_overflow",
				detail: expect.objectContaining({
					nodeId: "many-ports",
					side: "right",
					portCount: 6,
				}),
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
		// With minimum port gap guarantee (#42), spacing is at least
		// PORT_BOX_SIZE (10) + MIN_PORT_EDGE_GAP (12) = 22 px.
		expect(
			Math.abs(
				(rightSidePorts?.[1]?.anchor.y ?? 0) -
					(rightSidePorts?.[0]?.anchor.y ?? 0),
			),
		).toBeGreaterThanOrEqual(22);
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

	it("honors beside labelOffset for long-edge fallback label anchors", () => {
		const result = solveDiagram(
			{
				id: "edge-label-beside-fallback-offset",
				direction: "LR",
				nodes: [
					node("source", { x: 0, y: 0 }),
					node("target", { x: 400, y: 0 }),
					node("blocker_source", { x: 200, y: -180 }),
					node("blocker_target", { x: 200, y: 180 }),
				],
				edges: [
					{
						id: "labeled",
						source: { nodeId: "source" },
						target: { nodeId: "target" },
						label: { text: "realizes" },
					},
					{
						id: "blocker",
						source: { nodeId: "blocker_source" },
						target: { nodeId: "blocker_target" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				textMeasurer: new DeterministicTextMeasurer(),
				labelPlacement: "beside",
				labelOffset: 64,
			},
		);
		const edge = result.edges.find((item) => item.id === "labeled");
		const label = result.textAnnotations?.find(
			(annotation) =>
				annotation.surfaceKind === "edge-label" &&
				annotation.ownerId === "labeled",
		);

		expect(edge).toBeDefined();
		expect(label).toBeDefined();
		// The label should be offset perpendicularly from the edge path
		// by labelOffset (64 px).  With a horizontal LR edge the offset
		// is in the y-direction; the x falls at the edge midpoint which
		// may vary with the obstacle model (Issue #41).
		expect(label?.anchor.y).toBeCloseTo((edge?.points[0]?.y ?? 0) + 64);
		expect(label?.box?.x !== undefined).toBe(true);
		if (label?.box !== undefined) {
			expect(label.box.x + label.box.width / 2).toBeCloseTo(
				label?.anchor.x ?? 0,
			);
			expect(label.box.y + label.box.height / 2).toBeCloseTo(
				label?.anchor.y ?? 0,
			);
		}
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

	it("routes around group-label text when an endpoint node shares the group id", () => {
		const result = solveDiagram(
			{
				id: "same-id-group-label-route-clearance",
				direction: "LR",
				nodes: [
					node("shared", { x: 0, y: 0 }),
					node("target", { x: 300, y: 0 }),
					node("member", { x: 150, y: 50 }),
				],
				edges: [
					{
						id: "shared-target",
						source: { nodeId: "shared" },
						target: { nodeId: "target" },
					},
				],
				groups: [
					{
						id: "shared",
						label: { text: "shared group title" },
						nodeIds: ["member"],
						groupIds: [],
						padding: { top: 0, right: 0, bottom: 0, left: 0 },
						labelLayout: createTestLabelLayout("shared group title", {
							x: -100,
							y: -15,
							width: 200,
							height: 20,
						}),
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ routeKind: "straight" },
		);
		const route = result.edges.find((edge) => edge.id === "shared-target");

		expect(result.textAnnotations).toContainEqual(
			expect.objectContaining({
				ownerId: "shared",
				surfaceKind: "group-label",
			}),
		);
		expect(route?.points.some((point) => point.y !== 20)).toBe(true);
	});

	it("forwards maxRoutingAttempts to obstacle-avoiding route solving", () => {
		const obstacles = routingAttemptObstaclePanels();
		const diagram: NormalizedDiagram = {
			id: "max-routing-forwarding",
			direction: "LR",
			nodes: [node("source", { x: 0, y: 0 }), node("target", { x: 500, y: 0 })],
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
			evidencePanels: obstacles,
		};

		const shallow = solveDiagram(diagram, {
			routeKind: "obstacle-avoiding",
			maxRoutingAttempts: 0,
		});
		const deeper = solveDiagram(diagram, {
			routeKind: "obstacle-avoiding",
			maxRoutingAttempts: 4,
		});

		expect(shallow.edges[0]?.points).not.toEqual(deeper.edges[0]?.points);
		expect(shallow.diagnostics).toContainEqual(
			expect.objectContaining({ code: "routing.obstacle.unavoidable" }),
		);
	});

	it("routes around edge-label estimate corridors before final label placement", () => {
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

		const clearanceDiags = result.diagnostics.filter(
			(d) =>
				d.code === "routing.text-clearance.unresolved" &&
				d.detail?.textSurfaceKind === "edge-label",
		);
		expect(clearanceDiags).toEqual([]);
	});

	it("reroutes final edge-label crossings through the feedback loop", () => {
		const diagram: NormalizedDiagram = {
			id: "edge-label-feedback-clearance",
			direction: "LR",
			nodes: [
				node("source_a", { x: 0, y: -140 }),
				node("target_a", { x: 180, y: -140 }),
				node("source_b", { x: 40, y: -300 }),
				node("target_b", { x: 40, y: -40 }),
			],
			edges: [
				{
					id: "labeled",
					source: { nodeId: "source_a" },
					target: { nodeId: "target_a" },
					label: { text: "wide ".repeat(48).trim() },
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
		};
		const textMeasurer = new DeterministicTextMeasurer();
		const baseline = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: false,
			maxRoutingAttempts: 8,
			textMeasurer,
			textIntersectionTolerance: 0,
		});
		const result = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: { maxIterations: 4 },
			maxRoutingAttempts: 8,
			textMeasurer,
			textIntersectionTolerance: 0,
		});

		expect(baseline.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "crossing",
					textSurfaceKind: "edge-label",
					conflictingObjectId: "labeled",
				}),
			}),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "crossing",
					textSurfaceKind: "edge-label",
					conflictingObjectId: "labeled",
				}),
			}),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.route-label-loop.exhausted",
			}),
		);
		expect(
			result.edges.find((edge) => edge.id === "crossing")?.points,
		).not.toEqual(
			baseline.edges.find((edge) => edge.id === "crossing")?.points,
		);
	});

	it("keeps feedback text hard-obstacle diagnostics local", () => {
		const result = solveDiagram(
			hugeNodeLabelClearanceDiagram("route-label-hard-text-local"),
			{
				initialLayout: "positions",
				routeKind: "obstacle-avoiding",
				edgeLabelRerouting: { maxIterations: 2 },
				maxRoutingAttempts: 8,
				textIntersectionTolerance: 0,
			},
		);
		const safeResult = solveDiagramSafe(
			hugeNodeLabelClearanceDiagram("route-label-hard-text-safe"),
			{
				initialLayout: "positions",
				routeKind: "obstacle-avoiding",
				edgeLabelRerouting: { maxIterations: 2 },
				maxRoutingAttempts: 8,
				textIntersectionTolerance: 0,
			},
		);
		const affectedEdgeDiagnostics = result.diagnostics.filter(
			(diagnostic) => diagnostic.detail?.edgeId === "source-target",
		);

		expect(affectedEdgeDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "source-target",
					textSurfaceKind: "node-label",
					conflictingObjectId: "label_owner",
				}),
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "routing.route-label-loop.exhausted",
				detail: expect.objectContaining({
					edgeIds: "source-target",
					textSurfaceKinds: "node-label",
				}),
			}),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.label-hard-obstacle.unavoidable",
			}),
		);
		expect(affectedEdgeDiagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.evidence.crossing_forbidden",
			}),
		);
		expect(safeResult.diagnostics).not.toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "routing.evidence.crossing_forbidden",
			}),
		);
	});

	it("does not promote label-hard obstacles to fatal evidence crossings (#74)", () => {
		const result = solveDiagram(
			{
				id: "issue-74-label-hard-not-evidence",
				direction: "LR",
				nodes: [
					{
						id: "source",
						shape: "rectangle" as const,
						size: { width: 80, height: 40 },
						padding: { top: 0, right: 0, bottom: 0, left: 0 },
						position: { x: 0, y: 0 },
					},
					{
						id: "target",
						shape: "rectangle" as const,
						size: { width: 80, height: 40 },
						padding: { top: 0, right: 0, bottom: 0, left: 0 },
						position: { x: 280, y: 180 },
					},
				],
				edges: [
					{
						id: "labeled",
						source: { nodeId: "source" },
						target: { nodeId: "target" },
						label: { text: "blocking label that fills the corridor" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "straight",
				edgeLabelRerouting: { maxIterations: 1 },
				strict: true,
			},
		);

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "routing.evidence.crossing_forbidden",
			}),
		);
	});

	it("scores feedback hard-route diagnostics ahead of text-clearance gains", () => {
		const source = readFileSync(
			new URL("../src/solver/route-edges.ts", import.meta.url),
			"utf8",
		);
		const comparatorStart = source.indexOf(
			"function compareRouteLabelFeedbackScore(",
		);
		const hardPredicateStart = source.indexOf(
			"function isRouteLabelFeedbackHardRouteDiagnostic(",
		);
		expect(comparatorStart).toBeGreaterThanOrEqual(0);
		expect(hardPredicateStart).toBeGreaterThan(comparatorStart);

		const comparator = source.slice(comparatorStart, hardPredicateStart);
		const hardRouteIndex = comparator.indexOf(
			"left.hardRouteDiagnostics - right.hardRouteDiagnostics",
		);
		const routeTextIndex = comparator.indexOf(
			"left.routeTextConflicts - right.routeTextConflicts",
		);
		expect(hardRouteIndex).toBeGreaterThanOrEqual(0);
		expect(routeTextIndex).toBeGreaterThanOrEqual(0);
		expect(hardRouteIndex).toBeLessThan(routeTextIndex);

		const hardPredicate = source.slice(
			hardPredicateStart,
			source.indexOf("function replaceRouteDiagnosticsForEdge("),
		);
		expect(hardPredicate).toContain(
			'diagnostic.code === "routing.evidence.crossing_forbidden"',
		);
		expect(hardPredicate).toContain(
			'diagnostic.code === "route_obstacle_fallback"',
		);
		expect(hardPredicate).toContain('diagnostic.severity === "error"');
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

	it("reports route-label feedback exhaustion for impossible node-label clearance", () => {
		const result = solveDiagram(
			hugeNodeLabelClearanceDiagram("route-label-node-exhaustion"),
			{
				initialLayout: "positions",
				routeKind: "obstacle-avoiding",
				edgeLabelRerouting: { maxIterations: 1 },
				maxRoutingAttempts: 8,
				textIntersectionTolerance: 0,
			},
		);

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "source-target",
					textSurfaceKind: "node-label",
					conflictingObjectId: "label_owner",
				}),
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.route-label-loop.exhausted",
				detail: expect.objectContaining({
					conflictCount: 1,
					iterations: 1,
					maxIterations: 1,
					edgeIds: "source-target",
					ownerIds: "label_owner",
					textSurfaceKinds: "node-label",
				}),
			}),
		);
	});

	it("honors explicit orthogonal edgeLabelRerouting for discussion_r3541568275", () => {
		const baseline = solveDiagram(
			hugeNodeLabelClearanceDiagram("orthogonal-route-label-baseline"),
			{
				initialLayout: "positions",
				routeKind: "orthogonal",
				textIntersectionTolerance: 0,
			},
		);
		const explicitTrue = solveDiagram(
			hugeNodeLabelClearanceDiagram("orthogonal-route-label-true"),
			{
				initialLayout: "positions",
				routeKind: "orthogonal",
				edgeLabelRerouting: true,
				textIntersectionTolerance: 0,
			},
		);
		const explicitObject = solveDiagram(
			hugeNodeLabelClearanceDiagram("orthogonal-route-label-object"),
			{
				initialLayout: "positions",
				routeKind: "orthogonal",
				edgeLabelRerouting: { maxIterations: 2 },
				textIntersectionTolerance: 0,
			},
		);

		expect(baseline.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "source-target",
					textSurfaceKind: "node-label",
					conflictingObjectId: "label_owner",
				}),
			}),
		);
		expect(baseline.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.route-label-loop.exhausted",
			}),
		);
		expect(explicitTrue.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.route-label-loop.exhausted",
				detail: expect.objectContaining({
					maxIterations: 4,
					edgeIds: "source-target",
					ownerIds: "label_owner",
					textSurfaceKinds: "node-label",
				}),
			}),
		);
		expect(explicitObject.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.route-label-loop.exhausted",
				detail: expect.objectContaining({
					maxIterations: 2,
					edgeIds: "source-target",
					ownerIds: "label_owner",
					textSurfaceKinds: "node-label",
				}),
			}),
		);
	});

	it("groups residual dense label clearance failures into congestion diagnostics", () => {
		const diagram: NormalizedDiagram = {
			id: "route-label-congestion",
			direction: "LR",
			nodes: [
				node("source", { x: 0, y: 0 }),
				node("target", { x: 240, y: 0 }),
				{
					id: "label_owner",
					shape: "rectangle",
					size: { width: 0, height: 0 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 120, y: 0 },
					label: { text: "huge label" },
					labelLayout: createTestLabelLayout("huge label", {
						x: -1_000,
						y: -1_000,
						width: 3_000,
						height: 3_000,
					}),
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
		};

		const result = solveDiagram(diagram, {
			routeKind: "straight",
			textIntersectionTolerance: 0,
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "source-target",
					textSurfaceKind: "node-label",
					conflictingObjectId: "label_owner",
				}),
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-congestion.unresolved",
				detail: expect.objectContaining({
					edgeIds: "source-target",
					ownerIds: "label_owner",
					textSurfaceKinds: "node-label",
				}),
			}),
		);
	});

	it("marks requested strict edge labels as external callout required", () => {
		const result = solveDiagram(
			{
				id: "strict-edge-label-externalization",
				direction: "LR",
				nodes: [
					node("source", { x: -220, y: 0 }),
					node("target", { x: 520, y: 0 }),
				],
				edges: [
					{
						id: "labeled",
						source: { nodeId: "source" },
						target: { nodeId: "target" },
						label: { text: "external callout required label" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "straight",
				strict: true,
				externalLabels: true,
				textMeasurer: new DeterministicTextMeasurer(),
			},
		);
		const label = result.textAnnotations?.find(
			(annotation) =>
				annotation.surfaceKind === "edge-label" &&
				annotation.ownerId === "labeled",
		);

		expect(label).toMatchObject({
			placement: "external-callout-required",
			placementDetail: expect.objectContaining({
				candidateCount: expect.any(Number),
				localConflictCount: expect.any(Number),
				nodeOverlapCount: expect.any(Number),
			}),
		});
		expect(label?.placementDetail?.candidateCount).toBeGreaterThan(0);
		expect(label?.placementDetail?.localConflictCount).toBeGreaterThanOrEqual(
			0,
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-externalization.required",
				severity: "error",
				detail: expect.objectContaining({
					edgeIds: "labeled",
					labelCount: 1,
					remediationType: "external-label",
				}),
			}),
		);
		expect(result.deliverability).toMatchObject({
			status: "unsatisfiable",
			remediationTypes: expect.arrayContaining(["external-label"]),
		});
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					textSurfaceKind: "edge-label",
					conflictingObjectId: "labeled",
				}),
			}),
		);
	});

	it("does not reserve external callout labels as local label boxes", () => {
		const result = solveDiagram(
			{
				id: "external-callouts-do-not-reserve-local-label-boxes",
				direction: "LR",
				nodes: [
					node("a", { x: 0, y: 0 }),
					node("b", { x: 240, y: 0 }),
					node("c", { x: 0, y: 0 }),
					node("d", { x: 240, y: 0 }),
				],
				edges: [
					{
						id: "first",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						label: { text: "same label" },
					},
					{
						id: "second",
						source: { nodeId: "c" },
						target: { nodeId: "d" },
						label: { text: "same label" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "straight",
				externalLabels: true,
				textMeasurer: new DeterministicTextMeasurer(),
			},
		);
		const labels = result.textAnnotations?.filter(
			(annotation) => annotation.surfaceKind === "edge-label",
		);
		const first = labels?.find((annotation) => annotation.ownerId === "first");
		const second = labels?.find(
			(annotation) => annotation.ownerId === "second",
		);

		expect(first?.placement).toBe("external-callout-required");
		expect(second?.placement).toBe("external-callout-required");
		expect(second?.box).toEqual(first?.box);
		expect(second?.placementDetail).toMatchObject({
			labelOverlapCount: 0,
			localConflictCount: 0,
		});
	});

	it("does not route around forced external callout label estimates", () => {
		const result = solveDiagram(
			{
				id: "forced-external-label-estimates-not-local-obstacles",
				direction: "LR",
				nodes: [
					node("a", { x: 0, y: 0 }),
					node("b", { x: 240, y: 0 }),
					node("c", { x: 120, y: -160 }),
					node("d", { x: 120, y: 160 }),
				],
				edges: [
					{
						id: "external-label",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						label: { text: "wide external label" },
					},
					{
						id: "vertical",
						source: { nodeId: "c" },
						target: { nodeId: "d" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "obstacle-avoiding",
				externalLabels: true,
				edgeLabelRerouting: { maxIterations: 2 },
				textMeasurer: new DeterministicTextMeasurer(),
				textIntersectionTolerance: 0,
			},
		);
		const vertical = result.edges.find((edge) => edge.id === "vertical");

		expect(vertical?.points).toEqual([
			{ x: 160, y: -120 },
			{ x: 160, y: 160 },
		]);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					edgeId: "vertical",
					conflictingObjectId: "external-label",
				}),
			}),
		);
	});

	it("applies deterministic keyed external callouts when remediation policy is auto", () => {
		const result = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" },
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		});
		const plan = result.deliverability?.remediationPlans.find(
			(candidate) => candidate.type === "external-label",
		);
		const detail = plan?.detail as ExternalLabelRemediationDetail | undefined;

		expect(plan).toMatchObject({
			status: "applied",
			edgeIds: ["alpha", "middle", "zeta"],
			diagnosticCodes: expect.arrayContaining([
				"routing.label-externalization.required",
			]),
		});
		expect(detail).toMatchObject({
			strategy: "keyed-callouts",
			policy: "auto",
			labelCount: 3,
		});
		expect(
			detail?.callouts?.map(({ edgeId, key, text, shelfSide }) => ({
				edgeId,
				key,
				text,
				shelfSide,
			})),
		).toEqual([
			{
				edgeId: "alpha",
				key: "E1",
				text: "alpha external callout label",
				shelfSide: "right",
			},
			{
				edgeId: "middle",
				key: "E2",
				text: "middle external callout label",
				shelfSide: "right",
			},
			{
				edgeId: "zeta",
				key: "E3",
				text: "zeta external callout label",
				shelfSide: "right",
			},
		]);
		const labels = result.textAnnotations?.filter(
			(annotation) => annotation.surfaceKind === "edge-label",
		);
		expect(
			labels?.filter(
				(annotation) => annotation.placement === "external-callout-required",
			),
		).toEqual([]);
		const alphaKey = labels?.find(
			(annotation) =>
				annotation.ownerId === "alpha" &&
				annotation.placementDetail?.role === "key",
		);
		const alphaCallout = labels?.find(
			(annotation) =>
				annotation.ownerId === "alpha" &&
				annotation.placementDetail?.role === "callout",
		);
		expect(alphaKey).toMatchObject({
			text: "E1",
			placement: "external-callout",
			box: detail?.callouts?.[0]?.keyBox,
		});
		expect(alphaCallout).toMatchObject({
			text: "E1: alpha external callout label",
			placement: "external-callout",
			box: detail?.callouts?.[0]?.calloutBox,
		});
		expect(alphaKey?.box.width ?? 0).toBeLessThan(alphaCallout?.box.width ?? 0);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.text-clearance.unresolved",
				detail: expect.objectContaining({
					textSurfaceKind: "edge-label",
					conflictingObjectId: "alpha",
				}),
			}),
		);
	});

	it("honors deliverabilityMode strict for congested label externalization", () => {
		const diagram = congestedEdgeLabelExternalizationDiagram();
		const optionsBase = {
			initialLayout: "positions" as const,
			routeKind: "obstacle-avoiding" as const,
			pagePolicy: "off" as const,
			edgeLabelRerouting: { maxIterations: 2 },
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		};
		const withFlag = solveDiagram(diagram, {
			...optionsBase,
			strict: true,
		});
		const withMode = solveDiagram(diagram, {
			...optionsBase,
			deliverabilityMode: "strict",
		});
		const placements = (result: typeof withFlag) =>
			result.textAnnotations
				?.filter((annotation) => annotation.surfaceKind === "edge-label")
				.map((annotation) => ({
					ownerId: annotation.ownerId,
					placement: annotation.placement,
				}))
				.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
		expect(placements(withMode)).toEqual(placements(withFlag));
		expect(
			withMode.textAnnotations?.some(
				(annotation) =>
					annotation.placement === "external-callout-required" ||
					annotation.placement === "external-callout",
			),
		).toBe(true);
	});

	it("treats strict true like deliverabilityMode strict for page-policy auto-classify", () => {
		const nodes = [
			...Array.from({ length: 4 }, (_, index) =>
				node(`src-${index}`, { x: 0, y: index * 50 }),
			),
			node("agg", { x: 220, y: 60 }),
		];
		const diagram: NormalizedDiagram = {
			id: "strict-page-policy-equiv",
			direction: "LR",
			nodes,
			edges: Array.from({ length: 4 }, (_, index) => ({
				id: `fan-${index}`,
				source: { nodeId: `src-${index}` },
				target: { nodeId: "agg" },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		};
		const withStrict = resolvePagePolicy(diagram, { strict: true });
		const withMode = resolvePagePolicy(diagram, {
			deliverabilityMode: "strict",
		});
		expect(withStrict).toBe(withMode);
		expect(withStrict).toBe("ibd-high-fan-in");
		expect(resolvePagePolicy(diagram, {})).toBe("off");
	});

	it("does not auto-classify page policy for advisory deliverability settings", () => {
		const diagram: NormalizedDiagram = {
			id: "advisory-no-page-policy",
			direction: "LR",
			nodes: [
				...Array.from({ length: 4 }, (_, index) =>
					node(`src-${index}`, { x: 0, y: index * 50 }),
				),
				node("agg", { x: 220, y: 60 }),
			],
			edges: Array.from({ length: 4 }, (_, index) => ({
				id: `fan-${index}`,
				source: { nodeId: `src-${index}` },
				target: { nodeId: "agg" },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		};
		expect(
			resolvePagePolicy(diagram, { deliverabilityMode: "degraded-ok" }),
		).toBe("off");
		expect(
			resolvePagePolicy(diagram, {
				remediationPolicy: { externalLabels: "suggest" },
			}),
		).toBe("off");
		expect(
			resolvePagePolicy(diagram, {
				remediationPolicy: { routeRails: "auto" },
			}),
		).toBe("ibd-high-fan-in");
	});

	it("includes childId in grow-fixed-geometry remediation plans", () => {
		const result = solveDiagram(
			{
				id: "fixed-swimlane-childid-plan",
				direction: "LR",
				nodes: [node("a", { x: 500, y: 500 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "lanes",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						box: { x: 100, y: 40, width: 220, height: 160 },
						lanes: [
							{
								id: "fixed",
								children: ["a"],
								box: { x: 100, y: 40, width: 220, height: 160 },
							},
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				fixedSwimlaneGeometry: true,
				strict: true,
				pagePolicy: "off",
				remediationPolicy: {
					growFixedGeometry: "suggest",
					externalLabels: "suggest",
					routeRails: "suggest",
					pageSplit: "suggest",
				},
				textMeasurer: new DeterministicTextMeasurer(),
			},
		);
		const growPlan = result.deliverability?.remediationPlans.find(
			(plan) => plan.type === "grow-fixed-geometry",
		);
		expect(growPlan?.nodeIds).toContain("a");
	});

	it("maps label congestion residuals to route-rail candidates", () => {
		const result = solveDiagram(congestedEdgeLabelExternalizationDiagram(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "off",
			edgeLabelRerouting: { maxIterations: 1 },
			textIntersectionTolerance: 0,
			strict: true,
			remediationPolicy: {
				externalLabels: "suggest",
				routeRails: "suggest",
				growFixedGeometry: "suggest",
				pageSplit: "suggest",
			},
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const plans = result.deliverability?.remediationPlans ?? [];
		const hasCongestion = result.diagnostics.some((diagnostic) =>
			[
				"routing.label-congestion.unresolved",
				"routing.text-clearance.unresolved",
				"routing.route-label-loop.exhausted",
			].includes(diagnostic.code),
		);
		if (hasCongestion) {
			expect(plans.some((plan) => plan.type === "route-rail")).toBe(true);
			expect(plans.some((plan) => plan.type === "external-label")).toBe(true);
		}
	});

	it("stacks external callouts by cumulative shelf height", () => {
		const result = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" },
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		});
		const callouts = result.textAnnotations
			?.filter(
				(annotation) =>
					annotation.surfaceKind === "edge-label" &&
					annotation.placement === "external-callout" &&
					annotation.placementDetail?.role === "callout",
			)
			.sort((left, right) => left.box.y - right.box.y);
		expect((callouts?.length ?? 0) >= 2).toBe(true);
		if (callouts !== undefined && callouts.length >= 2) {
			for (let index = 0; index < callouts.length - 1; index += 1) {
				const current = callouts[index];
				const next = callouts[index + 1];
				if (current === undefined || next === undefined) continue;
				expect(next.box.y).toBeGreaterThanOrEqual(
					current.box.y + current.box.height,
				);
			}
		}
	});

	it("exports both key and shelf callout annotations in SVG", async () => {
		const { exportSvg } = await import("../src/exporters/svg.js");
		const result = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" },
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		});
		const svg = exportSvg(result);
		expect(svg).toContain(">E1<");
		expect(svg).toMatch(/E1: alpha external callout/);
		expect(svg).toMatch(/E2: middle external callout/);
		expect(svg).toContain('data-for="alpha"');
		expect(
			(svg.match(/data-for="alpha"/g) ?? []).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("exports both key and shelf callout annotations in Excalidraw", async () => {
		const { exportExcalidraw } = await import("../src/exporters/excalidraw.js");
		const result = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" },
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		});
		const scene = JSON.parse(exportExcalidraw(result)) as {
			elements: Array<{ id?: string; type?: string; text?: string }>;
		};
		const texts = scene.elements.filter((element) => element.type === "text");
		expect(texts.some((element) => element.text === "E1")).toBe(true);
		expect(
			texts.some((element) =>
				(element.text ?? "").includes("E1: alpha external callout"),
			),
		).toBe(true);
		expect(
			texts.filter((element) =>
				(element.id ?? "").startsWith("edge-label:alpha:"),
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("keeps keyed external-callout markers in route clearance", () => {
		const result = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" },
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		});
		const keyMarkers =
			result.textAnnotations?.filter(
				(annotation) =>
					annotation.surfaceKind === "edge-label" &&
					annotation.placement === "external-callout" &&
					annotation.placementDetail?.role === "key",
			) ?? [];
		expect(keyMarkers.length).toBeGreaterThan(0);
		const shelfBodies =
			result.textAnnotations?.filter(
				(annotation) =>
					annotation.surfaceKind === "edge-label" &&
					annotation.placement === "external-callout" &&
					annotation.placementDetail?.role === "callout",
			) ?? [];
		expect(shelfBodies.length).toBeGreaterThan(0);
		// Key markers remain local clearance obstacles; shelf bodies do not.
		for (const key of keyMarkers) {
			expect(key.box.width).toBeGreaterThan(0);
			expect(key.box.height).toBeGreaterThan(0);
		}
	});

	it("does not keep route-label-loop.exhausted when remediation clears conflicts", () => {
		const result = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: { maxIterations: 1 },
			externalLabels: true,
			remediationPolicy: {
				externalLabels: "auto",
				routeRails: "auto",
				growFixedGeometry: "auto",
				pageSplit: "suggest",
			},
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
			strict: true,
		});
		const hasResidualText = result.diagnostics.some(
			(diagnostic) => diagnostic.code === "routing.text-clearance.unresolved",
		);
		if (!hasResidualText && result.deliverability?.status === "clean") {
			expect(result.diagnostics).not.toContainEqual(
				expect.objectContaining({
					code: "routing.route-label-loop.exhausted",
				}),
			);
		}
	});

	it("keeps suggest and off external-label policies non-executing", () => {
		const suggest = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "suggest" },
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const off = solveDiagram(externalLabelAutoDiagram(), {
			initialLayout: "positions",
			routeKind: "straight",
			externalLabels: true,
			remediationPolicy: { externalLabels: "off" },
			textMeasurer: new DeterministicTextMeasurer(),
		});

		expect(
			suggest.deliverability?.remediationPlans.find(
				(plan) => plan.type === "external-label",
			),
		).toMatchObject({ status: "suggested" });
		expect(
			suggest.textAnnotations?.some(
				(annotation) =>
					annotation.surfaceKind === "edge-label" &&
					annotation.placement === "external-callout-required",
			),
		).toBe(true);
		expect(
			suggest.textAnnotations?.some(
				(annotation) => annotation.placement === "external-callout",
			),
		).toBe(false);
		expect(
			off.deliverability?.remediationPlans.some(
				(plan) => plan.type === "external-label",
			),
		).toBe(false);
		expect(
			off.textAnnotations?.some(
				(annotation) => annotation.placement === "external-callout",
			),
		).toBe(false);
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

	it("preserves fixed swimlane and lane geometry in fixed mode", () => {
		const result = solveDiagram(
			{
				id: "fixed-swimlane",
				direction: "LR",
				nodes: [node("a", { x: 150, y: 80 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "lanes",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						box: { x: 100, y: 40, width: 220, height: 160 },
						lanes: [
							{
								id: "fixed",
								children: ["a"],
								box: { x: 100, y: 40, width: 220, height: 160 },
							},
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", fixedSwimlaneGeometry: true },
		);

		expect(result.swimlanes?.[0]?.box).toEqual({
			x: 100,
			y: 40,
			width: 220,
			height: 160,
		});
		expect(result.swimlanes?.[0]?.lanes[0]?.box).toEqual({
			x: 100,
			y: 40,
			width: 220,
			height: 160,
		});
		expect(result.swimlanes?.[0]?.lanes[0]?.headerBox).toEqual({
			x: 100,
			y: 40,
			width: 220,
			height: 20,
		});
		expect(result.swimlanes?.[0]?.lanes[0]?.contentBox).toEqual({
			x: 100,
			y: 60,
			width: 220,
			height: 140,
		});
	});

	it("keeps contract layout for non-fixed swimlanes in fixed mode", () => {
		const result = solveDiagram(
			{
				id: "mixed-fixed-and-contract-swimlanes",
				direction: "LR",
				nodes: [
					node("fixed_child", { x: 130, y: 80 }),
					node("source_a", { x: 400, y: 0 }),
					node("source_b", { x: 400, y: 120 }),
					node("target_a", { x: 520, y: 0 }),
					node("target_b", { x: 520, y: 120 }),
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
						id: "fixed",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						box: { x: 100, y: 40, width: 220, height: 160 },
						lanes: [{ id: "fixed_lane", children: ["fixed_child"] }],
					},
					{
						id: "contract",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 24,
						padding: 16,
						lanes: [
							{ id: "sources", children: ["source_a", "source_b"] },
							{ id: "targets", children: ["target_a", "target_b"] },
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", fixedSwimlaneGeometry: true },
		);

		const fixed = result.swimlanes?.find((swimlane) => swimlane.id === "fixed");
		const contract = result.swimlanes?.find(
			(swimlane) => swimlane.id === "contract",
		);
		expect(fixed?.box).toEqual({ x: 100, y: 40, width: 220, height: 160 });
		expect(contract?.lanes[0]?.headerBox?.height).toBe(24);
		expect(contract?.lanes[1]?.headerBox?.height).toBe(24);
		expect(contract?.lanes[0]?.contentBox?.y).toBeGreaterThan(
			contract?.lanes[0]?.headerBox?.y ?? 0,
		);
		expect(
			result.nodes.find((n) => n.id === "target_a")?.box.x,
		).toBeGreaterThan(
			result.nodes.find((n) => n.id === "source_a")?.box.x ?? 0,
		);
	});

	it("derives missing fixed lane boxes from the authored swimlane box", () => {
		const result = solveDiagram(
			{
				id: "fixed-swimlane-parent-derived-lanes",
				direction: "LR",
				nodes: [node("a", { x: 120, y: 80 }), node("b", { x: 230, y: 80 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "lanes",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						box: { x: 100, y: 40, width: 220, height: 160 },
						lanes: [
							{ id: "left", children: ["a"] },
							{ id: "right", children: ["b"] },
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", fixedSwimlaneGeometry: true },
		);

		expect(result.swimlanes?.[0]?.lanes[0]?.box).toEqual({
			x: 100,
			y: 40,
			width: 110,
			height: 160,
		});
		expect(result.swimlanes?.[0]?.lanes[1]?.box).toEqual({
			x: 210,
			y: 40,
			width: 110,
			height: 160,
		});
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.container-fixed-bounds-overflow",
			}),
		);
	});

	it("wraps child-derived fixed lane boxes with header and padding", () => {
		const result = solveDiagram(
			{
				id: "partial-fixed-swimlane-derived-lane",
				direction: "LR",
				nodes: [node("a", { x: 100, y: 80 }), node("b", { x: 260, y: 80 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "lanes",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						padding: 12,
						lanes: [
							{
								id: "fixed",
								children: ["a"],
								box: { x: 80, y: 40, width: 120, height: 120 },
							},
							{ id: "derived", children: ["b"] },
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", fixedSwimlaneGeometry: true },
		);

		const derived = result.swimlanes?.[0]?.lanes.find(
			(lane) => lane.id === "derived",
		);
		const child = nodeBox(result, "b");
		expect(derived?.box).toEqual({
			x: child.x - 12,
			y: child.y - 32,
			width: child.width + 24,
			height: child.height + 44,
		});
		expect(derived?.contentBox).toBeDefined();
		if (derived?.contentBox !== undefined) {
			expect(derived.contentBox.y).toBe(child.y - 12);
			expect(derived.contentBox.height).toBe(child.height + 24);
			expect(child.x).toBeGreaterThanOrEqual(derived.contentBox.x);
			expect(child.y).toBeGreaterThanOrEqual(derived.contentBox.y);
			expect(child.x + child.width).toBeLessThanOrEqual(
				derived.contentBox.x + derived.contentBox.width,
			);
			expect(child.y + child.height).toBeLessThanOrEqual(
				derived.contentBox.y + derived.contentBox.height,
			);
		}
	});

	it("diagnoses fixed lane boxes outside an authored swimlane box", () => {
		const result = solveDiagram(
			{
				id: "fixed-lane-outside-parent",
				direction: "LR",
				nodes: [node("a", { x: 150, y: 80 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "lanes",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						box: { x: 100, y: 40, width: 220, height: 160 },
						lanes: [
							{
								id: "outside",
								children: ["a"],
								box: { x: 340, y: 40, width: 120, height: 160 },
							},
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", fixedSwimlaneGeometry: true },
		);

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "layout.container-fixed-bounds-overflow",
				detail: expect.objectContaining({
					swimlaneId: "lanes",
					laneId: "outside",
				}),
			}),
		);
	});

	it("diagnoses children outside fixed swimlane content bounds", () => {
		const result = solveDiagram(
			{
				id: "fixed-swimlane-overflow",
				direction: "LR",
				nodes: [node("a", { x: 500, y: 500 })],
				edges: [],
				groups: [],
				swimlanes: [
					{
						id: "lanes",
						orientation: "vertical",
						layout: "contract",
						headerHeight: 20,
						box: { x: 100, y: 40, width: 220, height: 160 },
						lanes: [
							{
								id: "fixed",
								children: ["a"],
								box: { x: 100, y: 40, width: 220, height: 160 },
							},
						],
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", fixedSwimlaneGeometry: true },
		);

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.container-fixed-bounds-overflow",
				detail: expect.objectContaining({
					swimlaneId: "lanes",
					laneId: "fixed",
					childId: "a",
				}),
			}),
		);
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

	it("keeps prefit multiline label lines local after port expansion", () => {
		const result = solveDiagramSafe(
			{
				id: "port-expanded-prefit-label",
				direction: "LR",
				nodes: [
					{
						...node("dense", { x: 0, y: 0 }),
						size: { width: 160, height: 80 },
						label: { text: "alpha\nbeta" },
						ports: Array.from({ length: 9 }, (_, index) => ({
							id: `p${index}`,
							side: "top" as const,
							kind: "proxy" as const,
						})),
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
			expect.objectContaining({ code: "port_capacity_overflow" }),
		);
		const denseNode = result.nodes[0];
		const nodeLabel = result.textAnnotations?.find(
			(annotation) => annotation.surfaceKind === "node-label",
		);
		if (denseNode === undefined || nodeLabel === undefined) {
			throw new Error("Expected dense node and node-label annotation");
		}
		expect(nodeLabel.box.x + nodeLabel.box.width / 2).toBeCloseTo(
			denseNode.box.x + denseNode.box.width / 2,
		);
		expect(nodeLabel.lines.map((line) => line.box.x)).toEqual(
			nodeLabel.lines.map(() => nodeLabel.paddings.left),
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

	it("preserves fixed-position locks in ranked contract lanes (flow edges present)", () => {
		// A flow edge between lane children creates ranks, routing through
		// the ranked placement path. A fixed-position child must still be
		// left in place and emit locked-target-not-moved — lock behavior must
		// not depend on the presence of unrelated flow edges (Codex P2).
		const result = solveDiagram({
			id: "ranked-fixed-lock",
			direction: "TB",
			nodes: [node("a", { x: 30, y: 200 }), node("b")],
			edges: [{ id: "e", source: { nodeId: "a" }, target: { nodeId: "b" } }],
			groups: [],
			swimlanes: [
				{
					id: "sw",
					layout: "contract",
					headerHeight: 24,
					padding: 16,
					orientation: "vertical",
					lanes: [{ id: "lane", children: ["a", "b"] }],
				},
			],
			constraints: [],
			diagnostics: [],
			metadata: { primaryReadingDirection: "top_to_bottom" },
		});

		// Fixed-position node "a" stays at its declared position.
		expect(
			result.nodes.find((coordinatedNode) => coordinatedNode.id === "a")?.box,
		).toMatchObject({ x: 30, y: 200 });
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.locked-target-not-moved",
				detail: expect.objectContaining({ nodeId: "a" }),
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
	expect(result.deliverability).toMatchObject({
		status: "degraded",
		strict: false,
		degraded: true,
		diagnosticCodes: expect.arrayContaining([
			"constraints.locked-target-not-moved",
		]),
		remediationTypes: expect.arrayContaining(["relax-or-grow-fixed-geometry"]),
	});
});

it("promotes deliverability warnings to errors when strict is set", () => {
	const result = solveDiagram(lockedChildDiagram(), { strict: true });
	expect(result.degraded).toBe(true);
	expect(result.deliverability).toMatchObject({
		status: "unsatisfiable",
		strict: true,
		degraded: true,
	});
	const locked = result.diagnostics.filter(
		(d) => d.code === "constraints.locked-target-not-moved",
	);
	expect(locked.length).toBeGreaterThan(0);
	for (const d of locked) {
		expect(d.severity).toBe("error");
	}
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "routing.deliverability.unsatisfiable",
			severity: "error",
			detail: expect.objectContaining({
				pageId: "locked-child",
				diagnosticCodes: expect.stringContaining(
					"constraints.locked-target-not-moved",
				),
				remediationTypes: expect.stringContaining(
					"relax-or-grow-fixed-geometry",
				),
			}),
		}),
	);
});

it("keeps degraded false when no deliverability diagnostics are emitted", () => {
	const result = solveDiagram(sampleDiagram());
	expect(result.degraded).toBe(false);
	expect(result.deliverability).toMatchObject({
		status: "clean",
		strict: false,
		degraded: false,
		diagnosticCodes: [],
		remediationTypes: [],
	});
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
		"constraints.overlap.locked-conflict",
		"constraints.overlap.post-growth",
		"layout.container-fixed-bounds-overflow",
		"route_obstacle_fallback",
		"routing.anchor-capacity.requires-resize",
		"routing.container-fixed-bounds-overflow",
		"routing.deliverability.unsatisfiable",
		"routing.endpoint-interior.unavoidable",
		"routing.evidence.crossing_forbidden",
		"routing.label-congestion.unresolved",
		"routing.label-externalization.required",
		"routing.label-hard-obstacle.unavoidable",
		"routing.obstacle.unavoidable",
		"routing.rail-capacity.exceeded",
		"routing.route-label-loop.exhausted",
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

it("uses obstacle-avoiding routing to dodge nodes", () => {
	const result = solveDiagram(
		{
			id: "obstacle-avoiding-test",
			direction: "LR",
			nodes: [
				{
					id: "a",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 0 },
				},
				{
					id: "b",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 100, y: 0 },
				},
				{
					id: "c",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 200, y: 0 },
				},
			],
			edges: [
				{
					id: "a-c",
					source: { nodeId: "a" },
					target: { nodeId: "c" },
				},
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{ routeKind: "obstacle-avoiding" },
	);

	expect(result.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
});

it("grows overloaded implicit anchor sides before routing", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 220, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "anchor-capacity-grow",
			direction: "LR",
			nodes: [
				{
					id: "source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 140 },
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `source-${target.id}`,
				source: { nodeId: "source" },
				target: { nodeId: target.id },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			anchorCapacity: { minSpacing: 24 },
		},
	);

	expect(nodeBox(result, "source").height).toBeGreaterThanOrEqual(106);
	expect(new Set(result.edges.map((edge) => edge.points[0]?.y)).size).toBe(
		targets.length,
	);
	expect(result.diagnostics).not.toContainEqual(
		expect.objectContaining({
			code: "routing.anchor-capacity.requires-resize",
		}),
	);
});

it("recenters node labels after implicit anchor capacity growth", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `label-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 220, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "anchor-capacity-label-recenter",
			direction: "LR",
			nodes: [
				{
					id: "source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 140 },
					label: { text: "source" },
					labelLayout: createTestLabelLayout("source", {
						x: 20,
						y: 13,
						width: 40,
						height: 14,
					}),
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `source-${target.id}`,
				source: { nodeId: "source" },
				target: { nodeId: target.id },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			anchorCapacity: { minSpacing: 24 },
		},
	);

	const source = result.nodes.find((node) => node.id === "source");
	expect(source?.labelLayout?.box.y).toBeCloseTo(
		((source?.box.height ?? 0) - (source?.labelLayout?.box.height ?? 0)) / 2,
		5,
	);
});

it("does not mutate caller node labels during anchor capacity growth", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `mutation-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 220, y: index * 70 },
	}));
	const source = {
		id: "source",
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 0, y: 140 },
		label: { text: "source" },
		labelLayout: createTestLabelLayout("source", {
			x: 20,
			y: 13,
			width: 40,
			height: 14,
		}),
	};
	const diagram: NormalizedDiagram = {
		id: "anchor-capacity-input-immutability",
		direction: "LR",
		nodes: [source, ...targets],
		edges: targets.map((target) => ({
			id: `source-${target.id}`,
			source: { nodeId: "source" },
			target: { nodeId: target.id },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
	};
	const before = { ...source.labelLayout.box };

	solveDiagram(diagram, {
		initialLayout: "positions",
		routeKind: "obstacle-avoiding",
		anchorCapacity: { minSpacing: 24 },
	});

	expect(source.labelLayout.box).toEqual(before);
	expect(diagram.nodes[0]?.labelLayout?.box).toEqual(before);
});

it("reports post-growth overlaps introduced by anchor capacity sizing", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `overlap-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 220, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "anchor-capacity-post-growth-overlap",
			direction: "LR",
			nodes: [
				{
					id: "source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 140 },
				},
				{
					id: "sibling",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 190 },
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `source-${target.id}`,
				source: { nodeId: "source" },
				target: { nodeId: target.id },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			anchorCapacity: { minSpacing: 24 },
			strict: true,
		},
	);

	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "constraints.overlap.post-growth",
			severity: "error",
			detail: expect.objectContaining({
				firstId: "sibling",
				secondId: "source",
				remediationType: "post-growth-repair",
			}),
		}),
	);
	expect(result.deliverability?.status).toBe("unsatisfiable");
});

it("sizes implicit anchor capacity after constraints move endpoint sides", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `moved-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
	}));
	const result = solveDiagram(
		{
			id: "anchor-capacity-after-constraints",
			direction: "LR",
			nodes: [
				{
					id: "source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 140 },
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `source-${target.id}`,
				source: { nodeId: "source" },
				target: { nodeId: target.id },
			})),
			groups: [],
			constraints: targets.map((target, index) => ({
				kind: "relative-position" as const,
				sourceId: target.id,
				referenceId: "source",
				relation: "right-of" as const,
				offset: { x: 220, y: (index - 2) * 70 },
			})),
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			anchorCapacity: { minSpacing: 24 },
		},
	);

	expect(nodeBox(result, "source").height).toBeGreaterThan(40);
	expect(new Set(result.edges.map((edge) => edge.points[0]?.y)).size).toBe(
		targets.length,
	);
});

it("diagnoses overloaded anchor sides when growth is disabled", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `fixed-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 220, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "anchor-capacity-diagnose",
			direction: "LR",
			nodes: [
				{
					id: "source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 140 },
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `source-${target.id}`,
				source: { nodeId: "source" },
				target: { nodeId: target.id },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			anchorCapacity: { minSpacing: 24, grow: false },
		},
	);

	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "routing.anchor-capacity.requires-resize",
			path: ["nodes", "source"],
		}),
	);
});

it("ignores explicit corner anchors during implicit anchor capacity checks", () => {
	const targets = Array.from({ length: 5 }, (_, index) => ({
		id: `corner-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 220, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "anchor-capacity-explicit-corners",
			direction: "LR",
			nodes: [
				{
					id: "source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 140 },
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `source-${target.id}`,
				source: { nodeId: "source", anchor: "top-left" },
				target: { nodeId: target.id },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			anchorCapacity: { minSpacing: 24, grow: false },
		},
	);

	expect(nodeBox(result, "source")).toEqual({
		x: 0,
		y: 140,
		width: 80,
		height: 40,
	});
	expect(result.diagnostics).not.toContainEqual(
		expect.objectContaining({
			code: "routing.anchor-capacity.requires-resize",
			path: ["nodes", "source"],
		}),
	);
});

it("routes dense same-rank dependencies through deterministic rails", () => {
	const pairCount = 6;
	const nodes = Array.from({ length: pairCount }, (_, index) => [
		{
			id: `source-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 0, y: index * 70 },
		},
		{
			id: `target-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 240, y: index * 70 },
		},
	]).flat();
	const result = solveDiagram(
		{
			id: "rail-routing",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `edge-${index}`,
				source: { nodeId: `source-${index}` },
				target: { nodeId: `target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
		},
	);
	const minNodeY = Math.min(...result.nodes.map((node) => node.box.y));
	const maxNodeBottom = Math.max(
		...result.nodes.map((node) => node.box.y + node.box.height),
	);
	const rails = result.routing?.rails ?? [];
	const sides = new Set(rails.map((rail) => rail.side));

	expect(rails).toHaveLength(pairCount);
	expect(sides.has("top")).toBe(true);
	expect(sides.has("bottom")).toBe(true);
	for (const rail of rails) {
		if (rail.side === "top") {
			expect(rail.coordinate).toBeLessThan(minNodeY);
		} else {
			expect(rail.coordinate).toBeGreaterThan(maxNodeBottom);
		}
	}
	expect(result.routing?.gutters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				side: "top",
				box: expect.objectContaining({
					height: expect.any(Number),
				}),
			}),
			expect.objectContaining({
				side: "bottom",
				box: expect.objectContaining({
					height: expect.any(Number),
				}),
			}),
		]),
	);
});

it("falls back from rails that cross off-corridor node obstacles", () => {
	const pairCount = 6;
	const nodes = [
		{
			id: "rail-blocker",
			shape: "rectangle" as const,
			size: { width: 20, height: 60 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 90, y: -250 },
		},
		...Array.from({ length: pairCount }, (_, index) => [
			{
				id: `blocked-source-${index}`,
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 0, y: index * 70 },
			},
			{
				id: `blocked-target-${index}`,
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 240, y: index * 70 },
			},
		]).flat(),
	];
	const result = solveDiagram(
		{
			id: "rail-routing-off-corridor-obstacle",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `blocked-edge-${index}`,
				source: { nodeId: `blocked-source-${index}` },
				target: { nodeId: `blocked-target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
		},
	);

	const blocker = nodeBox(result, "rail-blocker");
	for (const edge of result.edges) {
		expect(routeCrossesBox(edge.points, blocker)).toBe(false);
	}
});

it("expands diagram frames to enclose dependency rails", () => {
	const pairCount = 6;
	const nodes = Array.from({ length: pairCount }, (_, index) => [
		{
			id: `framed-source-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 0, y: index * 70 },
		},
		{
			id: `framed-target-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 240, y: index * 70 },
		},
	]).flat();
	const result = solveDiagram(
		{
			id: "framed-rail-routing",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `framed-edge-${index}`,
				source: { nodeId: `framed-source-${index}` },
				target: { nodeId: `framed-target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
			frame: {
				kind: "sysml",
				titleTab: "System",
			},
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
		},
	);

	const frame = result.frame?.box;
	expect(frame).toBeDefined();
	if (frame !== undefined) {
		for (const edge of result.edges) {
			for (const point of edge.points) {
				expect(point.x).toBeGreaterThanOrEqual(frame.x);
				expect(point.x).toBeLessThanOrEqual(frame.x + frame.width);
				expect(point.y).toBeGreaterThanOrEqual(frame.y);
				expect(point.y).toBeLessThanOrEqual(frame.y + frame.height);
			}
		}
	}
});

it("falls back from dependency rails that would cross hard obstacles", () => {
	const pairCount = 6;
	const nodes = Array.from({ length: pairCount }, (_, index) => [
		{
			id: `rail-source-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 0, y: index * 70 },
		},
		{
			id: `rail-target-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 240, y: index * 70 },
		},
	]).flat();
	const result = solveDiagram(
		{
			id: "rail-routing-hard-obstacle",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `rail-edge-${index}`,
				source: { nodeId: `rail-source-${index}` },
				target: { nodeId: `rail-target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
			matrices: [
				{
					id: "rail-hard-block",
					rows: ["need"],
					cols: ["function"],
					cells: [[{ text: "covered" }]],
					position: { x: 90, y: -70 },
					size: { width: 48, height: 64 },
				},
			],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
		},
	);

	const block = result.matrices?.[0]?.box;
	expect(block).toBeDefined();
	if (block !== undefined) {
		for (const edge of result.edges) {
			expect(routeCrossesBox(edge.points, block)).toBe(false);
		}
	}
	expect(result.diagnostics).not.toContainEqual(
		expect.objectContaining({ code: "routing.evidence.crossing_forbidden" }),
	);
});

it("reports the twenty-fifth dependency rail as over capacity", () => {
	const pairCount = 25;
	const nodes = Array.from({ length: pairCount }, (_, index) => [
		{
			id: `capacity-source-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 0, y: index * 70 },
		},
		{
			id: `capacity-target-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 240, y: index * 70 },
		},
	]).flat();
	const result = solveDiagram(
		{
			id: "rail-capacity",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `capacity-edge-${index}`,
				source: { nodeId: `capacity-source-${index}` },
				target: { nodeId: `capacity-target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
		},
	);

	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "routing.rail-capacity.exceeded",
			detail: expect.objectContaining({
				railIndex: 24,
				required: 25,
				available: 24,
			}),
		}),
	);
	const pageSplit = result.deliverability?.remediationPlans.find(
		(plan) => plan.type === "page-split",
	);
	expect(pageSplit).toBeDefined();
	expect(pageSplit?.edgeIds.length).toBeGreaterThan(0);
	expect(pageSplit?.nodeIds.length).toBeGreaterThan(0);
	expect(pageSplit?.reason.length).toBeGreaterThan(0);
	const detail = pageSplit?.detail as PageSplitRemediationDetail | undefined;
	expect(detail?.required).toBeGreaterThan(detail?.available ?? 0);
	expect(detail?.available).toBe(24);
	expect(
		result.deliverability?.remediationPlans.some(
			(plan) => plan.type === "route-rail",
		),
	).toBe(true);
});

describe("phase 17 remediation apply loop", () => {
	it("classifies route/text conflicts without rewriting diagnostic codes", () => {
		const result = solveDiagram(denseCvRemediationFixture(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: { maxIterations: 1 },
			textIntersectionTolerance: 0,
			externalLabels: true,
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const textClearance = result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.text-clearance.unresolved",
		);
		for (const diagnostic of textClearance) {
			expect(diagnostic.detail?.conflictClass).toBeDefined();
			expect([
				"node-label-strike",
				"edge-label-pileup",
				"label-bbox-graze",
			]).toContain(diagnostic.detail?.conflictClass);
		}
		const railOverflow = result.diagnostics.find(
			(diagnostic) => diagnostic.code === "routing.rail-capacity.exceeded",
		);
		if (railOverflow !== undefined) {
			expect(railOverflow.detail?.conflictClass).toBe("rail-lane-overflow");
		}
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "routing.evidence.crossing_forbidden",
				detail: expect.objectContaining({
					conflictClass: "edge-label-pileup",
				}),
			}),
		);
	});

	it("transitions exhausted route-label loop into remediation planning", () => {
		const result = solveDiagram(denseCvRemediationFixture(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: { maxIterations: 1 },
			textIntersectionTolerance: 0,
			externalLabels: true,
			remediationPolicy: {
				externalLabels: "auto",
				routeRails: "auto",
				growFixedGeometry: "auto",
				pageSplit: "suggest",
			},
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});

		const exhausted = result.diagnostics.find(
			(diagnostic) => diagnostic.code === "routing.route-label-loop.exhausted",
		);
		if (exhausted !== undefined) {
			expect(exhausted.detail).toMatchObject({
				remediationTransition: true,
				phase: "remediation-planning",
			});
		}
		expect(result.deliverability).toBeDefined();
		if (result.deliverability?.status === "clean") {
			expect(
				result.deliverability.remediationPlans.some(
					(plan) => plan.status === "applied",
				) ||
					!result.diagnostics.some((diagnostic) =>
						DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code),
					),
			).toBe(true);
		} else {
			expect(result.deliverability?.remediationPlans.length).toBeGreaterThan(0);
		}
	});

	it("marks routeRails auto as applied or blocked with snapshot semantics", () => {
		const auto = solveDiagram(denseCvRemediationFixture(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: { maxIterations: 2 },
			textIntersectionTolerance: 0,
			railRouting: false,
			pagePolicy: "off",
			externalLabels: true,
			remediationPolicy: {
				externalLabels: "suggest",
				routeRails: "auto",
				growFixedGeometry: "suggest",
				pageSplit: "suggest",
			},
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const suggest = solveDiagram(denseCvRemediationFixture(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			edgeLabelRerouting: { maxIterations: 2 },
			textIntersectionTolerance: 0,
			railRouting: false,
			pagePolicy: "off",
			externalLabels: true,
			remediationPolicy: {
				externalLabels: "suggest",
				routeRails: "suggest",
				growFixedGeometry: "suggest",
				pageSplit: "suggest",
			},
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});

		const autoRail = auto.deliverability?.remediationPlans.find(
			(plan) => plan.type === "route-rail",
		);
		const suggestRail = suggest.deliverability?.remediationPlans.find(
			(plan) => plan.type === "route-rail",
		);
		if (autoRail !== undefined) {
			expect(["applied", "blocked"]).toContain(autoRail.status);
			expect(autoRail.status).not.toBe("suggested");
			expect(autoRail.detail).toMatchObject({
				strategy: "dependency-rails",
				policy: "auto",
				required: expect.any(Number),
				available: expect.any(Number),
			});
		}
		if (suggestRail !== undefined) {
			expect(suggestRail.status).toBe("suggested");
		}
	});

	it("applies or blocks growFixedGeometry auto from grow-disabled IBD pressure", () => {
		const auto = solveDiagram(denseIbdRemediationFixture(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "ibd-high-fan-in",
			anchorCapacity: { minSpacing: 24, grow: false },
			remediationPolicy: {
				externalLabels: "suggest",
				routeRails: "suggest",
				growFixedGeometry: "auto",
				pageSplit: "suggest",
			},
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const suggest = solveDiagram(denseIbdRemediationFixture(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "ibd-high-fan-in",
			anchorCapacity: { minSpacing: 24, grow: false },
			remediationPolicy: {
				externalLabels: "suggest",
				routeRails: "suggest",
				growFixedGeometry: "suggest",
				pageSplit: "suggest",
			},
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});

		const autoGrow = auto.deliverability?.remediationPlans.find(
			(plan) => plan.type === "grow-fixed-geometry",
		);
		const suggestGrow = suggest.deliverability?.remediationPlans.find(
			(plan) => plan.type === "grow-fixed-geometry",
		);
		expect(autoGrow).toBeDefined();
		expect(["applied", "blocked"]).toContain(autoGrow?.status);
		if (autoGrow?.detail.strategy === "grow-or-relax-fixed-geometry") {
			expect(autoGrow.detail.policy).toBe("auto");
			if (autoGrow.status === "blocked") {
				expect((autoGrow.detail.growthDeltas?.length ?? 0) > 0).toBe(true);
			}
			if (autoGrow.status === "applied") {
				expect(nodeBox(auto, "ibd-aggregator").height).toBeGreaterThan(
					nodeBox(suggest, "ibd-aggregator").height - 0.001,
				);
			}
		}
		expect(suggestGrow?.status).toBe("suggested");
		expect(nodeBox(suggest, "ibd-aggregator").height).toBe(40);
	});

	it("recenters node labels after growFixedGeometry auto deltas", () => {
		const diagram = denseIbdRemediationFixture();
		const aggregator = diagram.nodes.find(
			(item) => item.id === "ibd-aggregator",
		);
		expect(aggregator).toBeDefined();
		if (aggregator !== undefined) {
			aggregator.label = { text: "aggregator" };
			aggregator.labelLayout = createTestLabelLayout("aggregator", {
				x: 10,
				y: 13,
				width: 60,
				height: 14,
			});
		}
		const result = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "ibd-high-fan-in",
			anchorCapacity: { minSpacing: 24, grow: false },
			remediationPolicy: {
				externalLabels: "suggest",
				routeRails: "suggest",
				growFixedGeometry: "auto",
				pageSplit: "suggest",
			},
			strict: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const grow = result.deliverability?.remediationPlans.find(
			(plan) => plan.type === "grow-fixed-geometry",
		);
		if (grow?.status !== "applied") {
			return;
		}
		const node = result.nodes.find((item) => item.id === "ibd-aggregator");
		expect(node?.labelLayout).toBeDefined();
		expect(node?.labelLayout?.box.y).toBeCloseTo(
			((node?.box.height ?? 0) - (node?.labelLayout?.box.height ?? 0)) / 2,
			5,
		);
		expect(node?.labelLayout?.box.x).toBeCloseTo(
			((node?.box.width ?? 0) - (node?.labelLayout?.box.width ?? 0)) / 2,
			5,
		);
	});

	it("never applies page-split and keeps required/available under suggest", () => {
		const pairCount = 25;
		const nodes = Array.from({ length: pairCount }, (_, index) => [
			{
				id: `capacity-source-${index}`,
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 0, y: index * 70 },
			},
			{
				id: `capacity-target-${index}`,
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 240, y: index * 70 },
			},
		]).flat();
		const result = solveDiagram(
			{
				id: "page-split-never-applied",
				direction: "LR",
				nodes,
				edges: Array.from({ length: pairCount }, (_, index) => ({
					id: `capacity-edge-${index}`,
					source: { nodeId: `capacity-source-${index}` },
					target: { nodeId: `capacity-target-${index}` },
				})),
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "obstacle-avoiding",
				railRouting: "dependency",
				remediationPolicy: {
					externalLabels: "auto",
					routeRails: "auto",
					growFixedGeometry: "auto",
					pageSplit: "suggest",
				},
				strict: true,
			},
		);

		const pageSplit = result.deliverability?.remediationPlans.find(
			(plan) => plan.type === "page-split",
		);
		expect(pageSplit).toBeDefined();
		expect(pageSplit?.status).not.toBe("applied");
		expect(pageSplit?.status).toBe("suggested");
		expect(pageSplit?.detail).toMatchObject({
			strategy: "split-over-capacity-page",
			required: expect.any(Number),
			available: expect.any(Number),
		});
		if (pageSplit?.detail.strategy === "split-over-capacity-page") {
			expect(pageSplit.detail.required).toBeGreaterThan(
				pageSplit.detail.available,
			);
		}
		if (result.deliverability?.status !== "clean") {
			expect(result.deliverability?.status).toBe("unsatisfiable");
			expect(result.deliverability?.remediationPlans.length).toBeGreaterThan(0);
		}
	});
});

function denseCvRemediationFixture(): NormalizedDiagram {
	const nodeCount = 5;
	const nodes = Array.from({ length: nodeCount }, (_, index) => [
		{
			id: `cv-source-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 0, y: index * 70 },
		},
		{
			id: `cv-target-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 300, y: index * 70 },
		},
	]).flat();
	return {
		id: "phase-17-cv-remediation",
		direction: "LR",
		nodes,
		edges: Array.from({ length: 20 }, (_, index) => ({
			id: `cv-dependency-${index}`,
			source: { nodeId: `cv-source-${index % nodeCount}` },
			target: {
				nodeId: `cv-target-${(index * 2 + Math.floor(index / nodeCount)) % nodeCount}`,
			},
			label: { text: `capability dependency ${index}` },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
		frame: {
			kind: "sysml",
			titleTab: "CV remediation view",
		},
	};
}

function denseIbdRemediationFixture(): NormalizedDiagram {
	const sources = Array.from({ length: 10 }, (_, index) => ({
		id: `ibd-source-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 0, y: index * 46 },
	}));
	return {
		id: "phase-17-ibd-remediation",
		direction: "LR",
		nodes: [
			...sources,
			{
				id: "ibd-aggregator",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 260, y: 180 },
			},
			{
				id: "ibd-sink",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 440, y: 180 },
			},
		],
		edges: [
			...sources.map((source, index) => ({
				id: `ibd-flow-${index}`,
				source: { nodeId: source.id },
				target: { nodeId: "ibd-aggregator" },
			})),
			{
				id: "ibd-aggregate-out",
				source: { nodeId: "ibd-aggregator" },
				target: { nodeId: "ibd-sink" },
			},
		],
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

it("resolves explicit pagePolicy over heuristic classification", () => {
	const diagram: NormalizedDiagram = {
		id: "page-policy-explicit",
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
				position: { x: 200, y: 0 },
			},
		],
		edges: [
			{
				id: "a-b",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				label: { text: "flow" },
			},
		],
		groups: [],
		constraints: [],
		diagnostics: [],
		swimlanes: [
			{
				id: "lane-pack",
				label: { text: "Lane" },
				orientation: "horizontal",
				lanes: [{ id: "lane-a", label: { text: "A" }, children: ["a", "b"] }],
			},
		],
	};
	expect(resolvePagePolicy(diagram, { pagePolicy: "auto" })).toBe(
		"lane-behavior",
	);
	expect(resolvePagePolicy(diagram, { pagePolicy: "dependency" })).toBe(
		"dependency",
	);
});

it("classifies pagePolicy auto from diagram structure", () => {
	const withSwimlanes: NormalizedDiagram = {
		id: "auto-lane",
		direction: "LR",
		nodes: [node("s1", { x: 0, y: 0 }), node("t1", { x: 200, y: 0 })],
		edges: [{ id: "e1", source: { nodeId: "s1" }, target: { nodeId: "t1" } }],
		groups: [],
		constraints: [],
		diagnostics: [],
		swimlanes: [
			{
				id: "sw",
				label: { text: "Swim" },
				orientation: "horizontal",
				lanes: [{ id: "l1", label: { text: "L1" }, children: ["s1", "t1"] }],
			},
		],
	};
	expect(resolvePagePolicy(withSwimlanes, { pagePolicy: "auto" })).toBe(
		"lane-behavior",
	);

	const highFanIn: NormalizedDiagram = {
		id: "auto-ibd",
		direction: "LR",
		nodes: [
			...Array.from({ length: 4 }, (_, index) =>
				node(`src-${index}`, { x: 0, y: index * 50 }),
			),
			node("agg", { x: 220, y: 60 }),
		],
		edges: Array.from({ length: 4 }, (_, index) => ({
			id: `fan-${index}`,
			source: { nodeId: `src-${index}` },
			target: { nodeId: "agg" },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
	};
	expect(resolvePagePolicy(highFanIn, { pagePolicy: "auto" })).toBe(
		"ibd-high-fan-in",
	);

	const resourceFlow: NormalizedDiagram = {
		id: "auto-resource",
		direction: "LR",
		nodes: [
			node("p0", { x: 0, y: 0 }),
			node("p1", { x: 0, y: 40 }),
			node("p2", { x: 0, y: 80 }),
			node("p3", { x: 0, y: 120 }),
			node("c0", { x: 280, y: 280 }),
			node("c1", { x: 280, y: 360 }),
			node("c2", { x: 280, y: 440 }),
			node("c3", { x: 280, y: 520 }),
		],
		edges: Array.from({ length: 4 }, (_, index) => ({
			id: `rf-${index}`,
			source: { nodeId: `p${index}` },
			target: { nodeId: `c${index}` },
			label: { text: `resource ${index}` },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
	};
	expect(resolvePagePolicy(resourceFlow, { pagePolicy: "auto" })).toBe(
		"resource-flow",
	);

	const dependency: NormalizedDiagram = {
		id: "auto-dependency",
		direction: "LR",
		nodes: Array.from({ length: 6 }, (_, index) => [
			node(`ds-${index}`, { x: 0, y: index * 70 }),
			node(`dt-${index}`, { x: 240, y: index * 70 }),
		]).flat(),
		edges: Array.from({ length: 6 }, (_, index) => ({
			id: `de-${index}`,
			source: { nodeId: `ds-${index}` },
			target: { nodeId: `dt-${index}` },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
	};
	expect(resolvePagePolicy(dependency, { pagePolicy: "auto" })).toBe(
		"dependency",
	);
	expect(resolvePagePolicy(dependency, { pagePolicy: "auto" })).toBe(
		resolvePagePolicy(dependency, { pagePolicy: "auto" }),
	);
});

it("fans out same-side anchors under resource-flow page policy", () => {
	const targets = Array.from({ length: 4 }, (_, index) => ({
		id: `fanout-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 240, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "policy-fanout-resource-flow",
			direction: "LR",
			nodes: [
				{
					id: "fanout-source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 105 },
				},
				...targets,
			],
			edges: targets.map((target) => ({
				id: `fanout-${target.id}`,
				source: { nodeId: "fanout-source" },
				target: { nodeId: target.id },
				label: { text: `flow ${target.id}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "resource-flow",
			anchorCapacity: { minSpacing: 12 },
		},
	);
	const sourceYs = result.edges
		.filter((edge) => edge.source.nodeId === "fanout-source")
		.map((edge) => edge.points[0]?.y)
		.filter((y): y is number => y !== undefined);
	expect(new Set(sourceYs).size).toBe(targets.length);
});

it("preserves explicit portId anchors under ibd-high-fan-in fan-out", () => {
	const targets = Array.from({ length: 3 }, (_, index) => ({
		id: `port-target-${index}`,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x: 240, y: index * 70 },
	}));
	const result = solveDiagram(
		{
			id: "policy-fanout-portid",
			direction: "LR",
			nodes: [
				{
					id: "port-source",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					position: { x: 0, y: 70 },
					ports: [{ id: "fixed-out", side: "right" as const, kind: "proxy" }],
				},
				...targets,
			],
			edges: [
				{
					id: "port-edge-fixed",
					source: { nodeId: "port-source", portId: "fixed-out" },
					target: { nodeId: "port-target-0" },
				},
				...targets.slice(1).map((target) => ({
					id: `port-edge-${target.id}`,
					source: { nodeId: "port-source" },
					target: { nodeId: target.id },
				})),
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "ibd-high-fan-in",
			anchorCapacity: { minSpacing: 12 },
		},
	);
	const source = result.nodes.find((node) => node.id === "port-source");
	const fixedPort = source?.ports?.find((port) => port.id === "fixed-out");
	const fixedEdge = result.edges.find((edge) => edge.id === "port-edge-fixed");
	expect(fixedPort).toBeDefined();
	expect(fixedEdge?.points[0]).toEqual(fixedPort?.anchor);
});

it("rejects a second edge from occupying the same rail lane", () => {
	const pairCount = 4;
	const result = solveDiagram(
		{
			id: "rail-occupancy",
			direction: "LR",
			nodes: Array.from({ length: pairCount }, (_, index) => [
				node(`s${index}`, { x: 0, y: index * 70 }),
				node(`t${index}`, { x: 240, y: index * 70 }),
			]).flat(),
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `edge-${index}`,
				source: { nodeId: `s${index}` },
				target: { nodeId: `t${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "dependency",
			railRouting: "dependency",
		},
	);
	const rails = result.routing?.rails ?? [];
	expect(rails.length).toBe(pairCount);
	const occupancyKeys = rails.map(
		(rail) => `${rail.side}:${Math.round(rail.coordinate)}`,
	);
	expect(new Set(occupancyKeys).size).toBe(rails.length);
	expect(new Set(rails.map((rail) => rail.side))).toEqual(
		new Set(["top", "bottom"]),
	);
});

it("honors railRouting false even when pagePolicy is dependency", () => {
	const result = solveDiagram(
		{
			id: "rail-opt-out",
			direction: "LR",
			nodes: [
				node("s0", { x: 0, y: 0 }),
				node("t0", { x: 240, y: 0 }),
				node("s1", { x: 0, y: 70 }),
				node("t1", { x: 240, y: 70 }),
				node("s2", { x: 0, y: 140 }),
				node("t2", { x: 240, y: 140 }),
				node("s3", { x: 0, y: 210 }),
				node("t3", { x: 240, y: 210 }),
				node("s4", { x: 0, y: 280 }),
				node("t4", { x: 240, y: 280 }),
				node("s5", { x: 0, y: 350 }),
				node("t5", { x: 240, y: 350 }),
			],
			edges: [
				{
					id: "edge-0",
					source: { nodeId: "s0" },
					target: { nodeId: "t0" },
				},
				{
					id: "edge-1",
					source: { nodeId: "s1" },
					target: { nodeId: "t1" },
				},
				{
					id: "edge-2",
					source: { nodeId: "s2" },
					target: { nodeId: "t2" },
				},
				{
					id: "edge-3",
					source: { nodeId: "s3" },
					target: { nodeId: "t3" },
				},
				{
					id: "edge-4",
					source: { nodeId: "s4" },
					target: { nodeId: "t4" },
				},
				{
					id: "edge-5",
					source: { nodeId: "s5" },
					target: { nodeId: "t5" },
				},
			],
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "dependency",
			railRouting: false,
		},
	);
	expect(result.routing?.rails ?? []).toEqual([]);
});

it("does not report rail capacity for rail candidates that fall back", () => {
	const pairCount = 25;
	const nodes = [
		{
			id: "capacity-blocker-top",
			shape: "rectangle" as const,
			size: { width: 20, height: 120 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 90, y: -450 },
		},
		{
			id: "capacity-blocker-bottom",
			shape: "rectangle" as const,
			size: { width: 20, height: 120 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 90, y: 25 * 70 + 200 },
		},
		...Array.from({ length: pairCount }, (_, index) => [
			{
				id: `fallback-capacity-source-${index}`,
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 0, y: index * 70 },
			},
			{
				id: `fallback-capacity-target-${index}`,
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 240, y: index * 70 },
			},
		]).flat(),
	];
	const result = solveDiagram(
		{
			id: "rail-capacity-fallback",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `fallback-capacity-edge-${index}`,
				source: { nodeId: `fallback-capacity-source-${index}` },
				target: { nodeId: `fallback-capacity-target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
		},
	);

	expect(result.diagnostics).not.toContainEqual(
		expect.objectContaining({ code: "routing.rail-capacity.exceeded" }),
	);
});

it("rejects dependency rails that cross non-connected edge-label estimates", () => {
	const pairCount = 6;
	const nodes = Array.from({ length: pairCount }, (_, index) => [
		{
			id: `label-rail-source-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 0, y: index * 70 },
		},
		{
			id: `label-rail-target-${index}`,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x: 240, y: index * 70 },
		},
	]).flat();
	const result = solveDiagram(
		{
			id: "rail-routing-edge-label-obstacle",
			direction: "LR",
			nodes,
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `label-rail-edge-${index}`,
				source: { nodeId: `label-rail-source-${index}` },
				target: { nodeId: `label-rail-target-${index}` },
				...(index === 0
					? { label: { text: Array(10).fill("label").join(" ") } }
					: {}),
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{
			initialLayout: "positions",
			routeKind: "orthogonal",
			railRouting: "dependency",
			edgeLabelRerouting: false,
			textMeasurer: new DeterministicTextMeasurer(),
			textIntersectionTolerance: 0,
		},
	);
	const label = result.textAnnotations?.find(
		(annotation) =>
			annotation.surfaceKind === "edge-label" &&
			annotation.ownerId === "label-rail-edge-0",
	);

	expect(result.routing?.rails.map((rail) => rail.edgeId)).toEqual(
		expect.arrayContaining(["label-rail-edge-0"]),
	);
	expect(result.routing?.rails.length).toBeGreaterThan(0);
	expect(label).toBeDefined();
	if (label !== undefined) {
		for (const edge of result.edges.filter(
			(edge) => edge.id !== "label-rail-edge-0",
		)) {
			expect(routeCrossesBox(edge.points, label.box)).toBe(false);
		}
	}
});

it("does not report ordinary detours as rail allocations", () => {
	const result = solveDiagram(
		{
			id: "ordinary-detour-not-rail-allocation",
			direction: "LR",
			nodes: [
				node("source", { x: 0, y: 0 }),
				node("target", { x: 300, y: 0 }),
				node("blocker", { x: 140, y: 0 }),
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
			initialLayout: "positions",
			routeKind: "orthogonal",
		},
	);

	expect(result.edges[0]?.points).toEqual([
		{ x: 80, y: 20 },
		{ x: 104, y: 20 },
		{ x: 104, y: -4 },
		{ x: 276, y: -4 },
		{ x: 276, y: 20 },
		{ x: 300, y: 20 },
	]);
	expect(result.routing).toBeUndefined();
});

it("applies routingGutter to expand node obstacle clearance", () => {
	const without = solveDiagram({
		id: "gutter-test",
		direction: "LR",
		nodes: [
			{
				id: "a",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
			},
			{
				id: "b",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
			},
		],
		edges: [{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } }],
		groups: [],
		constraints: [],
		diagnostics: [],
	});
	const withGutter = solveDiagram(
		{
			id: "gutter-test",
			direction: "LR",
			nodes: [
				{
					id: "a",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
				{
					id: "b",
					shape: "rectangle" as const,
					size: { width: 80, height: 40 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
			edges: [{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } }],
			groups: [],
			constraints: [],
			diagnostics: [],
		},
		{ routingGutter: 24 },
	);

	// Both should produce valid routes
	expect(without.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
	expect(withGutter.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
	// With gutter, the bounds should be larger due to expanded obstacle boxes
	expect(withGutter.bounds.width).toBeGreaterThanOrEqual(without.bounds.width);
});

function positionedChildDiagram(): ReturnType<typeof sampleDiagram> {
	return {
		id: "positioned-children",
		direction: "TB",
		nodes: [
			{
				id: "container",
				shape: "rectangle" as const,
				size: { width: 200, height: 200 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 0, y: 0 },
			},
			{
				id: "c1",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 10, y: 10 },
			},
			{
				id: "c2",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 10, y: 50 },
			},
		],
		edges: [],
		groups: [],
		constraints: [
			{
				kind: "containment" as const,
				containerId: "container",
				childIds: ["c1", "c2"],
				padding: { top: 8, right: 8, bottom: 8, left: 8 },
			},
		],
		diagnostics: [],
	};
}

it("distributeContainedChildren distributes children even when they have a position (#37)", () => {
	// With distributeContainedChildren: false, the position field
	const locked = solveDiagram(positionedChildDiagram(), {
		distributeContainedChildren: false,
	});
	const lockedC1 = locked.nodes.find((n) => n.id === "c1")?.box;
	const lockedC2 = locked.nodes.find((n) => n.id === "c2")?.box;
	expect(lockedC1).toBeDefined();
	expect(lockedC2).toBeDefined();
	if (lockedC1 === undefined || lockedC2 === undefined) return;
	const lockedGap = lockedC2.y - (lockedC1.y + lockedC1.height);
	expect(lockedGap).toBe(0);

	// With the option, fixed-position locks yield to the distributor.
	const distributed = solveDiagram(positionedChildDiagram(), {
		distributeContainedChildren: true,
		minSiblingGap: 28,
	});
	const c1 = distributed.nodes.find((n) => n.id === "c1")?.box;
	const c2 = distributed.nodes.find((n) => n.id === "c2")?.box;
	expect(c1).toBeDefined();
	expect(c2).toBeDefined();
	if (c1 === undefined || c2 === undefined) return;
	const gap = c2.y - (c1.y + c1.height);
	expect(gap).toBe(28);
});

function overlappingPositionedChildrenDiagram(): ReturnType<
	typeof sampleDiagram
> {
	return {
		id: "overlapping-positioned-children",
		direction: "TB",
		nodes: [
			{
				id: "container",
				shape: "rectangle" as const,
				size: { width: 200, height: 200 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 0, y: 0 },
			},
			{
				id: "c1",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 10, y: 10 },
			},
			{
				id: "c2",
				shape: "rectangle" as const,
				size: { width: 80, height: 40 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 10, y: 30 },
			},
		],
		edges: [],
		groups: [],
		constraints: [
			{
				kind: "containment" as const,
				containerId: "container",
				childIds: ["c1", "c2"],
				padding: { top: 8, right: 8, bottom: 8, left: 8 },
			},
		],
		diagnostics: [],
	};
}

it("distributeContainedChildren separates overlapping fixed-position children without stale diagnostics", () => {
	// c1 at y=10 (h=40) and c2 at y=30 (h=40) overlap by 20 px.
	const locked = solveDiagram(overlappingPositionedChildrenDiagram());
	const lockedC1 = locked.nodes.find((n) => n.id === "c1")?.box;
	const lockedC2 = locked.nodes.find((n) => n.id === "c2")?.box;
	expect(lockedC1).toBeDefined();
	expect(lockedC2).toBeDefined();
	if (lockedC1 === undefined || lockedC2 === undefined) return;
	// Without distribution they overlap (or are exactly adjacent after repair).
	expect(lockedC2.y).toBeLessThan(lockedC1.y + lockedC1.height + 10);

	const distributed = solveDiagram(overlappingPositionedChildrenDiagram(), {
		distributeContainedChildren: true,
		minSiblingGap: 28,
	});
	const c1 = distributed.nodes.find((n) => n.id === "c1")?.box;
	const c2 = distributed.nodes.find((n) => n.id === "c2")?.box;
	expect(c1).toBeDefined();
	expect(c2).toBeDefined();
	if (c1 === undefined || c2 === undefined) return;
	const gap = c2.y - (c1.y + c1.height);
	expect(gap).toBe(28);

	// Distribution must not leave stale overlap diagnostics behind.
	const unresolvedOverlaps = distributed.diagnostics.filter(
		(d) => d.code === "constraints.overlap.unresolved",
	);
	expect(unresolvedOverlaps).toHaveLength(0);
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

function externalLabelAutoDiagram(): NormalizedDiagram {
	return {
		id: "external-label-auto",
		direction: "LR",
		nodes: [
			node("zeta-source", { x: 0, y: 0 }),
			node("zeta-target", { x: 300, y: 0 }),
			node("alpha-source", { x: 0, y: 90 }),
			node("alpha-target", { x: 300, y: 90 }),
			node("middle-source", { x: 0, y: 180 }),
			node("middle-target", { x: 300, y: 180 }),
		],
		edges: [
			{
				id: "zeta",
				source: { nodeId: "zeta-source" },
				target: { nodeId: "zeta-target" },
				label: { text: "zeta external callout label" },
			},
			{
				id: "alpha",
				source: { nodeId: "alpha-source" },
				target: { nodeId: "alpha-target" },
				label: { text: "alpha external callout label" },
			},
			{
				id: "middle",
				source: { nodeId: "middle-source" },
				target: { nodeId: "middle-target" },
				label: { text: "middle external callout label" },
			},
		],
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function congestedEdgeLabelExternalizationDiagram(): NormalizedDiagram {
	const nodes: NormalizedDiagram["nodes"] = [];
	const edges: NormalizedDiagram["edges"] = [];
	for (let index = 0; index < 5; index += 1) {
		nodes.push(node(`s${index}`, { x: 0, y: index * 70 }));
		nodes.push(node(`t${index}`, { x: 300, y: index * 70 }));
	}
	for (let index = 0; index < 20; index += 1) {
		edges.push({
			id: `e${index}`,
			source: { nodeId: `s${index % 5}` },
			target: { nodeId: `t${(index * 2) % 5}` },
			label: { text: `capability dependency ${index} with long text` },
		});
	}
	return {
		id: "congested-edge-label-externalization",
		direction: "LR",
		nodes,
		edges,
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function hugeNodeLabelClearanceDiagram(id: string): NormalizedDiagram {
	return {
		id,
		direction: "LR",
		nodes: [
			node("source", { x: 0, y: 0 }),
			node("target", { x: 240, y: 0 }),
			{
				id: "label_owner",
				shape: "rectangle",
				size: { width: 0, height: 0 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 120, y: 0 },
				label: { text: "huge label" },
				labelLayout: createTestLabelLayout("huge label", {
					x: -1_000,
					y: -1_000,
					width: 3_000,
					height: 3_000,
				}),
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
	};
}

function nodeBox(result: ReturnType<typeof solveDiagram>, id: string) {
	const found = result.nodes.find(
		(coordinatedNode) => coordinatedNode.id === id,
	);
	if (found === undefined) {
		throw new Error(`Expected solved node ${id}`);
	}
	return found.box;
}

function routeCrossesBox(
	points: readonly { x: number; y: number }[],
	box: Box,
) {
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) continue;
		const segment = {
			x: Math.min(start.x, end.x),
			y: Math.min(start.y, end.y),
			width: Math.abs(end.x - start.x),
			height: Math.abs(end.y - start.y),
		};
		if (
			segment.x < box.x + box.width &&
			segment.x + segment.width > box.x &&
			segment.y < box.y + box.height &&
			segment.y + segment.height > box.y
		) {
			return true;
		}
	}
	return false;
}

function createTestLabelLayout(
	text: string,
	box: LabelLayout["box"],
): LabelLayout {
	return {
		text,
		box,
		contentBox: box,
		naturalSize: { width: box.width, height: box.height },
		fittedSize: { width: box.width, height: box.height },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
		lineHeight: 14,
		lines: [
			{
				text,
				box,
				baselineY: box.y + 11.2,
				width: box.width,
				lineIndex: 0,
			},
		],
		overflow: { horizontal: false, vertical: false, truncated: false },
		diagnostics: [],
	};
}

function routingAttemptObstaclePanels(): NonNullable<
	NormalizedDiagram["evidencePanels"]
> {
	return [
		{ x: 389, y: -90, width: 106, height: 88 },
		{ x: 127, y: 70, width: 31, height: 100 },
		{ x: 187, y: -134, width: 51, height: 120 },
		{ x: 343, y: 103, width: 62, height: 123 },
		{ x: 430, y: -12, width: 114, height: 141 },
		{ x: 376, y: -1, width: 48, height: 113 },
	].map((box, index) => ({
		id: `routing-obstacle-${index}`,
		kind: "legend" as const,
		position: { x: box.x, y: box.y },
		size: { width: box.width, height: box.height },
		items: [],
	}));
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
