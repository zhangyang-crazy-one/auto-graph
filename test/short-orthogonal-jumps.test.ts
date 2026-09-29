import { describe, expect, it } from "vitest";
import { exportExcalidraw, exportSvg } from "../src/exporters/index.js";
import {
	attachSlotFractions,
	attachSlotsForBox,
	computeShapeGeometry,
	detectOrthogonalEdgeCrossings,
} from "../src/geometry/index.js";
import type { CoordinatedDiagram } from "../src/ir/index.js";
import { routeEdge } from "../src/routing/index.js";
import { solveDiagram } from "../src/solver/index.js";
import { pinRouteEnds, routeEndsAt } from "../src/solver/route-edges.js";

describe("attach slots (#84 §B)", () => {
	it("locks public 25/50/75 fractions and box coordinates", () => {
		expect(attachSlotFractions(3)).toEqual([0.25, 0.5, 0.75]);
		const box = { x: 10, y: 20, width: 100, height: 80 };
		expect(attachSlotsForBox(box, "right", 3)).toEqual([
			{ x: 110, y: 40 },
			{ x: 110, y: 60 },
			{ x: 110, y: 80 },
		]);
		expect(attachSlotsForBox(box, "top", 3)).toEqual([
			{ x: 35, y: 20 },
			{ x: 60, y: 20 },
			{ x: 85, y: 20 },
		]);
	});
});

describe("short-orthogonal-jumps (#84 §C)", () => {
	it("selects a short L/Z path between clear nodes", () => {
		const result = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 40 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 200, y: 80, width: 80, height: 40 },
			}),
			maxAttachPointsPerSide: 3,
			maxDetourRatio: 3,
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.points.length).toBeGreaterThanOrEqual(2);
		expect(result.points.length).toBeLessThanOrEqual(4);
		for (let i = 0; i < result.points.length - 1; i += 1) {
			const a = result.points[i];
			const b = result.points[i + 1];
			expect(a).toBeDefined();
			expect(b).toBeDefined();
			if (a === undefined || b === undefined) continue;
			expect(a.x === b.x || a.y === b.y).toBe(true);
		}
		let length = 0;
		for (let i = 0; i < result.points.length - 1; i += 1) {
			const a = result.points[i];
			const b = result.points[i + 1];
			if (a === undefined || b === undefined) continue;
			length += Math.hypot(b.x - a.x, b.y - a.y);
		}
		expect(length).toBeLessThan(280);
	});

	it("rejects blocked short paths without route_obstacle_fallback success", () => {
		const wall = { x: 100, y: -40, width: 40, height: 200 };
		const result = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 40, width: 80, height: 40 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 200, y: 40, width: 80, height: 40 },
			}),
			obstacles: [wall],
			hardObstacles: [wall],
			maxAttachPointsPerSide: 3,
			maxDetourRatio: 3,
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.obstacle.unavoidable",
				detail: expect.objectContaining({
					remediationType: "route-rail-or-page-split",
					routingPolicy: "short-orthogonal-jumps",
				}),
			}),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "route_obstacle_fallback" }),
		);
	});

	it("marks strict deliverability unsatisfiable instead of accepting a flyer", () => {
		const solved = solveDiagram(
			{
				id: "short-path-blocked",
				direction: "LR",
				nodes: [
					{
						id: "a",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 0, y: 40 },
					},
					{
						id: "blocker",
						shape: "rectangle",
						size: { width: 40, height: 200 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 100, y: -40 },
					},
					{
						id: "b",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 200, y: 40 },
					},
				],
				edges: [
					{
						id: "a-b",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				deliverabilityMode: "strict",
				maxAttachPointsPerSide: 3,
				maxDetourRatio: 3,
			},
		);

		expect(solved.deliverability?.status).toBe("unsatisfiable");
		expect(solved.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.obstacle.unavoidable",
			}),
		);
		expect(solved.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "route_obstacle_fallback" }),
		);
	});
});

describe("short-orthogonal hard-obstacle gate (#95)", () => {
	it("never delivers a route through a blocker on the midline in degraded-ok mode", () => {
		const blocker = { x: 100, y: -40, width: 40, height: 200 };
		const solved = solveDiagram(
			{
				id: "short-path-blocked-degraded",
				direction: "LR",
				nodes: [
					{
						id: "a",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 0, y: 40 },
					},
					{
						id: "blocker",
						shape: "rectangle",
						size: { width: blocker.width, height: blocker.height },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: blocker.x, y: blocker.y },
					},
					{
						id: "b",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 200, y: 40 },
					},
				],
				edges: [
					{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				deliverabilityMode: "degraded-ok",
				maxAttachPointsPerSide: 3,
				maxDetourRatio: 3,
			},
		);

		const points = solved.edges[0]?.points ?? [];
		const box = solved.nodes.find((node) => node.id === "blocker")?.box;
		expect(box).toBeDefined();
		for (let index = 1; index < points.length; index += 1) {
			const a = points[index - 1];
			const b = points[index];
			if (a === undefined || b === undefined || box === undefined) continue;
			const enters =
				Math.max(a.x, b.x) > box.x + 0.5 &&
				Math.min(a.x, b.x) < box.x + box.width - 0.5 &&
				Math.max(a.y, b.y) > box.y + 0.5 &&
				Math.min(a.y, b.y) < box.y + box.height - 0.5;
			expect(enters).toBe(false);
		}
		expect(solved.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.short-orthogonal.obstacle-fallback",
			}),
		);
	});
});

describe("edge crossings / jumps (#84)", () => {
	it("detects orthogonal crossings with deterministic over/under", () => {
		const crossings = detectOrthogonalEdgeCrossings([
			{
				id: "h",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				points: [
					{ x: 0, y: 50 },
					{ x: 100, y: 50 },
				],
			},
			{
				id: "v",
				source: { nodeId: "c" },
				target: { nodeId: "d" },
				points: [
					{ x: 50, y: 0 },
					{ x: 50, y: 100 },
				],
			},
		]);

		expect(crossings).toEqual([
			{
				x: 50,
				y: 50,
				underEdgeId: "h",
				overEdgeId: "v",
				style: "jump",
			},
		]);
	});

	it("renders SVG hop arcs and Excalidraw bump points for under edges", () => {
		const diagram: CoordinatedDiagram = {
			id: "jump-export",
			direction: "LR",
			nodes: [
				{
					id: "a",
					shape: "rectangle",
					box: { x: 0, y: 40, width: 40, height: 20 },
					anchors: [],
				},
				{
					id: "b",
					shape: "rectangle",
					box: { x: 160, y: 40, width: 40, height: 20 },
					anchors: [],
				},
				{
					id: "c",
					shape: "rectangle",
					box: { x: 80, y: 0, width: 40, height: 20 },
					anchors: [],
				},
				{
					id: "d",
					shape: "rectangle",
					box: { x: 80, y: 80, width: 40, height: 20 },
					anchors: [],
				},
			],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 40, y: 50 },
						{ x: 160, y: 50 },
					],
				},
				{
					id: "v",
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x: 100, y: 20 },
						{ x: 100, y: 80 },
					],
				},
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edgeCrossings: [
				{
					x: 100,
					y: 50,
					underEdgeId: "h",
					overEdgeId: "v",
					style: "jump",
				},
			],
		};

		const svg = exportSvg(diagram);
		expect(svg).toMatch(/data-id="h"[^>]*\bA /);
		expect(svg).toContain('data-id="v"');

		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: Array<{ id: string; points?: Array<{ x: number; y: number }> }>;
		};
		const under = scene.elements.find((element) => element.id === "edge:h");
		expect(under?.points?.length).toBeGreaterThan(2);
	});

	it("draws a crossing right at a bend without a hop that doubles back", () => {
		const diagram: CoordinatedDiagram = {
			id: "jump-at-bend",
			direction: "LR",
			nodes: [],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					// Bends at (100,50), 3px after the crossing at (97,50).
					points: [
						{ x: 20, y: 50 },
						{ x: 100, y: 50 },
						{ x: 100, y: 120 },
					],
				},
				{
					id: "v",
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x: 97, y: 20 },
						{ x: 97, y: 80 },
					],
				},
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 140 },
			edgeCrossings: [
				{ x: 97, y: 50, underEdgeId: "h", overEdgeId: "v", style: "jump" },
			],
		};
		const svg = exportSvg(diagram);
		expect(svg).not.toMatch(/data-id="h"[^>]*\bA /);
		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: Array<{ id: string; points?: Array<{ x: number; y: number }> }>;
		};
		const under = scene.elements.find((element) => element.id === "edge:h");
		expect(under?.points).toHaveLength(3);
	});

	it("bridges two crossings closer than a glyph with one wider hop", () => {
		const diagram: CoordinatedDiagram = {
			id: "close-hops",
			direction: "LR",
			nodes: [],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 0, y: 50 },
						{ x: 200, y: 50 },
					],
				},
				...[96, 104].map((x) => ({
					id: `v${x}`,
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x, y: 20 },
						{ x, y: 80 },
					],
				})),
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edgeCrossings: [96, 104].map((x) => ({
				x,
				y: 50,
				underEdgeId: "h",
				overEdgeId: `v${x}`,
				style: "jump" as const,
			})),
		};
		const path = exportSvg(diagram).match(/data-id="h" d="([^"]*)"/)?.[1] ?? "";
		// One flat hop from x=90 to x=110 covers both crossings (96 and 104).
		expect(path).toBe("M 0 50 L 90 50 A 10 6 0 0 0 110 50 L 190 50");
	});

	it("keeps each style in a cluster of a gap and a jump", () => {
		const diagram: CoordinatedDiagram = {
			id: "mixed-hops",
			direction: "LR",
			nodes: [],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 0, y: 50 },
						{ x: 200, y: 50 },
					],
				},
				...[96, 104].map((x) => ({
					id: `v${x}`,
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x, y: 20 },
						{ x, y: 80 },
					],
				})),
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edgeCrossings: [
				{ x: 96, y: 50, underEdgeId: "h", overEdgeId: "v96", style: "gap" },
				{ x: 104, y: 50, underEdgeId: "h", overEdgeId: "v104", style: "jump" },
			],
		};
		const path = exportSvg(diagram).match(/data-id="h" d="([^"]*)"/)?.[1] ?? "";
		// The gap at 96 breaks the line from 90 to the midpoint 100; the jump
		// at 104 arcs from there to 110. Neither takes the other's style.
		expect(path).toBe(
			"M 0 50 L 90 50 M 100 50 L 100 50 A 5 6 0 0 0 110 50 L 190 50",
		);
	});

	it("keeps a drawable hop next to a crossing right at the segment end", () => {
		const diagram: CoordinatedDiagram = {
			id: "hop-near-end",
			direction: "LR",
			nodes: [],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 0, y: 50 },
						{ x: 200, y: 50 },
					],
				},
				...[5, 16].map((x) => ({
					id: `v${x}`,
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x, y: 20 },
						{ x, y: 80 },
					],
				})),
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edgeCrossings: [5, 16].map((x) => ({
				x,
				y: 50,
				underEdgeId: "h",
				overEdgeId: `v${x}`,
				style: "jump" as const,
			})),
		};
		const path = exportSvg(diagram).match(/data-id="h" d="([^"]*)"/)?.[1] ?? "";
		// The crossing at x=5 has no room; the one at x=16 still gets its hop.
		expect(path).toBe("M 0 50 L 10 50 A 6 6 0 0 0 22 50 L 190 50");
	});

	it("does not run a short route through a table as a text-clearance problem", () => {
		const table = { x: 180, y: -200, width: 60, height: 460 };
		const solved = solveDiagram(
			{
				id: "short-through-table",
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
						position: { x: 340, y: 0 },
					},
				],
				edges: [
					{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
				],
				groups: [],
				tables: [
					{
						id: "t",
						columns: [{ id: "c", label: { text: "Spec" } }],
						rows: [{ id: "r", cells: { c: { text: "x" } } }],
						position: { x: table.x, y: table.y },
						size: { width: table.width, height: table.height },
					},
				],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", routeKind: "short-orthogonal-jumps" },
		);
		// A crossing, if any, is reported as an obstacle, never as a label
		// problem external-label remediation could fix.
		expect(
			solved.diagnostics.filter(
				(diagnostic) =>
					diagnostic.code === "routing.text-clearance.unresolved" &&
					diagnostic.detail?.edgeId === "a-b",
			),
		).toEqual([]);
	});

	it("keeps Excalidraw hops clear of the arrowhead", () => {
		const diagram: CoordinatedDiagram = {
			id: "hop-at-arrowhead",
			direction: "LR",
			nodes: [],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 0, y: 50 },
						{ x: 200, y: 50 },
					],
				},
				{
					id: "v",
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x: 188, y: 20 },
						{ x: 188, y: 80 },
					],
				},
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			// 12px before the target: room for the glyph, not for the arrowhead.
			edgeCrossings: [
				{ x: 188, y: 50, underEdgeId: "h", overEdgeId: "v", style: "jump" },
			],
		};
		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: Array<{ id: string; points?: Array<{ x: number; y: number }> }>;
		};
		const under = scene.elements.find((element) => element.id === "edge:h");
		expect(under?.points).toHaveLength(2);
	});

	it("emits edgeCrossings from solve without treating jumps as unsatisfiable alone", () => {
		const solved = solveDiagram(
			{
				id: "crossing-ok",
				direction: "LR",
				nodes: [
					{
						id: "a",
						shape: "rectangle",
						size: { width: 40, height: 20 },
						padding: { top: 4, right: 4, bottom: 4, left: 4 },
						position: { x: 0, y: 40 },
					},
					{
						id: "b",
						shape: "rectangle",
						size: { width: 40, height: 20 },
						padding: { top: 4, right: 4, bottom: 4, left: 4 },
						position: { x: 160, y: 40 },
					},
					{
						id: "c",
						shape: "rectangle",
						size: { width: 40, height: 20 },
						padding: { top: 4, right: 4, bottom: 4, left: 4 },
						position: { x: 80, y: 0 },
					},
					{
						id: "d",
						shape: "rectangle",
						size: { width: 40, height: 20 },
						padding: { top: 4, right: 4, bottom: 4, left: 4 },
						position: { x: 80, y: 80 },
					},
				],
				edges: [
					{
						id: "h",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
					},
					{
						id: "v",
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
				routeKind: "short-orthogonal-jumps",
				deliverabilityMode: "degraded-ok",
			},
		);

		expect((solved.edgeCrossings ?? []).length).toBeGreaterThanOrEqual(1);
		expect(solved.deliverability?.status).not.toBe("unsatisfiable");
		expect(solved.bounds.x).toBeLessThanOrEqual(-6);
		expect(solved.bounds.y).toBeLessThanOrEqual(-6);
	});

	it("defaults short-orthogonal-jumps to three attach slots without explicit option", () => {
		const withDefault = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 120 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 200, y: 40, width: 80, height: 40 },
			}),
			maxDetourRatio: 3,
		});
		const midOnly = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 120 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 200, y: 40, width: 80, height: 40 },
			}),
			maxAttachPointsPerSide: 1,
			maxDetourRatio: 3,
		});
		const lengthOf = (points: { x: number; y: number }[]) => {
			let length = 0;
			for (let i = 0; i < points.length - 1; i += 1) {
				const a = points[i];
				const b = points[i + 1];
				if (a === undefined || b === undefined) continue;
				length += Math.hypot(b.x - a.x, b.y - a.y);
			}
			return length;
		};
		expect(withDefault.diagnostics).toEqual([]);
		expect(lengthOf(withDefault.points)).toBeLessThanOrEqual(
			lengthOf(midOnly.points),
		);
	});

	it("renders SVG gap breaks for style=gap crossings", () => {
		const diagram: CoordinatedDiagram = {
			id: "gap-export",
			direction: "LR",
			nodes: [
				{
					id: "a",
					shape: "rectangle",
					box: { x: 0, y: 40, width: 40, height: 20 },
					anchors: [],
				},
				{
					id: "b",
					shape: "rectangle",
					box: { x: 160, y: 40, width: 40, height: 20 },
					anchors: [],
				},
			],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 40, y: 50 },
						{ x: 160, y: 50 },
					],
				},
			],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edgeCrossings: [
				{
					x: 100,
					y: 50,
					underEdgeId: "h",
					overEdgeId: "other",
					style: "gap",
				},
			],
		};
		const svg = exportSvg(diagram);
		expect(svg).toMatch(/data-id="h"[^>]* M /);
		expect(svg).toMatch(/viewBox="-6 -6 /);
	});
});

describe("#95 fallback end pinning", () => {
	it("turns a straight two-point fallback into a Z onto both slots", () => {
		const pinned = pinRouteEnds(
			[
				{ x: 0, y: 50 },
				{ x: 100, y: 50 },
			],
			{ x: 0, y: 40 },
			{ x: 100, y: 60 },
		);
		expect(pinned).toEqual([
			{ x: 0, y: 40 },
			{ x: 50, y: 40 },
			{ x: 50, y: 60 },
			{ x: 100, y: 60 },
		]);
		expect(routeEndsAt(pinned, { x: 0, y: 40 }, { x: 100, y: 60 })).toBe(true);
	});

	it("reports ends it cannot pin so the fallback is rejected", () => {
		// The requested source lies on another side: no shift reaches it.
		const route = [
			{ x: 0, y: 50 },
			{ x: 50, y: 50 },
			{ x: 50, y: 100 },
		];
		const pinned = pinRouteEnds(route, { x: 20, y: 30 }, undefined);
		expect(routeEndsAt(pinned, { x: 20, y: 30 }, undefined)).toBe(false);
	});
});

describe("Excalidraw pieces split at a gap", () => {
	it("hops on every piece and puts the arrowhead only at the target", () => {
		const diagram = {
			id: "gap-pieces",
			direction: "LR",
			nodes: [],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 0, y: 50 },
						{ x: 100, y: 50 },
						{ x: 200, y: 50 },
					],
				},
				...[84, 150, 170].map((x) => ({
					id: `v${x}`,
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x, y: 0 },
						{ x, y: 100 },
					],
				})),
			],
			edgeCrossings: [
				{ x: 84, y: 50, underEdgeId: "h", overEdgeId: "v84", style: "jump" },
				{ x: 150, y: 50, underEdgeId: "h", overEdgeId: "v150", style: "gap" },
				{ x: 170, y: 50, underEdgeId: "h", overEdgeId: "v170", style: "jump" },
			],
		} as unknown as CoordinatedDiagram;
		const pieces = JSON.parse(exportExcalidraw(diagram)).elements.filter(
			(element: { id: string }) => element.id.startsWith("edge:h"),
		);
		expect(pieces).toHaveLength(2);
		const [first, second] = pieces;
		// The piece cut at the gap has no arrowhead and no binding there.
		expect(first.endArrowhead).toBeNull();
		expect(first.endBinding).toBeNull();
		expect(first.startBinding).not.toBeNull();
		// The piece after the gap keeps its own hop (at x=170) and ends at
		// the target with the arrowhead.
		expect(second.startBinding).toBeNull();
		expect(second.endBinding).not.toBeNull();
		expect(second.endArrowhead).toBe("arrow");
		expect(second.points.some((point: { y: number }) => point.y < -1)).toBe(
			true,
		);
	});

	it("keeps a jump right beside a gap", () => {
		// A gap at x=150 and a jump at x=154 share one glyph width: the gap
		// cuts [144,152], the jump bumps over [152,160].
		const diagram = {
			id: "gap-jump",
			direction: "LR",
			nodes: [],
			groups: [],
			diagnostics: [],
			degraded: false,
			bounds: { x: 0, y: 0, width: 200, height: 100 },
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 0, y: 50 },
						{ x: 200, y: 50 },
					],
				},
				...[150, 154].map((x) => ({
					id: `v${x}`,
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x, y: 0 },
						{ x, y: 100 },
					],
				})),
			],
			edgeCrossings: [
				{ x: 150, y: 50, underEdgeId: "h", overEdgeId: "v150", style: "gap" },
				{ x: 154, y: 50, underEdgeId: "h", overEdgeId: "v154", style: "jump" },
			],
		} as unknown as CoordinatedDiagram;
		const pieces = JSON.parse(exportExcalidraw(diagram)).elements.filter(
			(element: { id: string }) => element.id.startsWith("edge:h"),
		);
		expect(pieces).toHaveLength(2);
		const [first, second] = pieces;
		// The first piece stops at the gap's start (x=144).
		expect(first.x + first.points.at(-1).x).toBe(144);
		// The second starts halfway (x=152) and bumps for the jump.
		expect(second.x).toBe(152);
		expect(second.points.some((point: { y: number }) => point.y < -1)).toBe(
			true,
		);
	});
});
