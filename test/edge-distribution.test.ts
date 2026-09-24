import { describe, expect, it } from "vitest";
import { normalizeDiagramDsl, parseDiagramDsl } from "../src/dsl/index.js";
import { shapeSideAttachRange, shapeSidePoint } from "../src/geometry/index.js";
import type {
	CoordinatedDiagram,
	NormalizedDiagram,
	Point,
} from "../src/ir/index.js";
import { separateParallelSegments } from "../src/routing/index.js";
import { solveDiagram } from "../src/solver/index.js";
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
