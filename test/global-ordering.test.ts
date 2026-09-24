import { describe, expect, it } from "vitest";
import {
	assignLayers,
	buildContainerHierarchy,
	type ContainerHierarchy,
	countCrossings,
	type HierarchyInput,
	type Layering,
	orderLayers,
} from "../src/layout/index.js";

type Edge = [string, string];

function solve(
	nodeIds: string[],
	edges: Edge[],
	extra: Partial<Omit<HierarchyInput, "nodeIds">> = {},
) {
	const hierarchy = buildContainerHierarchy({
		direction: extra.direction ?? "LR",
		nodeIds,
		groups: extra.groups ?? [],
		swimlanes: extra.swimlanes ?? [],
	});
	const layering = assignLayers(
		nodeIds,
		edges.map(([source, target], index) => ({
			id: `e${index}-${source}-${target}`,
			source,
			target,
		})),
		hierarchy,
	);
	const ordering = orderLayers(layering, hierarchy);
	return { hierarchy, layering, ordering };
}

/** Container of each vertex along one layer, collapsed into runs. */
function containerRuns(
	layer: readonly string[],
	layering: Layering,
	hierarchy: ContainerHierarchy,
	kind: "lane" | "group",
): string[] {
	const runs: string[] = [];
	for (const id of layer) {
		let cursor: string | undefined = layering.vertices.get(id)?.containerId;
		let found: string | undefined;
		while (cursor !== undefined) {
			if (hierarchy.containers.get(cursor)?.kind === kind) {
				found = cursor;
				break;
			}
			cursor = hierarchy.containers.get(cursor)?.parentId;
		}
		const key = found ?? "-";
		if (runs.at(-1) !== key) runs.push(key);
	}
	return runs;
}

describe("global layering", () => {
	it("breaks cycles with one reversed edge and layers every node", () => {
		const { layering } = solve(
			["a", "b", "c"],
			[
				["a", "b"],
				["b", "c"],
				["c", "a"],
			],
		);
		expect(layering.reversedEdgeIds.size).toBe(1);
		const layers = ["a", "b", "c"].map((id) => layering.layerOfNode.get(id));
		expect(new Set(layers).size).toBe(3);
	});

	it("adds dummy vertices for long edges inside their common container", () => {
		const { layering } = solve(
			["a", "b", "c", "d"],
			[
				["a", "b"],
				["b", "c"],
				["a", "c"],
				["c", "d"],
			],
			{ groups: [{ id: "g", nodeIds: ["a", "b", "c"], groupIds: [] }] },
		);
		const dummies = [...layering.vertices.values()].filter(
			(vertex) => vertex.nodeId === undefined,
		);
		expect(dummies).toHaveLength(1);
		expect(dummies[0]?.containerId).toBe("group:g");
	});

	it("routes lane-crossing dummies inside the source lane, then the target lane", () => {
		const { layering } = solve(
			["a", "b", "c", "d", "z"],
			[
				["a", "b"],
				["b", "c"],
				["c", "d"],
				["d", "z"],
				["a", "z"],
			],
			{
				swimlanes: [
					{
						id: "s",
						orientation: "horizontal",
						lanes: [
							{ id: "top", children: ["a", "b", "c", "d"] },
							{ id: "bottom", children: ["z"] },
						],
					},
				],
			},
		);
		// a is on layer 0; the d→z hand-off stays on d's layer, so z is on
		// layer 3 and a→z has dummies on layers 1–2: the first half stays in
		// the source lane, the rest in the target lane.
		expect(layering.layerOfNode.get("z")).toBe(3);
		const dummies = [...layering.vertices.values()]
			.filter((vertex) => vertex.edgeId?.endsWith("-a-z"))
			.sort((x, y) => x.layer - y.layer);
		expect(dummies.map((dummy) => dummy.layer)).toEqual([1, 2]);
		expect(dummies.map((dummy) => dummy.containerId)).toEqual([
			"lane:s/top",
			"lane:s/bottom",
		]);
	});

	it("turns lanes along the flow into consecutive layer blocks", () => {
		// Vertical lanes (columns) in an LR diagram run along the flow.
		const { layering } = solve(
			["a1", "a2", "b1", "b2"],
			[
				["a1", "b1"],
				["a2", "b2"],
				["b1", "a2"],
			],
			{
				swimlanes: [
					{
						id: "s",
						orientation: "vertical",
						lanes: [
							{ id: "left", children: ["a1", "a2"] },
							{ id: "right", children: ["b1", "b2"] },
						],
					},
				],
			},
		);
		const layer = (id: string) => layering.layerOfNode.get(id) ?? -1;
		expect(Math.max(layer("a1"), layer("a2"))).toBeLessThan(
			Math.min(layer("b1"), layer("b2")),
		);
	});
});

describe("constrained ordering", () => {
	it("removes avoidable crossings", () => {
		// a→d and b→c cross in id order; the optimum has none.
		const { ordering } = solve(
			["a", "b", "c", "d"],
			[
				["a", "d"],
				["b", "c"],
			],
		);
		expect(ordering.crossings).toBe(0);
	});

	it("keeps lanes contiguous and in declared order in every layer", () => {
		const lanes = [
			{ id: "top", children: ["t1", "t2", "t3"] },
			{ id: "mid", children: ["m1", "m2"] },
			{ id: "bot", children: ["b1", "b2", "b3"] },
		];
		const nodes = lanes.flatMap((lane) => lane.children);
		const { layering, ordering, hierarchy } = solve(
			nodes,
			[
				["t1", "b1"],
				["b1", "m1"],
				["m1", "t2"],
				["t2", "b2"],
				["b2", "t3"],
				["m1", "m2"],
				["b2", "b3"],
			],
			{ swimlanes: [{ id: "flow", orientation: "horizontal", lanes }] },
		);
		const laneRank = (id: string) =>
			hierarchy.containers.get(id)?.fixedOrder ?? Number.POSITIVE_INFINITY;
		for (const layer of ordering.layers) {
			const runs = containerRuns(layer, layering, hierarchy, "lane").filter(
				(run) => run !== "-",
			);
			// Contiguous: each lane appears once per layer.
			expect(new Set(runs).size).toBe(runs.length);
			// Declared order.
			const ranks = runs.map(laneRank);
			expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
		}
	});

	it("keeps groups contiguous and in one consistent order across layers", () => {
		const groups = [
			{ id: "left", nodeIds: ["l1", "l2", "l3", "l4"], groupIds: [] },
			{ id: "right", nodeIds: ["r1", "r2", "r3", "r4"], groupIds: [] },
		];
		const { layering, ordering, hierarchy } = solve(
			["l1", "l2", "l3", "l4", "r1", "r2", "r3", "r4", "x"],
			[
				["l1", "l2"],
				["r1", "r2"],
				["l2", "r3"],
				["r2", "l3"],
				["l1", "l4"],
				["r1", "r4"],
				["x", "l2"],
				["x", "r2"],
			],
			{ groups },
		);
		const pairOrder = new Set<string>();
		for (const layer of ordering.layers) {
			const runs = containerRuns(layer, layering, hierarchy, "group").filter(
				(run) => run !== "-",
			);
			expect(new Set(runs).size).toBe(runs.length);
			if (runs.length === 2) pairOrder.add(runs.join(">"));
		}
		// Either left above right everywhere, or right above left everywhere.
		expect(pairOrder.size).toBeLessThanOrEqual(1);
	});

	it("never trades group-order consistency for fewer crossings", () => {
		// A and B share two layers; u0 feeds a0 and (across) b1, u1 feeds b0
		// and (across) a1. Flipping A/B between the two layers would uncross
		// the long edges but leave no drawable rectangles. (Edges between A
		// and B themselves would make them tiers in separate layers.)
		const { layering, ordering, hierarchy } = solve(
			["u0", "u1", "a0", "a1", "b0", "b1"],
			[
				["u0", "a0"],
				["u1", "b0"],
				["a0", "a1"],
				["b0", "b1"],
				["u0", "b1"],
				["u1", "a1"],
			],
			{
				groups: [
					{ id: "A", nodeIds: ["a0", "a1"], groupIds: [] },
					{ id: "B", nodeIds: ["b0", "b1"], groupIds: [] },
				],
			},
		);
		const shared = ordering.layers
			.map((layer) =>
				containerRuns(layer, layering, hierarchy, "group").filter(
					(run) => run !== "-",
				),
			)
			.filter((runs) => runs.length > 1);
		expect(shared.length).toBe(2);
		expect(new Set(shared.map((runs) => runs.join(">"))).size).toBe(1);
	});

	it("is deterministic", () => {
		const nodes = ["a", "b", "c", "d", "e", "f"];
		const edges: Edge[] = [
			["a", "c"],
			["b", "c"],
			["a", "d"],
			["c", "e"],
			["d", "f"],
			["b", "f"],
		];
		expect(solve(nodes, edges).ordering).toEqual(solve(nodes, edges).ordering);
	});
});

describe("main-axis lane layering (Codex #96, round 4)", () => {
	it("places an external predecessor before its lane successor", () => {
		const { layering } = solve(
			["x", "a", "b"],
			[
				["x", "a"],
				["a", "b"],
			],
			{
				direction: "LR",
				swimlanes: [
					{
						id: "s",
						orientation: "vertical",
						lanes: [
							{ id: "l0", children: ["a"] },
							{ id: "l1", children: ["b"] },
						],
					},
				],
			},
		);
		const layerOf = (id: string) => layering.layerOfNode.get(id) ?? -1;
		expect(layerOf("x")).toBeLessThan(layerOf("a"));
		expect(
			layering.segments.some(
				(segment) => segment.from === "x" && segment.to === "a",
			),
		).toBe(true);
	});
});

describe("main-axis lane layering (Codex #96, round 5)", () => {
	it("makes room for an external node between adjacent lane layers", () => {
		const { layering } = solve(
			["a", "x", "b"],
			[
				["a", "x"],
				["x", "b"],
			],
			{
				direction: "LR",
				swimlanes: [
					{
						id: "s",
						orientation: "vertical",
						lanes: [
							{ id: "l0", children: ["a"] },
							{ id: "l1", children: ["b"] },
						],
					},
				],
			},
		);
		const layerOf = (id: string) => layering.layerOfNode.get(id) ?? -1;
		expect(layerOf("a")).toBeLessThan(layerOf("x"));
		expect(layerOf("x")).toBeLessThan(layerOf("b"));
	});
});

describe("main-axis lane layering (Codex #96, round 6)", () => {
	it("opens a gap when both lane endpoints share a layer", () => {
		const { layering } = solve(
			["a", "x", "b"],
			[
				["a", "x"],
				["x", "b"],
			],
			{
				direction: "LR",
				swimlanes: [
					{
						id: "s",
						orientation: "vertical",
						lanes: [{ id: "l0", children: ["a", "b"] }],
					},
				],
			},
		);
		const layerOf = (id: string) => layering.layerOfNode.get(id) ?? -1;
		expect(layerOf("a")).toBeLessThan(layerOf("x"));
		expect(layerOf("x")).toBeLessThan(layerOf("b"));
	});
});

describe("countCrossings", () => {
	it("matches the pairwise definition on random layer pairs", () => {
		let state = 17;
		const random = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 2 ** 32;
		};
		for (let trial = 0; trial < 200; trial += 1) {
			const top = Array.from(
				{ length: 1 + Math.floor(random() * 8) },
				(_, i) => `t${i}`,
			);
			const bottom = Array.from(
				{ length: 1 + Math.floor(random() * 8) },
				(_, i) => `b${i}`,
			);
			const lower = new Map<string, string[]>();
			for (const id of top) {
				lower.set(
					id,
					bottom.filter(() => random() < 0.35),
				);
			}
			const pairs: [number, number][] = [];
			top.forEach((id, i) => {
				for (const target of lower.get(id) ?? []) {
					pairs.push([i, bottom.indexOf(target)]);
				}
			});
			let expected = 0;
			for (let i = 0; i < pairs.length; i += 1) {
				for (let j = i + 1; j < pairs.length; j += 1) {
					const [a0, a1] = pairs[i] as [number, number];
					const [b0, b1] = pairs[j] as [number, number];
					if ((a0 - b0) * (a1 - b1) < 0) expected += 1;
				}
			}
			expect(countCrossings([top, bottom], lower), `trial ${trial}`).toBe(
				expected,
			);
		}
	});
});
