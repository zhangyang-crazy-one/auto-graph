import type {
	DeliverabilityMode,
	NormalizedDiagram,
	PagePolicy,
	PagePolicyOption,
	RemediationPolicy,
	RoutingRailAllocation,
} from "../ir/diagram.js";
import type { NormalizedEdge, NormalizedNode } from "../ir/elements.js";
import type { Box } from "../ir/geometry.js";

/** Minimal options surface needed for page-policy resolution. */
export type PagePolicySolveOptions = {
	pagePolicy?: PagePolicyOption;
	strict?: boolean;
	deliverabilityMode?: DeliverabilityMode;
	remediationPolicy?: RemediationPolicy;
};

export const PAGE_POLICY_SAME_RANK_DEPENDENCY_MIN = 6;
const PAGE_POLICY_SAME_SIDE_FAN_IN_MIN = 4;
const PAGE_POLICY_LABELED_FLOW_MIN = 4;

export function resolvePagePolicy(
	diagram: NormalizedDiagram,
	options: PagePolicySolveOptions = {},
): PagePolicy {
	const explicit = options.pagePolicy ?? metadataPagePolicy(diagram.metadata);
	if (
		explicit === "off" ||
		explicit === "dependency" ||
		explicit === "resource-flow" ||
		explicit === "lane-behavior" ||
		explicit === "ibd-high-fan-in"
	) {
		return explicit;
	}
	if (explicit !== "auto" && explicit !== undefined) {
		return "off";
	}
	if (explicit === undefined && !shouldAutoClassifyPagePolicy(options)) {
		return "off";
	}
	return classifyPagePolicy(diagram);
}

export function metadataPagePolicy(
	metadata: NormalizedDiagram["metadata"],
): PagePolicyOption | undefined {
	const value = metadata?.pagePolicy;
	if (
		value === "off" ||
		value === "auto" ||
		value === "dependency" ||
		value === "resource-flow" ||
		value === "lane-behavior" ||
		value === "ibd-high-fan-in"
	) {
		return value;
	}
	return undefined;
}

function remediationPolicyHasAuto(
	policy: RemediationPolicy | undefined,
): boolean {
	if (policy === undefined) {
		return false;
	}
	return (
		policy.externalLabels === "auto" ||
		policy.routeRails === "auto" ||
		policy.growFixedGeometry === "auto"
	);
}

/**
 * Auto page-policy classification is a mutating routing side effect.
 * Trigger only for explicit `pagePolicy: "auto"`, strict deliverability, or
 * auto-applying remediation — not advisory `degraded-ok` / suggest-only policies.
 */
export function shouldAutoClassifyPagePolicy(
	options: PagePolicySolveOptions,
): boolean {
	return (
		options.pagePolicy === "auto" ||
		isStrictDeliverability(options) ||
		remediationPolicyHasAuto(options.remediationPolicy)
	);
}

function classifyPagePolicy(diagram: NormalizedDiagram): PagePolicy {
	const nodeById = new Map(diagram.nodes.map((node) => [node.id, node]));
	const boxes = new Map(
		diagram.nodes.map((node) => [node.id, nodeBoxFromNormalized(node)]),
	);
	return classifyPagePolicyFromBoxes(diagram, boxes, nodeById);
}

export function classifyPagePolicyFromBoxes(
	diagram: NormalizedDiagram,
	boxes: ReadonlyMap<string, Box>,
	nodeById: ReadonlyMap<string, NormalizedNode> = new Map(
		diagram.nodes.map((node) => [node.id, node]),
	),
): PagePolicy {
	const swimlanes = diagram.swimlanes ?? [];
	if (swimlanes.length > 0) {
		return "lane-behavior";
	}
	const direction = diagram.direction;
	const edges = [...diagram.edges].sort((a, b) => a.id.localeCompare(b.id));
	const sameSideFanIn = maxSameSideFanInFromBoxes(
		edges,
		boxes,
		nodeById,
		direction,
	);
	if (sameSideFanIn >= PAGE_POLICY_SAME_SIDE_FAN_IN_MIN) {
		return "ibd-high-fan-in";
	}
	const labeledFlowCount = countLabeledNonSameRankEdgesFromBoxes(
		edges,
		boxes,
		direction,
	);
	if (labeledFlowCount >= PAGE_POLICY_LABELED_FLOW_MIN) {
		return "resource-flow";
	}
	const sameRankCount = countSameRankEdgesFromBoxes(edges, boxes, direction);
	if (sameRankCount >= PAGE_POLICY_SAME_RANK_DEPENDENCY_MIN) {
		return "dependency";
	}
	return "off";
}

function countSameRankEdgesFromBoxes(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, Box>,
	direction: NormalizedDiagram["direction"],
): number {
	let count = 0;
	for (const edge of edges) {
		const source = boxes.get(edge.source.nodeId);
		const target = boxes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) continue;
		if (isSameRankByNodeBoxes(source, target, direction)) {
			count += 1;
		}
	}
	return count;
}

function countLabeledNonSameRankEdgesFromBoxes(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, Box>,
	direction: NormalizedDiagram["direction"],
): number {
	let count = 0;
	for (const edge of edges) {
		const labelText = edge.label?.text?.trim() ?? "";
		if (labelText.length === 0) continue;
		const source = boxes.get(edge.source.nodeId);
		const target = boxes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) continue;
		if (isSameRankByNodeBoxes(source, target, direction)) {
			continue;
		}
		count += 1;
	}
	return count;
}

function maxSameSideFanInFromBoxes(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, Box>,
	nodeById: ReadonlyMap<string, NormalizedNode>,
	direction: NormalizedDiagram["direction"],
): number {
	const counts = new Map<string, number>();
	for (const edge of edges) {
		if (
			!nodeById.has(edge.target.nodeId) ||
			!nodeById.has(edge.source.nodeId)
		) {
			continue;
		}
		const target = boxes.get(edge.target.nodeId);
		const source = boxes.get(edge.source.nodeId);
		if (target === undefined || source === undefined) continue;
		const side = inferredEndpointSide(source, target, direction, "target");
		const key = `${edge.target.nodeId}:${side}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let max = 0;
	for (const value of counts.values()) {
		if (value > max) max = value;
	}
	return max;
}

function nodeBoxFromNormalized(node: NormalizedNode): Box {
	const position = node.position ?? { x: 0, y: 0 };
	return {
		x: position.x,
		y: position.y,
		width: node.size.width,
		height: node.size.height,
	};
}

function isSameRankByNodeBoxes(
	source: Box,
	target: Box,
	direction: NormalizedDiagram["direction"],
): boolean {
	const sourceCenter = {
		x: source.x + source.width / 2,
		y: source.y + source.height / 2,
	};
	const targetCenter = {
		x: target.x + target.width / 2,
		y: target.y + target.height / 2,
	};
	const dx = Math.abs(targetCenter.x - sourceCenter.x);
	const dy = Math.abs(targetCenter.y - sourceCenter.y);
	const maxHeight = Math.max(source.height, target.height);
	const maxWidth = Math.max(source.width, target.width);
	return direction === "LR" || direction === "RL"
		? dx >= maxWidth && dy <= maxHeight * 1.5
		: dy >= maxHeight && dx <= maxWidth * 1.5;
}

function inferredEndpointSide(
	_source: Box,
	_target: Box,
	direction: NormalizedDiagram["direction"],
	endpoint: "source" | "target",
): RoutingRailAllocation["side"] {
	if (direction === "LR" || direction === "RL") {
		if (endpoint === "source") {
			return direction === "RL" ? "left" : "right";
		}
		return direction === "RL" ? "right" : "left";
	}
	if (endpoint === "source") {
		return direction === "BT" ? "top" : "bottom";
	}
	return direction === "BT" ? "bottom" : "top";
}

export function isStrictDeliverability(
	options: PagePolicySolveOptions,
): boolean {
	return options.strict === true || options.deliverabilityMode === "strict";
}
