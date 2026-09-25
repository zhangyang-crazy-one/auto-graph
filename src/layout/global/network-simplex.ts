/**
 * Layer assignment minimising total edge length: the network simplex of
 * Gansner, Koutsofios, North and Vo ("A technique for drawing directed
 * graphs", 1993), as used by Graphviz dot and Dagre.
 *
 * Minimises Σ (layer(target) − layer(source)) over the edges of a DAG
 * subject to layer(target) − layer(source) ≥ 1. Longest-path layering
 * puts every node as early as its predecessors allow, which leaves the
 * edges into late nodes long; every extra layer an edge spans is a dummy
 * vertex, i.e. another place to cross and to bend. Fewer, shorter edges
 * make the drawing smaller and straighter.
 *
 * Deterministic: nodes and edges are visited in the given order, ties go
 * to the first candidate. Each connected component is solved on its own.
 */
export function networkSimplexLayers(
	nodes: readonly string[],
	edges: readonly { source: string; target: string }[],
	initial: ReadonlyMap<string, number>,
): Map<string, number> {
	const index = new Map(nodes.map((id, i) => [id, i]));
	// Merge parallel edges (weights add); drop self loops.
	const merged = new Map<string, { v: number; w: number; weight: number }>();
	for (const edge of edges) {
		const v = index.get(edge.source);
		const w = index.get(edge.target);
		if (v === undefined || w === undefined || v === w) continue;
		const key = `${v}>${w}`;
		const existing = merged.get(key);
		if (existing === undefined) merged.set(key, { v, w, weight: 1 });
		else existing.weight += 1;
	}
	const all = [...merged.values()];
	const rank = nodes.map((id) => initial.get(id) ?? 0);
	for (const component of components(nodes.length, all)) {
		solveComponent(component, all, rank);
	}
	return new Map(nodes.map((id, i) => [id, rank[i] as number]));
}

interface Edge {
	v: number;
	w: number;
	weight: number;
}

/** Weakly connected components (vertex lists in index order). */
function components(size: number, edges: readonly Edge[]): number[][] {
	const parent = Array.from({ length: size }, (_, i) => i);
	const find = (a: number): number => {
		let root = a;
		while (parent[root] !== root) root = parent[root] as number;
		while (parent[a] !== root) {
			const next = parent[a] as number;
			parent[a] = root;
			a = next;
		}
		return root;
	};
	for (const { v, w } of edges) {
		const a = find(v);
		const b = find(w);
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
	}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < size; i += 1) {
		const root = find(i);
		const list = groups.get(root) ?? [];
		list.push(i);
		groups.set(root, list);
	}
	return [...groups.values()];
}

function solveComponent(
	vertices: readonly number[],
	allEdges: readonly Edge[],
	rank: number[],
): void {
	if (vertices.length < 2) return;
	const inComponent = new Set(vertices);
	const edges = allEdges.filter((edge) => inComponent.has(edge.v));
	const incident = new Map<number, number[]>();
	for (const vertex of vertices) incident.set(vertex, []);
	edges.forEach((edge, e) => {
		incident.get(edge.v)?.push(e);
		incident.get(edge.w)?.push(e);
	});
	const slack = (e: number): number => {
		const edge = edges[e] as Edge;
		return (rank[edge.w] as number) - (rank[edge.v] as number) - 1;
	};

	// --- Feasible tight spanning tree -------------------------------------
	const inTree = new Set<number>();
	const treeEdges = new Set<number>();
	const grow = (start: number) => {
		const stack = [start];
		while (stack.length > 0) {
			const vertex = stack.pop() as number;
			for (const e of incident.get(vertex) ?? []) {
				if (treeEdges.has(e) || slack(e) !== 0) continue;
				const edge = edges[e] as Edge;
				const other = edge.v === vertex ? edge.w : edge.v;
				if (inTree.has(other)) continue;
				inTree.add(other);
				treeEdges.add(e);
				stack.push(other);
			}
		}
	};
	inTree.add(vertices[0] as number);
	grow(vertices[0] as number);
	while (inTree.size < vertices.length) {
		let best = -1;
		let bestSlack = Number.POSITIVE_INFINITY;
		edges.forEach((edge, e) => {
			if (inTree.has(edge.v) === inTree.has(edge.w)) return;
			const s = slack(e);
			if (s < bestSlack) {
				bestSlack = s;
				best = e;
			}
		});
		if (best < 0) return; // cannot happen in a connected component
		const edge = edges[best] as Edge;
		const delta = inTree.has(edge.v) ? bestSlack : -bestSlack;
		for (const vertex of inTree)
			rank[vertex] = (rank[vertex] as number) + delta;
		for (const vertex of [...inTree]) grow(vertex);
	}

	// --- Tree bookkeeping ---------------------------------------------------
	const root = vertices[0] as number;
	const low = new Map<number, number>();
	const lim = new Map<number, number>();
	const treeParent = new Map<number, number>();
	const parentEdge = new Map<number, number>();
	const cut = new Map<number, number>();
	const treeNeighbours = (vertex: number): [number, number][] =>
		(incident.get(vertex) ?? [])
			.filter((e) => treeEdges.has(e))
			.map((e) => {
				const edge = edges[e] as Edge;
				return [edge.v === vertex ? edge.w : edge.v, e];
			});
	/** Postorder numbering and parents; returns vertices in postorder. */
	const number = (): number[] => {
		low.clear();
		lim.clear();
		treeParent.clear();
		parentEdge.clear();
		const order: number[] = [];
		let next = 1;
		const stack: {
			vertex: number;
			children: [number, number][];
			at: number;
			low: number;
		}[] = [{ vertex: root, children: treeNeighbours(root), at: 0, low: next }];
		const visited = new Set([root]);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1] as (typeof stack)[number];
			if (frame.at < frame.children.length) {
				const [child, e] = frame.children[frame.at] as [number, number];
				frame.at += 1;
				if (visited.has(child)) continue;
				visited.add(child);
				treeParent.set(child, frame.vertex);
				parentEdge.set(child, e);
				stack.push({
					vertex: child,
					children: treeNeighbours(child),
					at: 0,
					low: next,
				});
				continue;
			}
			low.set(frame.vertex, frame.low);
			lim.set(frame.vertex, next);
			next += 1;
			order.push(frame.vertex);
			stack.pop();
		}
		return order;
	};
	const cutValues = (order: readonly number[]) => {
		cut.clear();
		for (const child of order) {
			const parent = treeParent.get(child);
			if (parent === undefined) continue;
			const own = parentEdge.get(child) as number;
			const ownEdge = edges[own] as Edge;
			const childIsTail = ownEdge.v === child;
			let value = ownEdge.weight;
			for (const e of incident.get(child) ?? []) {
				if (e === own) continue;
				const edge = edges[e] as Edge;
				const isOut = edge.v === child;
				const pointsToHead = isOut === childIsTail;
				value += pointsToHead ? edge.weight : -edge.weight;
				if (treeEdges.has(e)) {
					const other = isOut ? edge.w : edge.v;
					// `other` is a tree child of `child` (postorder: done).
					if (treeParent.get(other) === child) {
						const otherCut = cut.get(e) as number;
						value += pointsToHead ? -otherCut : otherCut;
					}
				}
			}
			cut.set(own, value);
		}
	};
	const updateRanks = () => {
		// Preorder from the root: each vertex sits minlen from its parent.
		const stack = [root];
		const seen = new Set([root]);
		while (stack.length > 0) {
			const vertex = stack.pop() as number;
			for (const [child, e] of treeNeighbours(vertex)) {
				if (seen.has(child)) continue;
				seen.add(child);
				const edge = edges[e] as Edge;
				rank[child] =
					edge.v === vertex
						? (rank[vertex] as number) + 1
						: (rank[vertex] as number) - 1;
				stack.push(child);
			}
		}
	};

	let order = number();
	cutValues(order);
	const maxIterations = edges.length * vertices.length + 1;
	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		// Leaving edge: first tree edge with a negative cut value.
		let leaving = -1;
		for (const e of [...treeEdges].sort((a, b) => a - b)) {
			if ((cut.get(e) as number) < 0) {
				leaving = e;
				break;
			}
		}
		if (leaving < 0) break;
		// Entering edge: minimum-slack edge crossing the cut the other way.
		const edge = edges[leaving] as Edge;
		const vLim = lim.get(edge.v) as number;
		const wLim = lim.get(edge.w) as number;
		const tail = vLim > wLim ? edge.w : edge.v;
		const flip = vLim > wLim;
		const tailLow = low.get(tail) as number;
		const tailLim = lim.get(tail) as number;
		const below = (vertex: number) => {
			const l = lim.get(vertex) as number;
			return tailLow <= l && l <= tailLim;
		};
		let entering = -1;
		let enteringSlack = Number.POSITIVE_INFINITY;
		edges.forEach((candidate, e) => {
			if (treeEdges.has(e)) return;
			if (flip !== below(candidate.v) || flip === below(candidate.w)) return;
			const s = slack(e);
			if (s < enteringSlack) {
				enteringSlack = s;
				entering = e;
			}
		});
		if (entering < 0) break;
		treeEdges.delete(leaving);
		treeEdges.add(entering);
		order = number();
		cutValues(order);
		updateRanks();
	}
}
