import { describe, expect, it } from "vitest";
import type {
	Box,
	CoordinatedDiagram,
	NormalizedDiagram,
	SolvedTextAnnotation,
} from "../src/ir/index.js";
import {
	type SolveDiagramOptions,
	solveDiagram,
	solveDiagramSafe,
} from "../src/solver/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

describe("dense MBSE acceptance gate", () => {
	it.each([
		["CV dependency page", denseCvDependencyPage()],
		["OV/SV resource-flow page", denseResourceFlowPage()],
	])("reports Stage 5-style clearance evidence for %s", (_name, diagram) => {
		const result = solveDiagram(diagram, denseAcceptanceOptions());
		const safeResult = solveDiagramSafe(diagram, denseAcceptanceOptions());
		const evidence = stage5Evidence(result);
		const criticals =
			evidence.edgeLabelIntersections +
			evidence.nodeLabelIntersections +
			evidence.unrelatedNodeIntersections;

		expect(fatalEvidenceCrossings(result)).toEqual([]);
		expect(fatalEvidenceCrossings(safeResult)).toEqual([]);

		if (result.deliverability?.status === "clean") {
			expect(criticals).toBe(0);
			expect(result.diagnostics).not.toContainEqual(
				expect.objectContaining({
					code: "routing.text-clearance.unresolved",
				}),
			);
			expect(result.diagnostics).not.toContainEqual(
				expect.objectContaining({
					code: "routing.obstacle.unavoidable",
				}),
			);
			return;
		}

		expect(result.deliverability?.status).toBe("unsatisfiable");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.deliverability.unsatisfiable",
				severity: "error",
				detail: expect.objectContaining({
					pageId: diagram.id,
					remediationTypes: expect.any(String),
				}),
			}),
		);
		expect(
			result.diagnostics.some((diagnostic) =>
				[
					"routing.label-congestion.unresolved",
					"routing.label-externalization.required",
					"routing.route-label-loop.exhausted",
					"routing.obstacle.unavoidable",
					"constraints.overlap.post-growth",
				].includes(diagnostic.code),
			),
		).toBe(true);
	});

	it("exposes rail/gutter evidence for dense CV dependency pages", () => {
		const result = solveDiagram(denseCvDependencyPage(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const externalLabels = solveDiagram(denseCvDependencyPage(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			railRouting: "dependency",
			externalLabels: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});

		expect(result.routing?.rails.length).toBeGreaterThan(0);
		expect(result.routing?.gutters).toContainEqual(
			expect.objectContaining({
				side: "top",
				railCount: result.routing?.rails.length,
			}),
		);
		for (const edge of result.edges) {
			for (const annotation of result.textAnnotations ?? []) {
				if (annotation.surfaceKind !== "edge-label") continue;
				if (annotation.ownerId === edge.id) continue;
				expect(routeCrossesBox(edge.points, annotation.box)).toBe(false);
			}
		}
		expect(externalLabels.routing?.rails.length).toBeGreaterThanOrEqual(6);
		expect(externalLabels.routing?.gutters).toContainEqual(
			expect.objectContaining({
				side: "top",
				railCount: externalLabels.routing?.rails.length,
			}),
		);
		expect(externalLabels.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-externalization.required",
			}),
		);
	});
});

function denseAcceptanceOptions(): SolveDiagramOptions {
	return {
		initialLayout: "positions",
		routeKind: "obstacle-avoiding",
		railRouting: "dependency",
		edgeLabelRerouting: { maxIterations: 4 },
		textObstacleVertices: true,
		textIntersectionTolerance: 0,
		strict: true,
		textMeasurer: new DeterministicTextMeasurer(),
	};
}

function fatalEvidenceCrossings(
	result: CoordinatedDiagram,
): CoordinatedDiagram["diagnostics"] {
	return result.diagnostics.filter(
		(diagnostic) =>
			diagnostic.severity === "error" &&
			diagnostic.code === "routing.evidence.crossing_forbidden",
	);
}

function stage5Evidence(result: CoordinatedDiagram): {
	edgeLabelIntersections: number;
	nodeLabelIntersections: number;
	unrelatedNodeIntersections: number;
	unsatDiagnostics: number;
	backtrackingDiagnostics: number;
	pageOverflowDiagnostics: number;
} {
	const textAnnotations = result.textAnnotations ?? [];
	let edgeLabelIntersections = 0;
	let nodeLabelIntersections = 0;
	let unrelatedNodeIntersections = 0;
	for (const edge of result.edges) {
		for (const annotation of textAnnotations) {
			if (annotation.placement === "external-callout-required") continue;
			if (isConnectedText(edge, annotation)) continue;
			if (!routeCrossesBox(edge.points, annotation.box)) continue;
			if (annotation.surfaceKind === "edge-label") {
				edgeLabelIntersections += 1;
			}
			if (annotation.surfaceKind === "node-label") {
				nodeLabelIntersections += 1;
			}
		}
		for (const node of result.nodes) {
			if (node.id === edge.source.nodeId || node.id === edge.target.nodeId) {
				continue;
			}
			if (routeCrossesBox(edge.points, insetBox(node.box, 1))) {
				unrelatedNodeIntersections += 1;
			}
		}
	}
	return {
		edgeLabelIntersections,
		nodeLabelIntersections,
		unrelatedNodeIntersections,
		unsatDiagnostics: result.diagnostics.filter((diagnostic) =>
			diagnostic.code.includes("unsatisfiable"),
		).length,
		backtrackingDiagnostics: result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.backtracking_excessive",
		).length,
		pageOverflowDiagnostics: result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "page_overflow",
		).length,
	};
}

function isConnectedText(
	edge: CoordinatedDiagram["edges"][number],
	annotation: SolvedTextAnnotation,
): boolean {
	if (annotation.surfaceKind === "edge-label") {
		return annotation.ownerId === edge.id;
	}
	if (annotation.surfaceKind === "node-label") {
		return (
			annotation.ownerId === edge.source.nodeId ||
			annotation.ownerId === edge.target.nodeId
		);
	}
	return false;
}

function routeCrossesBox(
	points: readonly { x: number; y: number }[],
	box: Box,
): boolean {
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) continue;
		if (segmentIntersectsBox(start, end, box)) return true;
	}
	return false;
}

function segmentIntersectsBox(
	start: { x: number; y: number },
	end: { x: number; y: number },
	box: Box,
): boolean {
	if (pointInsideBox(start, box) || pointInsideBox(end, box)) {
		return true;
	}
	if (start.x === end.x) {
		return (
			start.x > box.x &&
			start.x < box.x + box.width &&
			rangesOverlap(start.y, end.y, box.y, box.y + box.height)
		);
	}
	if (start.y === end.y) {
		return (
			start.y > box.y &&
			start.y < box.y + box.height &&
			rangesOverlap(start.x, end.x, box.x, box.x + box.width)
		);
	}
	return true;
}

function pointInsideBox(point: { x: number; y: number }, box: Box): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return high > min && low < max;
}

function insetBox(box: Box, amount: number): Box {
	return {
		x: box.x + amount,
		y: box.y + amount,
		width: Math.max(0, box.width - amount * 2),
		height: Math.max(0, box.height - amount * 2),
	};
}

function denseCvDependencyPage(): NormalizedDiagram {
	const pairCount = 8;
	const nodes = Array.from({ length: pairCount }, (_, index) => [
		node(`cv-source-${index}`, { x: 0, y: index * 70 }),
		node(`cv-target-${index}`, { x: 300, y: index * 70 }),
	]).flat();
	return {
		id: "phase-12-cv-dependency",
		direction: "LR",
		nodes,
		edges: Array.from({ length: pairCount }, (_, index) => ({
			id: `cv-dependency-${index}`,
			source: { nodeId: `cv-source-${index}` },
			target: { nodeId: `cv-target-${index}` },
			label: { text: `capability dependency ${index}` },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
		frame: {
			kind: "sysml",
			titleTab: "CV-1 capability dependency view",
		},
	};
}

function denseResourceFlowPage(): NormalizedDiagram {
	return {
		id: "phase-12-resource-flow",
		direction: "LR",
		nodes: [
			node("producer-a", { x: 0, y: 0 }),
			node("producer-b", { x: 0, y: 90 }),
			node("consumer-a", { x: 320, y: 0 }),
			node("consumer-b", { x: 320, y: 90 }),
			{
				...node("dense-label-cell", { x: 150, y: 20 }),
				label: { text: "resource coordination cell" },
				labelLayout: testLabelLayout("resource coordination cell", {
					x: -180,
					y: -80,
					width: 420,
					height: 220,
				}),
			},
		],
		edges: [
			{
				id: "rf-01",
				source: { nodeId: "producer-a" },
				target: { nodeId: "consumer-b" },
				label: { text: "resource flow one" },
			},
			{
				id: "rf-02",
				source: { nodeId: "producer-b" },
				target: { nodeId: "consumer-a" },
				label: { text: "resource flow two" },
			},
			{
				id: "rf-03",
				source: { nodeId: "producer-a" },
				target: { nodeId: "consumer-a" },
				label: { text: "resource flow three" },
			},
			{
				id: "rf-04",
				source: { nodeId: "producer-b" },
				target: { nodeId: "consumer-b" },
				label: { text: "resource flow four" },
			},
		],
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function node(id: string, position: { x: number; y: number }) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position,
		label: { text: id },
	};
}

function testLabelLayout(text: string, box: Box) {
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
