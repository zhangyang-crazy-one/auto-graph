import type { DslDiagnostic } from "../dsl/types.js";
import type { NormalizedDiagram } from "../ir/diagram.js";
import type { CoordinatedDiagram } from "../ir/index.js";
import {
	containmentRelations,
	type LayoutMetrics,
	measureLayoutQuality,
} from "../quality/layout-metrics.js";
import type { PageFit } from "../solver/page-fit.js";

/**
 * A compact, machine-readable account of one render, written for the
 * agent that produced the diagram: a verdict, what is wrong and where in
 * the source, the few numbers that matter, and what to change next. It
 * leaves out the informational chatter the solver emits (font choices,
 * applied defaults) that `--verbose` diagnostics keep.
 */
export interface AgentReport {
	/** `fail`: fix before use. `warn`: usable, worth a look. `ok`: done. */
	verdict: "ok" | "warn" | "fail";
	/** One sentence. */
	summary: string;
	issues: AgentIssue[];
	metrics?: AgentMetrics;
	page?: AgentPage;
	/** Concrete next steps, most useful first. */
	suggestions: string[];
}

export interface AgentIssue {
	severity: "error" | "warning";
	code: string;
	/** Dotted path into the source document, e.g. `flow.3` or `nodes.api`. */
	where?: string;
	message: string;
	fix?: string;
}

export interface AgentMetrics {
	nodes: number;
	edges: number;
	groups: number;
	lanes: number;
	crossings: number;
	bendsPerEdge: number;
	width: number;
	height: number;
	aspectRatio: number;
	/** Hard layout defects (overlaps, text overflow, …); only non-zero ones. */
	defects: Record<string, number>;
}

export interface AgentPage {
	size: string;
	orientation: "portrait" | "landscape";
	direction: string;
	scale: number;
	fontPx: number;
	readable: boolean;
	comfortable: boolean;
}

export interface AgentReportInput {
	diagram?: CoordinatedDiagram | undefined;
	diagnostics: readonly DslDiagnostic[];
	constraints?: NormalizedDiagram["constraints"] | undefined;
	page?: PageFit | undefined;
}

/** Defects that make a diagram wrong, and how to address each. */
const DEFECTS: Record<
	string,
	{ code: string; message: (count: number) => string; fix: string }
> = {
	nodeOverlaps: {
		code: "quality.node-overlap",
		message: (count) => `${count} pair(s) of nodes overlap.`,
		fix: "Remove fixed positions or constraints that force nodes onto each other.",
	},
	groupOverlaps: {
		code: "quality.group-overlap",
		message: (count) => `${count} pair(s) of groups overlap.`,
		fix: "Nest a group inside another or give a node to one group only.",
	},
	foreignNodesInGroups: {
		code: "quality.foreign-node",
		message: (count) =>
			`${count} node(s) sit inside a group they do not belong to.`,
		fix: "Check group membership; remove constraints that pull nodes into groups.",
	},
	labelOverflows: {
		code: "quality.label-overflow",
		message: (count) => `${count} node label(s) do not fit their shape.`,
		fix: "Shorten those labels or break them with \\n.",
	},
	edgesThroughNodes: {
		code: "quality.edge-through-node",
		message: (count) => `${count} edge segment(s) run through a node.`,
		fix: "Remove fixed positions/constraints that block the routes, or use the global layout.",
	},
	edgeLabelCollisions: {
		code: "quality.edge-label-collision",
		message: (count) =>
			`${count} edge label(s) overlap a node or another label.`,
		fix: "Shorten edge labels or drop labels that repeat the obvious.",
	},
	sharedEndpoints: {
		code: "quality.shared-endpoint",
		message: (count) => `${count} pair(s) of edges end on the same point.`,
		fix: "Usually harmless; merge parallel edges between the same nodes.",
	},
};
const BLOCKING = new Set([
	"nodeOverlaps",
	"groupOverlaps",
	"foreignNodesInGroups",
	"labelOverflows",
	"edgesThroughNodes",
]);
/** Node labels wider than this many characters are hard to scan. */
const LONG_LABEL = 24;

export function buildAgentReport(input: AgentReportInput): AgentReport {
	const issues = diagnosticIssues(input.diagnostics);
	const suggestions: string[] = [];
	const diagram = input.diagram;
	let metrics: AgentMetrics | undefined;
	let blocking = false;

	if (diagram !== undefined) {
		const quality = measureLayoutQuality(diagram, {
			containment: containmentRelations(input.constraints),
		});
		metrics = agentMetrics(quality);
		for (const [key, count] of Object.entries(metrics.defects)) {
			const defect = DEFECTS[key];
			if (defect === undefined) continue;
			if (BLOCKING.has(key)) blocking = true;
			issues.push({
				severity: BLOCKING.has(key) ? "error" : "warning",
				code: defect.code,
				message: defect.message(count),
				fix: defect.fix,
			});
		}
		suggestions.push(...layoutSuggestions(diagram, quality, input.page));
	}

	const page = input.page === undefined ? undefined : agentPage(input.page);
	if (page !== undefined && !page.readable) {
		issues.push({
			severity: "error",
			code: "page.unreadable",
			where: "page",
			message: `On ${page.size} the labels shrink to ${page.fontPx}px, too small to read.`,
			fix: "Split the diagram or use a larger page (see suggestions).",
		});
	} else if (page !== undefined && !page.comfortable) {
		issues.push({
			severity: "warning",
			code: "page.small-text",
			where: "page",
			message: `On ${page.size} the labels are ${page.fontPx}px, readable but small.`,
			fix: "A larger page, `direction: auto` on the page, or fewer nodes per page.",
		});
	}

	const errors = issues.filter((issue) => issue.severity === "error").length;
	const warnings = issues.length - errors;
	const verdict: AgentReport["verdict"] =
		diagram === undefined || errors > 0 || blocking
			? "fail"
			: warnings > 0
				? "warn"
				: "ok";
	return {
		verdict,
		summary: summarise(verdict, metrics, errors, warnings, page),
		issues,
		...(metrics === undefined ? {} : { metrics }),
		...(page === undefined ? {} : { page }),
		suggestions,
	};
}

function diagnosticIssues(diagnostics: readonly DslDiagnostic[]): AgentIssue[] {
	const seen = new Set<string>();
	const issues: AgentIssue[] = [];
	for (const diagnostic of diagnostics) {
		if (diagnostic.severity === "info") continue;
		const where =
			diagnostic.path === undefined || diagnostic.path.length === 0
				? undefined
				: diagnostic.path.map(String).join(".");
		const key = `${diagnostic.code}\u0000${where ?? ""}\u0000${diagnostic.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		issues.push({
			severity: diagnostic.severity,
			code: diagnostic.code,
			...(where === undefined ? {} : { where }),
			message: diagnostic.message,
			...(diagnostic.hint === undefined ? {} : { fix: diagnostic.hint }),
		});
	}
	return issues;
}

function agentMetrics(quality: LayoutMetrics): AgentMetrics {
	const defects: Record<string, number> = {};
	for (const key of Object.keys(DEFECTS) as (keyof LayoutMetrics)[]) {
		const value = quality[key];
		if (typeof value === "number" && value > 0) defects[key] = value;
	}
	return {
		nodes: quality.nodeCount,
		edges: quality.edgeCount,
		groups: quality.groupCount,
		lanes: quality.laneCount,
		crossings: quality.crossings,
		bendsPerEdge: quality.bendsPerEdge,
		width: Math.round(quality.width),
		height: Math.round(quality.height),
		aspectRatio: quality.aspectRatio,
		defects,
	};
}

function agentPage(fit: PageFit): AgentPage {
	return {
		size: `${fit.name === undefined ? `${fit.width}x${fit.height}` : fit.name.toUpperCase()}`,
		orientation: fit.orientation,
		direction: fit.direction,
		scale: fit.scale,
		fontPx: Math.round(fit.fontPx * 10) / 10,
		readable: fit.readable,
		comfortable: fit.comfortable,
	};
}

function layoutSuggestions(
	diagram: CoordinatedDiagram,
	quality: LayoutMetrics,
	page: PageFit | undefined,
): string[] {
	const suggestions: string[] = [];
	const containers = [
		...(diagram.swimlanes ?? []).flatMap((swimlane) =>
			swimlane.lanes.map((lane) => lane.id),
		),
		...diagram.groups
			.filter(
				(group) =>
					!diagram.groups.some((other) => other.groupIds.includes(group.id)),
			)
			.map((group) => group.id),
	];
	if (page !== undefined && !page.comfortable) {
		const needed = Math.ceil((11 / Math.max(0.1, page.fontPx)) ** 2);
		suggestions.push(
			containers.length > 1
				? `Split into about ${needed} page(s), e.g. one per ${
						(diagram.swimlanes ?? []).length > 0 ? "lane" : "group"
					} (${containers.slice(0, 6).join(", ")}${containers.length > 6 ? ", …" : ""}), each with the edges it needs.`
				: `Split into about ${needed} page(s) along the flow, or use page A3 / A3-landscape.`,
		);
		if (
			page.candidates.every(
				(candidate) => candidate.direction === page.direction,
			)
		) {
			suggestions.push(
				"Let the engine also try the other flow direction: page: { size: …, direction: auto }.",
			);
		}
	}
	if (
		page === undefined &&
		(quality.aspectRatio > 3.5 || quality.aspectRatio < 0.3)
	) {
		suggestions.push(
			`The drawing is ${Math.round(quality.width)}×${Math.round(quality.height)} px (aspect ${quality.aspectRatio}); set page: A4 (or slide) to fold it into a printable shape.`,
		);
	}
	if (quality.edgeCount >= 8 && quality.crossings > quality.edgeCount * 0.5) {
		suggestions.push(
			`${quality.crossings} crossings for ${quality.edgeCount} edges: group closely related nodes (groups or lanes), and write callbacks and retries after the forward flow so they are drawn as back edges.`,
		);
	}
	const long = (diagram.textAnnotations ?? [])
		.filter(
			(annotation) =>
				annotation.surfaceKind === "node-label" &&
				annotation.lines.some((line) => [...line.text].length > LONG_LABEL),
		)
		.map((annotation) => annotation.ownerId);
	if (long.length > 0) {
		suggestions.push(
			`${long.length} node label(s) have lines over ${LONG_LABEL} characters (${long.slice(0, 4).join(", ")}${long.length > 4 ? ", …" : ""}); shorten them or move detail into a second line.`,
		);
	}
	const connected = new Set(
		diagram.edges.flatMap((edge) => [edge.source.nodeId, edge.target.nodeId]),
	);
	const isolated = diagram.nodes
		.filter((node) => !connected.has(node.id))
		.map((node) => node.id);
	if (diagram.edges.length > 0 && isolated.length > 0) {
		suggestions.push(
			`${isolated.length} node(s) have no connection (${isolated.slice(0, 5).join(", ")}${isolated.length > 5 ? ", …" : ""}); connect or remove them.`,
		);
	}
	return suggestions;
}

function summarise(
	verdict: AgentReport["verdict"],
	metrics: AgentMetrics | undefined,
	errors: number,
	warnings: number,
	page: AgentPage | undefined,
): string {
	const head =
		verdict === "ok"
			? "Ready"
			: verdict === "warn"
				? "Usable with warnings"
				: "Needs fixes";
	const parts = [
		metrics === undefined
			? "no diagram was produced"
			: `${metrics.nodes} nodes, ${metrics.edges} edges, ${metrics.crossings} crossings`,
		`${errors} error(s), ${warnings} warning(s)`,
	];
	if (page !== undefined) {
		parts.push(
			`${page.size} ${page.orientation} at ${Math.round(page.scale * 100)}% (labels ${page.fontPx}px)`,
		);
	}
	return `${head}: ${parts.join("; ")}.`;
}
