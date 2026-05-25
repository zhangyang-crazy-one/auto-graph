import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import { Graph, layout } from "@dagrejs/dagre";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box } from "../ir/geometry.js";
import type {
	DagreLayoutInput,
	DagreLayoutOptions,
	InitialLayoutResult,
} from "./types.js";

const DEFAULT_OPTIONS: DagreLayoutOptions = {
	nodesep: 80,
	ranksep: 100,
	edgesep: 40,
	marginx: 0,
	marginy: 0,
	ranker: "network-simplex",
};

export function runDagreInitialLayout(
	input: DagreLayoutInput,
): InitialLayoutResult {
	const diagnostics: Diagnostic[] = [];
	const boxes = new Map<string, Box>();
	const validNodeIds = new Set<string>();
	const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({
		directed: true,
		multigraph: true,
		compound: false,
	});
	const options = { ...DEFAULT_OPTIONS, ...input.options };

	graph.setGraph({
		rankdir: input.direction,
		nodesep: options.nodesep,
		ranksep: options.ranksep,
		edgesep: options.edgesep,
		marginx: options.marginx,
		marginy: options.marginy,
		ranker: options.ranker,
	});
	graph.setDefaultEdgeLabel(() => ({}));

	for (const node of input.nodes) {
		if (
			!isValidDimension(node.size.width) ||
			!isValidDimension(node.size.height)
		) {
			diagnostics.push({
				severity: "error",
				code: "layout.node-size.invalid",
				message: `Node ${node.id} has invalid layout dimensions.`,
				path: ["nodes", node.id, "size"],
				detail: { nodeId: node.id },
			});
			continue;
		}

		validNodeIds.add(node.id);
		graph.setNode(node.id, {
			width: node.size.width,
			height: node.size.height,
		});
	}

	for (const edge of input.edges) {
		if (!validNodeIds.has(edge.sourceId) || !validNodeIds.has(edge.targetId)) {
			diagnostics.push({
				severity: "error",
				code: "layout.edge-reference.missing",
				message: `Edge ${edge.id} references a missing layout node.`,
				path: ["edges", edge.id],
				detail: {
					edgeId: edge.id,
					sourceId: edge.sourceId,
					targetId: edge.targetId,
				},
			});
			continue;
		}

		graph.setEdge(
			edge.sourceId,
			edge.targetId,
			{ minlen: 1, weight: 1 },
			edge.id,
		);
	}

	layout(graph);

	for (const node of input.nodes) {
		if (!validNodeIds.has(node.id)) {
			continue;
		}

		const label = graph.node(node.id);
		const centerX = label?.x;
		const centerY = label?.y;
		if (
			typeof centerX !== "number" ||
			typeof centerY !== "number" ||
			!Number.isFinite(centerX) ||
			!Number.isFinite(centerY)
		) {
			diagnostics.push({
				severity: "error",
				code: "layout.node-position.invalid",
				message: `Dagre returned an invalid position for node ${node.id}.`,
				path: ["nodes", node.id],
				detail: { nodeId: node.id },
			});
			continue;
		}

		boxes.set(node.id, {
			x: centerX - node.size.width / 2,
			y: centerY - node.size.height / 2,
			width: node.size.width,
			height: node.size.height,
		});
	}

	return { boxes, diagnostics };
}

function isValidDimension(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}
