import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import { exportGeometry, exportSvg } from "../src/exporters/index.js";
import type { Box, CoordinatedEdge, Point } from "../src/ir/index.js";
import { centreSegmentsInChannels } from "../src/routing/channel-centre.js";

function edge(id: string, points: [number, number][]): CoordinatedEdge {
	return {
		id,
		source: { nodeId: `${id}-s` },
		target: { nodeId: `${id}-t` },
		points: points.map(([x, y]) => ({ x, y })),
	};
}

const pairs = (points: readonly Point[]) => points.map((p) => [p.x, p.y]);

describe("channel centring", () => {
	const left: Box = { x: 0, y: 0, width: 100, height: 80 };
	const right: Box = { x: 160, y: 120, width: 100, height: 80 };

	it("moves a segment hugging a node side to the middle of its channel", () => {
		// The corner-graph route runs 2px beside the target's left side.
		const [moved] = centreSegmentsInChannels(
			[
				edge("e", [
					[100, 40],
					[158, 40],
					[158, 160],
					[160, 160],
				]),
			],
			[left, right],
		);
		expect(pairs(moved?.points ?? [])).toEqual([
			[100, 40],
			[130, 40],
			[130, 160],
			[160, 160],
		]);
	});

	it("spaces segments sharing a channel evenly, in their order", () => {
		const moved = centreSegmentsInChannels(
			[
				edge("a", [
					[100, 20],
					[102, 20],
					[102, 150],
					[160, 150],
				]),
				edge("b", [
					[100, 60],
					[104, 60],
					[104, 180],
					[160, 180],
				]),
			],
			[left, right],
		);
		expect(moved[0]?.points[1]?.x).toBeCloseTo(120);
		expect(moved[1]?.points[1]?.x).toBeCloseTo(140);
	});

	it("bounds a segment inside a frame by the frame's sides", () => {
		const node: Box = { x: 20, y: 20, width: 100, height: 40 };
		const below: Box = { x: 20, y: 120, width: 100, height: 40 };
		const frame: Box = { x: 0, y: 0, width: 140, height: 180 };
		// Out of the right side, down beside the frame, into the node below.
		const [moved] = centreSegmentsInChannels(
			[
				edge("e", [
					[120, 40],
					[138, 40],
					[138, 100],
					[70, 100],
					[70, 120],
				]),
			],
			[node, below],
			[frame],
		);
		expect(moved?.points[1]?.x).toBeCloseTo(130);
	});

	it("leaves segments through a solid box or in an open channel alone", () => {
		const through = edge("through", [
			[100, 40],
			[50, 40],
			[50, 160],
			[160, 160],
		]);
		const open = edge("open", [
			[100, 40],
			[400, 40],
			[400, 300],
			[500, 300],
		]);
		const moved = centreSegmentsInChannels([through, open], [left, right]);
		expect(moved[0]).toBe(through);
		expect(moved[1]).toBe(open);
	});
});

/**
 * A pinned two-column page routed with obstacle-avoiding, modelled on a
 * figure of an emergency-platform proposal: its routes ran along the node
 * sides of the 60px gutters and ended on stubs shorter than an arrowhead.
 */
const PINNED_COLUMNS = JSON.stringify({
	layout: { direction: "TB" },
	routing: { kind: "obstacle-avoiding" },
	nodes: Object.fromEntries(
		[
			["evidence", 260, 0],
			["person", 0, 130],
			["system", 520, 130],
			["coach", 0, 260],
			["repair", 520, 260],
			["pcheck", 0, 390],
			["scheck", 520, 390],
		].map(([id, x, y]) => [
			id,
			{ label: id, size: { width: 200, height: 80 }, position: { x, y } },
		]),
	),
	edges: [
		{ source: "evidence", target: "person", label: "people" },
		{ source: "evidence", target: "system", label: "system" },
		{ source: "person", target: "coach" },
		{ source: "system", target: "repair" },
		{ source: "coach", target: "pcheck" },
		{ source: "repair", target: "scheck" },
	],
});

describe("obstacle-avoiding routes keep off node sides", () => {
	it("runs no segment along a node side and leaves room for every arrowhead", () => {
		const diagram = renderDiagramDsl(PINNED_COLUMNS).diagram;
		if (diagram === undefined) throw new Error("did not solve");
		for (const route of diagram.edges) {
			const points = route.points;
			for (let index = 0; index + 1 < points.length; index += 1) {
				const a = points[index] as Point;
				const b = points[index + 1] as Point;
				const vertical = Math.abs(a.x - b.x) < 1e-6;
				const at = vertical ? a.x : a.y;
				const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
				const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
				for (const node of diagram.nodes) {
					const box = node.box;
					const sides = vertical
						? [box.x, box.x + box.width]
						: [box.y, box.y + box.height];
					const spanLo = vertical ? box.y : box.x;
					const spanHi = vertical ? box.y + box.height : box.x + box.width;
					const run = Math.min(hi, spanHi) - Math.max(lo, spanLo);
					const onSide = sides.some((side) => Math.abs(side - at) <= 3);
					expect(onSide && run > 1).toBe(false);
				}
			}
			const last = points.at(-1) as Point;
			const before = points.at(-2) as Point;
			expect(
				Math.abs(last.x - before.x) + Math.abs(last.y - before.y),
			).toBeGreaterThanOrEqual(12);
		}
	});
});

describe("nested group frames", () => {
	// The outer group listed after the one nested in it: painted in input
	// order, its filled frame covered the inner one.
	const NESTED = `
nodes:
  a: { label: A }
  b: { label: B }
  c: { label: C }
edges:
  - a -> b
  - b -> c
groups:
  inner: { label: Inner, nodes: [a, b] }
  outer: { label: Outer, groups: [inner], nodes: [c] }
`;

	it("solves a parent group whose id sorts before its nested groups", () => {
		// Groups are sorted by id: "a-platform" comes before "layer", so the
		// parent was solved before the group it contains.
		const result = renderDiagramDsl(`
nodes:
  a: { label: A }
  b: { label: B }
edges:
  - a -> b
groups:
  layer: { label: Layer, nodes: [a, b] }
  a-platform: { label: Platform, groups: [layer] }
`);
		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.severity === "error",
			),
		).toEqual([]);
		const groups = result.diagram?.groups ?? [];
		const outer = groups.find((group) => group.id === "a-platform")?.box;
		const inner = groups.find((group) => group.id === "layer")?.box;
		expect(outer).toBeDefined();
		expect(inner).toBeDefined();
		if (outer === undefined || inner === undefined) return;
		expect(outer.x).toBeLessThanOrEqual(inner.x);
		expect(outer.x + outer.width).toBeGreaterThanOrEqual(inner.x + inner.width);
	});

	it("paints outer frames before the frames nested in them", () => {
		const diagram = renderDiagramDsl(NESTED).diagram;
		if (diagram === undefined) throw new Error("did not solve");
		const svg = exportSvg(diagram);
		expect(svg.indexOf('class="group" data-id="outer"')).toBeLessThan(
			svg.indexOf('class="group" data-id="inner"'),
		);
		const containers = exportGeometry(diagram).zOrder.filter(
			(entry) => entry.kind === "container",
		);
		expect(containers.map((entry) => entry.id)).toEqual(["outer", "inner"]);
	});
});
