import type { Point } from "../ir/geometry.js";

// ---------------------------------------------------------------------------
// Bus routing — shared-corridor edge bundling (Issue #54, 方案 C)
//
// NOTE: This module currently exports the computeFanOutPorts primitive
// only.  It is NOT yet wired into coordinateEdges / routeEdge, so
// merging this file alone produces zero runtime behavior change.
// Integration into the edge-coordination path is planned in a follow-up
// PR that will call computeFanOutPorts for same-source same-side edges
// (skipping edges that already carry an explicit portId or anchor).
// ---------------------------------------------------------------------------

/**
 * Compute a port offset for edges that share the same source node and
 * side so they fan out instead of stacking at a single point.  This
 * is a lightweight bus-routing primitive: edges from the same source
 * are spread along the node edge, creating visual separation.
 */
export interface PortFanOut {
	/** The anchor point offset for this edge. */
	readonly anchor: Point;
	/** Index of this edge in the fan-out group (0-based). */
	readonly index: number;
	/** Total edges sharing this source node + side. */
	readonly total: number;
}

/**
 * Group edges by (source node id, side) and assign each a distinct
 * position along the node edge so they fan out visually.
 *
 * The offset is perpendicular to the edge direction: for TB layout,
 * edges from the bottom of a node fan out horizontally; for LR
 * layout, edges from the right fan out vertically.
 *
 * @param edgeIds  All edge ids that share a common source node + side.
 * @param nodeBox  The source node's bounding box.
 * @param side     Which side the edges depart from ("top"|"right"|"bottom"|"left").
 * @param spacing  Minimum spacing between ports (default 8 px).
 */
export function computeFanOutPorts(
	edgeIds: readonly string[],
	nodeBox: { x: number; y: number; width: number; height: number },
	side: "top" | "right" | "bottom" | "left",
	spacing = 8,
): Map<string, PortFanOut> {
	const result = new Map<string, PortFanOut>();
	if (edgeIds.length <= 1) {
		for (const id of edgeIds) {
			result.set(id, {
				anchor: nodeSideCenter(nodeBox, side),
				index: 0,
				total: 1,
			});
		}
		return result;
	}

	const total = edgeIds.length;
	const isHorizontal = side === "top" || side === "bottom";
	const totalSpan = (total - 1) * spacing;
	const start = -totalSpan / 2;

	for (let i = 0; i < edgeIds.length; i++) {
		const id = edgeIds[i] as string;
		const offset = start + i * spacing;
		const center = nodeSideCenter(nodeBox, side);
		let anchor: Point = isHorizontal
			? { x: center.x + offset, y: center.y }
			: { x: center.x, y: center.y + offset };
		// Clamp anchors to the node boundary so ports never land
		// outside the node box when the fan-out span exceeds the
		// edge length.
		if (isHorizontal) {
			anchor = { ...anchor, x: clamp(anchor.x, nodeBox.x, nodeBox.x + nodeBox.width) };
		} else {
			anchor = { ...anchor, y: clamp(anchor.y, nodeBox.y, nodeBox.y + nodeBox.height) };
		}
		result.set(id, { anchor, index: i, total });
	}

	return result;
}


function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function nodeSideCenter(
	box: { x: number; y: number; width: number; height: number },
	side: string,
): Point {
	switch (side) {
		case "top":
			return { x: box.x + box.width / 2, y: box.y };
		case "right":
			return { x: box.x + box.width, y: box.y + box.height / 2 };
		case "bottom":
			return { x: box.x + box.width / 2, y: box.y + box.height };
		case "left":
			return { x: box.x, y: box.y + box.height / 2 };
		default:
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}
}
