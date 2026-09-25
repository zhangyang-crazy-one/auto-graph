import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../../src/dsl/index.js";
import {
	exportGeometry,
	previousLayoutFromGeometry,
} from "../../src/exporters/index.js";
import type { Box, CoordinatedDiagram } from "../../src/ir/index.js";
import {
	assignLayers,
	buildContainerHierarchy,
	orderLayers,
	previousLayoutOf,
} from "../../src/layout/index.js";
import {
	LAYOUT_METRIC_HARD_KEYS,
	measureLayoutQuality,
	measureLayoutStability,
} from "../../src/quality/index.js";
import { DeterministicTextMeasurer } from "../../src/text/index.js";
import { applyEdit, baseDocument, toDsl } from "./edits.js";

function box(x: number, y: number): Box {
	return { x, y, width: 40, height: 20 };
}

function solve(source: string, previous?: CoordinatedDiagram) {
	const result = renderDiagramDsl(source, {
		textMeasurer: new DeterministicTextMeasurer(),
		...(previous === undefined
			? {}
			: { previousLayout: previousLayoutOf(previous) }),
	});
	expect(result.diagram).toBeDefined();
	return result.diagram as CoordinatedDiagram;
}

function boxes(diagram: CoordinatedDiagram) {
	return new Map(diagram.nodes.map((node) => [node.id, node.box] as const));
}

function hardMetrics(diagram: CoordinatedDiagram): number {
	const metrics = measureLayoutQuality(diagram);
	return LAYOUT_METRIC_HARD_KEYS.reduce(
		(sum, key) => sum + Number(metrics[key]),
		0,
	);
}

describe("measureLayoutStability", () => {
	it("ignores a translation of the whole layout", () => {
		const before = new Map([
			["a", box(0, 0)],
			["b", box(100, 0)],
			["c", box(0, 100)],
		]);
		const after = new Map(
			[...before].map(([id, b]) => [id, { ...b, x: b.x + 50, y: b.y - 30 }]),
		);
		expect(measureLayoutStability(before, after)).toEqual({
			common: 3,
			meanShift: 0,
			maxShift: 0,
			movedShare: 0,
			orderPreserved: 1,
		});
	});

	it("counts pairs that swap sides and nodes that move", () => {
		const before = new Map([
			["a", box(0, 0)],
			["b", box(0, 100)],
			["c", box(200, 0)],
		]);
		const after = new Map([
			["a", box(0, 100)],
			["b", box(0, 0)],
			["c", box(200, 0)],
			["new", box(400, 0)],
		]);
		const stability = measureLayoutStability(before, after);
		expect(stability.common).toBe(3);
		// a and b swap above/below; c was and stays level with one of them,
		// which is not a flip.
		expect(stability.orderPreserved).toBeCloseTo(2 / 3, 3);
		expect(stability.movedShare).toBeCloseTo(2 / 3, 3);
	});

	it("is neutral when nothing survives", () => {
		expect(
			measureLayoutStability(new Map(), new Map([["a", box(0, 0)]])),
		).toMatchObject({ common: 0, orderPreserved: 1 });
	});
});

describe("previous layout read-back", () => {
	it("reads node boxes and edge routes from a geometry document", () => {
		const diagram = solve(toDsl(baseDocument("architecture", 12)));
		const read = previousLayoutFromGeometry(
			JSON.parse(JSON.stringify(exportGeometry(diagram))),
		);
		expect("layout" in read).toBe(true);
		if (!("layout" in read)) return;
		// The geometry contract rounds coordinates to 0.01 px.
		for (const [id, expected] of previousLayoutOf(diagram).nodes) {
			const actual = read.layout.nodes.get(id) as Box;
			expect(actual.x).toBeCloseTo(expected.x, 1);
			expect(actual.y).toBeCloseTo(expected.y, 1);
		}
		expect(read.layout.edges?.size).toBe(diagram.edges.length);
	});

	it("rejects anything that is not a geometry document", () => {
		const read = previousLayoutFromGeometry({ format: "svg" });
		expect("error" in read && read.error).toContain("dge-geometry");
	});
});

describe("ordering orientation", () => {
	function layered(edges: [string, string][], nodeIds: string[]) {
		const hierarchy = buildContainerHierarchy({
			direction: "LR",
			nodeIds,
			groups: [],
			swimlanes: [],
		});
		const layering = assignLayers(
			nodeIds,
			edges.map(([source, target]) => ({
				id: `${source}-${target}`,
				source,
				target,
			})),
			hierarchy,
		);
		return { hierarchy, layering };
	}

	it("picks the mirror image that lists nodes in id order", () => {
		const { hierarchy, layering } = layered(
			[
				["a", "c"],
				["b", "d"],
			],
			["d", "c", "b", "a"],
		);
		const ordering = orderLayers(layering, hierarchy);
		expect(ordering.layers[0]).toEqual(["a", "b"]);
		expect(ordering.layers[1]).toEqual(["c", "d"]);
	});

	it("keeps a reference order that costs no crossings", () => {
		const { hierarchy, layering } = layered(
			[
				["a", "c"],
				["b", "d"],
			],
			["a", "b", "c", "d"],
		);
		const ordering = orderLayers(layering, hierarchy, {
			reference: new Map([
				["a", 10],
				["b", 0],
				["c", 10],
				["d", 0],
			]),
		});
		expect(ordering.layers[0]).toEqual(["b", "a"]);
		expect(ordering.layers[1]).toEqual(["d", "c"]);
	});

	it("gives up a reference order when that removes enough crossings", () => {
		const { hierarchy, layering } = layered(
			[
				["a", "c"],
				["b", "d"],
			],
			["a", "b", "c", "d"],
		);
		// Reference crosses a-c with b-d: one crossing against one reversed
		// pair. Weight 0.5 makes the uncrossed order cheaper.
		const ordering = orderLayers(layering, hierarchy, {
			reference: new Map([
				["a", 0],
				["b", 10],
				["c", 10],
				["d", 0],
			]),
			stabilityWeight: 0.5,
		});
		expect(ordering.crossings).toBe(0);
	});
});

describe("incremental stability", () => {
	it("reproduces a layout solved against itself", () => {
		const source = toDsl(baseDocument("architecture", 40));
		const first = solve(source);
		const again = solve(source, first);
		const stability = measureLayoutStability(boxes(first), boxes(again));
		expect(stability.orderPreserved).toBe(1);
		expect(stability.maxShift).toBeLessThan(0.5);
	});

	it("keeps the picture when a node is removed", () => {
		const base = baseDocument("plain", 40);
		const first = solve(toDsl(base));
		const edited = toDsl(applyEdit(base, "remove-node"));
		const cold = measureLayoutStability(boxes(first), boxes(solve(edited)));
		const warmDiagram = solve(edited, first);
		const warm = measureLayoutStability(boxes(first), boxes(warmDiagram));
		expect(warm.orderPreserved).toBeGreaterThanOrEqual(0.98);
		expect(warm.orderPreserved).toBeGreaterThan(cold.orderPreserved);
		expect(warm.meanShift).toBeLessThan(cold.meanShift);
		expect(hardMetrics(warmDiagram)).toBe(0);
	});

	it("keeps group diagrams stable across an added edge", () => {
		const base = baseDocument("architecture", 40);
		const first = solve(toDsl(base));
		const warmDiagram = solve(toDsl(applyEdit(base, "add-edge")), first);
		const warm = measureLayoutStability(boxes(first), boxes(warmDiagram));
		expect(warm.orderPreserved).toBeGreaterThanOrEqual(0.99);
		expect(hardMetrics(warmDiagram)).toBe(0);
	});

	it("is deterministic", () => {
		const base = baseDocument("process", 30);
		const first = solve(toDsl(base));
		const edited = toDsl(applyEdit(base, "add-node"));
		expect(boxes(solve(edited, first))).toEqual(boxes(solve(edited, first)));
	});
});
