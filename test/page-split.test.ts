import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import {
	exportDrawio,
	exportExcalidraw,
	exportGeometry,
	exportSvg,
	geometryDocumentSchema,
} from "../src/exporters/index.js";
import type {
	CoordinatedDiagram,
	NormalizedDiagram,
	NormalizedGroup,
	PageSplitRemediationDetail,
	RemediationPolicyMode,
} from "../src/ir/index.js";
import { solveDiagram } from "../src/solver/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

/** 25 unconnected pairs: one dependency rail more than the page has (24). */
function railOverflowPage(groups: NormalizedGroup[] = []): NormalizedDiagram {
	const nodes = Array.from({ length: 25 }, (_, index) => [
		box(`s${index}`, 0, index * 70),
		box(`t${index}`, 240, index * 70),
	]).flat();
	return {
		id: "rail-overflow",
		direction: "LR",
		nodes,
		edges: Array.from({ length: 25 }, (_, index) => ({
			id: `e${index}`,
			source: { nodeId: `s${index}` },
			target: { nodeId: `t${index}` },
		})),
		groups,
		constraints: [],
		diagnostics: [],
	};
}

function box(id: string, x: number, y: number) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		position: { x, y },
	};
}

function solveRailOverflow(
	pageSplit: RemediationPolicyMode,
	groups: NormalizedGroup[] = [],
): CoordinatedDiagram {
	return solveDiagram(railOverflowPage(groups), {
		initialLayout: "positions",
		routeKind: "obstacle-avoiding",
		railRouting: "dependency",
		textMeasurer: new DeterministicTextMeasurer(),
		remediationPolicy: { pageSplit },
	});
}

/** Eight chained six-node flows with long jumps: far too much for A5. */
function longFlowSource(): string {
	const lines = [
		"title: Order platform",
		"page: A5",
		"layout: { direction: LR }",
		"routing:",
		"  remediationPolicy:",
		"    pageSplit: auto",
		"nodes:",
	];
	for (let group = 0; group < 8; group += 1) {
		for (let step = 0; step < 6; step += 1) {
			lines.push(`  s${group}_${step}: { label: Service ${group}.${step} }`);
		}
	}
	lines.push("edges:");
	for (let group = 0; group < 8; group += 1) {
		for (let step = 0; step < 5; step += 1) {
			lines.push(`  - s${group}_${step} -> s${group}_${step + 1}`);
		}
		if (group < 7) lines.push(`  - s${group}_5 -> s${group + 1}_0`);
		if (group < 6) lines.push(`  - s${group}_2 -> s${group + 2}_3`);
	}
	return `${lines.join("\n")}\n`;
}

describe("executable page split (#75 / #86)", { timeout: 30_000 }, () => {
	it("only suggests the split unless pageSplit is auto", () => {
		const suggested = solveRailOverflow("suggest");
		expect(suggested.pages).toBeUndefined();
		expect(suggested.deliverability?.status).toBe("degraded");
		expect(
			suggested.deliverability?.remediationPlans.find(
				(plan) => plan.type === "page-split",
			)?.status,
		).toBe("suggested");
	});

	it("splits an over-capacity page into clean pages", () => {
		const result = solveRailOverflow("auto");
		expect(result.pages).toHaveLength(2);
		expect(result.deliverability?.status).toBe("clean");
		const plan = result.deliverability?.remediationPlans.find(
			(candidate) => candidate.type === "page-split",
		);
		expect(plan?.status).toBe("applied");
		const detail = plan?.detail as PageSplitRemediationDetail;
		expect(detail.policy).toBe("auto");
		// Unconnected pairs split without cutting an edge.
		expect(detail.crossPageEdgeIds).toEqual([]);
		const placed = (detail.pages ?? []).flatMap((page) => page.nodeIds);
		expect([...placed].sort()).toEqual(
			railOverflowPage()
				.nodes.map((node) => node.id)
				.sort(),
		);
		for (const page of result.pages ?? []) {
			expect(page.deliverability?.status).toBe("clean");
			expect(
				page.diagnostics.filter(
					(diagnostic) => diagnostic.code === "routing.rail-capacity.exceeded",
				),
			).toEqual([]);
		}
		// The top level is page 1, with every page's diagnostics.
		expect(result.nodes).toEqual(result.pages?.[0]?.nodes);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "remediation.page-split.applied" }),
		);
	});

	it("keeps a group and everything in it on one page", () => {
		const group: NormalizedGroup = {
			id: "pinned",
			nodeIds: ["s0", "t0", "s24", "t24"],
			groupIds: [],
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
		};
		const result = solveRailOverflow("auto", [group]);
		const detail = result.deliverability?.remediationPlans.find(
			(plan) => plan.type === "page-split",
		)?.detail as PageSplitRemediationDetail;
		const pageOf = (id: string) =>
			detail.pages?.find((page) => page.nodeIds.includes(id))?.page;
		expect(new Set(group.nodeIds.map(pageOf)).size).toBe(1);
		const groupPage = result.pages?.[(pageOf("s0") ?? 1) - 1];
		expect(groupPage?.groups.map((item) => item.id)).toEqual(["pinned"]);
	});

	it("reports a blocked split when there is nothing to split along", () => {
		const group: NormalizedGroup = {
			id: "everything",
			nodeIds: railOverflowPage().nodes.map((node) => node.id),
			groupIds: [],
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
		};
		const result = solveRailOverflow("auto", [group]);
		expect(result.pages).toBeUndefined();
		expect(result.deliverability?.status).toBe("degraded");
		expect(
			result.deliverability?.remediationPlans.find(
				(plan) => plan.type === "page-split",
			)?.status,
		).toBe("blocked");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "remediation.page-split.blocked" }),
		);
	});

	it("splits a page too small to read into readable pages with off-page connectors", () => {
		const result = renderDiagramDsl(longFlowSource(), { format: "svg" });
		const diagram = result.diagram as CoordinatedDiagram;
		expect(result.page?.readable).toBe(true);
		expect(result.page?.pageCount).toBe(diagram.pages?.length);
		expect(diagram.pages?.length).toBeGreaterThanOrEqual(2);
		const detail = diagram.deliverability?.remediationPlans.find(
			(plan) => plan.type === "page-split",
		)?.detail as PageSplitRemediationDetail;
		expect(detail.crossPageEdgeIds?.length).toBeGreaterThan(0);

		const pages = diagram.pages ?? [];
		for (const edgeId of detail.crossPageEdgeIds ?? []) {
			// Drawn on two pages, ending at a connector on each.
			const halves = pages.flatMap((page, index) =>
				page.edges
					.filter((edge) => edge.id === edgeId)
					.map((edge) => ({ edge, page, index })),
			);
			expect(halves).toHaveLength(2);
			for (const { edge, page, index } of halves) {
				const connectorId = [edge.source.nodeId, edge.target.nodeId].find(
					(id) => id.startsWith("__offpage__"),
				);
				const connector = page.nodes.find((node) => node.id === connectorId);
				expect(connector?.metadata?.offPageConnector).toBe(true);
				const remotePage = connector?.metadata?.remotePage as number;
				expect(remotePage).not.toBe(index + 1);
				expect(connector?.label?.text).toContain(`P${remotePage}`);
			}
		}
		// Every original node is drawn exactly once.
		const drawn = pages
			.flatMap((page) => page.nodes)
			.filter((node) => node.metadata?.offPageConnector !== true)
			.map((node) => node.id);
		expect(drawn).toHaveLength(48);
		expect(new Set(drawn).size).toBe(48);
		expect(pages.map((page) => page.title)).toEqual(
			pages.map((_, index) => `Order platform (${index + 1}/${pages.length})`),
		);
	});

	it("exports every page in every format", () => {
		const diagram = renderDiagramDsl(longFlowSource(), { format: "svg" })
			.diagram as CoordinatedDiagram;
		const count = diagram.pages?.length ?? 0;

		const svg = exportSvg(diagram);
		expect(svg).toContain(`data-page-count="${count}"`);
		expect(svg.match(/<svg class="page"/g)).toHaveLength(count);

		const drawio = exportDrawio(diagram);
		expect(drawio.match(/<diagram /g)).toHaveLength(count);
		expect(drawio.match(/<mxfile /g)).toHaveLength(1);

		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: Array<{
				id: string;
				containerId?: string | null;
				startBinding?: { elementId: string } | null;
				endBinding?: { elementId: string } | null;
			}>;
		};
		const ids = scene.elements.map((element) => element.id);
		expect(new Set(ids).size).toBe(ids.length);
		const known = new Set(ids);
		for (const element of scene.elements) {
			for (const ref of [
				element.containerId,
				element.startBinding?.elementId,
				element.endBinding?.elementId,
			]) {
				if (ref !== undefined && ref !== null)
					expect(known.has(ref)).toBe(true);
			}
		}

		const geometry = exportGeometry(diagram);
		expect(geometry.pages).toHaveLength(count);
		expect(() => geometryDocumentSchema.parse(geometry)).not.toThrow();
	});

	it("is byte-stable", () => {
		const first = renderDiagramDsl(longFlowSource(), { format: "geometry" });
		const second = renderDiagramDsl(longFlowSource(), { format: "geometry" });
		expect(first.content).toBe(second.content);
		const pairsA = JSON.stringify(solveRailOverflow("auto"));
		const pairsB = JSON.stringify(solveRailOverflow("auto"));
		expect(pairsA).toBe(pairsB);
	});
});
