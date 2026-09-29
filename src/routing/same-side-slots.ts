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
	/**
	 * Fractions already taken on a side (named ports), keyed
	 * `${nodeId}:${side}`. Anonymous endpoints are placed between them.
	 */
	occupied?: ReadonlyMap<string, readonly number[]>;
	/**
	 * Named port attach points by node id, then port id (ids may contain
	 * dots, so a joined key would be ambiguous). A lone anonymous end facing
	 * a ported end lines up with the port.
	 */
	portPoints?: ReadonlyMap<string, ReadonlyMap<string, Point>>;
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
			/** Order along the side ({@link nestedSlotKey}). */
			toward: number;
			/** The other end's box. */
			other: Box;
			/** The other end's fixed attach point (a named port), if any. */
			otherPoint?: Point;
		}>
	>();

	for (const edge of input.edges) {
		const source = input.nodes.get(edge.source.nodeId);
		const target = input.nodes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) continue;

		// An authored anchor that is not a side (center, a corner) keeps
		// its own point: such an end takes no slot and no fraction.
		if (
			edge.source.portId === undefined &&
			!nonSideAnchor(edge.source.anchor)
		) {
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
					toward: nestedSlotKey(side, source.box, centerOf(target.box)),
					other: target.box,
					...portPointOf(input, edge.target),
				});
				buckets.set(key, list);
			}
		}

		if (
			edge.target.portId === undefined &&
			!nonSideAnchor(edge.target.anchor)
		) {
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
					toward: nestedSlotKey(side, target.box, centerOf(source.box)),
					other: source.box,
					...portPointOf(input, edge.source),
				});
				buckets.set(key, list);
			}
		}
	}

	const assignments = new Map<string, SameSideSlotAssignment>();
	for (const [, entries] of [...buckets.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		// Order along the side by where the other end lies, so neighbouring
		// edges leave in the order they travel and do not cross at the node.
		const ordered = [...entries].sort(
			(left, right) =>
				left.toward - right.toward ||
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

		// Every endpoint gets its own fraction (overflow is reported above,
		// never stacked on one point), placed between the side's ports.
		const occupied = input.occupied?.get(`${nodeId}:${side}`) ?? [];
		const fractions =
			ordered.length === 1 && occupied.length === 0
				? [
						alignedFraction(
							side,
							geometry.box,
							(ordered[0] as { other: Box }).other,
							(ordered[0] as { otherPoint?: Point }).otherPoint,
						),
					]
				: freeFractions(ordered.length, occupied);
		ordered.forEach((entry, index) => {
			const fraction = fractions[index] ?? 0.5;
			assignments.set(`${entry.edgeId}:${entry.endpoint}`, {
				edgeId: entry.edgeId,
				endpoint: entry.endpoint,
				nodeId: entry.nodeId,
				anchor: side,
				point: sidePointAtFraction(geometry.box, side, fraction),
				fraction,
			});
		});
	}

	return { assignments, diagnostics };
}

/**
 * `count` fractions along a side, in order: the attach-slot contract when
 * the side is free, otherwise spread over the gaps between the occupied
 * fractions (each gap gets endpoints in proportion to its length).
 */
export function freeFractions(
	count: number,
	occupied: readonly number[],
): number[] {
	if (count <= 0) return [];
	if (occupied.length === 0) return attachSlotFractions(count);
	const stops = [0, ...[...occupied].sort((a, b) => a - b), 1];
	const gaps = stops.slice(1).map((end, index) => ({
		start: stops[index] as number,
		length: end - (stops[index] as number),
		count: 0,
	}));
	for (let placed = 0; placed < count; placed += 1) {
		let best = gaps[0] as (typeof gaps)[number];
		for (const gap of gaps) {
			if (
				gap.length / (gap.count + 1) >
				best.length / (best.count + 1) + 1e-9
			) {
				best = gap;
			}
		}
		best.count += 1;
	}
	return gaps.flatMap((gap) =>
		Array.from(
			{ length: gap.count },
			(_, index) => gap.start + (gap.length * (index + 1)) / (gap.count + 1),
		),
	);
}

function portPointOf(
	input: AssignSameSideSlotsInput,
	end: NormalizedEdge["source"],
): { otherPoint?: Point } {
	if (end.portId === undefined) return {};
	const point = input.portPoints?.get(end.nodeId)?.get(end.portId);
	return point === undefined ? {} : { otherPoint: point };
}

/**
 * A lone end sits at the middle of the span its box shares with the other
 * end's box along this side, so two facing lone ends line up and the route
 * runs straight instead of jogging a few pixels; facing a named port it
 * lines up with the port. Without either (or too near a corner) it keeps
 * the side's middle.
 */
function alignedFraction(
	side: "top" | "right" | "bottom" | "left",
	own: Box,
	other: Box,
	otherPoint?: Point,
): number {
	const horizontal = side === "top" || side === "bottom";
	const start = horizontal ? own.x : own.y;
	const length = horizontal ? own.width : own.height;
	if (otherPoint !== undefined && length > 0) {
		// Facing a named port: sit level with it when that stays on the side.
		const fraction =
			((horizontal ? otherPoint.x : otherPoint.y) - start) / length;
		if (fraction >= 0.2 && fraction <= 0.8) return fraction;
	}
	const otherStart = horizontal ? other.x : other.y;
	const otherLength = horizontal ? other.width : other.height;
	const lo = Math.max(start, otherStart);
	const hi = Math.min(start + length, otherStart + otherLength);
	if (length <= 0 || hi - lo < 8) return 0.5;
	const fraction = ((lo + hi) / 2 - start) / length;
	return Math.min(0.8, Math.max(0.2, fraction));
}

/**
 * Order key for ends sharing one node side, so their routes nest instead
 * of crossing at the node (#99 D). An end whose other node lies in front
 * of the side (beyond it along the outward normal) is ordered by where
 * that node sits. An end whose other node lies behind or beside it wraps
 * around the node: ends wrapping from before the side's middle take the
 * first slots, the farthest one closest to the middle (outermost route),
 * and ends wrapping from after it take the last slots, mirrored.
 */
export function nestedSlotKey(
	side: "top" | "right" | "bottom" | "left",
	own: Box,
	other: Point,
): number {
	const alongY = side === "left" || side === "right";
	const along = alongY ? other.y : other.x;
	const inFront =
		side === "left"
			? other.x < own.x
			: side === "right"
				? other.x > own.x + own.width
				: side === "top"
					? other.y < own.y
					: other.y > own.y + own.height;
	if (inFront) return 1e7 + along;
	const middle = alongY ? own.y + own.height / 2 : own.x + own.width / 2;
	return along < middle ? -along : 2e7 - along;
}

function centerOf(box: Box): Point {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function nonSideAnchor(anchor: string | undefined): boolean {
	return anchor !== undefined && cardinalSide(anchor) === undefined;
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
		// Flow sides follow the actual boxes: the wider gap between them
		// picks the axis. The other end mostly below or above picks
		// bottom/top (back-edges included); a same-rank pair, or one far
		// off to the side of a shallow step, picks left/right so the bend
		// is not squeezed into the short gap.
		const verticalGap = Math.max(
			other.y - (own.y + own.height),
			own.y - (other.y + other.height),
		);
		const horizontalGap = Math.max(
			other.x - (own.x + own.width),
			own.x - (other.x + other.width),
		);
		if (verticalGap > 0 && verticalGap >= horizontalGap) {
			return other.y > own.y ? "bottom" : "top";
		}
		if (dx !== 0) return dx > 0 ? "right" : "left";
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
