import { describe, expect, it } from "vitest";
import { normalizeDiagramDsl, parseDiagramDsl } from "../src/dsl/index.js";
import {
	computeShapeGeometry,
	shapeSideAttachRange,
	shapeSidePoint,
} from "../src/geometry/index.js";
import type {
	Box,
	CoordinatedDiagram,
	NormalizedDiagram,
	Point,
} from "../src/ir/index.js";
import { separateParallelSegments } from "../src/routing/index.js";
import { solveDiagram } from "../src/solver/index.js";
import {
	flowAwareAnchorSide,
	growNodesForEdgeDegree,
} from "../src/solver/ports.js";
import {
	finalizeCoordinatedEdges,
	pruneResolvedRouteDiagnostics,
} from "../src/solver/route-edges.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

describe("edge separation (nudging)", () => {
	it("spreads collinear interior segments into distinct parallel tracks", () => {
		// Three Z routes whose vertical trunks share x = 100.
		const routes = [0, 1, 2].map((index) => ({
			id: `edge-${index}`,
			points: [
				{ x: 0, y: 40 + index * 10 },
				{ x: 100, y: 40 + index * 10 },
				{ x: 100, y: 200 + index * 60 },
				{ x: 200, y: 200 + index * 60 },
			],
		}));

		const separated = separateParallelSegments(routes, [], { spacing: 12 });
		const trunkXs = separated.map((points) => points[1]?.x);

		expect(new Set(trunkXs).size).toBe(3);
		const sorted = [...(trunkXs as number[])].sort((a, b) => a - b);
		expect((sorted[1] ?? 0) - (sorted[0] ?? 0)).toBeCloseTo(12, 5);
		expect((sorted[2] ?? 0) - (sorted[1] ?? 0)).toBeCloseTo(12, 5);
		// Endpoints never move.
		separated.forEach((points, index) => {
			expect(points[0]).toEqual(routes[index]?.points[0]);
			expect(points.at(-1)).toEqual(routes[index]?.points.at(-1));
		});
		// The chosen track order introduces no crossings among the bundle.
		expect(countCrossings(separated)).toBe(0);
	});

	it("keeps tracks inside the free channel between obstacles", () => {
		const routes = [0, 1].map((index) => ({
			id: `edge-${index}`,
			points: [
				{ x: 0, y: 10 + index * 10 },
				{ x: 100, y: 10 + index * 10 },
				{ x: 100, y: 200 + index * 10 },
				{ x: 150, y: 200 + index * 10 },
			],
		}));
		const obstacles = [
			{ x: 60, y: 50, width: 30, height: 100 },
			{ x: 110, y: 50, width: 30, height: 100 },
		];
		const separated = separateParallelSegments(routes, obstacles, {
			spacing: 12,
		});
		for (const points of separated) {
			const x = points[1]?.x ?? 0;
			expect(x).toBeGreaterThanOrEqual(90);
			expect(x).toBeLessThanOrEqual(110);
		}
		expect(separated[0]?.[1]?.x).not.toBe(separated[1]?.[1]?.x);
	});

	it("is deterministic", () => {
		const routes = [0, 1, 2, 3].map((index) => ({
			id: `edge-${index}`,
			points: [
				{ x: 0, y: index * 8 },
				{ x: 50, y: index * 8 },
				{ x: 50, y: 300 - index * 40 },
				{ x: 120, y: 300 - index * 40 },
			],
		}));
		expect(separateParallelSegments(routes, [])).toEqual(
			separateParallelSegments(routes, []),
		);
	});
});

describe("default port distribution", () => {
	it("splits a fan-out across the flow side instead of one shared point", () => {
		const result = solveDsl(`
layout: { direction: LR }
nodes:
  hub: { label: Hub }
  a: { label: A }
  b: { label: B }
  c: { label: C }
  d: { label: D }
edges:
  - hub -> a
  - hub -> b
  - hub -> c
  - hub -> d
`);
		const starts = result.edges.map((edge) => edge.points[0] as Point);
		const hub = result.nodes.find((node) => node.id === "hub");
		expect(hub).toBeDefined();
		const right = (hub?.box.x ?? 0) + (hub?.box.width ?? 0);
		for (const start of starts) {
			expect(start.x).toBeCloseTo(right, 5);
		}
		expect(new Set(starts.map((start) => start.y.toFixed(3))).size).toBe(4);
		// Ports follow target order top→bottom so the fan does not cross.
		const byTarget = [...result.edges].sort(
			(left, right) =>
				targetCenterY(result, left.target.nodeId) -
				targetCenterY(result, right.target.nodeId),
		);
		const ys = byTarget.map((edge) => edge.points[0]?.y ?? 0);
		expect([...ys].sort((a, b) => a - b)).toEqual(ys);
		// Interior trunks never share a coordinate.
		expect(sharedInteriorSegments(result)).toBe(0);
	});

	it("never leaves a side anchor along the node border", () => {
		const result = solveDsl(`
layout: { direction: LR }
nodes:
  a: { label: A }
  b: { label: B }
edges:
  - a -> b
constraints:
  - { kind: relative-position, source: b, reference: a, relation: right-of, offset: { x: 80, y: 80 } }
`);
		const points = result.edges[0]?.points ?? [];
		const [first, second] = points;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		// The route leaves the right anchor horizontally (outward), not down
		// the node's right border.
		expect(second?.y).toBeCloseTo(first?.y ?? 0, 5);
		expect((second?.x ?? 0) > (first?.x ?? 0)).toBe(true);
	});

	it("keeps horizontal swimlane children in flow order across lanes", () => {
		const result = solveDsl(`
layout: { direction: LR }
swimlanes:
  flow:
    layout: contract
    orientation: horizontal
    lanes:
      top: { label: Top, children: [a, c] }
      bottom: { label: Bottom, children: [b] }
nodes:
  a: { label: A }
  b: { label: B }
  c: { label: C }
edges:
  - a -> b
  - b -> c
`);
		const x = (id: string) =>
			result.nodes.find((node) => node.id === id)?.box.x ?? Number.NaN;
		expect(x("a")).toBeLessThan(x("b"));
		expect(x("b")).toBeLessThan(x("c"));
	});

	it("centres relative-position placement when align is center", () => {
		const result = solveDsl(`
layout: { direction: TB }
nodes:
  wide: { label: A much wider node label }
  narrow: { label: N }
edges:
  - wide -> narrow
constraints:
  - { kind: relative-position, source: narrow, reference: wide, relation: below, offset: { x: 0, y: 80 }, align: center }
`);
		const box = (id: string) =>
			result.nodes.find((node) => node.id === id)?.box;
		const wide = box("wide");
		const narrow = box("narrow");
		expect(wide && narrow).toBeTruthy();
		expect((narrow?.x ?? 0) + (narrow?.width ?? 0) / 2).toBeCloseTo(
			(wide?.x ?? 0) + (wide?.width ?? 0) / 2,
			5,
		);
		const points = result.edges[0]?.points ?? [];
		expect(points).toHaveLength(2);
	});
});

describe("shape outline attach points", () => {
	it("projects side points onto the drawn outline", () => {
		const box = { x: 0, y: 0, width: 100, height: 40 };
		// Diamond left side at the tip is the box edge; off-centre moves inward.
		expect(shapeSidePoint("diamond", box, "left", 0.5)).toEqual({
			x: 0,
			y: 20,
		});
		const offCentre = shapeSidePoint("diamond", box, "left", 0.25);
		expect(offCentre.x).toBeCloseTo(25, 5);
		expect(offCentre.y).toBeCloseTo(10, 5);
		// Rectangles use the whole side minus corner insets.
		const [start, end] = shapeSideAttachRange("rectangle", box, "top");
		expect(start).toBeGreaterThan(0);
		expect(end).toBeLessThan(1);
	});
});

function solveDsl(source: string): CoordinatedDiagram {
	const parsed = parseDiagramDsl(source);
	if (parsed.value === undefined) {
		throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
	}
	const textMeasurer = new DeterministicTextMeasurer();
	const normalized = normalizeDiagramDsl(parsed.value, { textMeasurer });
	const diagram = normalized.diagram as NormalizedDiagram;
	return solveDiagram(diagram, { textMeasurer });
}

function targetCenterY(result: CoordinatedDiagram, nodeId: string): number {
	const box = result.nodes.find((node) => node.id === nodeId)?.box;
	return box === undefined ? 0 : box.y + box.height / 2;
}

function sharedInteriorSegments(result: CoordinatedDiagram): number {
	const segments = result.edges.flatMap((edge) =>
		edge.points.slice(1, -2).map((start, index) => {
			const end = edge.points[index + 2] as Point;
			return { edgeId: edge.id, start, end };
		}),
	);
	let shared = 0;
	for (let i = 0; i < segments.length; i += 1) {
		for (let j = i + 1; j < segments.length; j += 1) {
			const a = segments[i];
			const b = segments[j];
			if (a === undefined || b === undefined || a.edgeId === b.edgeId) continue;
			const aVertical = Math.abs(a.start.x - a.end.x) < 0.5;
			const bVertical = Math.abs(b.start.x - b.end.x) < 0.5;
			if (aVertical !== bVertical) continue;
			const coordA = aVertical ? a.start.x : a.start.y;
			const coordB = aVertical ? b.start.x : b.start.y;
			if (Math.abs(coordA - coordB) >= 1) continue;
			const [a0, a1] = aVertical ? [a.start.y, a.end.y] : [a.start.x, a.end.x];
			const [b0, b1] = aVertical ? [b.start.y, b.end.y] : [b.start.x, b.end.x];
			const overlap =
				Math.min(Math.max(a0, a1), Math.max(b0, b1)) -
				Math.max(Math.min(a0, a1), Math.min(b0, b1));
			if (overlap > 1) shared += 1;
		}
	}
	return shared;
}

function countCrossings(routes: readonly Point[][]): number {
	let crossings = 0;
	for (let i = 0; i < routes.length; i += 1) {
		for (let j = i + 1; j < routes.length; j += 1) {
			const a = routes[i] ?? [];
			const b = routes[j] ?? [];
			for (let ai = 0; ai + 1 < a.length; ai += 1) {
				for (let bi = 0; bi + 1 < b.length; bi += 1) {
					if (crosses(a[ai], a[ai + 1], b[bi], b[bi + 1])) crossings += 1;
				}
			}
		}
	}
	return crossings;
}

function crosses(
	a0: Point | undefined,
	a1: Point | undefined,
	b0: Point | undefined,
	b1: Point | undefined,
): boolean {
	if (!a0 || !a1 || !b0 || !b1) return false;
	const aVertical = a0.x === a1.x;
	const bVertical = b0.x === b1.x;
	if (aVertical === bVertical) return false;
	const [v0, v1, h0, h1] = aVertical ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
	return (
		v0.x > Math.min(h0.x, h1.x) &&
		v0.x < Math.max(h0.x, h1.x) &&
		h0.y > Math.min(v0.y, v1.y) &&
		h0.y < Math.max(v0.y, v1.y)
	);
}

describe("finalizeCoordinatedEdges", () => {
	it("never nudges a track into a policy soft obstacle", () => {
		const nodeBox = (x: number, y: number) => ({
			x,
			y,
			width: 40,
			height: 20,
		});
		const nodes = new Map(
			[
				["s1", nodeBox(0, 0)],
				["s2", nodeBox(0, 40)],
				["t1", nodeBox(300, 200)],
				["t2", nodeBox(300, 260)],
			].map(([id, box]) => [
				id as string,
				computeShapeGeometry({ shape: "rectangle", box: box as Box }),
			]),
		);
		// Two routes share the vertical trunk at x = 150; a soft obstacle
		// (e.g. a table) sits immediately right of it.
		const edge = (
			id: string,
			source: string,
			target: string,
			y0: number,
			y1: number,
		) => ({
			id,
			source: { nodeId: source },
			target: { nodeId: target },
			points: [
				{ x: 40, y: y0 },
				{ x: 150, y: y0 },
				{ x: 150, y: y1 },
				{ x: 300, y: y1 },
			],
		});
		const soft = { x: 152, y: 0, width: 100, height: 300 };
		const result = finalizeCoordinatedEdges(
			[edge("a", "s1", "t1", 10, 210), edge("b", "s2", "t2", 50, 270)],
			nodes,
			[...nodes].map(([id, geometry]) => ({ id, box: geometry.box })),
			[],
			[soft],
			[],
			undefined,
			{},
		);
		for (const routed of result) {
			for (let index = 0; index + 1 < routed.points.length; index += 1) {
				const a = routed.points[index] as Point;
				const b = routed.points[index + 1] as Point;
				const vertical = Math.abs(a.x - b.x) < 0.5;
				if (!vertical) continue;
				const inside = a.x > soft.x && a.x < soft.x + soft.width;
				expect(inside, `${routed.id} trunk at x=${a.x}`).toBe(false);
			}
		}
		// And the shared trunk was still separated.
		expect(result[0]?.points[1]?.x).not.toBe(result[1]?.points[1]?.x);
	});
});

describe("review follow-ups (Codex #96, round 2)", () => {
	it("keeps every obstacle escape on a route, not only the last", () => {
		// One route with two interior segments, each clipping an obstacle.
		const route = {
			id: "r",
			points: [
				{ x: 0, y: 0 },
				{ x: 50, y: 0 },
				{ x: 50, y: 100 },
				{ x: 150, y: 100 },
				{ x: 150, y: 200 },
				{ x: 300, y: 200 },
			],
		};
		const obstacles = [
			{ x: 45, y: 30, width: 20, height: 40 }, // clips x = 50
			{ x: 100, y: 95, width: 20, height: 20 }, // clips y = 100
		];
		const [separated] = separateParallelSegments([route], obstacles);
		expect(separated).toBeDefined();
		for (const [index, box] of obstacles.entries()) {
			const hit = (separated ?? []).some((point, i, all) => {
				const next = all[i + 1];
				if (next === undefined) return false;
				return (
					Math.max(point.x, next.x) > box.x &&
					Math.min(point.x, next.x) < box.x + box.width &&
					Math.max(point.y, next.y) > box.y &&
					Math.min(point.y, next.y) < box.y + box.height
				);
			});
			expect(hit, `obstacle ${index}`).toBe(false);
		}
	});

	it("moves a free track off a fixed rail it is stacked on", () => {
		const rail = {
			id: "rail",
			fixed: true,
			points: [
				{ x: 0, y: 10 },
				{ x: 100, y: 10 },
				{ x: 100, y: 200 },
				{ x: 300, y: 200 },
			],
		};
		const free = {
			id: "free",
			points: [
				{ x: 0, y: 40 },
				{ x: 100, y: 40 },
				{ x: 100, y: 240 },
				{ x: 300, y: 240 },
			],
		};
		const [railOut, freeOut] = separateParallelSegments([rail, free], []);
		// The rail never moves.
		expect(railOut).toEqual(rail.points);
		// The free trunk no longer shares x = 100 with the rail.
		expect(Math.abs((freeOut?.[1]?.x ?? 100) - 100)).toBeGreaterThanOrEqual(11);
	});

	it("drops obstacle diagnostics once the final route is clean", () => {
		const nodes = new Map(
			[
				["a", { x: 0, y: 0, width: 40, height: 20 }],
				["b", { x: 200, y: 0, width: 40, height: 20 }],
				["c", { x: 0, y: 100, width: 40, height: 20 }],
				["d", { x: 200, y: 100, width: 40, height: 20 }],
				["blocker", { x: 100, y: 90, width: 20, height: 40 }],
			].map(([id, box]) => [
				id as string,
				computeShapeGeometry({ shape: "rectangle", box: box as Box }),
			]),
		);
		const edges = [
			{
				id: "clean",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				points: [
					{ x: 40, y: 10 },
					{ x: 200, y: 10 },
				],
			},
			{
				id: "blocked",
				source: { nodeId: "c" },
				target: { nodeId: "d" },
				points: [
					{ x: 40, y: 110 },
					{ x: 200, y: 110 },
				],
			},
		];
		const diagnostics = edges.map((edge) => ({
			severity: "warning" as const,
			code: "routing.obstacle.unavoidable",
			message: "stale",
			detail: { edgeId: edge.id },
		}));
		pruneResolvedRouteDiagnostics(
			diagnostics,
			edges,
			[...nodes].map(([id, geometry]) => ({ id, box: geometry.box })),
			[],
			[],
			[],
			[],
			{},
		);
		expect(diagnostics.map((diagnostic) => diagnostic.detail.edgeId)).toEqual([
			"blocked",
		]);
	});
});

describe("review follow-ups (Codex #96, round 3)", () => {
	it("still escapes obstacles when track separation is off", () => {
		const route = {
			id: "only",
			points: [
				{ x: 0, y: 0 },
				{ x: 50, y: 0 },
				{ x: 50, y: 100 },
				{ x: 150, y: 100 },
			],
		};
		const [out] = separateParallelSegments(
			[route],
			[{ x: 45, y: 30, width: 20, height: 40 }],
			{ separate: false },
		);
		const trunkX = out?.[1]?.x ?? 50;
		expect(trunkX < 45 || trunkX > 65).toBe(true);
	});

	it("respects the router's expanded node clearance when nudging", () => {
		const raw = { x: 160, y: 0, width: 40, height: 200 };
		const expanded = { x: 140, y: -20, width: 80, height: 240 };
		const geometry = (box: Box) =>
			computeShapeGeometry({ shape: "rectangle", box });
		const nodes = new Map([
			["wall", geometry(raw)],
			["s", geometry({ x: 0, y: 0, width: 20, height: 20 })],
			["t1", geometry({ x: 300, y: 250, width: 20, height: 20 })],
			["t2", geometry({ x: 300, y: 290, width: 20, height: 20 })],
		]);
		const edge = (id: string, target: string, y: number) => ({
			id,
			source: { nodeId: "s" },
			target: { nodeId: target },
			points: [
				{ x: 20, y: 10 },
				{ x: 135, y: 10 },
				{ x: 135, y },
				{ x: 300, y },
			],
		});
		const result = finalizeCoordinatedEdges(
			[edge("a", "t1", 260), edge("b", "t2", 300)],
			nodes,
			[
				{ id: "wall", box: expanded },
				...["s", "t1", "t2"].map((id) => ({
					id,
					box: nodes.get(id)?.box as Box,
				})),
			],
			[],
			[],
			[],
			undefined,
			{},
		);
		for (const routed of result) {
			const trunk = routed.points[1]?.x ?? 0;
			expect(trunk, routed.id).toBeLessThanOrEqual(expanded.x);
		}
	});
});

describe("review follow-ups (Codex #96, round 4)", () => {
	it("does not treat a route's own endpoint boxes as obstacles", () => {
		// The trunk runs through the (expanded) box of its own target node:
		// that is expected clearance overlap, not something to escape.
		const route = {
			id: "own",
			points: [
				{ x: 0, y: 0 },
				{ x: 50, y: 0 },
				{ x: 50, y: 100 },
				{ x: 150, y: 100 },
			],
			ignoreObstacles: new Set([0]),
		};
		const [out] = separateParallelSegments(
			[route],
			[{ x: 40, y: 60, width: 120, height: 60 }],
			{ separate: false },
		);
		expect(out?.[1]?.x).toBe(50);
	});

	it("keeps explicit-port endpoints on their port anchor", () => {
		const diamond = computeShapeGeometry({
			shape: "diamond",
			box: { x: 0, y: 0, width: 100, height: 60 },
		});
		const target = computeShapeGeometry({
			shape: "rectangle",
			box: { x: 200, y: 0, width: 60, height: 40 },
		});
		// Off-centre point on the diamond's right bounding-box side.
		const start = { x: 100, y: 15 };
		const [edge] = finalizeCoordinatedEdges(
			[
				{
					id: "ported",
					source: { nodeId: "d", portId: "out" },
					target: { nodeId: "t" },
					points: [
						start,
						{ x: 150, y: 15 },
						{ x: 150, y: 20 },
						{ x: 200, y: 20 },
					],
				},
			],
			new Map([
				["d", diamond],
				["t", target],
			]),
			[
				{ id: "d", box: diamond.box },
				{ id: "t", box: target.box },
			],
			[],
			[],
			[],
			undefined,
			{},
		);
		expect(edge?.points[0]).toEqual(start);
	});

	it("keeps over-budget detour diagnostics on clean routes", () => {
		const edges = [
			{
				id: "long",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				points: [
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
				],
			},
		];
		const diagnostics = [
			{
				severity: "warning" as const,
				code: "routing.obstacle.unavoidable",
				message: "over detour budget",
				detail: { edgeId: "long", detourRatio: 3.4, maxDetourRatio: 3 },
			},
		];
		pruneResolvedRouteDiagnostics(diagnostics, edges, [], [], [], [], [], {});
		expect(diagnostics).toHaveLength(1);
	});

	it("grows a node with declared ports for its unported edges", () => {
		const node = {
			id: "hub",
			shape: "rectangle" as const,
			size: { width: 120, height: 40 },
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
			ports: [{ id: "p", side: "left" as const, kind: "flow" as const }],
		};
		const edges = ["a", "b", "c", "d"].map((id) => ({
			id: `hub-${id}`,
			source: { nodeId: "hub" },
			target: { nodeId: id },
		}));
		const [grown] = growNodesForEdgeDegree([node], edges, "LR", {});
		expect(grown?.size.height).toBeGreaterThan(40);
	});
});

describe("collinear end segments", () => {
	it("moves a long end segment off another route when splitEnds is on", () => {
		// b leaves its source on the same y as a's interior trunk.
		const routes = [
			{
				id: "a",
				points: [
					{ x: 0, y: 0 },
					{ x: 40, y: 0 },
					{ x: 40, y: 100 },
					{ x: 300, y: 100 },
					{ x: 300, y: 200 },
				],
			},
			{
				id: "b",
				points: [
					{ x: 60, y: 100 },
					{ x: 280, y: 100 },
					{ x: 280, y: 300 },
				],
			},
		];
		const overlapping = (result: Point[][]) =>
			result[1]?.some(
				(point, index, all) =>
					index > 0 &&
					point.y === 100 &&
					all[index - 1]?.y === 100 &&
					Math.abs(point.x - (all[index - 1]?.x ?? 0)) > 20,
			) ?? false;
		expect(overlapping(separateParallelSegments(routes, []))).toBe(true);
		const split = separateParallelSegments(routes, [], { splitEnds: true });
		expect(overlapping(split)).toBe(false);
		// The port stub stays on the original line.
		expect(split[1]?.[0]).toEqual({ x: 60, y: 100 });
		expect(split[1]?.[1]?.y).toBe(100);
	});
});

describe("review follow-ups (Codex #96, round 5)", () => {
	const rect = (box: Box) => computeShapeGeometry({ shape: "rectangle", box });

	it("leaves edges that share an explicit port on the port", () => {
		const hub = rect({ x: 0, y: 0, width: 60, height: 60 });
		const t1 = rect({ x: 200, y: -100, width: 40, height: 40 });
		const t2 = rect({ x: 200, y: 100, width: 40, height: 40 });
		const port = { x: 60, y: 30 };
		const edges = [
			{
				id: "up",
				source: { nodeId: "hub", portId: "out" },
				target: { nodeId: "t1" },
				points: [
					port,
					{ x: 120, y: 30 },
					{ x: 120, y: -80 },
					{ x: 200, y: -80 },
				],
			},
			{
				id: "down",
				source: { nodeId: "hub", portId: "out" },
				target: { nodeId: "t2" },
				points: [
					port,
					{ x: 130, y: 30 },
					{ x: 130, y: 120 },
					{ x: 200, y: 120 },
				],
			},
		];
		const result = finalizeCoordinatedEdges(
			edges,
			new Map([
				["hub", hub],
				["t1", t1],
				["t2", t2],
			]),
			[
				{ id: "hub", box: hub.box },
				{ id: "t1", box: t1.box },
				{ id: "t2", box: t2.box },
			],
			[],
			[],
			[],
			undefined,
			{},
		);
		for (const edge of result) expect(edge.points[0], edge.id).toEqual(port);
	});

	it("keeps nudged routes out of groups they do not belong to", () => {
		const a = rect({ x: 0, y: 0, width: 40, height: 40 });
		const b = rect({ x: 300, y: 200, width: 40, height: 40 });
		const inner = rect({ x: 120, y: 90, width: 40, height: 40 });
		const group = {
			id: "g",
			nodeIds: ["inner"],
			groupIds: [],
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			box: { x: 100, y: 60, width: 100, height: 100 },
		};
		// The trunk at x = 150 clips the unrelated group only.
		const edge = {
			id: "outside",
			source: { nodeId: "a" },
			target: { nodeId: "b" },
			points: [
				{ x: 40, y: 20 },
				{ x: 150, y: 20 },
				{ x: 150, y: 220 },
				{ x: 300, y: 220 },
			],
		};
		const nodes = new Map([
			["a", a],
			["b", b],
			["inner", inner],
		]);
		const entries = [...nodes].map(([id, geometry]) => ({
			id,
			box: geometry.box,
		}));
		const [without] = finalizeCoordinatedEdges(
			[edge],
			nodes,
			entries.filter((entry) => entry.id !== "inner"),
			[],
			[],
			[],
			undefined,
			{},
		);
		expect(without?.points[1]?.x).toBe(150);
		const [withGroup] = finalizeCoordinatedEdges(
			[edge],
			nodes,
			entries.filter((entry) => entry.id !== "inner"),
			[],
			[],
			[],
			undefined,
			{},
			[group],
		);
		const trunk = withGroup?.points[1]?.x ?? 150;
		expect(trunk < 100 || trunk > 200).toBe(true);
	});
});

describe("degree growth keeps circles round (Codex #96, round 6)", () => {
	it("grows a circular ellipse in both dimensions", () => {
		const hub = {
			id: "start",
			shape: "ellipse" as const,
			size: { width: 80, height: 80 },
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
		};
		const edges = ["a", "b", "c", "d", "e"].map((id) => ({
			id: `start-${id}`,
			source: { nodeId: "start" },
			target: { nodeId: id },
		}));
		const [grown] = growNodesForEdgeDegree([hub], edges, "LR", {});
		expect(grown?.size.height).toBeGreaterThan(80);
		expect(grown?.size.width).toBe(grown?.size.height);
	});
});

describe("trunk crossing reduction", () => {
	const crossings = (routes: Point[][]) => {
		let total = 0;
		for (let i = 0; i < routes.length; i += 1) {
			for (let j = i + 1; j < routes.length; j += 1) {
				const a = routes[i] ?? [];
				const b = routes[j] ?? [];
				for (let s = 0; s + 1 < a.length; s += 1) {
					for (let t = 0; t + 1 < b.length; t += 1) {
						const [p0, p1] = [a[s] as Point, a[s + 1] as Point];
						const [q0, q1] = [b[t] as Point, b[t + 1] as Point];
						const pv = p0.x === p1.x;
						const qv = q0.x === q1.x;
						if (pv === qv) continue;
						const [v0, v1, h0, h1] = pv ? [p0, p1, q0, q1] : [q0, q1, p0, p1];
						if (
							v0.x > Math.min(h0.x, h1.x) &&
							v0.x < Math.max(h0.x, h1.x) &&
							h0.y > Math.min(v0.y, v1.y) &&
							h0.y < Math.max(v0.y, v1.y)
						) {
							total += 1;
						}
					}
				}
			}
		}
		return total;
	};

	it("moves a trunk within its channel when that removes crossings", () => {
		const routes = [
			{
				id: "a",
				points: [
					{ x: 0, y: 0 },
					{ x: 40, y: 0 },
					{ x: 40, y: 100 },
					{ x: 200, y: 100 },
				],
			},
			{
				id: "b",
				points: [
					{ x: 0, y: 50 },
					{ x: 120, y: 50 },
					{ x: 120, y: 120 },
					{ x: 200, y: 120 },
				],
			},
		];
		expect(crossings(routes.map((route) => route.points))).toBe(2);
		const result = separateParallelSegments(routes, [], { spacing: 12 });
		expect(crossings(result)).toBe(0);
	});

	it("keeps trunks when track separation is off", () => {
		const routes = [
			{
				id: "a",
				points: [
					{ x: 0, y: 0 },
					{ x: 40, y: 0 },
					{ x: 40, y: 100 },
					{ x: 200, y: 100 },
				],
			},
			{
				id: "b",
				points: [
					{ x: 0, y: 50 },
					{ x: 120, y: 50 },
					{ x: 120, y: 120 },
					{ x: 200, y: 120 },
				],
			},
		];
		const result = separateParallelSegments(routes, [], { separate: false });
		expect(crossings(result)).toBe(2);
	});
});

describe("backward edges across rows", () => {
	it("leaves and enters across the flow when running far back", () => {
		// A folded band's return edge: e-sign at the right end of row 1,
		// disbursement at the left end of row 2 (LR flow).
		const sign = { x: 1000, y: 0, width: 120, height: 40 };
		const disburse = { x: 0, y: 200, width: 120, height: 40 };
		expect(flowAwareAnchorSide(sign, disburse, "LR", "source")).toBe("bottom");
		expect(flowAwareAnchorSide(disburse, sign, "LR", "target")).toBe("top");
	});

	it("keeps flow sides for forward edges and short loops back", () => {
		const a = { x: 0, y: 0, width: 120, height: 40 };
		const b = { x: 300, y: 200, width: 120, height: 40 };
		expect(flowAwareAnchorSide(a, b, "LR", "source")).toBe("right");
		// Loop back to the step right before, one row up: along < across.
		const c = { x: 0, y: 0, width: 120, height: 40 };
		const d = { x: 160, y: 300, width: 120, height: 40 };
		expect(flowAwareAnchorSide(d, c, "LR", "source")).toBe("left");
	});
});
