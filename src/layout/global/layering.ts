import type { ContainerHierarchy } from "./hierarchy.js";
import { lowestCommonContainer } from "./hierarchy.js";

/**
 * Layer assignment for the global solver (plan P2).
 *
 * 1. Cycle breaking with the Eades–Lin–Smyth greedy feedback arc set:
 *    sinks go to the back, sources to the front, otherwise the node with the
 *    largest (out − in) degree goes to the front. Edges pointing backwards in
 *    that sequence are reversed for layering only.
 * 2. Longest-path layering on the resulting DAG, then sources are pulled
 *    towards their successors so they do not create long edges.
 * 3. Swimlanes whose lanes run along the flow become consecutive layer
 *    blocks (lane k starts after lane k-1 ends).
 * 4. Edges spanning more than one layer get one dummy vertex per inner
 *    layer so the ordering stage can route them between real nodes.
 */
export interface LayeringEdge {
	id: string;
	source: string;
	target: string;
}

export interface LayerVertex {
	id: string;
	/** Real node id, or undefined for a dummy vertex of a long edge. */
	nodeId?: string;
	/** Edge a dummy vertex belongs to. */
	edgeId?: string;
	/** Container used for contiguity during ordering. */
	containerId: string;
	layer: number;
}

export interface LayerSegment {
	edgeId: string;
	/** Upper-layer vertex id. */
	from: string;
	/** Next-layer vertex id. */
	to: string;
}

export interface Layering {
	vertices: Map<string, LayerVertex>;
	/** Vertex ids per layer (unordered; ordering assigns positions). */
	layers: string[][];
	/** Unit-length segments between consecutive layers. */
	segments: LayerSegment[];
	/** Edge ids reversed to break cycles. */
	reversedEdgeIds: Set<string>;
	/** Layer of every real node. */
	layerOfNode: Map<string, number>;
}

export function assignLayers(
	nodeIds: readonly string[],
	edges: readonly LayeringEdge[],
	hierarchy: ContainerHierarchy,
): Layering {
	const nodes = [...nodeIds].sort();
	const nodeSet = new Set(nodes);
	const usable = edges
		.filter(
			(edge) =>
				nodeSet.has(edge.source) &&
				nodeSet.has(edge.target) &&
				edge.source !== edge.target,
		)
		.sort((a, b) => a.id.localeCompare(b.id));

	const sequence = greedyFeedbackArcOrder(nodes, usable);
	const rank = new Map(sequence.map((id, index) => [id, index]));
	const reversedEdgeIds = new Set<string>();
	const dagEdges = usable.map((edge) => {
		const forward = (rank.get(edge.source) ?? 0) < (rank.get(edge.target) ?? 0);
		if (!forward) reversedEdgeIds.add(edge.id);
		return forward
			? { id: edge.id, source: edge.source, target: edge.target }
			: { id: edge.id, source: edge.target, target: edge.source };
	});

	const layerOfNode = hasMainAxisLanes(hierarchy)
		? laneBlockLayers(nodes, dagEdges, hierarchy)
		: longestPathLayers(nodes, dagEdges);

	// Normalise so the first layer is 0.
	const minLayer = Math.min(0, ...layerOfNode.values());
	for (const [id, layer] of layerOfNode) layerOfNode.set(id, layer - minLayer);

	const vertices = new Map<string, LayerVertex>();
	for (const nodeId of nodes) {
		vertices.set(nodeId, {
			id: nodeId,
			nodeId,
			containerId: hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId,
			layer: layerOfNode.get(nodeId) ?? 0,
		});
	}
	const segments: LayerSegment[] = [];
	for (const edge of dagEdges) {
		const from = layerOfNode.get(edge.source) ?? 0;
		const to = layerOfNode.get(edge.target) ?? 0;
		if (from === to) continue; // same-layer edge (lane blocks); routed later
		const [upper, lower, top, bottom] =
			from < to
				? [edge.source, edge.target, from, to]
				: [edge.target, edge.source, to, from];
		const upperContainer =
			hierarchy.containerOfNode.get(upper) ?? hierarchy.rootId;
		const lowerContainer =
			hierarchy.containerOfNode.get(lower) ?? hierarchy.rootId;
		const common = lowestCommonContainer(
			hierarchy,
			upperContainer,
			lowerContainer,
		);
		// An edge between two lanes travels inside its source lane, then
		// inside its target lane (one lane change), instead of floating
		// between lane blocks and crossing every intra-lane flow.
		const upperLane = enclosingLane(hierarchy, upperContainer);
		const lowerLane = enclosingLane(hierarchy, lowerContainer);
		const switchLayer = top + Math.ceil((bottom - top) / 2);
		let previous = upper;
		for (let layer = top + 1; layer < bottom; layer += 1) {
			const id = `__dummy__:${edge.id}:${layer}`;
			const containerId =
				upperLane !== undefined &&
				lowerLane !== undefined &&
				upperLane !== lowerLane
					? layer < switchLayer
						? upperLane
						: lowerLane
					: common;
			vertices.set(id, { id, edgeId: edge.id, containerId, layer });
			segments.push({ edgeId: edge.id, from: previous, to: id });
			previous = id;
		}
		segments.push({ edgeId: edge.id, from: previous, to: lower });
	}

	const layerCount =
		Math.max(-1, ...[...vertices.values()].map((vertex) => vertex.layer)) + 1;
	const layers: string[][] = Array.from({ length: layerCount }, () => []);
	for (const vertex of [...vertices.values()].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		layers[vertex.layer]?.push(vertex.id);
	}
	return { vertices, layers, segments, reversedEdgeIds, layerOfNode };
}

/** Nearest lane container at or above `containerId`, if any. */
function enclosingLane(
	hierarchy: ContainerHierarchy,
	containerId: string,
): string | undefined {
	let cursor: string | undefined = containerId;
	while (cursor !== undefined) {
		const container = hierarchy.containers.get(cursor);
		if (container?.kind === "lane") return cursor;
		cursor = container?.parentId;
	}
	return undefined;
}

/** Eades–Lin–Smyth greedy vertex sequence (deterministic). */
export function greedyFeedbackArcOrder(
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
): string[] {
	const remaining = new Set(nodes);
	const outgoing = new Map<string, Set<string>>();
	const incoming = new Map<string, Set<string>>();
	for (const node of nodes) {
		outgoing.set(node, new Set());
		incoming.set(node, new Set());
	}
	for (const edge of edges) {
		outgoing.get(edge.source)?.add(edge.target);
		incoming.get(edge.target)?.add(edge.source);
	}
	const degree = (map: Map<string, Set<string>>, node: string): number => {
		let count = 0;
		for (const other of map.get(node) ?? [])
			if (remaining.has(other)) count += 1;
		return count;
	};
	const front: string[] = [];
	const back: string[] = [];
	const sorted = [...nodes].sort();
	while (remaining.size > 0) {
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of sorted) {
				if (remaining.has(node) && degree(outgoing, node) === 0) {
					back.unshift(node);
					remaining.delete(node);
					changed = true;
				}
			}
			for (const node of sorted) {
				if (remaining.has(node) && degree(incoming, node) === 0) {
					front.push(node);
					remaining.delete(node);
					changed = true;
				}
			}
		}
		if (remaining.size === 0) break;
		let best: string | undefined;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (const node of sorted) {
			if (!remaining.has(node)) continue;
			const score = degree(outgoing, node) - degree(incoming, node);
			if (score > bestScore) {
				best = node;
				bestScore = score;
			}
		}
		if (best === undefined) break;
		front.push(best);
		remaining.delete(best);
	}
	return [...front, ...back];
}

function longestPathLayers(
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
): Map<string, number> {
	const preds = new Map<string, string[]>(nodes.map((id) => [id, []]));
	const succs = new Map<string, string[]>(nodes.map((id) => [id, []]));
	for (const edge of edges) {
		preds.get(edge.target)?.push(edge.source);
		succs.get(edge.source)?.push(edge.target);
	}
	const order = topologicalOrder(nodes, edges);
	const layer = new Map<string, number>();
	for (const node of order) {
		const incoming = preds.get(node) ?? [];
		layer.set(
			node,
			incoming.length === 0
				? 0
				: Math.max(...incoming.map((pred) => (layer.get(pred) ?? 0) + 1)),
		);
	}
	// Pull sources next to their nearest successor (shorter edges).
	for (const node of [...order].reverse()) {
		if ((preds.get(node) ?? []).length > 0) continue;
		const outgoing = succs.get(node) ?? [];
		if (outgoing.length === 0) continue;
		const nearest = Math.min(...outgoing.map((succ) => layer.get(succ) ?? 0));
		layer.set(node, Math.max(layer.get(node) ?? 0, nearest - 1));
	}
	return layer;
}

function hasMainAxisLanes(hierarchy: ContainerHierarchy): boolean {
	return hierarchy.mainAxisLaneOfNode.size > 0;
}

/**
 * Lanes along the flow: layer each lane on its own intra-lane edges, then
 * stack lane blocks (lane k after lane k-1). Nodes outside those lanes are
 * layered by longest path relative to their placed predecessors.
 */
function laneBlockLayers(
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
	hierarchy: ContainerHierarchy,
): Map<string, number> {
	const layer = new Map<string, number>();
	const bySwimlane = new Map<string, Map<number, string[]>>();
	for (const node of nodes) {
		const lane = hierarchy.mainAxisLaneOfNode.get(node);
		if (lane === undefined) continue;
		const lanes =
			bySwimlane.get(lane.swimlaneId) ?? new Map<number, string[]>();
		const members = lanes.get(lane.laneIndex) ?? [];
		members.push(node);
		lanes.set(lane.laneIndex, members);
		bySwimlane.set(lane.swimlaneId, lanes);
	}
	for (const lanes of [...bySwimlane.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		let offset = 0;
		for (const laneIndex of [...lanes[1].keys()].sort((a, b) => a - b)) {
			const members = lanes[1].get(laneIndex) ?? [];
			const memberSet = new Set(members);
			const local = longestPathLayers(
				members,
				edges.filter(
					(edge) => memberSet.has(edge.source) && memberSet.has(edge.target),
				),
			);
			let maxLocal = 0;
			for (const member of members) {
				const value = local.get(member) ?? 0;
				layer.set(member, offset + value);
				maxLocal = Math.max(maxLocal, value);
			}
			offset += maxLocal + 1;
		}
	}
	// Remaining nodes: longest path over the whole DAG around the fixed lane
	// blocks. A node that only feeds lane nodes (no placed predecessor) is
	// put right before its earliest placed successor — possibly at a negative
	// layer, normalised later — so `x -> a` never collapses onto a's layer.
	const order = topologicalOrder(nodes, edges);
	const preds = new Map<string, string[]>(nodes.map((id) => [id, []]));
	const succs = new Map<string, string[]>(nodes.map((id) => [id, []]));
	for (const edge of edges) {
		preds.get(edge.target)?.push(edge.source);
		succs.get(edge.source)?.push(edge.target);
	}
	const fixed = new Set(layer.keys());
	const upper = new Map<string, number>();
	for (const node of [...order].reverse()) {
		if (fixed.has(node)) continue;
		let bound = Number.POSITIVE_INFINITY;
		for (const succ of succs.get(node) ?? []) {
			const limit = fixed.has(succ)
				? (layer.get(succ) ?? 0)
				: (upper.get(succ) ?? Number.POSITIVE_INFINITY);
			bound = Math.min(bound, limit - 1);
		}
		upper.set(node, bound);
	}
	for (const node of order) {
		if (fixed.has(node)) continue;
		const incoming = preds.get(node) ?? [];
		const bound = upper.get(node) ?? Number.POSITIVE_INFINITY;
		const earliest =
			incoming.length === 0
				? Number.NEGATIVE_INFINITY
				: Math.max(...incoming.map((pred) => (layer.get(pred) ?? 0) + 1));
		layer.set(
			node,
			Number.isFinite(earliest) ? earliest : Number.isFinite(bound) ? bound : 0,
		);
	}
	return layer;
}

function topologicalOrder(
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
): string[] {
	const indegree = new Map<string, number>(nodes.map((id) => [id, 0]));
	const succs = new Map<string, string[]>(nodes.map((id) => [id, []]));
	for (const edge of edges) {
		if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
		indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
		succs.get(edge.source)?.push(edge.target);
	}
	const ready = nodes.filter((id) => (indegree.get(id) ?? 0) === 0).sort();
	const order: string[] = [];
	while (ready.length > 0) {
		const node = ready.shift() as string;
		order.push(node);
		for (const next of (succs.get(node) ?? []).sort()) {
			const remaining = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) {
				ready.push(next);
				ready.sort();
			}
		}
	}
	// Defensive: append anything left (should not happen on a DAG).
	for (const node of nodes) if (!order.includes(node)) order.push(node);
	return order;
}
