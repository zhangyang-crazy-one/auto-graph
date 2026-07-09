import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	normalizeDiagramDsl,
	parseDiagramDsl,
	renderDiagramDsl,
} from "../src/dsl/index.js";
import { exportExcalidraw, exportSvg } from "../src/exporters/index.js";
import type {
	CoordinatedDiagram,
	ExternalLabelRemediationDetail,
	LabelLayout,
	NormalizedDiagram,
} from "../src/ir/index.js";
import { stringifyCanonical } from "../src/serialization/index.js";
import { solveDiagram } from "../src/solver/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

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

	it("serializes repeated route-label feedback output byte-identically", () => {
		const input = routeLabelFeedbackDiagram();
		const options = {
			initialLayout: "positions" as const,
			routeKind: "orthogonal" as const,
			edgeLabelRerouting: { maxIterations: 2 },
			textIntersectionTolerance: 0,
		};
		const first = solveDiagram(input, options);

		expect(first.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.route-label-loop.exhausted",
				detail: expect.objectContaining({
					maxIterations: 2,
					edgeIds: "source-target",
					ownerIds: "label_owner",
					textSurfaceKinds: "node-label",
				}),
			}),
		);
		expect(stringifyCanonical(first)).toBe(
			stringifyCanonical(solveDiagram(input, options)),
		);
	});

	it("serializes repeated external-label auto callouts byte-identically", () => {
		const input = externalLabelCalloutDiagram();
		const options = {
			initialLayout: "positions" as const,
			routeKind: "straight" as const,
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" as const },
			textMeasurer: new DeterministicTextMeasurer(),
		};
		const first = solveDiagram(input, options);
		const second = solveDiagram(input, options);
		const firstDetail = first.deliverability?.remediationPlans.find(
			(plan) => plan.type === "external-label",
		)?.detail as ExternalLabelRemediationDetail | undefined;
		const secondDetail = second.deliverability?.remediationPlans.find(
			(plan) => plan.type === "external-label",
		)?.detail as ExternalLabelRemediationDetail | undefined;

		expect(firstDetail?.callouts).toEqual(secondDetail?.callouts);
		expect(
			first.textAnnotations
				?.filter((annotation) => annotation.placement === "external-callout")
				.map((annotation) => ({
					ownerId: annotation.ownerId,
					text: annotation.text,
					role: annotation.placementDetail?.role,
					box: annotation.box,
				})),
		).toEqual(
			second.textAnnotations
				?.filter((annotation) => annotation.placement === "external-callout")
				.map((annotation) => ({
					ownerId: annotation.ownerId,
					text: annotation.text,
					role: annotation.placementDetail?.role,
					box: annotation.box,
				})),
		);
		expect(stringifyCanonical(first)).toBe(stringifyCanonical(second));
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

	it("renders the Phase 5 architecture fixture deterministically", () => {
		const sourcePath = fileURLToPath(
			new URL("./fixtures/phase-05/architecture.yaml", import.meta.url),
		);
		const source = readFileSync(sourcePath, "utf8");
		const parsedA = parseDiagramDsl(source, { sourcePath });
		const parsedB = parseDiagramDsl(source, { sourcePath });
		const normalizedA = normalizeDiagramDsl(parsedA.value);
		const normalizedB = normalizeDiagramDsl(parsedB.value);
		const renderedA = renderDiagramDsl(source, { sourcePath });
		const renderedB = renderDiagramDsl(source, { sourcePath });

		expect(parsedA.diagnostics).toEqual([]);
		expect(parsedB.diagnostics).toEqual([]);
		expect(stringifyCanonical(normalizedA.diagram)).toBe(
			stringifyCanonical(normalizedB.diagram),
		);
		expect(stringifyCanonical(renderedA.diagram)).toBe(
			stringifyCanonical(renderedB.diagram),
		);
		expect(renderedA.content).toBe(renderedB.content);
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

function routeLabelFeedbackDiagram(): NormalizedDiagram {
	return {
		id: "route-label-feedback-determinism",
		direction: "LR",
		nodes: [
			node("source", { x: 0, y: 0 }),
			node("target", { x: 240, y: 0 }),
			{
				id: "label_owner",
				shape: "rectangle" as const,
				size: { width: 0, height: 0 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				position: { x: 120, y: 0 },
				label: { text: "huge label" },
				labelLayout: testLabelLayout("huge label", {
					x: -1_000,
					y: -1_000,
					width: 3_000,
					height: 3_000,
				}),
			},
		],
		edges: [
			{
				id: "source-target",
				source: { nodeId: "source" },
				target: { nodeId: "target" },
			},
		],
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function externalLabelCalloutDiagram(): NormalizedDiagram {
	return {
		id: "external-label-callout-deterministic",
		direction: "LR",
		nodes: [
			node("source-b", { x: 0, y: 0 }),
			node("target-b", { x: 300, y: 0 }),
			node("source-a", { x: 0, y: 90 }),
			node("target-a", { x: 300, y: 90 }),
		],
		edges: [
			{
				id: "edge-b",
				source: { nodeId: "source-b" },
				target: { nodeId: "target-b" },
				label: { text: "second callout label" },
			},
			{
				id: "edge-a",
				source: { nodeId: "source-a" },
				target: { nodeId: "target-a" },
				label: { text: "first callout label" },
			},
		],
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

function testLabelLayout(text: string, box: LabelLayout["box"]): LabelLayout {
	return {
		text,
		box,
		contentBox: box,
		naturalSize: { width: box.width, height: box.height },
		fittedSize: { width: box.width, height: box.height },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
		lineHeight: 14,
		lines: [
			{
				text,
				box,
				baselineY: box.y + 11.2,
				width: box.width,
				lineIndex: 0,
			},
		],
		overflow: { horizontal: false, vertical: false, truncated: false },
		diagnostics: [],
	};
}
