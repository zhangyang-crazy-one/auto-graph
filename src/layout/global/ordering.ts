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
	iterations: number,
	heuristic: Heuristic,
): Ordering {
	// Every candidate is canonicalised to one global sibling-container order
	// before it can become `best`: a layer-local start could otherwise flip
	// two groups between layers and win on crossings with an order that no
	// set of non-interleaving rectangles can draw.
	let layers = canonicalize(
		transpose(cloneLayers(start), layering, lower),
		layering,
		hierarchy,
	);
	let best: Ordering = {
		layers: cloneLayers(layers),
		crossings: countCrossings(layers, lower),
	};
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		for (const direction of ["down", "up"] as const) {
			layers = sweep(
				layers,
				layering,
				hierarchy,
				direction === "down" ? upper : lower,
				direction,
				heuristic,
			);
			layers = canonicalize(
				transpose(layers, layering, lower),
				layering,
				hierarchy,
			);
			const crossings = countCrossings(layers, lower);
			if (crossings < best.crossings) {
				best = { layers: cloneLayers(layers), crossings };
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
	for (const id of vertices) {
		const values = (neighbours.get(id) ?? [])
			.map((other) => position.get(other))
			.filter((value): value is number => value !== undefined);
		if (values.length === 0) continue;
		if (heuristic === "median") {
			const sorted = [...values].sort((a, b) => a - b);
			const middle = Math.floor(sorted.length / 2);
			result.set(
				id,
				sorted.length % 2 === 1
					? (sorted[middle] as number)
					: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
			);
		} else {
			result.set(
				id,
				values.reduce((sum, value) => sum + value, 0) / values.length,
			);
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
			(a, b) => a.fixed - b.fixed || a.key - b.key || a.id.localeCompare(b.id),
		);
		return entries.flatMap((entry) => entry.items());
	};
	return flatten(hierarchy.rootId);
}

/**
 * Swap adjacent vertices of the same container while that lowers the
 * crossings with both neighbouring layers.
 */
function transpose(
	layers: string[][],
	layering: Layering,
	lower: ReadonlyMap<string, string[]>,
): string[][] {
	const next = cloneLayers(layers);
	for (let round = 0; round < 4; round += 1) {
		let improved = false;
		for (let index = 0; index < next.length; index += 1) {
			const layer = next[index] ?? [];
			for (let position = 0; position + 1 < layer.length; position += 1) {
				const a = layer[position] as string;
				const b = layer[position + 1] as string;
				if (
					layering.vertices.get(a)?.containerId !==
					layering.vertices.get(b)?.containerId
				) {
					continue;
				}
				const before = localCrossings(next, index, lower);
				layer[position] = b;
				layer[position + 1] = a;
				const after = localCrossings(next, index, lower);
				if (after < before) {
					improved = true;
				} else {
					layer[position] = a;
					layer[position + 1] = b;
				}
			}
		}
		if (!improved) break;
	}
	return next;
}

function localCrossings(
	layers: readonly string[][],
	index: number,
	lower: ReadonlyMap<string, string[]>,
): number {
	let total = 0;
	if (index > 0)
		total += crossingsBetween(
			layers[index - 1] ?? [],
			layers[index] ?? [],
			lower,
		);
	if (index + 1 < layers.length) {
		total += crossingsBetween(
			layers[index] ?? [],
			layers[index + 1] ?? [],
			lower,
		);
	}
	return total;
}

/** Total crossings of unit segments between consecutive layers. */
export function countCrossings(
	layers: readonly string[][],
	lower: ReadonlyMap<string, string[]>,
): number {
	let total = 0;
	for (let index = 0; index + 1 < layers.length; index += 1) {
		total += crossingsBetween(
			layers[index] ?? [],
			layers[index + 1] ?? [],
			lower,
		);
	}
	return total;
}

function crossingsBetween(
	top: readonly string[],
	bottom: readonly string[],
	lower: ReadonlyMap<string, string[]>,
): number {
	const bottomPosition = new Map(bottom.map((id, index) => [id, index]));
	const pairs: Array<[number, number]> = [];
	top.forEach((id, topIndex) => {
		for (const target of lower.get(id) ?? []) {
			const bottomIndex = bottomPosition.get(target);
			if (bottomIndex !== undefined) pairs.push([topIndex, bottomIndex]);
		}
	});
	let crossings = 0;
	for (let i = 0; i < pairs.length; i += 1) {
		const [a0, a1] = pairs[i] as [number, number];
		for (let j = i + 1; j < pairs.length; j += 1) {
			const [b0, b1] = pairs[j] as [number, number];
			if ((a0 - b0) * (a1 - b1) < 0) crossings += 1;
		}
	}
	return crossings;
}

function cloneLayers(layers: readonly string[][]): string[][] {
	return layers.map((layer) => [...layer]);
}
