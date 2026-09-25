import type { Box, DiagramDirection } from "../../ir/geometry.js";
import type { Layering } from "./layering.js";

/**
 * Order of every layer implied by an existing layout (e.g. Dagre): real
 * vertices by their cross-axis centre, dummy vertices by linear
 * interpolation between the endpoints of their edge. Used as an extra start
 * for `orderLayers`.
 */
export function seedOrderFromBoxes(
	layering: Layering,
	boxes: ReadonlyMap<string, Box>,
	direction: DiagramDirection,
	edgeEndpoints: ReadonlyMap<string, { source: string; target: string }>,
): string[][] {
	const horizontalFlow = direction === "LR" || direction === "RL";
	const crossCenter = (box: Box): number =>
		horizontalFlow ? box.y + box.height / 2 : box.x + box.width / 2;
	const cross = (id: string): number => {
		const vertex = layering.vertices.get(id);
		if (vertex === undefined) return 0;
		if (vertex.nodeId !== undefined) {
			const box = boxes.get(vertex.nodeId);
			return box === undefined ? 0 : crossCenter(box);
		}
		const edge =
			vertex.edgeId === undefined
				? undefined
				: edgeEndpoints.get(vertex.edgeId);
		const sourceBox = edge === undefined ? undefined : boxes.get(edge.source);
		const targetBox = edge === undefined ? undefined : boxes.get(edge.target);
		if (
			edge === undefined ||
			sourceBox === undefined ||
			targetBox === undefined
		) {
			return 0;
		}
		const sourceLayer = layering.layerOfNode.get(edge.source) ?? 0;
		const targetLayer = layering.layerOfNode.get(edge.target) ?? 0;
		const span = targetLayer - sourceLayer;
		const t = span === 0 ? 0.5 : (vertex.layer - sourceLayer) / span;
		const from = crossCenter(sourceBox);
		const to = crossCenter(targetBox);
		return from + (to - from) * t;
	};
	return layering.layers.map((layer) =>
		[...layer].sort((a, b) => cross(a) - cross(b) || a.localeCompare(b)),
	);
}

/**
 * Order of every layer by first visit in a depth-first walk down the
 * layered graph (sources in id order, then any vertex not yet reached):
 * the kind of start Dagre's own ordering begins from, in linear time. Used
 * instead of a full Dagre layout on large diagrams.
 */
export function seedOrderByDepthFirst(layering: Layering): string[][] {
	const lower = new Map<string, string[]>();
	const hasUpper = new Set<string>();
	for (const segment of layering.segments) {
		const list = lower.get(segment.from) ?? [];
		list.push(segment.to);
		lower.set(segment.from, list);
		hasUpper.add(segment.to);
	}
	const visit = new Map<string, number>();
	const walk = (root: string) => {
		const stack = [root];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (visit.has(id)) continue;
			visit.set(id, visit.size);
			const next = lower.get(id) ?? [];
			for (let index = next.length - 1; index >= 0; index -= 1) {
				const target = next[index] as string;
				if (!visit.has(target)) stack.push(target);
			}
		}
	};
	const all = layering.layers.flat();
	for (const id of [...all].sort()) if (!hasUpper.has(id)) walk(id);
	for (const layer of layering.layers) {
		for (const id of [...layer].sort()) walk(id);
	}
	return layering.layers.map((layer) =>
		[...layer].sort(
			(a, b) => (visit.get(a) ?? 0) - (visit.get(b) ?? 0) || a.localeCompare(b),
		),
	);
}
