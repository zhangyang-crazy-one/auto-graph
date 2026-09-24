import type { ContainerHierarchy } from "./hierarchy.js";
import { lowestCommonContainer } from "./hierarchy.js";

/**
 * Layer assignment for the global solver (plan P2).
 *
 * 1. Cycle breaking: a depth-first search in declaration order reverses
 *    the edges that close a cycle (the edges an author writes last, such
 *    as "retry" or "reject" loops), for layering only. The Eades–Lin–Smyth
 *    greedy sequence is kept as `greedyFeedbackArcOrder` for callers that
 *    want the smallest feedback set instead of the declared reading order.
 * 2. Longest-path layering on the resulting DAG, then sources are pulled
 *    towards their successors so they do not create long edges.
 *    In swimlanes whose lanes run across the flow, a hand-off between two
 *    lanes does not advance the layer: it is drawn straight across the
 *    lanes, so a flow that zig-zags between lanes stays compact.
 * 3. Swimlanes whose lanes run along the flow become consecutive layer
 *    blocks (lane k starts after lane k-1 ends). Otherwise sibling groups
 *    (and top-level nodes) linked by edges in one direction only are laid
 *    out as tiers: the whole target group starts after the source group
 *    ends, so e.g. services → data reads left to right instead of stacking.
 * 4. Edges spanning more than one layer get one dummy vertex per inner
 *    layer so the ordering stage can route them between real nodes.
 * 5. Every container gets a filler vertex in each layer of its span that
 *    has no member, so ordering and coordinates keep its rectangle closed
 *    (no foreign node can sit in a hole of a group or lane band).
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
	/** Placeholder that keeps a container present in a layer. */
	filler?: true;
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
	const declared = edges.filter(
		(edge) =>
			nodeSet.has(edge.source) &&
			nodeSet.has(edge.target) &&
			edge.source !== edge.target,
	);
	const usable = [...declared].sort((a, b) => a.id.localeCompare(b.id));

	const reversedEdgeIds = depthFirstBackEdges(
		nodeIds.filter((id) => nodeSet.has(id)),
		declared,
	);
	const dagEdges = usable.map((edge) =>
		reversedEdgeIds.has(edge.id)
			? { id: edge.id, source: edge.target, target: edge.source }
			: { id: edge.id, source: edge.source, target: edge.target },
	);

	const layerOfNode = hasMainAxisLanes(hierarchy)
		? laneBlockLayers(nodes, dagEdges, hierarchy)
		: hasCrossAxisLanes(hierarchy)
			? crossLaneLayers(nodes, dagEdges, hierarchy, reversedEdgeIds)
			: longestPathLayers(nodes, dagEdges);
	if (!hasMainAxisLanes(hierarchy)) {
		enforceContainerPrecedence(layerOfNode, nodes, dagEdges, hierarchy);
	}

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
	const spans = containerSpans(layerOfNode, hierarchy);
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
		// A long edge travels inside the containers it starts in for as long
		// as they span the layer, then inside the containers it ends in: the
		// first half prefers the upper end's containers, the second half the
		// lower end's. Between two lanes that is one lane change; out of a
		// group it keeps the edge inside the group until the group ends,
		// instead of forcing it around the group's rectangle.
		const upperChain = containerChain(hierarchy, upperContainer);
		const lowerChain = containerChain(hierarchy, lowerContainer);
		const covering = (chain: readonly string[], layer: number) =>
			chain.find((id) => {
				const span = spans.get(id);
				return span !== undefined && span.min <= layer && layer <= span.max;
			});
		const switchLayer = top + Math.ceil((bottom - top) / 2);
		let previous = upper;
		for (let layer = top + 1; layer < bottom; layer += 1) {
			const id = syntheticVertexId(vertices, `dummy:${edge.id}:${layer}`);
			const fromUpper = covering(upperChain, layer);
			const fromLower = covering(lowerChain, layer);
			const containerId =
				(layer < switchLayer
					? (fromUpper ?? fromLower)
					: (fromLower ?? fromUpper)) ?? common;
			vertices.set(id, { id, edgeId: edge.id, containerId, layer });
			segments.push({ edgeId: edge.id, from: previous, to: id });
			previous = id;
		}
		segments.push({ edgeId: edge.id, from: previous, to: lower });
	}

	addContainerFillers(vertices, layerOfNode, hierarchy);

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

/**
 * Id for a dummy or filler vertex. Node ids are arbitrary strings, so the
 * id lives in a NUL-prefixed namespace and, should it still be taken
 * (real vertices are inserted first), gets a deterministic `#n` suffix: a
 * synthetic vertex can never overwrite a real node.
 */
function syntheticVertexId(
	vertices: ReadonlyMap<string, LayerVertex>,
	base: string,
): string {
	let id = `\u0000${base}`;
	for (let suffix = 1; vertices.has(id); suffix += 1) {
		id = `\u0000${base}#${suffix}`;
	}
	return id;
}

/** Containers from `containerId` up to (excluding) the root, deepest first. */
function containerChain(
	hierarchy: ContainerHierarchy,
	containerId: string,
): string[] {
	const chain: string[] = [];
	let cursor: string | undefined = containerId;
	while (cursor !== undefined && cursor !== hierarchy.rootId) {
		chain.push(cursor);
		cursor = hierarchy.containers.get(cursor)?.parentId;
	}
	return chain;
}

/**
 * Layer span of every container over its real members. A lane spans its
 * whole swimlane, so lanes stay closed bands.
 */
function containerSpans(
	layerOfNode: ReadonlyMap<string, number>,
	hierarchy: ContainerHierarchy,
): Map<string, { min: number; max: number }> {
	const spans = new Map<string, { min: number; max: number }>();
	for (const [nodeId, layer] of layerOfNode) {
		const deepest = hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId;
		for (const id of containerChain(hierarchy, deepest)) {
			const current = spans.get(id);
			spans.set(id, {
				min: Math.min(current?.min ?? layer, layer),
				max: Math.max(current?.max ?? layer, layer),
			});
		}
	}
	for (const container of hierarchy.containers.values()) {
		if (container.kind !== "lane" || container.parentId === undefined) continue;
		const swimlane = spans.get(container.parentId);
		if (swimlane !== undefined) spans.set(container.id, { ...swimlane });
	}
	return spans;
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

/**
 * Edges closing a cycle in a depth-first search that visits nodes and
 * out-edges in declaration order (iterative, so deep chains are safe).
 */
export function depthFirstBackEdges(
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
): Set<string> {
	const outgoing = new Map<string, LayeringEdge[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.source) ?? [];
		list.push(edge);
		outgoing.set(edge.source, list);
	}
	const state = new Map<string, "active" | "done">();
	const back = new Set<string>();
	for (const root of nodes) {
		if (state.has(root)) continue;
		state.set(root, "active");
		const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1] as { node: string; next: number };
			const out = outgoing.get(frame.node) ?? [];
			const edge = out[frame.next];
			if (edge === undefined) {
				state.set(frame.node, "done");
				stack.pop();
				continue;
			}
			frame.next += 1;
			const seen = state.get(edge.target);
			if (seen === "active") {
				back.add(edge.id);
			} else if (seen === undefined) {
				state.set(edge.target, "active");
				stack.push({ node: edge.target, next: 0 });
			}
		}
	}
	return back;
}

/**
 * Give every container a filler vertex in each layer of its span where
 * none of its (transitive) members sits. Lanes of one swimlane all span the
 * swimlane's layers, so every lane stays a closed band.
 */
function addContainerFillers(
	vertices: Map<string, LayerVertex>,
	layerOfNode: ReadonlyMap<string, number>,
	hierarchy: ContainerHierarchy,
): void {
	const ancestors = (id: string): string[] => {
		const chain: string[] = [];
		let cursor: string | undefined = id;
		while (cursor !== undefined && cursor !== hierarchy.rootId) {
			chain.push(cursor);
			cursor = hierarchy.containers.get(cursor)?.parentId;
		}
		return chain;
	};
	const span = new Map<string, { min: number; max: number }>();
	for (const [nodeId, layer] of layerOfNode) {
		const deepest = hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId;
		for (const id of ancestors(deepest)) {
			const current = span.get(id);
			span.set(id, {
				min: Math.min(current?.min ?? layer, layer),
				max: Math.max(current?.max ?? layer, layer),
			});
		}
	}
	const occupied = new Map<string, Set<number>>();
	const occupy = (containerId: string, layer: number) => {
		for (const id of ancestors(containerId)) {
			const layers = occupied.get(id) ?? new Set<number>();
			layers.add(layer);
			occupied.set(id, layers);
		}
	};
	for (const vertex of vertices.values())
		occupy(vertex.containerId, vertex.layer);

	const containers = [...hierarchy.containers.values()]
		.filter(
			(container) => container.kind === "group" || container.kind === "lane",
		)
		.sort((a, b) => a.id.localeCompare(b.id));
	for (const container of containers) {
		const range =
			container.kind === "lane" && container.parentId !== undefined
				? span.get(container.parentId)
				: span.get(container.id);
		if (range === undefined) continue;
		for (let layer = range.min; layer <= range.max; layer += 1) {
			if (occupied.get(container.id)?.has(layer)) continue;
			const id = syntheticVertexId(vertices, `fill:${container.id}:${layer}`);
			vertices.set(id, { id, containerId: container.id, layer, filler: true });
			occupy(container.id, layer);
		}
	}
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

/**
 * Tier constraint between sibling units (groups, or single nodes next to
 * groups): for every unit edge A → B outside a cycle of the unit graph,
 * every node of B gets a layer after every node of A. Units that reach each
 * other both ways keep plain node layering. Raises layers monotonically, so
 * the loop ends; the cap only guards against malformed input.
 */
function enforceContainerPrecedence(
	layer: Map<string, number>,
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
	hierarchy: ContainerHierarchy,
): void {
	const pathOf = (nodeId: string): string[] => {
		const chain: string[] = [];
		let cursor: string | undefined =
			hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId;
		while (cursor !== undefined) {
			chain.unshift(cursor);
			cursor = hierarchy.containers.get(cursor)?.parentId;
		}
		return chain;
	};
	const unitMembers = new Map<string, string[]>();
	const unitEdges = new Map<string, Set<string>>();
	const addMember = (unit: string, nodeId: string) => {
		const list = unitMembers.get(unit) ?? [];
		if (!list.includes(nodeId)) list.push(nodeId);
		unitMembers.set(unit, list);
	};
	for (const edge of edges) {
		const pu = pathOf(edge.source);
		const pv = pathOf(edge.target);
		let depth = 0;
		while (depth < pu.length && depth < pv.length && pu[depth] === pv[depth]) {
			depth += 1;
		}
		const a = pu[depth] ?? `node:${edge.source}`;
		const b = pv[depth] ?? `node:${edge.target}`;
		const kindA = hierarchy.containers.get(a)?.kind;
		const kindB = hierarchy.containers.get(b)?.kind;
		// Only groups form tiers; lanes and swimlanes share layers by design.
		if (kindA !== undefined && kindA !== "group") continue;
		if (kindB !== undefined && kindB !== "group") continue;
		if (kindA === undefined && kindB === undefined) continue;
		const targets = unitEdges.get(a) ?? new Set<string>();
		targets.add(b);
		unitEdges.set(a, targets);
	}
	if (unitEdges.size === 0) return;
	for (const nodeId of nodes) {
		for (const unit of pathOf(nodeId)) addMember(unit, nodeId);
		addMember(`node:${nodeId}`, nodeId);
	}
	const component = stronglyConnectedComponents(unitEdges);
	const tiers: [string, string][] = [];
	for (const [a, targets] of [...unitEdges].sort((x, y) =>
		x[0].localeCompare(y[0]),
	)) {
		for (const b of [...targets].sort()) {
			if (component.get(a) !== component.get(b)) tiers.push([a, b]);
		}
	}
	if (tiers.length === 0) return;

	const order = topologicalOrder(nodes, edges);
	const preds = new Map<string, string[]>(nodes.map((id) => [id, []]));
	for (const edge of edges) preds.get(edge.target)?.push(edge.source);
	const limit = nodes.length * (tiers.length + 1) + 1;
	for (let round = 0; round < limit; round += 1) {
		let changed = false;
		for (const [a, b] of tiers) {
			const before = unitMembers.get(a) ?? [];
			const after = unitMembers.get(b) ?? [];
			if (before.length === 0 || after.length === 0) continue;
			// Raise each late member to the tier bound individually (not the
			// whole block), so a tier fed from one side collapses into one
			// column instead of keeping its longest-path staircase.
			const bound = Math.max(...before.map((id) => layer.get(id) ?? 0)) + 1;
			for (const id of after) {
				if ((layer.get(id) ?? 0) < bound) {
					layer.set(id, bound);
					changed = true;
				}
			}
		}
		for (const node of order) {
			const incoming = preds.get(node) ?? [];
			if (incoming.length === 0) continue;
			const least = Math.max(...incoming.map((id) => (layer.get(id) ?? 0) + 1));
			if ((layer.get(node) ?? 0) < least) {
				layer.set(node, least);
				changed = true;
			}
		}
		if (!changed) return;
	}
}

/** Tarjan's strongly connected components (iterative, deterministic). */
function stronglyConnectedComponents(
	graph: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
	const vertices = new Set<string>();
	for (const [from, targets] of graph) {
		vertices.add(from);
		for (const to of targets) vertices.add(to);
	}
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const component = new Map<string, number>();
	let counter = 0;
	let components = 0;
	for (const root of [...vertices].sort()) {
		if (index.has(root)) continue;
		const work: { v: string; targets: string[]; next: number }[] = [];
		const open = (v: string) => {
			index.set(v, counter);
			low.set(v, counter);
			counter += 1;
			stack.push(v);
			onStack.add(v);
			work.push({ v, targets: [...(graph.get(v) ?? [])].sort(), next: 0 });
		};
		open(root);
		while (work.length > 0) {
			const frame = work[work.length - 1] as {
				v: string;
				targets: string[];
				next: number;
			};
			const w = frame.targets[frame.next];
			if (w !== undefined) {
				frame.next += 1;
				if (!index.has(w)) {
					open(w);
				} else if (onStack.has(w)) {
					low.set(frame.v, Math.min(low.get(frame.v) ?? 0, index.get(w) ?? 0));
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent !== undefined) {
				low.set(
					parent.v,
					Math.min(low.get(parent.v) ?? 0, low.get(frame.v) ?? 0),
				);
			}
			if (low.get(frame.v) === index.get(frame.v)) {
				for (;;) {
					const member = stack.pop() as string;
					onStack.delete(member);
					component.set(member, components);
					if (member === frame.v) break;
				}
				components += 1;
			}
		}
	}
	return component;
}

function hasCrossAxisLanes(hierarchy: ContainerHierarchy): boolean {
	for (const container of hierarchy.containers.values()) {
		if (container.kind === "lane") return true;
	}
	return false;
}

interface LanePosition {
	lane: string;
	swimlane: string;
	index: number;
}

/**
 * Layering for swimlanes whose lanes run across the flow.
 *
 * Only edges inside one lane (and edges reversed to break cycles, and
 * edges leaving the swimlane) must advance a layer. A forward hand-off
 * between two lanes of the same swimlane may stay on its source's layer and
 * be drawn straight across the lanes, like a BPMN hand-off. Three guards
 * keep that readable; a node moves one layer later while any holds:
 *
 * - it would share a layer with one of its own ancestors in its lane
 *   (the lane would stack a later step on top of an earlier one);
 * - it sits in a lane crossed by an earlier straight hand-off on that layer;
 * - its own straight hand-off would cross a node in a lane in between.
 */
function crossLaneLayers(
	nodes: readonly string[],
	edges: readonly LayeringEdge[],
	hierarchy: ContainerHierarchy,
	reversedEdgeIds: ReadonlySet<string>,
): Map<string, number> {
	const laneCache = new Map<string, LanePosition | undefined>();
	const laneOf = (nodeId: string): LanePosition | undefined => {
		if (laneCache.has(nodeId)) return laneCache.get(nodeId);
		const lane = enclosingLane(
			hierarchy,
			hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId,
		);
		const container =
			lane === undefined ? undefined : hierarchy.containers.get(lane);
		const position =
			lane === undefined || container?.parentId === undefined
				? undefined
				: {
						lane,
						swimlane: container.parentId,
						index: container.fixedOrder ?? 0,
					};
		laneCache.set(nodeId, position);
		return position;
	};
	const handOff = (edge: LayeringEdge): boolean => {
		if (reversedEdgeIds.has(edge.id)) return false;
		const from = laneOf(edge.source);
		const to = laneOf(edge.target);
		return (
			from !== undefined &&
			to !== undefined &&
			from.swimlane === to.swimlane &&
			from.lane !== to.lane
		);
	};
	const preds = new Map<string, { node: string; handOff: boolean }[]>(
		nodes.map((id) => [id, []]),
	);
	for (const edge of edges) {
		preds.get(edge.target)?.push({ node: edge.source, handOff: handOff(edge) });
	}
	const order = topologicalOrder(nodes, edges);
	const ancestors = new Map<string, Set<string>>();
	for (const node of order) {
		const set = new Set<string>();
		for (const pred of preds.get(node) ?? []) {
			set.add(pred.node);
			for (const id of ancestors.get(pred.node) ?? []) set.add(id);
		}
		ancestors.set(node, set);
	}

	const layer = new Map<string, number>();
	const occupants = new Map<number, string[]>();
	const spans = new Map<
		number,
		{ swimlane: string; lo: number; hi: number }[]
	>();
	const between = (
		position: LanePosition | undefined,
		swimlane: string,
		lo: number,
		hi: number,
	) =>
		position !== undefined &&
		position.swimlane === swimlane &&
		position.index > lo &&
		position.index < hi;
	const blocked = (node: string, at: number): boolean => {
		const own = laneOf(node);
		const here = occupants.get(at) ?? [];
		if (own !== undefined) {
			const ancestry = ancestors.get(node) ?? new Set<string>();
			if (
				here.some(
					(other) => laneOf(other)?.lane === own.lane && ancestry.has(other),
				)
			) {
				return true;
			}
			if (
				(spans.get(at) ?? []).some((span) =>
					between(own, span.swimlane, span.lo, span.hi),
				)
			) {
				return true;
			}
		}
		for (const pred of preds.get(node) ?? []) {
			if (!pred.handOff || layer.get(pred.node) !== at) continue;
			const from = laneOf(pred.node);
			if (from === undefined || own === undefined) continue;
			const lo = Math.min(from.index, own.index);
			const hi = Math.max(from.index, own.index);
			if (here.some((other) => between(laneOf(other), from.swimlane, lo, hi))) {
				return true;
			}
		}
		return false;
	};

	for (const node of order) {
		let at = 0;
		for (const pred of preds.get(node) ?? []) {
			at = Math.max(at, (layer.get(pred.node) ?? 0) + (pred.handOff ? 0 : 1));
		}
		while (blocked(node, at)) at += 1;
		layer.set(node, at);
		const here = occupants.get(at) ?? [];
		here.push(node);
		occupants.set(at, here);
		const own = laneOf(node);
		for (const pred of preds.get(node) ?? []) {
			const from = laneOf(pred.node);
			if (
				!pred.handOff ||
				layer.get(pred.node) !== at ||
				from === undefined ||
				own === undefined
			) {
				continue;
			}
			const list = spans.get(at) ?? [];
			list.push({
				swimlane: from.swimlane,
				lo: Math.min(from.index, own.index),
				hi: Math.max(from.index, own.index),
			});
			spans.set(at, list);
		}
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
		const laneCount = Math.max(
			hierarchy.mainAxisLaneCount.get(lanes[0]) ?? 0,
			...[...lanes[1].keys()].map((index) => index + 1),
		);
		for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
			const members = lanes[1].get(laneIndex) ?? [];
			if (members.length === 0) {
				// Reserve one empty layer so an empty lane keeps its slot.
				offset += 1;
				continue;
			}
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
	const placeFree = () => {
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
				Number.isFinite(earliest)
					? earliest
					: Number.isFinite(bound)
						? bound
						: 0,
			);
		}
	};
	// A free node squeezed between two lane layers (`a -> x -> b` with b on
	// the layer right after a) cannot fit: make room by moving b's layer and
	// every later fixed layer back, then place the free nodes again. Each
	// round only moves layers later, and the graph is acyclic, so it ends.
	for (let round = 0; round <= nodes.length; round += 1) {
		placeFree();
		let conflict: { node: string; at: number; shift: number } | undefined;
		for (const node of order) {
			if (fixed.has(node)) continue;
			const at = layer.get(node) ?? 0;
			for (const succ of succs.get(node) ?? []) {
				if (!fixed.has(succ)) continue;
				const target = layer.get(succ) ?? 0;
				if (target <= at && (conflict === undefined || target < conflict.at)) {
					conflict = { node, at: target, shift: at + 1 - target };
				}
			}
		}
		if (conflict === undefined) break;
		const { at, shift } = conflict;
		// Move the blocked suffix only: fixed nodes on or after the blocked
		// layer that are not upstream of the squeezed node. Its fixed
		// ancestors (e.g. `a` in `a -> x -> b` with a and b co-layered) stay,
		// so the gap actually opens.
		const upstream = new Set<string>();
		const stack = [...(preds.get(conflict.node) ?? [])];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (upstream.has(id)) continue;
			upstream.add(id);
			stack.push(...(preds.get(id) ?? []));
		}
		for (const node of fixed) {
			const value = layer.get(node) ?? 0;
			if (value >= at && !upstream.has(node)) layer.set(node, value + shift);
		}
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
