import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportExcalidraw, exportSvg } from "../src/exporters/index.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../src/ir/index.js";
import { stringifyCanonical } from "../src/serialization/index.js";
import { solveDiagram } from "../src/solver/index.js";

describe("solver determinism", () => {
	it("serializes repeated solveDiagram output byte-identically", () => {
		const input: NormalizedDiagram = {
			id: "deterministic",
			direction: "TB",
			nodes: [node("b"), node("a", { x: 0, y: 0 }), node("c")],
			edges: [
				{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
				{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
			],
			groups: [],
			constraints: [
				{
					kind: "relative-position",
					sourceId: "b",
					referenceId: "a",
					relation: "below",
					offset: { x: 0, y: 80 },
				},
				{
					kind: "relative-position",
					sourceId: "c",
					referenceId: "b",
					relation: "below",
					offset: { x: 0, y: 80 },
				},
			],
			diagnostics: [],
		};

		expect(stringifyCanonical(solveDiagram(input))).toBe(
			stringifyCanonical(solveDiagram(input)),
		);
	});

	it.each([
		["dagre-directions.canonical.json", dagreDirectionsDiagram()],
		["hybrid-layout.canonical.json", hybridLayoutDiagram()],
		["constraints.canonical.json", constraintDiagnosticsDiagram()],
		["routing.canonical.json", routingDiagram()],
	])("matches committed Phase 3 fixture %s", (fixtureName, input) => {
		const fixture = readFileSync(
			new URL(`./fixtures/phase-03/${fixtureName}`, import.meta.url),
			"utf8",
		);

		expect(stringifyCanonical(solveDiagram(input))).toBe(fixture);
	});

	it("matches committed Phase 4 coordinated exporter fixtures", () => {
		const fixture = JSON.parse(
			readFileSync(
				new URL(
					"./fixtures/phase-04/coordinated-export.canonical.json",
					import.meta.url,
				),
				"utf8",
			),
		) as CoordinatedDiagram;
		const svgGolden = readFileSync(
			new URL("./fixtures/phase-04/coordinated-export.svg", import.meta.url),
			"utf8",
		);
		const excalidrawGolden = readFileSync(
			new URL(
				"./fixtures/phase-04/coordinated-export.excalidraw.json",
				import.meta.url,
			),
			"utf8",
		);

		expect(exportSvg(fixture, { title: "Coordinated Export" })).toBe(svgGolden);
		expect(
			stringifyCanonical(
				JSON.parse(exportExcalidraw(fixture, { title: "Coordinated Export" })),
			),
		).toBe(excalidrawGolden);
	});
});

function dagreDirectionsDiagram(): NormalizedDiagram {
	return {
		id: "dagre-directions",
		direction: "BT",
		nodes: [node("a"), node("b"), node("c")],
		edges: [
			{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
			{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
		],
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function hybridLayoutDiagram(): NormalizedDiagram {
	return {
		id: "hybrid-layout",
		direction: "LR",
		nodes: [node("fixed", { x: 10, y: 20 }), node("auto"), node("exact")],
		edges: [
			{
				id: "fixed-auto",
				source: { nodeId: "fixed" },
				target: { nodeId: "auto" },
			},
			{
				id: "auto-exact",
				source: { nodeId: "auto" },
				target: { nodeId: "exact" },
			},
		],
		groups: [
			{
				id: "cluster",
				nodeIds: ["fixed", "auto"],
				groupIds: [],
				padding: { top: 8, right: 8, bottom: 8, left: 8 },
			},
		],
		constraints: [
			{
				kind: "relative-position",
				sourceId: "auto",
				referenceId: "fixed",
				relation: "right-of",
				offset: { x: 80, y: 0 },
			},
			{
				kind: "exact-position",
				targetId: "exact",
				position: { x: 340, y: 20 },
			},
		],
		diagnostics: [],
	};
}

function constraintDiagnosticsDiagram(): NormalizedDiagram {
	return {
		id: "constraint-diagnostics",
		direction: "TB",
		nodes: [
			node("container", { x: 0, y: 0 }),
			node("child", { x: 300, y: 300 }),
		],
		edges: [
			{
				id: "missing-edge",
				source: { nodeId: "container" },
				target: { nodeId: "missing" },
			},
		],
		groups: [
			{
				id: "broken-group",
				nodeIds: ["missing"],
				groupIds: [],
				padding: { top: 4, right: 4, bottom: 4, left: 4 },
			},
		],
		constraints: [
			{
				kind: "containment",
				containerId: "container",
				childIds: ["child"],
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
			},
		],
		diagnostics: [],
	};
}

function routingDiagram(): NormalizedDiagram {
	return {
		id: "routing",
		direction: "LR",
		nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 160, y: 80 })],
		edges: [{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } }],
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function node(id: string, position?: { x: number; y: number }) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		...(position === undefined ? {} : { position }),
	};
}
