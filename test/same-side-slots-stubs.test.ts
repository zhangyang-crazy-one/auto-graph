import { describe, expect, it } from "vitest";
import { attachSlotFractions } from "../src/geometry/attach-slots.js";
import { computeShapeGeometry } from "../src/geometry/shapes.js";
import type { NormalizedEdge } from "../src/ir/elements.js";
import {
	applyChannelTrackAssignments,
	nudgeOrthogonalRoutes,
	revertCoincidentMoves,
	revertCrossingMoves,
	routeEdge,
} from "../src/routing/index.js";
import {
	assignSameSideSlots,
	slotFits,
} from "../src/routing/same-side-slots.js";
import { solveDiagram } from "../src/solver/index.js";
import {
	clearOutlineRuns,
	tidyRouteEnds,
	withCrowdedEnds,
} from "../src/solver/route-edges.js";

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

	it("undoes a move onto another route's end segment", () => {
		// "b" leaves its node along y=60 (its first segment); "a"'s middle
		// track moved from y=50 onto that line.
		const b = {
			id: "b",
			source: { nodeId: "b-s" },
			target: { nodeId: "b-t" },
			points: [
				{ x: 20, y: 60 },
				{ x: 80, y: 60 },
				{ x: 80, y: 200 },
			],
		};
		const original = [edge("a", 50), b];
		const moved = [edge("a", 60), b];
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

describe("channel track moves beside margin-grown node boxes", () => {
	// S (0,0,40,40) → T (100,80,40,40); the vertical track moves x 60 → 70.
	const route = {
		id: "e",
		source: { nodeId: "s" },
		target: { nodeId: "t" },
		points: [
			{ x: 40, y: 20 },
			{ x: 60, y: 20 },
			{ x: 60, y: 100 },
			{ x: 100, y: 100 },
		],
	};
	const assignments = [
		{ edgeId: "e", segmentIndex: 1, axis: "v" as const, track: 1, coord: 70 },
	];
	// Hard obstacles grown by a 5px margin contain the route's own ends.
	const grown = [
		{ x: -5, y: -5, width: 50, height: 50 },
		{ x: 95, y: 75, width: 50, height: 50 },
	];
	const outlines = [
		{ x: 0, y: 0, width: 40, height: 40 },
		{ x: 100, y: 80, width: 40, height: 40 },
	];

	it("keeps a valid move when the real end outlines are given", () => {
		const [moved] = applyChannelTrackAssignments(
			[route] as never,
			assignments,
			grown,
			outlines,
		);
		expect(moved?.points[1]).toEqual({ x: 70, y: 20 });
	});

	it("still refuses a move through an end node's real outline", () => {
		const [moved] = applyChannelTrackAssignments(
			[route] as never,
			[
				{
					edgeId: "e",
					segmentIndex: 0,
					axis: "h" as const,
					track: 1,
					coord: 30,
				},
			],
			grown,
			[
				{ x: 0, y: 0, width: 80, height: 40 },
				{ x: 100, y: 80, width: 40, height: 40 },
			],
		);
		expect(moved).toBe(route);
	});
});

describe("channel nudge crossing rollback", () => {
	const route = (id: string, points: { x: number; y: number }[]) => ({
		id,
		source: { nodeId: `${id}-s` },
		target: { nodeId: `${id}-t` },
		points,
	});
	// "b" is a vertical route at x=50 spanning y 0..40.
	const b = route("b", [
		{ x: 50, y: 0 },
		{ x: 50, y: 40 },
	]);

	it("undoes a track move that stretches a route across another", () => {
		// "a"'s middle track moves from y=60 (below "b") to y=20, across it.
		const original = [
			route("a", [
				{ x: 0, y: 100 },
				{ x: 0, y: 60 },
				{ x: 100, y: 60 },
				{ x: 100, y: 100 },
			]),
			b,
		];
		const moved = [
			route("a", [
				{ x: 0, y: 100 },
				{ x: 0, y: 20 },
				{ x: 100, y: 20 },
				{ x: 100, y: 100 },
			]),
			b,
		];
		const settled = revertCrossingMoves(original as never, moved as never);
		expect(settled[0]).toBe(original[0]);
	});

	it("undoes two moves that only cross each other", () => {
		// Apart in place; each moved route crosses the other's old line and
		// the two moved lines cross each other.
		const original = [
			route("a", [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
			]),
			route("b", [
				{ x: 200, y: -50 },
				{ x: 200, y: 50 },
			]),
		];
		const moved = [
			route("a", [
				{ x: 0, y: 0 },
				{ x: 300, y: 0 },
			]),
			route("b", [
				{ x: 50, y: -50 },
				{ x: 50, y: 50 },
			]),
		];
		const settled = revertCrossingMoves(original as never, moved as never);
		expect(settled[0]).toBe(original[0]);
		expect(settled[1]).toBe(original[1]);
	});

	it("keeps a move that crosses no more routes than before", () => {
		const original = [
			route("a", [
				{ x: 0, y: 100 },
				{ x: 0, y: 60 },
				{ x: 100, y: 60 },
				{ x: 100, y: 100 },
			]),
			b,
		];
		const moved = [
			route("a", [
				{ x: 0, y: 100 },
				{ x: 0, y: 70 },
				{ x: 100, y: 70 },
				{ x: 100, y: 100 },
			]),
			b,
		];
		const settled = revertCrossingMoves(original as never, moved as never);
		expect(settled[0]).toBe(moved[0]);
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

	it("reports ends crowding a port even when the slot count fits", () => {
		// A 48px side with ports at 0.25/0.75 and two anonymous ends, five
		// slots allowed: one end lands at 0.125, 6px from a port centre.
		const nodes = new Map([
			shape("a", 0, 0, 80, 48),
			shape("b", 200, 0),
			shape("c", 200, 80),
		]);
		const edges: NormalizedEdge[] = ["b", "c"].map((target) => ({
			id: `to-${target}`,
			source: { nodeId: "a", anchor: "right" },
			target: { nodeId: target, anchor: "left" },
		}));
		const assigned = assignSameSideSlots({
			edges,
			nodes,
			direction: "LR",
			maxAttachPointsPerSide: 5,
			occupied: new Map([["a:right", [0.25, 0.75]]]),
		});
		expect(assigned.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.channel.capacity_exhausted",
				detail: expect.objectContaining({
					nodeId: "a",
					side: "right",
					minSpacing: 10,
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

describe("relocated endpoint capacity", () => {
	it("refuses a side with no slot left or no room beside its ports", () => {
		// Two ports and an end already on a 48px side: a fourth does not fit
		// three slots.
		expect(slotFits(0.5, [0.25, 0.75, 0.125], 48, 3)).toBe(false);
		// A free slot, but 6px from a port centre on a 48px side.
		expect(slotFits(0.125, [0.25, 0.75], 48, 5)).toBe(false);
		// Room on a longer side.
		expect(slotFits(0.5, [0.25, 0.75], 96, 3)).toBe(true);
	});
});

describe("relocated endpoint occupancy", () => {
	it("frees the slot an end leaves for later relocations", () => {
		const node = (id: string, x: number, y: number, w = 80, h = 48) => ({
			id,
			shape: "rectangle" as const,
			size: { width: w, height: h },
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
			position: { x, y },
		});
		// "e1" is slotted on a's right, walled off, and leaves by the top;
		// "e2" is slotted on a's bottom, floored off, and takes the right
		// side e1 vacated: the lone end there, centred and within capacity.
		const solved = solveDiagram(
			{
				id: "vacated-slot",
				direction: "LR",
				nodes: [
					node("a", 0, 200),
					node("wall", 140, 120, 30, 210),
					node("b", 260, 120),
					node("floor", -80, 300, 180, 30),
					node("c", -20, 420),
				],
				edges: [
					{ id: "e1", source: { nodeId: "a" }, target: { nodeId: "b" } },
					{ id: "e2", source: { nodeId: "a" }, target: { nodeId: "c" } },
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				maxAttachPointsPerSide: 1,
			},
		);
		const start = (id: string) =>
			solved.edges.find((edge) => edge.id === id)?.points[0];
		expect(start("e1")).toEqual({ x: 40, y: 200 });
		expect(start("e2")).toEqual({ x: 80, y: 224 });
		expect(solved.diagnostics.map((entry) => entry.code)).not.toContain(
			"routing.channel.capacity_exhausted",
		);
	});
});

describe("relocated endpoint capacity reports", () => {
	const node = (id: string, x: number, y: number, w = 80, h = 48) => ({
		id,
		shape: "rectangle" as const,
		size: { width: w, height: h },
		padding: { top: 8, right: 8, bottom: 8, left: 8 },
		position: { x, y },
	});
	const solve = (
		id: string,
		nodes: ReturnType<typeof node>[],
		edges: NormalizedEdge[],
		maxAttachPointsPerSide: number,
	) =>
		solveDiagram(
			{
				id,
				direction: "LR",
				nodes,
				edges,
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				maxAttachPointsPerSide,
			},
		);

	it("drops a side's overflow report once relocations empty it", () => {
		// Both ends start on a's right side (one slot); the wall sends one
		// out by the top and the other by the bottom.
		const solved = solve(
			"relieved-side",
			[
				node("a", 0, 200),
				node("wall", 140, 120, 30, 210),
				node("b", 260, 120),
				node("b2", 260, 260),
			],
			[
				{ id: "e1", source: { nodeId: "a" }, target: { nodeId: "b" } },
				{ id: "e3", source: { nodeId: "a" }, target: { nodeId: "b2" } },
			],
			1,
		);
		const starts = solved.edges.map((edge) => edge.points[0]);
		expect(starts).toEqual([
			{ x: 40, y: 200 },
			{ x: 40, y: 248 },
		]);
		expect(solved.diagnostics.map((entry) => entry.code)).not.toContain(
			"routing.channel.capacity_exhausted",
		);
	});

	it("keeps a self-loop's two relocated ends apart on one side", () => {
		const solved = solve(
			"paired-loop",
			[
				node("a", 0, 200),
				node("r", 90, 150, 30, 150),
				node("l", -50, 150, 40, 150),
			],
			[
				{
					id: "loop",
					source: { nodeId: "a", anchor: "right" },
					target: { nodeId: "a", anchor: "right" },
				},
			],
			3,
		);
		const points = solved.edges[0]?.points ?? [];
		const first = points[0];
		const last = points.at(-1);
		// Both ends leave by the bottom, at different points.
		expect(first?.y).toBe(248);
		expect(last?.y).toBe(248);
		expect(first?.x).not.toBe(last?.x);
	});
});

describe("same-side slots on global layout pages", () => {
	it("moves a layered end off a named port onto its slot", () => {
		const node = (id: string, ports?: { id: string; side: "right" }[]) => ({
			id,
			shape: "rectangle" as const,
			size: { width: 80, height: 48 },
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
			...(ports === undefined ? {} : { ports }),
		});
		const solved = solveDiagram(
			{
				id: "layered-slots",
				direction: "LR",
				nodes: [
					node("hub", [{ id: "p", side: "right" }]),
					node("x"),
					node("y"),
				] as never,
				edges: [
					{ id: "anon", source: { nodeId: "hub" }, target: { nodeId: "x" } },
					{
						id: "via-port",
						source: { nodeId: "hub", portId: "p" },
						target: { nodeId: "y" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{ initialLayout: "global", routeKind: "short-orthogonal-jumps" },
		);
		const port = solved.nodes.find((entry) => entry.id === "hub")?.ports?.[0]
			?.anchor;
		const start = solved.edges.find((edge) => edge.id === "anon")?.points[0];
		expect(port).toBeDefined();
		expect(start).toBeDefined();
		if (port === undefined || start === undefined) return;
		// The layered route ended 7px from the port; the slot keeps 10px.
		expect(
			Math.hypot(start.x - port.x, start.y - port.y),
		).toBeGreaterThanOrEqual(10);
	});
});

describe("relocation ranking", () => {
	const lexicographic = (left: number[], right: number[]) => {
		for (let index = 0; index < left.length; index += 1) {
			const difference = (left[index] ?? 0) - (right[index] ?? 0);
			if (difference !== 0) return difference;
		}
		return 0;
	};

	it("ranks an equally clean candidate that fits ahead of a crowding one", () => {
		// Same hits and penalties; the crowding candidate is even shorter.
		const crowding = withCrowdedEnds([0, 0, 0, 0, 120], 1);
		const fitting = withCrowdedEnds([0, 0, 0, 0, 150], 0);
		expect(lexicographic(fitting, crowding)).toBeLessThan(0);
	});

	it("never lets room outrank a cleaner route", () => {
		const cleanerButCrowding = withCrowdedEnds([0, 0, 0, 0, 120], 1);
		const fittingWithHit = withCrowdedEnds([0, 1, 0, 0, 120], 0);
		expect(lexicographic(cleanerButCrowding, fittingWithHit)).toBeLessThan(0);
	});
});

describe("route tidying and crossings", () => {
	const edge = (id: string, points: { x: number; y: number }[]) => ({
		id,
		source: { nodeId: `${id}-s` },
		target: { nodeId: `${id}-t` },
		points,
	});

	it("keeps a micro-jog whose straightening would cross another route", () => {
		// "a" has a 1.5px jog at x=50. Straightening it either way sweeps a
		// strip holding the end of "b" (x=75) or "c" (x=25).
		const a = edge("a", [
			{ x: 0, y: 0 },
			{ x: 0, y: 50 },
			{ x: 50, y: 50 },
			{ x: 50, y: 51.5 },
			{ x: 100, y: 51.5 },
			{ x: 100, y: 100 },
		]);
		const b = edge("b", [
			{ x: 75, y: 20 },
			{ x: 75, y: 50.8 },
		]);
		const c = edge("c", [
			{ x: 25, y: 51 },
			{ x: 25, y: 80 },
		]);
		const [tidied] = tidyRouteEnds(
			[a, b, c] as never,
			new Map(),
			[],
			new Set(["b", "c"]),
		);
		expect(tidied?.points).toEqual(a.points);
	});

	it("keeps a jog whose straightening lands on a parallel connector", () => {
		// Either straightening puts a horizontal run of "a" on a horizontal
		// run of "b" (y=50) or "c" (y=51.5): no crossing, but overlapping
		// strokes.
		const a = edge("a", [
			{ x: 0, y: 0 },
			{ x: 0, y: 50 },
			{ x: 50, y: 50 },
			{ x: 50, y: 51.5 },
			{ x: 100, y: 51.5 },
			{ x: 100, y: 100 },
		]);
		const b = edge("b", [
			{ x: 60, y: 20 },
			{ x: 60, y: 50 },
			{ x: 90, y: 50 },
			{ x: 90, y: 20 },
		]);
		const c = edge("c", [
			{ x: 10, y: 80 },
			{ x: 10, y: 51.5 },
			{ x: 40, y: 51.5 },
			{ x: 40, y: 80 },
		]);
		const [tidied] = tidyRouteEnds(
			[a, b, c] as never,
			new Map(),
			[],
			new Set(["b", "c"]),
		);
		expect(tidied?.points).toEqual(a.points);
	});
});

describe("outline clearing and crossings", () => {
	it("steps a run off an outline only where it crosses no new route", () => {
		// "a" runs 2px below a frame's top side (y=100). The nearest step
		// (y=108) would cross the vertical run of "b" (x=100, from y=104);
		// the far step (y=92) crosses nothing.
		const a = {
			id: "a",
			source: { nodeId: "a-s" },
			target: { nodeId: "a-t" },
			points: [
				{ x: 0, y: 50 },
				{ x: 20, y: 50 },
				{ x: 20, y: 102 },
				{ x: 180, y: 102 },
				{ x: 180, y: 150 },
				{ x: 200, y: 150 },
			],
		};
		const b = {
			id: "b",
			source: { nodeId: "b-s" },
			target: { nodeId: "b-t" },
			points: [
				{ x: 100, y: 104 },
				{ x: 100, y: 150 },
			],
		};
		const [cleared] = clearOutlineRuns(
			[a, b] as never,
			[{ x: 0, y: 100, width: 200, height: 100 }],
			[],
			new Set(["b"]),
		);
		expect(cleared?.points[2]).toEqual({ x: 20, y: 92 });
		expect(cleared?.points[3]).toEqual({ x: 180, y: 92 });
	});
});

describe("outline clearing and parallel overlaps", () => {
	it("skips a step that stretches a neighbour onto another connector", () => {
		// Stepping "a" from y=102 to the near y=108 stretches its vertical
		// run at x=20 down over "c" (x=20, y=103..106); the far step (y=92)
		// shortens it instead.
		const a = {
			id: "a",
			source: { nodeId: "a-s" },
			target: { nodeId: "a-t" },
			points: [
				{ x: 0, y: 50 },
				{ x: 20, y: 50 },
				{ x: 20, y: 102 },
				{ x: 180, y: 102 },
				{ x: 180, y: 150 },
				{ x: 200, y: 150 },
			],
		};
		const c = {
			id: "c",
			source: { nodeId: "c-s" },
			target: { nodeId: "c-t" },
			points: [
				{ x: 20, y: 103 },
				{ x: 20, y: 106 },
			],
		};
		const [cleared] = clearOutlineRuns(
			[a, c] as never,
			[{ x: 0, y: 100, width: 200, height: 100 }],
			[],
			new Set(["c"]),
		);
		expect(cleared?.points[2]).toEqual({ x: 20, y: 92 });
	});
});

describe("same-side slots on dependency rails", () => {
	it("starts a rail route at its slot, not on a named port", () => {
		const node = (
			id: string,
			x: number,
			y: number,
			ports?: { id: string; side: "right"; kind: "flow" }[],
		) => ({
			id,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x, y },
			...(ports === undefined ? {} : { ports }),
		});
		const solved = solveDiagram(
			{
				id: "rail-slots",
				direction: "LR",
				nodes: [
					node("a", 0, 0, [{ id: "p", side: "right", kind: "flow" }]),
					node("b", 240, 0),
					node("c", 240, 100),
				] as never,
				edges: [
					{ id: "anon", source: { nodeId: "a" }, target: { nodeId: "b" } },
					{
						id: "via-port",
						source: { nodeId: "a", portId: "p" },
						target: { nodeId: "c" },
					},
				],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				routeKind: "short-orthogonal-jumps",
				railRouting: "dependency",
			},
		);
		expect(solved.routing?.rails?.map((rail) => rail.edgeId)).toEqual(["anon"]);
		const port = solved.nodes.find((entry) => entry.id === "a")?.ports?.[0]
			?.anchor;
		const start = solved.edges.find((edge) => edge.id === "anon")?.points[0];
		expect(port).toBeDefined();
		expect(start).toBeDefined();
		if (port === undefined || start === undefined) return;
		// The rail used the side's default point, the port's own point.
		expect(
			Math.hypot(start.x - port.x, start.y - port.y),
		).toBeGreaterThanOrEqual(10);
	});
});
