import type {
	Box,
	DiagramDirection,
	Point,
	PreviousLayout,
} from "../../ir/geometry.js";
import type { Layering } from "./layering.js";

/**
 * The previous layout of a solved diagram, or of a geometry document read
 * back from disk (both list nodes with `box` and edges with `points`).
 */
export function previousLayoutOf(solved: {
	nodes: readonly { id: string; box: Box }[];
	edges: readonly { id: string; points: readonly Point[] }[];
}): PreviousLayout {
	return {
		nodes: new Map(solved.nodes.map((node) => [node.id, { ...node.box }])),
		edges: new Map(
			solved.edges.map((edge) => [
				edge.id,
				edge.points.map((point) => ({ x: point.x, y: point.y })),
			]),
		),
	};
}

export interface PreviousHint {
	/** Starting order per layer implied by the previous layout. */
	seed: string[][];
	/**
	 * Previous cross-axis position of every surviving node. Dummy vertices
	 * only seed the order: routes are final geometry, after post-passes
	 * that can move nodes off the layout's slots, so they would pin a
	 * slightly wrong order.
	 */
	reference: Map<string, number>;
	/**
	 * Band of the previous (possibly folded) layout each current layer
	 * lay in: a new band starts where the old main-axis position steps
	 * back against the flow by more than half its span.
	 */
	bandOfLayer: number[];
}

/**
 * Read the previous layout in the current layering:
 * - a surviving node sits where it was;
 * - a dummy vertex sits where its edge's old route crossed the layer's
 *   (old) main-axis position, else between its endpoints;
 * - a new node sits at the mean position of its surviving neighbours;
 * - a container filler sits at the mean of its container in its layer.
 * Anything left unplaced goes after the placed vertices of its layer.
 */
export function previousHint(
	previous: PreviousLayout,
	layering: Layering,
	edgeEndpoints: ReadonlyMap<string, { source: string; target: string }>,
	direction: DiagramDirection,
): PreviousHint {
	const horizontalFlow = direction === "LR" || direction === "RL";
	const flow = direction === "RL" || direction === "BT" ? -1 : 1;
	const cross = (point: Point) => (horizontalFlow ? point.y : point.x);
	const main = (point: Point) => (horizontalFlow ? point.x : point.y);
	const centre = (box: Box): Point => ({
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
	});
	const nodeCross = (nodeId: string): number | undefined => {
		const box = previous.nodes.get(nodeId);
		return box === undefined ? undefined : cross(centre(box));
	};

	// Old main-axis and cross-axis position of every current layer, from
	// the surviving nodes in it.
	const layerMain: (number | undefined)[] = [];
	const layerCross: (number | undefined)[] = [];
	layering.layers.forEach((layer, index) => {
		const mains: number[] = [];
		const crosses: number[] = [];
		for (const id of layer) {
			const nodeId = layering.vertices.get(id)?.nodeId;
			const box = nodeId === undefined ? undefined : previous.nodes.get(nodeId);
			if (box === undefined) continue;
			mains.push(main(centre(box)));
			crosses.push(cross(centre(box)));
		}
		layerMain[index] = median(mains);
		layerCross[index] = median(crosses);
	});
	// Layers without surviving nodes: interpolate between the nearest
	// layers that have some.
	fillGaps(layerMain, true);
	fillGaps(layerCross, false);
	// A fold steps back by about a band's length; changed layering only
	// jitters the old positions by a fraction of that.
	const known = layerMain.filter((value) => value !== undefined);
	const span = known.length === 0 ? 0 : Math.max(...known) - Math.min(...known);
	const bandOfLayer: number[] = [];
	let band = 0;
	layerMain.forEach((value, index) => {
		const before = layerMain[index - 1];
		if (
			value !== undefined &&
			before !== undefined &&
			(value - before) * flow < -span / 2
		) {
			band += 1;
		}
		bandOfLayer.push(band);
	});

	const reference = new Map<string, number>();
	const position = new Map<string, number>();
	for (const [id, vertex] of layering.vertices) {
		if (vertex.nodeId !== undefined) {
			const value = nodeCross(vertex.nodeId);
			if (value !== undefined) {
				reference.set(id, value);
				position.set(id, value);
			}
			continue;
		}
		if (vertex.edgeId === undefined) continue;
		const route = previous.edges?.get(vertex.edgeId);
		const at = layerMain[vertex.layer];
		const onRoute =
			route === undefined || at === undefined
				? undefined
				: routeCrossAt(route, at, layerCross[vertex.layer], main, cross);
		if (onRoute !== undefined) {
			position.set(id, onRoute);
			continue;
		}
		const edge = edgeEndpoints.get(vertex.edgeId);
		const from = edge === undefined ? undefined : nodeCross(edge.source);
		const to = edge === undefined ? undefined : nodeCross(edge.target);
		if (edge === undefined || from === undefined || to === undefined) continue;
		const sourceLayer = layering.layerOfNode.get(edge.source) ?? 0;
		const targetLayer = layering.layerOfNode.get(edge.target) ?? 0;
		const span = targetLayer - sourceLayer;
		const t = span === 0 ? 0.5 : (vertex.layer - sourceLayer) / span;
		position.set(id, from + (to - from) * t);
	}

	// New nodes: mean of surviving neighbours.
	const neighbourValues = new Map<string, number[]>();
	for (const edge of edgeEndpoints.values()) {
		for (const [id, other] of [
			[edge.source, edge.target],
			[edge.target, edge.source],
		] as const) {
			if (position.has(id)) continue;
			const value = nodeCross(other);
			if (value === undefined) continue;
			const list = neighbourValues.get(id) ?? [];
			list.push(value);
			neighbourValues.set(id, list);
		}
	}
	for (const [id, values] of neighbourValues) {
		if (layering.vertices.has(id)) position.set(id, mean(values));
	}

	// Fillers: mean of their container in their layer.
	for (const layer of layering.layers) {
		const byContainer = new Map<string, number[]>();
		for (const id of layer) {
			const vertex = layering.vertices.get(id);
			const value = position.get(id);
			if (vertex === undefined || value === undefined) continue;
			const list = byContainer.get(vertex.containerId) ?? [];
			list.push(value);
			byContainer.set(vertex.containerId, list);
		}
		for (const id of layer) {
			const vertex = layering.vertices.get(id);
			if (vertex?.filler !== true || position.has(id)) continue;
			const values = byContainer.get(vertex.containerId);
			if (values !== undefined) position.set(id, mean(values));
		}
	}

	const seed = layering.layers.map((layer) =>
		[...layer].sort(
			(a, b) =>
				(position.get(a) ?? Number.POSITIVE_INFINITY) -
					(position.get(b) ?? Number.POSITIVE_INFINITY) || a.localeCompare(b),
		),
	);
	return { seed, reference, bandOfLayer };
}

/**
 * Cross-axis position where `route` runs through main-axis position `at`
 * along the flow. A folded route can pass `at` more than once (once per
 * band); the crossing nearest the layer's old cross position wins.
 */
function routeCrossAt(
	route: readonly Point[],
	at: number,
	near: number | undefined,
	main: (point: Point) => number,
	cross: (point: Point) => number,
): number | undefined {
	let best: number | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index + 1 < route.length; index += 1) {
		const a = route[index] as Point;
		const b = route[index + 1] as Point;
		const low = Math.min(main(a), main(b));
		const high = Math.max(main(a), main(b));
		if (high - low < 1e-9 || at < low || at > high) continue;
		const t = (at - main(a)) / (main(b) - main(a));
		const value = cross(a) + (cross(b) - cross(a)) * t;
		const distance = near === undefined ? 0 : Math.abs(value - near);
		if (distance < bestDistance) {
			best = value;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Fill undefined entries from the nearest defined ones: linearly between
 * two neighbours when `interpolate`, else from the nearer one.
 */
function fillGaps(values: (number | undefined)[], interpolate: boolean): void {
	const known = values.flatMap((value, index) =>
		value === undefined ? [] : [index],
	);
	if (known.length === 0) return;
	values.forEach((value, index) => {
		if (value !== undefined) return;
		const after = known.find((at) => at > index);
		const before = [...known].reverse().find((at) => at < index);
		if (before === undefined || after === undefined) {
			values[index] = values[(before ?? after) as number];
			return;
		}
		const low = values[before] as number;
		const high = values[after] as number;
		values[index] = interpolate
			? low + ((high - low) * (index - before)) / (after - before)
			: index - before <= after - index
				? low
				: high;
	});
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] as number)
		: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function mean(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}
