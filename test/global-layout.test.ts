import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import type { Box } from "../src/ir/index.js";
import {
	assignLayers,
	buildContainerHierarchy,
	depthFirstBackEdges,
	type GlobalLayoutInput,
	runGlobalLayout,
} from "../src/layout/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

const PAD = { top: 12, right: 12, bottom: 12, left: 12 };

function node(id: string, width = 80, height = 40) {
	return { id, size: { width, height } };
}

function edges(...pairs: [string, string][]) {
	return pairs.map(([source, target], index) => ({
		id: `e${index}`,
		source,
		target,
	}));
}

function union(boxes: Box[]): Box {
	const x = Math.min(...boxes.map((b) => b.x));
	const y = Math.min(...boxes.map((b) => b.y));
	const right = Math.max(...boxes.map((b) => b.x + b.width));
	const bottom = Math.max(...boxes.map((b) => b.y + b.height));
	return { x, y, width: right - x, height: bottom - y };
}

/** Group box as coordinateGroups draws it: members + padding + header. */
function groupBox(
	boxes: Map<string, Box>,
	members: string[],
	header = 20,
): Box {
	const inner = union(members.map((id) => boxes.get(id) as Box));
	return {
		x: inner.x - PAD.left,
		y: inner.y - PAD.top - header,
		width: inner.width + PAD.left + PAD.right,
		height: inner.height + PAD.top + PAD.bottom + header,
	};
}

function overlaps(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

function centre(box: Box) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function inside(point: { x: number; y: number }, box: Box): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

function group(id: string, nodeIds: string[]) {
	return {
		id,
		nodeIds,
		groupIds: [],
		padding: PAD,
		headerHeight: 20,
		labelWidth: 40,
	};
}

describe("runGlobalLayout", () => {
	it("keeps sibling groups that share layers as disjoint rectangles", () => {
		for (const direction of ["TB", "LR", "BT", "RL"] as const) {
			const input: GlobalLayoutInput = {
				direction,
				nodes: ["a1", "a2", "b1", "b2", "c"].map((id) => node(id)),
				edges: edges(
					["c", "a1"],
					["c", "b1"],
					["a1", "a2"],
					["b1", "b2"],
					["a1", "b2"],
				),
				groups: [group("A", ["a1", "a2"]), group("B", ["b1", "b2"])],
			};
			const { boxes } = runGlobalLayout(input);
			const a = groupBox(boxes, ["a1", "a2"]);
			const b = groupBox(boxes, ["b1", "b2"]);
			expect(overlaps(a, b), direction).toBe(false);
			expect(inside(centre(boxes.get("c") as Box), a)).toBe(false);
			expect(inside(centre(boxes.get("c") as Box), b)).toBe(false);
		}
	});

	it("keeps a foreign node out of a layer gap inside a group's span", () => {
		// order → pay are grouped, kafka is not, recommend is grouped again:
		// kafka's layer lies inside the group's span but holds no member.
		const { boxes } = runGlobalLayout({
			direction: "LR",
			nodes: ["order", "pay", "kafka", "recommend"].map((id) => node(id)),
			edges: edges(["order", "pay"], ["pay", "kafka"], ["kafka", "recommend"]),
			groups: [group("svc", ["order", "pay", "recommend"])],
		});
		const svc = groupBox(boxes, ["order", "pay", "recommend"]);
		expect(inside(centre(boxes.get("kafka") as Box), svc)).toBe(false);
	});

	it("lays groups linked one way out as consecutive tiers", () => {
		const { boxes } = runGlobalLayout({
			direction: "LR",
			nodes: ["s1", "s2", "s3", "d1", "d2"].map((id) => node(id)),
			edges: edges(["s1", "s2"], ["s2", "s3"], ["s1", "d1"], ["s3", "d2"]),
			groups: [group("svc", ["s1", "s2", "s3"]), group("data", ["d1", "d2"])],
		});
		const serviceRight = Math.max(
			...["s1", "s2", "s3"].map((id) => {
				const box = boxes.get(id) as Box;
				return box.x + box.width;
			}),
		);
		for (const id of ["d1", "d2"]) {
			expect((boxes.get(id) as Box).x).toBeGreaterThan(serviceRight);
		}
		// Both data nodes share one column.
		expect((boxes.get("d1") as Box).x).toBe((boxes.get("d2") as Box).x);
	});

	it("stacks swimlane lanes as ordered, non-overlapping bands", () => {
		const { boxes } = runGlobalLayout({
			direction: "LR",
			nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)),
			edges: edges(["a", "b"], ["b", "c"], ["c", "d"], ["a", "e"], ["e", "d"]),
			swimlanes: [
				{
					id: "flow",
					orientation: "horizontal",
					headerHeight: 28,
					padding: 16,
					lanes: [
						{ id: "one", children: ["a", "d"] },
						{ id: "two", children: ["b", "e"] },
						{ id: "three", children: ["c"] },
					],
				},
			],
		});
		const band = (ids: string[]) => {
			const u = union(ids.map((id) => boxes.get(id) as Box));
			return [u.y, u.y + u.height] as const;
		};
		const [, oneBottom] = band(["a", "d"]);
		const [twoTop, twoBottom] = band(["b", "e"]);
		const [threeTop] = band(["c"]);
		expect(twoTop).toBeGreaterThanOrEqual(oneBottom + 32);
		expect(threeTop).toBeGreaterThanOrEqual(twoBottom + 32);
	});

	it("aligns a straight chain and centres a parent over its children", () => {
		const { boxes } = runGlobalLayout({
			direction: "TB",
			nodes: [node("p"), node("l"), node("r"), node("x"), node("y")],
			edges: edges(["p", "l"], ["p", "r"], ["x", "y"]),
		});
		const cx = (id: string) => centre(boxes.get(id) as Box).x;
		expect(cx("x")).toBeCloseTo(cx("y"), 0);
		expect(cx("p")).toBeCloseTo((cx("l") + cx("r")) / 2, 0);
		// Children keep the node spacing.
		const l = boxes.get("l") as Box;
		const r = boxes.get("r") as Box;
		expect(Math.abs(r.x - l.x)).toBeGreaterThanOrEqual(80 + 48 - 0.01);
	});

	it("reserves room for edge labels between layers", () => {
		const plain = runGlobalLayout({
			direction: "LR",
			nodes: [node("a"), node("b")],
			edges: edges(["a", "b"]),
		});
		const labelled = runGlobalLayout({
			direction: "LR",
			nodes: [node("a"), node("b")],
			edges: [
				{
					id: "e",
					source: "a",
					target: "b",
					labelSize: { width: 140, height: 14 },
				},
			],
		});
		const gap = (boxes: Map<string, Box>) =>
			(boxes.get("b") as Box).x -
			((boxes.get("a") as Box).x + (boxes.get("a") as Box).width);
		expect(gap(labelled.boxes)).toBeGreaterThanOrEqual(140 + 16);
		expect(gap(labelled.boxes)).toBeGreaterThan(gap(plain.boxes));
	});

	it("is deterministic", () => {
		const input: GlobalLayoutInput = {
			direction: "TB",
			nodes: ["a", "b", "c", "d", "e", "f"].map((id) =>
				node(id, 60 + (id.charCodeAt(0) % 5) * 10),
			),
			edges: edges(
				["a", "b"],
				["a", "c"],
				["b", "d"],
				["c", "d"],
				["d", "e"],
				["e", "a"],
				["c", "f"],
			),
			groups: [group("g", ["b", "c"])],
		};
		expect([...runGlobalLayout(input).boxes]).toEqual([
			...runGlobalLayout(input).boxes,
		]);
	});
});

describe("cycle breaking", () => {
	it("reverses the edge that closes a cycle in declaration order", () => {
		const back = depthFirstBackEdges(
			["start", "pay", "callback"],
			edges(["start", "pay"], ["pay", "callback"], ["callback", "pay"]),
		);
		expect([...back]).toEqual(["e2"]);
	});

	it("layers a retry loop after the step it returns to", () => {
		const hierarchy = buildContainerHierarchy({
			direction: "LR",
			nodeIds: ["order", "pay", "callback"],
			groups: [],
			swimlanes: [],
		});
		const layering = assignLayers(
			["order", "pay", "callback"],
			edges(["order", "pay"], ["pay", "callback"], ["callback", "pay"]),
			hierarchy,
		);
		expect(layering.layerOfNode.get("order")).toBe(0);
		expect(layering.layerOfNode.get("pay")).toBe(1);
		expect(layering.layerOfNode.get("callback")).toBe(2);
	});
});

describe("swimlane hand-offs", () => {
	const lanes = (children: Record<string, string[]>) => ({
		id: "flow",
		orientation: "horizontal" as const,
		headerHeight: 28,
		padding: 16,
		lanes: Object.entries(children).map(([id, ids]) => ({ id, children: ids })),
	});
	const layersOf = (
		nodeIds: string[],
		pairs: [string, string][],
		swimlane: ReturnType<typeof lanes>,
	) => {
		const hierarchy = buildContainerHierarchy({
			direction: "LR",
			nodeIds,
			groups: [],
			swimlanes: [swimlane],
		});
		return assignLayers(nodeIds, edges(...pairs), hierarchy).layerOfNode;
	};

	it("keeps a hand-off between lanes on the same layer", () => {
		const layer = layersOf(
			["a", "b", "c"],
			[
				["a", "b"],
				["b", "c"],
			],
			lanes({ one: ["a"], two: ["b"], three: ["c"] }),
		);
		expect([layer.get("a"), layer.get("b"), layer.get("c")]).toEqual([0, 0, 0]);
	});

	it("advances when the flow returns to a lane it already used", () => {
		const layer = layersOf(
			["a", "b", "c"],
			[
				["a", "b"],
				["b", "c"],
			],
			lanes({ one: ["a", "c"], two: ["b"] }),
		);
		expect(layer.get("b")).toBe(0);
		expect(layer.get("c")).toBe(1);
	});

	it("never draws a straight hand-off through a node in a lane between", () => {
		const layer = layersOf(
			["a", "m", "b"],
			[
				["a", "m"],
				["a", "b"],
			],
			lanes({ one: ["a"], two: ["m"], three: ["b"] }),
		);
		// a→b drawn straight on layer 0 would pass through m if m were there.
		expect(layer.get("m") === 0 && layer.get("b") === 0).toBe(false);
		expect(Math.min(layer.get("m") ?? 9, layer.get("b") ?? 9)).toBe(0);
	});

	it("still advances inside one lane", () => {
		const layer = layersOf(
			["a", "b"],
			[["a", "b"]],
			lanes({ one: ["a", "b"] }),
		);
		expect(layer.get("b")).toBe(1);
	});
});

describe("default layout mode", () => {
	const yaml = (mode?: string) => `
layout: { direction: LR${mode === undefined ? "" : `, mode: ${mode}`} }
swimlanes:
  flow:
    orientation: horizontal
    lanes:
      one: { children: [a] }
      two: { children: [b] }
nodes:
  a: { label: A }
  b: { label: B }
edges:
  - a -> b
`;
	const centreX = (source: string, id: string) => {
		const result = renderDiagramDsl(source, {
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const box = result.diagram?.nodes.find((node) => node.id === id)?.box;
		return box === undefined ? Number.NaN : box.x + box.width / 2;
	};

	it("solves swimlane diagrams with the global layout by default", () => {
		// Global: the hand-off a → b is drawn straight across the lanes.
		expect(centreX(yaml(), "b")).toBeCloseTo(centreX(yaml(), "a"), 0);
		expect(centreX(yaml(), "b")).toBeCloseTo(centreX(yaml("global"), "b"), 6);
	});

	it("keeps Dagre when the mode is set explicitly", () => {
		expect(centreX(yaml("dagre"), "b")).toBeGreaterThan(
			centreX(yaml("dagre"), "a") + 40,
		);
	});
});
