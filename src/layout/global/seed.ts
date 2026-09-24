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
