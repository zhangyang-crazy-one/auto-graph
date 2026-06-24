import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import { Graph, layout } from "@dagrejs/dagre";
import { unionBoxes } from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box } from "../ir/geometry.js";
import type {
	DagreLayoutEdge,
	DagreLayoutInput,
	DagreLayoutNode,
	DagreLayoutOptions,
	InitialLayoutResult,
} from "./types.js";

const DEFAULT_OPTIONS: DagreLayoutOptions = {
	nodesep: 80,
	ranksep: 100,
	edgesep: 40,
	marginx: 0,
	marginy: 0,
	componentGap: 160,
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

export function runComponentAwareDagreInitialLayout(
	input: DagreLayoutInput,
): InitialLayoutResult {
	const options = { ...DEFAULT_OPTIONS, ...input.options };
	const diagnostics = reportMissingEdgeReferences(input);
	const validNodeIds = new Set(input.nodes.map((node) => node.id));
	const validEdges = input.edges.filter(
		(edge) =>
			validNodeIds.has(edge.sourceId) && validNodeIds.has(edge.targetId),
	);
	const components = connectedComponents(input.nodes, validEdges);
	if (components.length <= 1) {
		const layout = runDagreInitialLayout({ ...input, edges: validEdges });
		return {
			boxes: layout.boxes,
			diagnostics: [...diagnostics, ...layout.diagnostics],
		};
	}

	const boxes = new Map<string, Box>();
	let cursor = 0;
	for (const component of components) {
		const componentNodeIds = new Set(component.map((node) => node.id));
		const componentLayout = runDagreInitialLayout({
			...input,
			nodes: component,
			edges: validEdges.filter(
				(edge) =>
					componentNodeIds.has(edge.sourceId) &&
					componentNodeIds.has(edge.targetId),
			),
		});
		diagnostics.push(...componentLayout.diagnostics);
		if (componentLayout.boxes.size === 0) {
			continue;
		}

		const bounds = unionBoxes([...componentLayout.boxes.values()]);
		const axis =
			input.direction === "LR" || input.direction === "RL" ? "x" : "y";
		const dx = axis === "x" ? cursor - bounds.x : -bounds.x;
		const dy = axis === "y" ? cursor - bounds.y : -bounds.y;
		for (const [id, box] of componentLayout.boxes) {
			boxes.set(id, { ...box, x: box.x + dx, y: box.y + dy });
		}
		cursor +=
			(axis === "x" ? bounds.width : bounds.height) + options.componentGap;
	}

	return { boxes, diagnostics };
}

function reportMissingEdgeReferences(input: DagreLayoutInput): Diagnostic[] {
	const validNodeIds = new Set(input.nodes.map((node) => node.id));
	return input.edges.flatMap((edge) => {
		if (validNodeIds.has(edge.sourceId) && validNodeIds.has(edge.targetId)) {
			return [];
		}
		return [
			{
				severity: "error" as const,
				code: "layout.edge-reference.missing",
				message: `Edge ${edge.id} references a missing layout node.`,
				path: ["edges", edge.id],
				detail: {
					edgeId: edge.id,
					sourceId: edge.sourceId,
					targetId: edge.targetId,
				},
			},
		];
	});
}

function isValidDimension(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function connectedComponents(
	nodes: readonly DagreLayoutNode[],
	edges: readonly DagreLayoutEdge[],
): DagreLayoutNode[][] {
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
	for (const edge of edges) {
		if (!nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId)) {
			continue;
		}
		adjacency.get(edge.sourceId)?.add(edge.targetId);
		adjacency.get(edge.targetId)?.add(edge.sourceId);
	}

	const visited = new Set<string>();
	const components: DagreLayoutNode[][] = [];
	for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
		if (visited.has(node.id)) {
			continue;
		}
		const ids: string[] = [];
		const stack = [node.id];
		visited.add(node.id);
		while (stack.length > 0) {
			const id = stack.pop();
			if (id === undefined) {
				continue;
			}
			ids.push(id);
			for (const neighbor of [...(adjacency.get(id) ?? [])].sort().reverse()) {
				if (!visited.has(neighbor)) {
					visited.add(neighbor);
					stack.push(neighbor);
				}
			}
		}
		components.push(
			ids.sort().flatMap((id) => {
				const componentNode = nodeById.get(id);
				return componentNode === undefined ? [] : [componentNode];
			}),
		);
	}

	return components.sort((a, b) => {
		const left = a[0]?.id ?? "";
		const right = b[0]?.id ?? "";
		return left.localeCompare(right);
	});
}
