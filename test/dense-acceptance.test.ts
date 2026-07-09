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
		["IBD high-fan-in page", denseIbdHighFanInPage()],
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
		expect(evidence.routeObstacleIntersections).toBeGreaterThanOrEqual(0);
		expect(evidence.remediationPlanCount).toBe(
			result.deliverability?.remediationPlans.length ?? 0,
		);

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
		expect(evidence.remediationPlanCount).toBeGreaterThan(0);
		expect(evidence.remediationPlanTypes.length).toBeGreaterThan(0);
	});

	it("emits deterministic remediation plan objects for dense strict output", () => {
		const first = solveDiagram(
			denseCvDependencyPage(),
			denseAcceptanceOptions(),
		);
		const second = solveDiagram(
			denseCvDependencyPage(),
			denseAcceptanceOptions(),
		);

		expect(first.deliverability?.remediationPlans.length).toBeGreaterThan(0);
		expect(first.deliverability?.remediationPlans).toEqual(
			second.deliverability?.remediationPlans,
		);
		expect(first.deliverability?.remediationPlans[0]).toMatchObject({
			id: expect.stringMatching(/^remediation-\d\d-/),
			status: "suggested",
			diagnosticCodes: expect.any(Array),
			edgeIds: expect.any(Array),
			nodeIds: expect.any(Array),
		});
	});

	it("applies external label callouts in auto mode for dense CV pages", () => {
		const suggest = solveDiagram(denseCvDependencyPage(), {
			...denseAcceptanceOptions(),
			externalLabels: true,
			remediationPolicy: { externalLabels: "suggest" },
		});
		const off = solveDiagram(denseCvDependencyPage(), {
			...denseAcceptanceOptions(),
			externalLabels: true,
			remediationPolicy: { externalLabels: "off" },
		});
		const auto = solveDiagram(denseCvDependencyPage(), {
			...denseAcceptanceOptions(),
			externalLabels: true,
			remediationPolicy: { externalLabels: "auto" },
		});
		const autoEvidence = stage5Evidence(auto);
		const suggestEvidence = stage5Evidence(suggest);
		const offEvidence = stage5Evidence(off);
		const autoPlan = auto.deliverability?.remediationPlans.find(
			(plan) => plan.type === "external-label",
		);

		expect(autoPlan).toMatchObject({
			type: "external-label",
			status: "applied",
			detail: expect.objectContaining({
				strategy: "keyed-callouts",
				policy: "auto",
				callouts: expect.any(Array),
			}),
		});
		expect(autoEvidence.remediationPlanTypes).toContain("external-label");
		expect(autoPlan?.detail.strategy).toBe("keyed-callouts");
		if (autoPlan?.detail.strategy === "keyed-callouts") {
			expect(autoPlan.detail.callouts?.length ?? 0).toBeGreaterThan(0);
		}
		expect(autoEvidence.edgeLabelIntersections).toBeLessThanOrEqual(
			suggestEvidence.edgeLabelIntersections,
		);
		expect(autoEvidence.edgeLabelIntersections).toBeLessThanOrEqual(
			offEvidence.edgeLabelIntersections,
		);
		expect(
			auto.textAnnotations?.some(
				(annotation) => annotation.placement === "external-callout-required",
			),
		).toBe(false);
	});

	it("exposes rail/gutter evidence for dense CV dependency pages", () => {
		const result = solveDiagram(denseCvDependencyPage(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "dependency",
			railRouting: "dependency",
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const externalLabels = solveDiagram(denseCvDependencyPage(), {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "dependency",
			railRouting: "dependency",
			externalLabels: true,
			textMeasurer: new DeterministicTextMeasurer(),
		});

		expect(result.routing?.rails.length).toBeGreaterThan(0);
		expect(result.routing?.gutters).toContainEqual(
			expect.objectContaining({
				side: "top",
			}),
		);
		for (const edge of result.edges) {
			for (const annotation of result.textAnnotations ?? []) {
				if (annotation.surfaceKind !== "edge-label") continue;
				if (annotation.ownerId === edge.id) continue;
				expect(routeCrossesBox(edge.points, annotation.box)).toBe(false);
			}
		}
		expect(externalLabels.routing?.rails.length).toBeGreaterThanOrEqual(1);
		expect(externalLabels.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-externalization.required",
			}),
		);
	});

	it("allocates top and bottom dependency rails under pagePolicy", () => {
		const pairCount = 6;
		const diagram: NormalizedDiagram = {
			id: "phase-16-dependency-rails",
			direction: "LR",
			nodes: Array.from({ length: pairCount }, (_, index) => [
				node(`dep-source-${index}`, { x: 0, y: index * 70 }),
				node(`dep-target-${index}`, { x: 260, y: index * 70 }),
			]).flat(),
			edges: Array.from({ length: pairCount }, (_, index) => ({
				id: `dep-edge-${index}`,
				source: { nodeId: `dep-source-${index}` },
				target: { nodeId: `dep-target-${index}` },
			})),
			groups: [],
			constraints: [],
			diagnostics: [],
		};
		const first = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "dependency",
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const second = solveDiagram(diagram, {
			initialLayout: "positions",
			routeKind: "obstacle-avoiding",
			pagePolicy: "dependency",
			textMeasurer: new DeterministicTextMeasurer(),
		});
		const sides = new Set(first.routing?.rails.map((rail) => rail.side));
		expect(first.routing?.rails.length).toBe(pairCount);
		expect(sides.has("top")).toBe(true);
		expect(sides.has("bottom")).toBe(true);
		expect(first.routing?.gutters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ side: "top" }),
				expect.objectContaining({ side: "bottom" }),
			]),
		);
		expect(first.routing?.rails.map((rail) => rail.coordinate)).toEqual(
			second.routing?.rails.map((rail) => rail.coordinate),
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
	routeObstacleIntersections: number;
	unsatDiagnostics: number;
	backtrackingDiagnostics: number;
	pageOverflowDiagnostics: number;
	remediationPlanCount: number;
	remediationPlanTypes: string[];
} {
	const textAnnotations = result.textAnnotations ?? [];
	let edgeLabelIntersections = 0;
	let nodeLabelIntersections = 0;
	let unrelatedNodeIntersections = 0;
	let routeObstacleIntersections = 0;
	for (const edge of result.edges) {
		for (const annotation of textAnnotations) {
			if (annotation.placement === "external-callout-required") continue;
			if (annotation.placement === "external-callout") continue;
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
				routeObstacleIntersections += 1;
			}
		}
	}
	const remediationPlans = result.deliverability?.remediationPlans ?? [];
	return {
		edgeLabelIntersections,
		nodeLabelIntersections,
		unrelatedNodeIntersections,
		routeObstacleIntersections,
		unsatDiagnostics: result.diagnostics.filter((diagnostic) =>
			diagnostic.code.includes("unsatisfiable"),
		).length,
		backtrackingDiagnostics: result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.backtracking_excessive",
		).length,
		pageOverflowDiagnostics: result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "page_overflow",
		).length,
		remediationPlanCount: remediationPlans.length,
		remediationPlanTypes: [
			...new Set(remediationPlans.map((plan) => plan.type)),
		]
			.sort()
			.map(String),
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
	const nodeCount = 5;
	const nodes = Array.from({ length: nodeCount }, (_, index) => [
		node(`cv-source-${index}`, { x: 0, y: index * 70 }),
		node(`cv-target-${index}`, { x: 300, y: index * 70 }),
	]).flat();
	return {
		id: "phase-12-cv-dependency",
		direction: "LR",
		nodes,
		edges: Array.from({ length: 20 }, (_, index) => ({
			id: `cv-dependency-${index}`,
			source: { nodeId: `cv-source-${index % nodeCount}` },
			target: {
				nodeId: `cv-target-${(index * 2 + Math.floor(index / nodeCount)) % nodeCount}`,
			},
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
	const producers = Array.from({ length: 4 }, (_, index) =>
		node(`producer-${index}`, { x: 0, y: index * 78 }),
	);
	const relays = Array.from({ length: 4 }, (_, index) =>
		node(`relay-${index}`, { x: 160, y: 30 + index * 78 }),
	);
	const consumers = Array.from({ length: 4 }, (_, index) =>
		node(`consumer-${index}`, { x: 340, y: index * 78 }),
	);
	return {
		id: "phase-12-resource-flow",
		direction: "LR",
		nodes: [
			...producers,
			...relays,
			...consumers,
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
		edges: Array.from({ length: 12 }, (_, index) => ({
			id: `rf-${String(index + 1).padStart(2, "0")}`,
			source: { nodeId: `producer-${index % producers.length}` },
			target: { nodeId: `consumer-${(index * 2 + 1) % consumers.length}` },
			label: { text: `resource flow ${index + 1}` },
		})),
		groups: [],
		constraints: [],
		diagnostics: [],
	};
}

function denseIbdHighFanInPage(): NormalizedDiagram {
	const sources = Array.from({ length: 10 }, (_, index) =>
		node(`ibd-source-${index}`, { x: 0, y: index * 46 }),
	);
	return {
		id: "phase-12-ibd-high-fan-in",
		direction: "LR",
		nodes: [
			...sources,
			node("ibd-aggregator", { x: 260, y: 180 }),
			node("ibd-sink", { x: 440, y: 180 }),
		],
		edges: [
			...sources.map((source, index) => ({
				id: `ibd-flow-${index}`,
				source: { nodeId: source.id },
				target: { nodeId: "ibd-aggregator" },
				label: { text: `allocated item flow ${index}` },
			})),
			{
				id: "ibd-aggregate-out",
				source: { nodeId: "ibd-aggregator" },
				target: { nodeId: "ibd-sink" },
				label: { text: "aggregate item flow" },
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
