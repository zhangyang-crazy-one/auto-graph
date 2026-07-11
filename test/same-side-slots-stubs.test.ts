import { describe, expect, it } from "vitest";
import { attachSlotFractions } from "../src/geometry/attach-slots.js";
import { computeShapeGeometry } from "../src/geometry/shapes.js";
import type { NormalizedEdge } from "../src/ir/elements.js";
import { nudgeOrthogonalRoutes, routeEdge } from "../src/routing/index.js";
import { assignSameSideSlots } from "../src/routing/same-side-slots.js";
import { solveDiagram } from "../src/solver/index.js";

function shape(
	id: string,
	x: number,
	y: number,
	w = 80,
	h = 48,
): [string, ReturnType<typeof computeShapeGeometry>] {
	return [
		id,
		computeShapeGeometry({
			shape: "rectangle",
			box: { x, y, width: w, height: h },
		}),
	];
}

describe("same-side slots + escape stubs (#92)", () => {
	it("pre-assigns 0.25/0.5/0.75 for three anonymous same-side endpoints", () => {
		const nodes = new Map([
			shape("a", 0, 0, 80, 160),
			shape("b", 200, 0),
			shape("c", 200, 80),
			shape("d", 200, 160),
		]);
		const edges: NormalizedEdge[] = [
			{
				id: "e1",
				source: { nodeId: "a", anchor: "right" },
				target: { nodeId: "b", anchor: "left" },
			},
			{
				id: "e2",
				source: { nodeId: "a", anchor: "right" },
				target: { nodeId: "c", anchor: "left" },
			},
			{
				id: "e3",
				source: { nodeId: "a", anchor: "right" },
				target: { nodeId: "d", anchor: "left" },
			},
		];
		const assigned = assignSameSideSlots({
			edges,
			nodes,
			direction: "LR",
			maxAttachPointsPerSide: 3,
		});
		expect(assigned.diagnostics).toEqual([]);
		const fractions = ["e1", "e2", "e3"].map(
			(id) => assigned.assignments.get(`${id}:source`)?.fraction,
		);
		expect(fractions).toEqual(attachSlotFractions(3));
		const ys = ["e1", "e2", "e3"].map(
			(id) => assigned.assignments.get(`${id}:source`)?.point.y,
		);
		expect(new Set(ys).size).toBe(3);
	});

	it("separates parallel same-side tracks by at least pitch", () => {
		const solved = solveDiagram(
			{
				id: "same-side-stubs",
				direction: "LR",
				nodes: [
					{
						id: "left",
						shape: "rectangle",
						size: { width: 80, height: 120 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 0, y: 40 },
					},
					{
						id: "r1",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 220, y: 20 },
					},
					{
						id: "r2",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 220, y: 80 },
					},
					{
						id: "r3",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 220, y: 140 },
					},
				],
				edges: [
					{
						id: "p1",
						source: { nodeId: "left", anchor: "right" },
						target: { nodeId: "r1", anchor: "left" },
					},
					{
						id: "p2",
						source: { nodeId: "left", anchor: "right" },
						target: { nodeId: "r2", anchor: "left" },
					},
					{
						id: "p3",
						source: { nodeId: "left", anchor: "right" },
						target: { nodeId: "r3", anchor: "left" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				idealNudgingDistance: 10,
				maxAttachPointsPerSide: 3,
			},
		);
		const trackYs = [...solved.edges]
			.map((edge) => edge.points[0]?.y)
			.filter((y): y is number => y !== undefined)
			.sort((a, b) => a - b);
		expect(trackYs).toHaveLength(3);
		for (let i = 1; i < trackYs.length; i += 1) {
			expect(trackYs[i]! - trackYs[i - 1]!).toBeGreaterThanOrEqual(9.5);
		}
	});

	it("keeps endpoints fixed after channel nudge", () => {
		const edges = [
			{
				id: "e1",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				points: [
					{ x: 80, y: 25 },
					{ x: 140, y: 25 },
					{ x: 140, y: 30 },
					{ x: 240, y: 30 },
				],
			},
			{
				id: "e2",
				source: { nodeId: "a" },
				target: { nodeId: "c" },
				points: [
					{ x: 80, y: 75 },
					{ x: 140, y: 75 },
					{ x: 140, y: 90 },
					{ x: 240, y: 90 },
				],
			},
		];
		const before = edges.map((edge) => ({
			id: edge.id,
			start: { ...edge.points[0]! },
			end: { ...edge.points[edge.points.length - 1]! },
		}));
		const nudged = nudgeOrthogonalRoutes(edges, {
			idealNudgingDistance: 10,
		});
		for (const edge of nudged.edges) {
			const original = before.find((entry) => entry.id === edge.id);
			expect(edge.points[0]).toEqual(original?.start);
			expect(edge.points[edge.points.length - 1]).toEqual(original?.end);
		}
	});

	it("prefers separable interior over 0-bend when endpoints differ in Y", () => {
		const result = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 80 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 200, y: 40, width: 80, height: 40 },
			}),
			sourceAnchor: "right",
			targetAnchor: "left",
			sourcePoint: { x: 80, y: 20 },
			targetPoint: { x: 200, y: 60 },
			obstacles: [],
			hardObstacles: [],
			softTextClearPitch: 10,
			maxAttachPointsPerSide: 3,
			maxDetourRatio: 3,
		});
		expect(result.points.length).toBeGreaterThan(2);
		expect(result.diagnostics.map((d) => d.code)).not.toContain(
			"routing.obstacle.unavoidable",
		);
	});
});
