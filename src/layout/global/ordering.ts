import type { ContainerHierarchy } from "./hierarchy.js";
import type { Layering } from "./layering.js";

/**
 * Crossing minimisation with container constraints (plan P2).
 *
 * Classic layer-by-layer barycenter sweeps (down, then up), with two extra
 * rules that make container rectangles possible in the coordinate stage:
 *
 * - **Contiguity**: inside every layer the vertices of one container form a
 *   single block (recursively for nested containers).
 * - **Consistency**: sibling containers keep one global order across all
 *   layers. That order comes from each container's mean normalised position
 *   over every layer; lanes keep their declared order.
 *
 * Vertices are sorted inside their block by barycenter; a transposition
 * pass then swaps neighbours of the same container while that reduces
 * crossings. The best ordering seen (fewest crossings) wins; ties keep the
 * earlier one, so the result is deterministic.
 */
export interface OrderingOptions {
	/** Down+up sweep pairs per start (default 12). */
	iterations?: number;
	/**
	 * Extra starting orders (per layer, cross-axis order of vertex ids), for
	 * example the order implied by a Dagre layout. Each seed is first made
	 * container-contiguous, then refined; the best result over all starts
	 * wins, so the output is never worse than a contiguous seed.
	 */
	seeds?: readonly (readonly (readonly string[])[])[];
}

export interface Ordering {
	/** Vertex ids per layer, in cross-axis order. */
	layers: string[][];
	crossings: number;
}

type Heuristic = "barycenter" | "median";

/** Sweep rounds without improvement before a refinement stops. */
const PATIENCE = 5;

export function orderLayers(
	layering: Layering,
	hierarchy: ContainerHierarchy,
	options: OrderingOptions = {},
): Ordering {
	const iterations = Math.max(1, options.iterations ?? 12);
	const upper = new Map<string, string[]>();
	const lower = new Map<string, string[]>();
	for (const segment of layering.segments) {
		const down = lower.get(segment.from) ?? [];
		down.push(segment.to);
		lower.set(segment.from, down);
		const up = upper.get(segment.to) ?? [];
		up.push(segment.from);
		upper.set(segment.to, up);
	}

	const graph = indexGraph(
		layering.vertices.keys(),
		lower,
		(id) => layering.vertices.get(id)?.containerId,
	);
	const starts: string[][][] = [
		initialOrder(layering, hierarchy, upper),
		...(options.seeds ?? []).map((seed) =>
			seededOrder(seed, layering, hierarchy),
		),
	];
	let best: Ordering | undefined;
	for (const start of starts) {
		for (const heuristic of ["barycenter", "median"] as const) {
			const result = refine(
				start,
				layering,
				hierarchy,
				upper,
				lower,
				graph,
				iterations,
				heuristic,
			);
			if (best === undefined || result.crossings < best.crossings) {
				best = result;
			}
			if (best.crossings === 0) return best;
		}
	}
	return best ?? { layers: [], crossings: 0 };
}

function refine(
	start: string[][],
	layering: Layering,
	hierarchy: ContainerHierarchy,
	upper: ReadonlyMap<string, string[]>,
	lower: ReadonlyMap<string, string[]>,
	graph: IndexedGraph,
	iterations: number,
	heuristic: Heuristic,
): Ordering {
	// Every candidate is canonicalised to one global sibling-container order
	// before it can become `best`: a layer-local start could otherwise flip
	// two groups between layers and win on crossings with an order that no
	// set of non-interleaving rectangles can draw.
	let layers = canonicalize(transpose(start, graph), layering, hierarchy);
	let best: Ordering = {
		layers: cloneLayers(layers),
		crossings: countIndexed(layers, graph),
	};
	let lastImprovement = -1;
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		// Sweeps converge in a few rounds; stop once `PATIENCE` rounds in a
		// row found nothing better.
		if (iteration - lastImprovement > PATIENCE) break;
		for (const direction of ["down", "up"] as const) {
			layers = sweep(
				layers,
				layering,
				hierarchy,
				direction === "down" ? upper : lower,
				direction,
				heuristic,
			);
			layers = canonicalize(transpose(layers, graph), layering, hierarchy);
			const crossings = countIndexed(layers, graph);
			if (crossings < best.crossings) {
				best = { layers: cloneLayers(layers), crossings };
				lastImprovement = iteration;
			}
		}
		if (best.crossings === 0) break;
	}
	return best;
}

/**
 * Re-arrange every layer into blocks ordered by one global container order,
 * keeping the current order of vertices inside each block.
 */
function canonicalize(
	layers: readonly string[][],
	layering: Layering,
	hierarchy: ContainerHierarchy,
): string[][] {
	const containerOrder = globalContainerOrder(layers, layering, hierarchy);
	return layers.map((layer) => {
		const keys = new Map(
			layer.map((id, index) => [id, (index + 0.5) / Math.max(1, layer.length)]),
		);
		return arrangeBlocks(layer, keys, layering, hierarchy, containerOrder);
	});
}

/** Make a seed order container-contiguous (seed positions as keys). */
function seededOrder(
	seed: readonly (readonly string[])[],
	layering: Layering,
	hierarchy: ContainerHierarchy,
): string[][] {
	const provisional = layering.layers.map((vertices, index) => {
		const seedLayer = seed[index] ?? [];
		const position = new Map(seedLayer.map((id, order) => [id, order]));
		return [...vertices].sort(
			(a, b) =>
				(position.get(a) ?? Number.POSITIVE_INFINITY) -
					(position.get(b) ?? Number.POSITIVE_INFINITY) || a.localeCompare(b),
		);
	});
	const containerOrder = globalContainerOrder(provisional, layering, hierarchy);
	return provisional.map((layer) => {
		const keys = new Map(
			layer.map((id, index) => [id, (index + 0.5) / Math.max(1, layer.length)]),
		);
		return arrangeBlocks(layer, keys, layering, hierarchy, containerOrder);
	});
}

function initialOrder(
	layering: Layering,
	hierarchy: ContainerHierarchy,
	upper: ReadonlyMap<string, string[]>,
): string[][] {
	// Layer 0 by id; every later layer by barycenter of its upper layer,
	// arranged into container blocks.
	const layers: string[][] = [];
	layering.layers.forEach((vertices, index) => {
		if (index === 0) {
			layers.push(
				arrangeBlocks(
					[...vertices].sort(),
					new Map(),
					layering,
					hierarchy,
					new Map(),
				),
			);
			return;
		}
		const previous = layers[index - 1] ?? [];
		const bary = barycenters(vertices, previous, upper);
		layers.push(arrangeBlocks(vertices, bary, layering, hierarchy, new Map()));
	});
	return layers;
}

function sweep(
	layers: string[][],
	layering: Layering,
	hierarchy: ContainerHierarchy,
	neighbours: ReadonlyMap<string, string[]>,
	direction: "down" | "up",
	heuristic: Heuristic = "barycenter",
): string[][] {
	const next = cloneLayers(layers);
	const containerOrder = globalContainerOrder(next, layering, hierarchy);
	const indices =
		direction === "down"
			? next.map((_, index) => index).slice(1)
			: next
					.map((_, index) => index)
					.slice(0, -1)
					.reverse();
	for (const index of indices) {
		const fixed = next[direction === "down" ? index - 1 : index + 1] ?? [];
		const current = next[index] ?? [];
		const bary = barycenters(current, fixed, neighbours, heuristic);
		// Vertices without neighbours keep their current relative position.
		current.forEach((id, position) => {
			if (!bary.has(id))
				bary.set(id, (position + 0.5) / Math.max(1, current.length));
		});
		next[index] = arrangeBlocks(
			current,
			bary,
			layering,
			hierarchy,
			containerOrder,
		);
	}
	return next;
}

/** Mean normalised position of each vertex's neighbours in `fixed`. */
function barycenters(
	vertices: readonly string[],
	fixed: readonly string[],
	neighbours: ReadonlyMap<string, string[]>,
	heuristic: Heuristic = "barycenter",
): Map<string, number> {
	const position = new Map(
		fixed.map((id, index) => [id, (index + 0.5) / Math.max(1, fixed.length)]),
	);
	const result = new Map<string, number>();
	const values: number[] = [];
	for (const id of vertices) {
		values.length = 0;
		for (const other of neighbours.get(id) ?? []) {
			const value = position.get(other);
			if (value !== undefined) values.push(value);
		}
		if (values.length === 0) continue;
		if (heuristic === "median") {
			values.sort((a, b) => a - b);
			const middle = Math.floor(values.length / 2);
			result.set(
				id,
				values.length % 2 === 1
					? (values[middle] as number)
					: ((values[middle - 1] as number) + (values[middle] as number)) / 2,
			);
		} else {
			let sum = 0;
			for (const value of values) sum += value;
			result.set(id, sum / values.length);
		}
	}
	return result;
}

/**
 * Global container order: mean normalised position of every vertex in the
 * container's subtree over all layers. Lanes use their fixed order.
 */
function globalContainerOrder(
	layers: readonly string[][],
	layering: Layering,
	hierarchy: ContainerHierarchy,
): Map<string, number> {
	const sums = new Map<string, { total: number; count: number }>();
	layers.forEach((layer) => {
		layer.forEach((id, index) => {
			const value = (index + 0.5) / Math.max(1, layer.length);
			let cursor: string | undefined = layering.vertices.get(id)?.containerId;
			while (cursor !== undefined) {
				const entry = sums.get(cursor) ?? { total: 0, count: 0 };
				entry.total += value;
				entry.count += 1;
				sums.set(cursor, entry);
				cursor = hierarchy.containers.get(cursor)?.parentId;
			}
		});
	});
	const order = new Map<string, number>();
	for (const [id, entry] of sums)
		order.set(id, entry.total / Math.max(1, entry.count));
	return order;
}

const RANKS = new WeakMap<Layering, Map<string, number>>();

/**
 * `localeCompare` order of every vertex and container id as integers, so
 * the hot sorts compare numbers (ids that compare equal share a rank).
 */
function idRanks(
	layering: Layering,
	hierarchy: ContainerHierarchy,
): ReadonlyMap<string, number> {
	const cached = RANKS.get(layering);
	if (cached !== undefined) return cached;
	const ids = [
		...new Set([...layering.vertices.keys(), ...hierarchy.containers.keys()]),
	].sort((a, b) => a.localeCompare(b));
	const rank = new Map<string, number>();
	ids.forEach((id, index) => {
		const previous = ids[index - 1];
		rank.set(
			id,
			previous !== undefined && previous.localeCompare(id) === 0
				? (rank.get(previous) as number)
				: index,
		);
	});
	RANKS.set(layering, rank);
	return rank;
}

/**
 * Sort one layer into nested container blocks. Siblings at each level are
 * child containers (keyed by fixed order, else global order, else the mean
 * barycenter of their vertices in this layer) and direct vertices (keyed by
 * barycenter). Ties break on id.
 */
function arrangeBlocks(
	vertices: readonly string[],
	bary: ReadonlyMap<string, number>,
	layering: Layering,
	hierarchy: ContainerHierarchy,
	containerOrder: ReadonlyMap<string, number>,
): string[] {
	const rank = idRanks(layering, hierarchy);
	const inLayer = new Set(vertices);
	const direct = new Map<string, string[]>();
	for (const id of vertices) {
		const container =
			layering.vertices.get(id)?.containerId ?? hierarchy.rootId;
		const list = direct.get(container) ?? [];
		list.push(id);
		direct.set(container, list);
	}
	const subtreeHasVertices = new Map<string, boolean>();
	const hasVertices = (containerId: string): boolean => {
		const cached = subtreeHasVertices.get(containerId);
		if (cached !== undefined) return cached;
		const container = hierarchy.containers.get(containerId);
		const result =
			(direct.get(containerId) ?? []).some((id) => inLayer.has(id)) ||
			(container?.childIds ?? []).some((child) => hasVertices(child));
		subtreeHasVertices.set(containerId, result);
		return result;
	};
	const localMean = (containerId: string): number => {
		const values: number[] = [];
		const visit = (id: string): void => {
			for (const vertex of direct.get(id) ?? []) {
				values.push(bary.get(vertex) ?? 0.5);
			}
			for (const child of hierarchy.containers.get(id)?.childIds ?? [])
				visit(child);
		};
		visit(containerId);
		return values.length === 0
			? 0.5
			: values.reduce((a, b) => a + b, 0) / values.length;
	};
	const flatten = (containerId: string): string[] => {
		const container = hierarchy.containers.get(containerId);
		type Entry = {
			key: number;
			fixed: number;
			id: string;
			items: () => string[];
		};
		const entries: Entry[] = [];
		for (const vertex of direct.get(containerId) ?? []) {
			entries.push({
				key: bary.get(vertex) ?? 0.5,
				fixed: Number.POSITIVE_INFINITY,
				id: vertex,
				items: () => [vertex],
			});
		}
		for (const childId of container?.childIds ?? []) {
			if (!hasVertices(childId)) continue;
			const child = hierarchy.containers.get(childId);
			entries.push({
				key: containerOrder.get(childId) ?? localMean(childId),
				fixed: child?.fixedOrder ?? Number.POSITIVE_INFINITY,
				id: childId,
				items: () => flatten(childId),
			});
		}
		entries.sort(
			(a, b) =>
				a.fixed - b.fixed ||
				a.key - b.key ||
				(rank.get(a.id) as number) - (rank.get(b.id) as number),
		);
		return entries.flatMap((entry) => entry.items());
	};
	return flatten(hierarchy.rootId);
}

/** Integer view of the layered graph for the hot loops. */
interface IndexedGraph {
	ids: readonly string[];
	index: ReadonlyMap<string, number>;
	upper: readonly (readonly number[])[];
	lower: readonly (readonly number[])[];
	/** Container per vertex: equal values mean the same container. */
	container: readonly (string | undefined)[];
	/** Scratch: position of each vertex inside its layer. */
	position: Int32Array;
	/** Scratch: layer of each vertex, -1 when not placed. */
	layerOf: Int32Array;
	/** Scratch: Fenwick tree for crossing counts. */
	tree: Int32Array;
}

function indexGraph(
	vertices: Iterable<string>,
	lower: ReadonlyMap<string, readonly string[]>,
	containerOf: (id: string) => string | undefined,
): IndexedGraph {
	const ids: string[] = [];
	const index = new Map<string, number>();
	const add = (id: string): number => {
		let at = index.get(id);
		if (at === undefined) {
			at = ids.length;
			ids.push(id);
			index.set(id, at);
		}
		return at;
	};
	for (const id of vertices) add(id);
	const edges: [number, number][] = [];
	for (const [from, targets] of lower) {
		const source = add(from);
		for (const to of targets) edges.push([source, add(to)]);
	}
	const upperLists: number[][] = ids.map(() => []);
	const lowerLists: number[][] = ids.map(() => []);
	for (const [source, target] of edges) {
		(lowerLists[source] as number[]).push(target);
		(upperLists[target] as number[]).push(source);
	}
	return {
		ids,
		index,
		upper: upperLists,
		lower: lowerLists,
		container: ids.map(containerOf),
		position: new Int32Array(ids.length),
		layerOf: new Int32Array(ids.length),
		tree: new Int32Array(ids.length + 1),
	};
}

function toIndices(
	layers: readonly (readonly string[])[],
	graph: IndexedGraph,
): number[][] {
	return layers.map((layer) =>
		layer.map((id) => graph.index.get(id) as number),
	);
}

/**
 * Swap adjacent vertices of the same container while that lowers the
 * crossings with both neighbouring layers.
 */
function transpose(
	layers: readonly (readonly string[])[],
	graph: IndexedGraph,
): string[][] {
	const { upper, lower, container, position } = graph;
	const next = toIndices(layers, graph);
	for (const layer of next) {
		for (let at = 0; at < layer.length; at += 1) {
			position[layer[at] as number] = at;
		}
	}
	// Swapping adjacent a, b only changes crossings between their own edges:
	// each pair of other ends (x of a, y of b) crosses in exactly one of the
	// two orders, so the sign of their positions decides which.
	const preference = (a: readonly number[], b: readonly number[]): number => {
		let score = 0;
		for (const x of a) {
			const px = position[x] as number;
			for (const y of b) {
				const py = position[y] as number;
				if (px > py) score += 1;
				else if (px < py) score -= 1;
			}
		}
		return score;
	};
	for (let round = 0; round < 4; round += 1) {
		let improved = false;
		for (const layer of next) {
			for (let at = 0; at + 1 < layer.length; at += 1) {
				const a = layer[at] as number;
				const b = layer[at + 1] as number;
				if (container[a] !== container[b]) continue;
				// crossings(a, b) - crossings(b, a) with both neighbouring layers.
				if (
					preference(upper[a] as number[], upper[b] as number[]) +
						preference(lower[a] as number[], lower[b] as number[]) >
					0
				) {
					layer[at] = b;
					layer[at + 1] = a;
					position[b] = at;
					position[a] = at + 1;
					improved = true;
				}
			}
		}
		if (!improved) break;
	}
	return next.map((layer) =>
		layer.map((vertex) => graph.ids[vertex] as string),
	);
}

/** Total crossings of unit segments between consecutive layers. */
export function countCrossings(
	layers: readonly string[][],
	lower: ReadonlyMap<string, string[]>,
): number {
	return countIndexed(
		layers,
		indexGraph(layers.flat(), lower, () => undefined),
	);
}

function countIndexed(
	layers: readonly (readonly string[])[],
	graph: IndexedGraph,
): number {
	const { lower, position, layerOf, tree } = graph;
	const indexed = toIndices(layers, graph);
	layerOf.fill(-1);
	indexed.forEach((layer, layerIndex) => {
		for (let at = 0; at < layer.length; at += 1) {
			const vertex = layer[at] as number;
			position[vertex] = at;
			layerOf[vertex] = layerIndex;
		}
	});
	let total = 0;
	const bottoms: number[] = [];
	for (let layerIndex = 0; layerIndex + 1 < indexed.length; layerIndex += 1) {
		// Barth–Mutzel–Jünger: take the segments sorted by (top, bottom) and
		// count, for each, the earlier ones with a strictly larger bottom
		// index (inversions), with a Fenwick tree — O(E log V) instead of
		// comparing all pairs. Equal tops sort by bottom, so they never
		// count; equal bottoms fail the strict comparison. Same result as
		// the pairwise definition.
		const size = (indexed[layerIndex + 1] as number[]).length;
		tree.fill(0, 0, size + 1);
		let inserted = 0;
		for (const vertex of indexed[layerIndex] as number[]) {
			bottoms.length = 0;
			for (const target of lower[vertex] as number[]) {
				if (layerOf[target] === layerIndex + 1) {
					bottoms.push(position[target] as number);
				}
			}
			if (bottoms.length > 1) bottoms.sort((a, b) => a - b);
			for (const bottom of bottoms) {
				// Earlier segments with bottom <= this one.
				let atMost = 0;
				for (let i = bottom + 1; i > 0; i -= i & -i) {
					atMost += tree[i] as number;
				}
				total += inserted - atMost;
				for (let i = bottom + 1; i <= size; i += i & -i) {
					tree[i] = (tree[i] as number) + 1;
				}
				inserted += 1;
			}
		}
	}
	return total;
}

function cloneLayers(layers: readonly string[][]): string[][] {
	return layers.map((layer) => [...layer]);
}
