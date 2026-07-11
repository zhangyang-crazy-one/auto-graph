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
