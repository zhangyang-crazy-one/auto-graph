import { describe, expect, it } from "vitest";
import { attachSlotFractions } from "../src/geometry/attach-slots.js";
import { computeShapeGeometry } from "../src/geometry/shapes.js";
import type { NormalizedEdge } from "../src/ir/elements.js";
import {
	nudgeOrthogonalRoutes,
	revertCoincidentMoves,
	routeEdge,
} from "../src/routing/index.js";
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

describe("channel nudge rollback", () => {
	const edge = (id: string, y: number) => ({
		id,
		source: { nodeId: `${id}-s` },
		target: { nodeId: `${id}-t` },
		points: [
			{ x: 0, y: 0 },
			{ x: 0, y },
			{ x: 100, y },
			{ x: 100, y: 200 },
		],
	});

	it("undoes a move onto another route's line", () => {
		const original = [edge("a", 50), edge("b", 60)];
		// "a" moved onto the line "b" kept.
		const moved = [edge("a", 60), original[1] as ReturnType<typeof edge>];
		const settled = revertCoincidentMoves(original as never, moved as never);
		expect(settled.edges[0]).toBe(original[0]);
		expect(settled.overlapping).toBe(false);
	});

	it("reports routes left on one line after a rollback", () => {
		const original = [edge("a", 50), edge("b", 50), edge("c", 50)];
		// "a" was rolled back (hard obstacle), "b" took the centre track,
		// "c" moved one pitch away: "a" and "b" still share y=50.
		const moved = [original[0], edge("b", 50), edge("c", 60)];
		const settled = revertCoincidentMoves(original as never, moved as never);
		expect(settled.overlapping).toBe(true);
		expect(settled.edges[2]?.points[1]?.y).toBe(60);
	});
});

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

	it("counts named ports on a side toward its slot capacity", () => {
		const nodes = new Map([
			shape("a", 0, 0, 80, 160),
			shape("b", 200, 0),
			shape("c", 200, 80),
			shape("d", 200, 160),
		]);
		const edges: NormalizedEdge[] = ["b", "c", "d"].map((target) => ({
			id: `to-${target}`,
			source: { nodeId: "a", anchor: "right" },
			target: { nodeId: target, anchor: "left" },
		}));
		// Three anonymous ends fit three slots on a free side, but not
		// beside two named ports.
		const free = assignSameSideSlots({
			edges,
			nodes,
			direction: "LR",
			maxAttachPointsPerSide: 3,
		});
		expect(free.diagnostics).toEqual([]);
		const ported = assignSameSideSlots({
			edges,
			nodes,
			direction: "LR",
			maxAttachPointsPerSide: 3,
			occupied: new Map([["a:right", [0.25, 0.75]]]),
		});
		expect(ported.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.channel.capacity_exhausted",
				detail: expect.objectContaining({
					nodeId: "a",
					side: "right",
					edgeCount: 3,
					portCount: 2,
				}),
			}),
		);
	});

	it("picks TB slot sides from the boxes for back-edges and same-rank pairs", () => {
		const nodes = new Map([
			shape("top", 0, 0),
			shape("low", 0, 200),
			shape("peer", 200, 200),
		]);
		const edges: NormalizedEdge[] = [
			// Back-edge: the source sits below its target.
			{ id: "back", source: { nodeId: "low" }, target: { nodeId: "top" } },
			// Same rank: side by side.
			{ id: "flat", source: { nodeId: "low" }, target: { nodeId: "peer" } },
		];
		const { assignments } = assignSameSideSlots({
			edges,
			nodes,
			direction: "TB",
			maxAttachPointsPerSide: 3,
		});
		expect(assignments.get("back:source")?.anchor).toBe("top");
		expect(assignments.get("back:target")?.anchor).toBe("bottom");
		expect(assignments.get("flat:source")?.anchor).toBe("right");
		expect(assignments.get("flat:target")?.anchor).toBe("left");
	});

	it("lines up lone facing ends so the route runs straight", () => {
		const nodes = new Map([
			shape("upper", 0, 0, 88, 42),
			shape("lower", 0, 140, 80, 42),
			shape("port", 300, 0, 80, 120),
		]);
		const { assignments } = assignSameSideSlots({
			edges: [
				{
					id: "down",
					source: { nodeId: "upper" },
					target: { nodeId: "lower" },
				},
				{
					id: "ported",
					source: { nodeId: "port", portId: "p" },
					target: { nodeId: "upper" },
				},
			],
			nodes,
			direction: "TB",
			maxAttachPointsPerSide: 3,
			portPoints: new Map([["port", new Map([["p", { x: 300, y: 30 }]])]]),
		});
		// Shared span x 0–80: both ends at x=40, not 44 and 40.
		expect(assignments.get("down:source")?.point.x).toBe(40);
		expect(assignments.get("down:target")?.point.x).toBe(40);
		// Level with the named port it faces.
		expect(assignments.get("ported:target")?.point.y).toBe(30);
	});

	it("gives no slot to an end with an authored corner or center anchor", () => {
		const nodes = new Map([
			shape("a", 0, 0, 80, 160),
			shape("b", 200, 0),
			shape("c", 200, 100),
		]);
		const { assignments, diagnostics } = assignSameSideSlots({
			edges: [
				{
					id: "corner",
					source: { nodeId: "a", anchor: "top-right" },
					target: { nodeId: "b", anchor: "left" },
				},
				{
					id: "free",
					source: { nodeId: "a", anchor: "right" },
					target: { nodeId: "c", anchor: "left" },
				},
			],
			nodes,
			direction: "LR",
			maxAttachPointsPerSide: 1,
		});
		expect(assignments.has("corner:source")).toBe(false);
		// The lone anonymous end keeps the whole side (no false overflow).
		expect(diagnostics).toEqual([]);
		expect(assignments.get("free:source")?.anchor).toBe("right");
	});

	it("puts off-centre slots on an ellipse's outline", () => {
		const node = (
			id: string,
			shape: "ellipse" | "rectangle",
			y: number,
			x: number,
		) => ({
			id,
			shape,
			size: { width: 80, height: 120 },
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
			position: { x, y },
		});
		const solved = solveDiagram(
			{
				id: "ellipse-slots",
				direction: "LR",
				nodes: [
					node("hub", "ellipse", 40, 0),
					{
						...node("r1", "rectangle", 0, 240),
						size: { width: 80, height: 40 },
					},
					{
						...node("r2", "rectangle", 180, 240),
						size: { width: 80, height: 40 },
					},
				],
				edges: [
					{ id: "e1", source: { nodeId: "hub" }, target: { nodeId: "r1" } },
					{ id: "e2", source: { nodeId: "hub" }, target: { nodeId: "r2" } },
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "positions", routeKind: "short-orthogonal-jumps" },
		);
		const hub = solved.nodes.find((entry) => entry.id === "hub")?.box;
		expect(hub).toBeDefined();
		if (hub === undefined) return;
		const rx = hub.width / 2;
		const ry = hub.height / 2;
		const starts = solved.edges.map((edge) => edge.points[0]);
		// Two ends on one side: at least one is off the side's middle.
		expect(
			starts.some((point) => Math.abs((point?.y ?? 0) - (hub.y + ry)) > 1),
		).toBe(true);
		for (const point of starts) {
			if (point === undefined) continue;
			const radius =
				((point.x - hub.x - rx) / rx) ** 2 + ((point.y - hub.y - ry) / ry) ** 2;
			expect(radius).toBeCloseTo(1, 2);
		}
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

	it("reports a micro-clear route past the two-bend contract", () => {
		// Soft text leaves only micro-cleared candidates, which need four
		// bends: the route is delivered, but never silently.
		const result = routeEdge({
			kind: "short-orthogonal-jumps",
			direction: "LR",
			source: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 0, y: 0, width: 80, height: 60 },
			}),
			target: computeShapeGeometry({
				shape: "rectangle",
				box: { x: 300, y: 80, width: 80, height: 60 },
			}),
			sourceAnchor: "right",
			targetAnchor: "left",
			obstacles: [
				{ x: 177, y: 133, width: 63, height: 35 },
				{ x: 95, y: 154, width: 45, height: 16 },
				{ x: 180, y: 14, width: 30, height: 30 },
				{ x: 187, y: 100, width: 58, height: 30 },
			],
			hardObstacles: [],
			softTextClearPitch: 10,
			maxAttachPointsPerSide: 3,
			maxDetourRatio: 3,
		});
		let bends = 0;
		for (let index = 1; index < result.points.length - 1; index += 1) {
			const a = result.points[index - 1];
			const b = result.points[index];
			const c = result.points[index + 1];
			if (a === undefined || b === undefined || c === undefined) continue;
			if (Math.abs(a.x - b.x) < 0.5 !== Math.abs(b.x - c.x) < 0.5) {
				bends += 1;
			}
		}
		expect(bends).toBeGreaterThan(2);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.short-orthogonal.bend_budget_exceeded",
				detail: expect.objectContaining({ bendCount: bends, maxBends: 2 }),
			}),
		);
	});
});
