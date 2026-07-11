import { describe, expect, it } from "vitest";
import { exportDrawio, exportSvg } from "../src/exporters/index.js";
import {
	computeShapeGeometry,
	detectOrthogonalEdgeCrossings,
} from "../src/geometry/index.js";
import type { CoordinatedDiagram } from "../src/ir/index.js";
import {
	assignChannelTracks,
	nudgeOrthogonalRoutes,
	routeEdge,
} from "../src/routing/index.js";
import { solveDiagram } from "../src/solver/index.js";

describe("RSOP Phase-2 soft-text micro-clear (#87)", () => {
	it("prefers a hard-clear soft-cost path without flyer detours", () => {
		// Text soft obstacle sits on the default mid L-bend; micro-clear or
		// alternate slot should keep detour ≤ 3 and never emit fallback success.
		const textSoft = { x: 110, y: 10, width: 40, height: 30 };
		const result = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 40 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 220, y: 0, width: 80, height: 40 },
			}),
			obstacles: [textSoft],
			hardObstacles: [],
			maxAttachPointsPerSide: 3,
			maxDetourRatio: 3,
			softTextClearPitch: 12,
		});

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "route_obstacle_fallback" }),
		);
		let length = 0;
		for (let i = 0; i < result.points.length - 1; i += 1) {
			const a = result.points[i];
			const b = result.points[i + 1];
			if (a === undefined || b === undefined) continue;
			length += Math.hypot(b.x - a.x, b.y - a.y);
		}
		expect(length / 140).toBeLessThanOrEqual(3);
	});

	it("keeps foreign nodes hard under short-orthogonal solve", () => {
		const solved = solveDiagram(
			{
				id: "rsop-node-hard",
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
				edges: [{ id: "e1", source: { nodeId: "a" }, target: { nodeId: "b" } }],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				maxDetourRatio: 3,
				deliverabilityMode: "strict",
			},
		);
		expect(solved.diagnostics).toContainEqual(
			expect.objectContaining({
				code: expect.stringMatching(
					/routing\.(obstacle\.unavoidable|evidence\.crossing_forbidden|deliverability\.unsatisfiable)/,
				),
			}),
		);
		expect(solved.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "route_obstacle_fallback" }),
		);
	});
});

describe("RSOP Phase-3/4 channel tracks + nudge (#88)", () => {
	it("assigns distinct tracks to parallel gutter edges", () => {
		const edges = [
			{
				id: "e1",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				points: [
					{ x: 0, y: 10 },
					{ x: 100, y: 10 },
					{ x: 100, y: 80 },
					{ x: 200, y: 80 },
				],
			},
			{
				id: "e2",
				source: { nodeId: "c" },
				target: { nodeId: "d" },
				points: [
					{ x: 0, y: 12 },
					{ x: 100, y: 12 },
					{ x: 100, y: 120 },
					{ x: 200, y: 120 },
				],
			},
			{
				id: "e3",
				source: { nodeId: "e" },
				target: { nodeId: "f" },
				points: [
					{ x: 0, y: 14 },
					{ x: 100, y: 14 },
					{ x: 100, y: 160 },
					{ x: 200, y: 160 },
				],
			},
		];
		const tracks = assignChannelTracks(edges, { idealNudgingDistance: 10 });
		expect(tracks.assignments.length).toBeGreaterThanOrEqual(3);
		const verticalTracks = tracks.assignments.filter(
			(assignment) => assignment.axis === "v",
		);
		const unique = new Set(
			verticalTracks.map((assignment) => assignment.track),
		);
		expect(unique.size).toBeGreaterThanOrEqual(2);

		const nudged = nudgeOrthogonalRoutes(edges, {
			idealNudgingDistance: 10,
		});
		const midXs = nudged.edges.map((edge) => edge.points[1]?.x ?? 0);
		expect(
			new Set(midXs.map((x) => Math.round(x))).size,
		).toBeGreaterThanOrEqual(2);
	});

	it("emits capacity_exhausted when track budget is tiny", () => {
		const edges = Array.from({ length: 6 }, (_, index) => ({
			id: `e${index}`,
			source: { nodeId: "a" },
			target: { nodeId: "b" },
			points: [
				{ x: 0, y: index },
				{ x: 80, y: index },
				{ x: 80, y: 40 + index * 20 },
				{ x: 160, y: 40 + index * 20 },
			],
		}));
		const tracks = assignChannelTracks(edges, {
			idealNudgingDistance: 8,
			maxTracks: 2,
		});
		expect(tracks.capacityExhausted).toBe(true);
	});
});

describe("RSOP Phase-5 draw.io jump parity (#89)", () => {
	it("exports jumpStyle and crossing metadata for orthogonal hops", () => {
		const diagram: CoordinatedDiagram = {
			id: "jump-parity",
			direction: "LR",
			bounds: { x: 0, y: 0, width: 300, height: 200 },
			diagnostics: [],
			degraded: false,
			nodes: [
				{
					id: "a",
					shape: "rectangle",
					box: { x: 0, y: 0, width: 60, height: 30 },
					anchors: [],
					label: { text: "A" },
				},
				{
					id: "b",
					shape: "rectangle",
					box: { x: 200, y: 0, width: 60, height: 30 },
					anchors: [],
					label: { text: "B" },
				},
				{
					id: "c",
					shape: "rectangle",
					box: { x: 80, y: 120, width: 60, height: 30 },
					anchors: [],
					label: { text: "C" },
				},
				{
					id: "d",
					shape: "rectangle",
					box: { x: 80, y: -80, width: 60, height: 30 },
					anchors: [],
					label: { text: "D" },
				},
			],
			groups: [],
			edges: [
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 60, y: 15 },
						{ x: 200, y: 15 },
					],
				},
				{
					id: "v",
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x: 110, y: 120 },
						{ x: 110, y: -50 },
					],
				},
			],
			edgeCrossings: detectOrthogonalEdgeCrossings([
				{
					id: "h",
					source: { nodeId: "a" },
					target: { nodeId: "b" },
					points: [
						{ x: 60, y: 15 },
						{ x: 200, y: 15 },
					],
				},
				{
					id: "v",
					source: { nodeId: "c" },
					target: { nodeId: "d" },
					points: [
						{ x: 110, y: 120 },
						{ x: 110, y: -50 },
					],
				},
			]),
		};

		expect((diagram.edgeCrossings ?? []).length).toBeGreaterThanOrEqual(1);
		const svg = exportSvg(diagram);
		expect(svg).toMatch(/path|arc|jump|M /i);
		const drawio = exportDrawio(diagram);
		expect(drawio).toContain("jumpStyle=arc");
		expect(drawio).toContain("dgeCrossings=");
		expect(drawio).toContain("<mxfile");
	});
});

describe("RSOP Phase-6 shelf pageBounds honesty", () => {
	it("keeps external callout shelves inside pageBounds when set", () => {
		const solved = solveDiagram(
			{
				id: "shelf-bounds",
				direction: "LR",
				nodes: [
					{
						id: "a",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 20, y: 40 },
						label: { text: "A" },
					},
					{
						id: "b",
						shape: "rectangle",
						size: { width: 80, height: 40 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 200, y: 40 },
						label: { text: "B" },
					},
				],
				edges: [
					{
						id: "e1",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						label: { text: "congested-label-needs-external-shelf" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				externalLabels: true,
				pageBounds: { width: 320, height: 200 },
				deliverabilityMode: "degraded-ok",
			},
		);
		const callouts = (solved.textAnnotations ?? []).filter(
			(annotation) =>
				annotation.placement === "external-callout" &&
				annotation.placementDetail?.role === "callout",
		);
		for (const callout of callouts) {
			expect(callout.box.x + callout.box.width).toBeLessThanOrEqual(320);
			expect(callout.box.y + callout.box.height).toBeLessThanOrEqual(200);
		}
	});
});
