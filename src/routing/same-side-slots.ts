import {
	attachSlotFractions,
	sidePointAtFraction,
} from "../geometry/attach-slots.js";
import type { ShapeGeometry } from "../geometry/shapes.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { NormalizedEdge } from "../ir/elements.js";
import type {
	AnchorName,
	Box,
	DiagramDirection,
	Point,
} from "../ir/geometry.js";

export interface SameSideSlotAssignment {
	edgeId: string;
	endpoint: "source" | "target";
	nodeId: string;
	anchor: "top" | "right" | "bottom" | "left";
	point: Point;
	fraction: number;
}

export interface AssignSameSideSlotsInput {
	edges: readonly NormalizedEdge[];
	nodes: ReadonlyMap<string, ShapeGeometry>;
	direction: DiagramDirection;
	maxAttachPointsPerSide?: number;
}

export interface AssignSameSideSlotsResult {
	/** Key: `${edgeId}:${endpoint}` */
	assignments: Map<string, SameSideSlotAssignment>;
	diagnostics: Diagnostic[];
}

/**
 * Pre-route same-side slot assignment for anonymous (non-port) endpoints (#92).
 * Ported endpoints are skipped — #91 owns their equal-division placement.
 */
export function assignSameSideSlots(
	input: AssignSameSideSlotsInput,
): AssignSameSideSlotsResult {
	const maxSlots = Math.min(5, Math.max(1, input.maxAttachPointsPerSide ?? 3));
	const diagnostics: Diagnostic[] = [];
	const buckets = new Map<
		string,
		Array<{
			edgeId: string;
			endpoint: "source" | "target";
			nodeId: string;
			side: "top" | "right" | "bottom" | "left";
		}>
	>();

	for (const edge of input.edges) {
		const source = input.nodes.get(edge.source.nodeId);
		const target = input.nodes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) continue;

		if (edge.source.portId === undefined) {
			const side =
				cardinalSide(edge.source.anchor) ??
				preferredSide(source.box, target.box, input.direction, "source");
			if (side !== undefined) {
				const key = `${edge.source.nodeId}:${side}`;
				const list = buckets.get(key) ?? [];
				list.push({
					edgeId: edge.id,
					endpoint: "source",
					nodeId: edge.source.nodeId,
					side,
				});
				buckets.set(key, list);
			}
		}

		if (edge.target.portId === undefined) {
			const side =
				cardinalSide(edge.target.anchor) ??
				preferredSide(target.box, source.box, input.direction, "target");
			if (side !== undefined) {
				const key = `${edge.target.nodeId}:${side}`;
				const list = buckets.get(key) ?? [];
				list.push({
					edgeId: edge.id,
					endpoint: "target",
					nodeId: edge.target.nodeId,
					side,
				});
				buckets.set(key, list);
			}
		}
	}

	const assignments = new Map<string, SameSideSlotAssignment>();
	for (const [, entries] of [...buckets.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const ordered = [...entries].sort(
			(left, right) =>
				left.edgeId.localeCompare(right.edgeId) ||
				left.endpoint.localeCompare(right.endpoint),
		);
		const side = ordered[0]?.side;
		const nodeId = ordered[0]?.nodeId;
		if (side === undefined || nodeId === undefined) continue;
		const geometry = input.nodes.get(nodeId);
		if (geometry === undefined) continue;

		if (ordered.length > maxSlots) {
			diagnostics.push({
				severity: "warning",
				code: "routing.channel.capacity_exhausted",
				message: `Same-side attach capacity exhausted on ${nodeId}/${side}: ${ordered.length} anonymous edges for ${maxSlots} slots.`,
				detail: {
					nodeId,
					side,
					edgeCount: ordered.length,
					maxAttachPointsPerSide: maxSlots,
					conflictClass: "fixed-geometry-block",
					remediationType: "route-rail-or-page-split",
					edgeIds: ordered.map((entry) => entry.edgeId).join(","),
				},
			});
		}

		// Assign at most maxSlots distinct fractions — never stack overflow on mid.
		const slotCount = Math.min(ordered.length, maxSlots);
		const fractions = attachSlotFractions(slotCount);
		for (let index = 0; index < slotCount; index += 1) {
			const entry = ordered[index];
			if (entry === undefined) continue;
			const fraction = fractions[index] ?? 0.5;
			const point = sidePointAtFraction(geometry.box, side, fraction);
			assignments.set(`${entry.edgeId}:${entry.endpoint}`, {
				edgeId: entry.edgeId,
				endpoint: entry.endpoint,
				nodeId: entry.nodeId,
				anchor: side,
				point,
				fraction,
			});
		}
	}

	return { assignments, diagnostics };
}

function cardinalSide(
	anchor: string | undefined,
): "top" | "right" | "bottom" | "left" | undefined {
	if (
		anchor === "top" ||
		anchor === "right" ||
		anchor === "bottom" ||
		anchor === "left"
	) {
		return anchor;
	}
	return undefined;
}

function preferredSide(
	own: Box,
	other: Box,
	direction: DiagramDirection,
	endpoint: "source" | "target",
): "top" | "right" | "bottom" | "left" {
	const ownCenter = {
		x: own.x + own.width / 2,
		y: own.y + own.height / 2,
	};
	const otherCenter = {
		x: other.x + other.width / 2,
		y: other.y + other.height / 2,
	};
	const dx = otherCenter.x - ownCenter.x;
	const dy = otherCenter.y - ownCenter.y;
	if (direction === "TB" || direction === "BT") {
		if (endpoint === "source") {
			return direction === "TB" ? "bottom" : "top";
		}
		return direction === "TB" ? "top" : "bottom";
	}
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? "right" : "left";
	}
	return dy >= 0 ? "bottom" : "top";
}
