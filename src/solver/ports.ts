/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	attachSlotFractions,
	type computeShapeGeometry,
	sidePointAtFraction,
} from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	NormalizedDiagram,
	RoutingAllocationReport,
	RoutingGutterAllocation,
	RoutingRailAllocation,
} from "../ir/diagram.js";
import type {
	CoordinatedPort,
	NormalizedEdge,
	NormalizedNode,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type {
	LabelLayout,
	SolvedTextAnnotation,
	TextSurfaceKind,
} from "../ir/label-layout.js";
import { computeFanOutPorts } from "../routing/bus-router.js";
import type { TextStyleOptions } from "../text/types.js";
import type { CjkTypography } from "./cjk-typography.js";
import {
	boxCenter,
	MIN_PORT_EDGE_GAP,
	PORT_BOX_SIZE,
	recenterNodeLabelLayout,
	stableStrings,
} from "./helpers.js";
import type { PortShiftingOptions, SolveDiagramOptions } from "./options.js";

/** #91 equal-division fractions for named ports (same contract as attach slots). */
export function equalDivisionFractions(count: number): number[] {
	return attachSlotFractions(count);
}

export function buildRoutingAllocationReport(
	acceptedRails: readonly RoutingRailAllocation[],
	contentBounds: Box,
	reservedGutters: readonly RoutingGutterAllocation[] = [],
): RoutingAllocationReport | undefined {
	const rails = [...acceptedRails]
		.map((rail) => ({ ...rail, coordinate: Math.round(rail.coordinate) }))
		.sort(
			(left, right) =>
				left.index - right.index ||
				left.coordinate - right.coordinate ||
				left.edgeId.localeCompare(right.edgeId),
		);
	const gutters: RoutingAllocationReport["gutters"] = [
		...reservedGutters.map((gutter) => ({
			...gutter,
			box: { ...gutter.box },
		})),
	];
	const reservedSides = new Set(gutters.map((gutter) => gutter.side));
	const sides = stableStrings(rails.map((rail) => rail.side)) as Array<
		RoutingRailAllocation["side"]
	>;
	for (const side of sides) {
		if (reservedSides.has(side)) {
			continue;
		}
		const sideRails = rails.filter((rail) => rail.side === side);
		if (sideRails.length === 0) {
			continue;
		}
		const minCoordinate = Math.min(...sideRails.map((rail) => rail.coordinate));
		const maxCoordinate = Math.max(...sideRails.map((rail) => rail.coordinate));
		switch (side) {
			case "top":
				gutters.push({
					side,
					box: {
						x: contentBounds.x,
						y: minCoordinate,
						width: contentBounds.width,
						height: contentBounds.y - minCoordinate,
					},
					railCount: sideRails.length,
				});
				break;
			case "left":
				gutters.push({
					side,
					box: {
						x: minCoordinate,
						y: contentBounds.y,
						width: contentBounds.x - minCoordinate,
						height: contentBounds.height,
					},
					railCount: sideRails.length,
				});
				break;
			case "bottom":
				gutters.push({
					side,
					box: {
						x: contentBounds.x,
						y: contentBounds.y + contentBounds.height,
						width: contentBounds.width,
						height: maxCoordinate - (contentBounds.y + contentBounds.height),
					},
					railCount: sideRails.length,
				});
				break;
			case "right":
				gutters.push({
					side,
					box: {
						x: contentBounds.x + contentBounds.width,
						y: contentBounds.y,
						width: maxCoordinate - (contentBounds.x + contentBounds.width),
						height: contentBounds.height,
					},
					railCount: sideRails.length,
				});
				break;
		}
	}
	gutters.sort(
		(left, right) =>
			left.side.localeCompare(right.side) ||
			left.box.x - right.box.x ||
			left.box.y - right.box.y,
	);
	if (rails.length === 0 && gutters.length === 0) {
		return undefined;
	}
	return { rails, gutters };
}

export function computePolicyFanOutAnchors(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): Map<string, DistributedAnchor> {
	const config =
		typeof options.anchorCapacity === "object" ? options.anchorCapacity : {};
	const spacing = Math.max(1, config.minSpacing ?? 8);
	const groups = new Map<
		string,
		{
			nodeId: string;
			side: AnchorSide;
			role: EndpointRole;
			edgeIds: string[];
		}
	>();

	for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
		const sourceBox = boxes.get(edge.source.nodeId)?.box;
		const targetBox = boxes.get(edge.target.nodeId)?.box;
		if (sourceBox === undefined || targetBox === undefined) {
			continue;
		}
		if (
			edge.source.portId === undefined &&
			distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			) !== undefined
		) {
			const side = distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			);
			if (side !== undefined) {
				const key = `${edge.source.nodeId}:${side}:source`;
				const group = groups.get(key) ?? {
					nodeId: edge.source.nodeId,
					side,
					role: "source" as EndpointRole,
					edgeIds: [],
				};
				group.edgeIds.push(edge.id);
				groups.set(key, group);
			}
		}
		if (
			edge.target.portId === undefined &&
			distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			) !== undefined
		) {
			const side = distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			);
			if (side !== undefined) {
				const key = `${edge.target.nodeId}:${side}:target`;
				const group = groups.get(key) ?? {
					nodeId: edge.target.nodeId,
					side,
					role: "target" as EndpointRole,
					edgeIds: [],
				};
				group.edgeIds.push(edge.id);
				groups.set(key, group);
			}
		}
	}

	const distributed = new Map<string, DistributedAnchor>();
	for (const group of [...groups.values()].sort((a, b) =>
		`${a.nodeId}:${a.side}:${a.role}`.localeCompare(
			`${b.nodeId}:${b.side}:${b.role}`,
		),
	)) {
		if (group.edgeIds.length <= 1) continue;
		const box = boxes.get(group.nodeId)?.box;
		if (box === undefined) continue;
		const edgeIds = [...group.edgeIds].sort((a, b) => a.localeCompare(b));
		const fanOut = computeFanOutPorts(edgeIds, box, group.side, spacing);
		for (const edgeId of edgeIds) {
			const port = fanOut.get(edgeId);
			if (port === undefined) continue;
			distributed.set(endpointDistributionKey(edgeId, group.role), {
				anchor: group.side,
				point: port.anchor,
			});
		}
	}
	return distributed;
}

/**
 * Pre-expand node boxes whose sides cannot accommodate all ports
 * at the minimum spacing.  Runs before constraint solving so
 * containment, overlap repair, and swimlane contracts see the
 * expanded sizes (Codex P2: #42).
 */
export function expandNodeBoxesForPorts(
	nodes: readonly NormalizedNode[],
	boxes: Map<string, Box>,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	const shiftingEnabled = options.portShifting?.enabled ?? true;
	if (!shiftingEnabled) return;
	const requestedSpacing = options.portShifting?.spacing ?? 24;
	const minSpacing = Math.max(
		requestedSpacing,
		PORT_BOX_SIZE + MIN_PORT_EDGE_GAP,
	);

	for (const node of nodes) {
		if (node.ports === undefined || node.ports.length === 0) continue;
		const box = boxes.get(node.id);
		if (box === undefined) continue;

		// Aggregate required expansion per axis so all sides
		// are handled atomically (Codex P2: avoid stale anchors).
		let heightExpansion = 0;
		let widthExpansion = 0;

		const portsBySide = new Map<string, NormalizedNode["ports"]>();
		for (const port of node.ports) {
			const list = portsBySide.get(port.side) ?? [];
			list.push(port);
			portsBySide.set(port.side, list);
		}

		for (const [side, ports] of portsBySide) {
			const count = (ports ?? []).length;
			if (count <= 1) continue;
			const isVertical = side === "left" || side === "right";
			const availableSpan = isVertical ? box.height : box.width;
			const fractions = equalDivisionFractions(count);
			let minFractionGap = 1;
			for (let i = 0; i < fractions.length - 1; i += 1) {
				const left = fractions[i];
				const right = fractions[i + 1];
				if (left === undefined || right === undefined) continue;
				minFractionGap = Math.min(minFractionGap, right - left);
			}
			const requiredSpan =
				minFractionGap > 0
					? minSpacing / minFractionGap
					: (count - 1) * minSpacing + PORT_BOX_SIZE;
			if (requiredSpan > availableSpan) {
				const expansion = requiredSpan - availableSpan;
				if (isVertical) {
					heightExpansion = Math.max(heightExpansion, expansion);
				} else {
					widthExpansion = Math.max(widthExpansion, expansion);
				}
				diagnostics.push({
					severity: "info",
					code: "port_capacity_overflow",
					message: `Expanded node ${node.id} ${isVertical ? "height" : "width"} by ${Math.ceil(expansion)} px to fit ${count} port(s) on ${side} side.`,
					path: ["nodes", node.id, "ports"],
					detail: {
						nodeId: node.id,
						side,
						portCount: count,
						expansion: Math.ceil(expansion),
					},
				});
				diagnostics.push({
					severity: "warning",
					code: "routing.port.capacity_exhausted",
					message: `Node ${node.id} side ${side} required grow to place ${count} equal-division port(s).`,
					path: ["nodes", node.id, "ports"],
					detail: {
						nodeId: node.id,
						side,
						portCount: count,
						requiredSpan: Math.ceil(requiredSpan),
						availableSpan: Math.ceil(availableSpan),
						conflictClass: "fixed-geometry-block",
						remediationType: "grow-node-anchor-capacity",
					},
				});
			}
		}

		if (heightExpansion > 0) {
			box.y -= heightExpansion / 2;
			box.height += heightExpansion;
		}
		if (widthExpansion > 0) {
			box.x -= widthExpansion / 2;
			box.width += widthExpansion;
		}
		if (heightExpansion > 0 || widthExpansion > 0) {
			recenterNodeLabelLayout(node, box);
		}
	}
}

export type AnchorSide = "top" | "right" | "bottom" | "left";
export type EndpointRole = "source" | "target";

export interface DistributedAnchor {
	anchor: AnchorSide;
	point: Point;
}

export function expandNodeBoxesForAnchorCapacity(
	edges: readonly NormalizedEdge[],
	nodes: readonly NormalizedNode[],
	boxes: Map<string, Box>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	const enabled =
		options.anchorCapacity !== false &&
		(options.anchorCapacity !== undefined ||
			(options.routeKind ?? "orthogonal") === "obstacle-avoiding");
	if (!enabled) return;
	const config =
		typeof options.anchorCapacity === "object" ? options.anchorCapacity : {};
	const minSpacing = Math.max(1, config.minSpacing ?? 16);
	const grow = config.grow ?? true;
	const counts = new Map<string, Map<AnchorSide, number>>();
	const nodesById = new Map(nodes.map((node) => [node.id, node] as const));

	for (const edge of edges) {
		const sourceBox = boxes.get(edge.source.nodeId);
		const targetBox = boxes.get(edge.target.nodeId);
		if (sourceBox === undefined || targetBox === undefined) {
			continue;
		}
		if (edge.source.portId === undefined) {
			const sourceSide = distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			);
			if (sourceSide !== undefined) {
				incrementAnchorCount(counts, edge.source.nodeId, sourceSide);
			}
		}
		if (edge.target.portId === undefined) {
			const targetSide = distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			);
			if (targetSide !== undefined) {
				incrementAnchorCount(counts, edge.target.nodeId, targetSide);
			}
		}
	}

	for (const [nodeId, sideCounts] of [...counts.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		const box = boxes.get(nodeId);
		if (box === undefined) continue;
		let widthExpansion = 0;
		let heightExpansion = 0;
		for (const [side, count] of [...sideCounts.entries()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		)) {
			if (count <= 1) continue;
			const slotCount = Math.max(3, count);
			const vertical = side === "left" || side === "right";
			const availableSpan = vertical ? box.height : box.width;
			const requiredSpan = (slotCount - 1) * minSpacing + PORT_BOX_SIZE;
			if (requiredSpan <= availableSpan) continue;
			const expansion = requiredSpan - availableSpan;
			if (grow) {
				if (vertical) {
					heightExpansion = Math.max(heightExpansion, expansion);
				} else {
					widthExpansion = Math.max(widthExpansion, expansion);
				}
			} else {
				const expansion = Math.ceil(requiredSpan - availableSpan);
				const deltaWidth = vertical ? 0 : expansion;
				const deltaHeight = vertical ? expansion : 0;
				diagnostics.push({
					severity: "warning",
					code: "routing.anchor-capacity.requires-resize",
					message: `Node ${nodeId} needs ${Math.ceil(requiredSpan)} px on ${side} side to fit ${count} edge anchor(s) (reserved ${slotCount} slots).`,
					path: ["nodes", nodeId],
					detail: {
						nodeId,
						side,
						edgeCount: count,
						slotCount,
						availableSpan: Math.round(availableSpan),
						requiredSpan: Math.ceil(requiredSpan),
						required: Math.ceil(requiredSpan),
						available: Math.round(availableSpan),
						deltaWidth,
						deltaHeight,
						minSpacing,
						conflictClass: "fixed-geometry-block",
						remediationType: "grow-node-anchor-capacity",
						suggestedRemedy:
							"Increase node size, reduce same-side fanout, or enable anchorCapacity.grow.",
					},
				});
			}
		}
		if (widthExpansion > 0) {
			box.x -= widthExpansion / 2;
			box.width += widthExpansion;
		}
		if (heightExpansion > 0) {
			box.y -= heightExpansion / 2;
			box.height += heightExpansion;
		}
		if (heightExpansion > 0 || widthExpansion > 0) {
			const node = nodesById.get(nodeId);
			if (node !== undefined) {
				recenterNodeLabelLayout(node, box);
			}
		}
	}
}

export function incrementAnchorCount(
	counts: Map<string, Map<AnchorSide, number>>,
	nodeId: string,
	side: AnchorSide,
): void {
	const sideCounts = counts.get(nodeId) ?? new Map<AnchorSide, number>();
	sideCounts.set(side, (sideCounts.get(side) ?? 0) + 1);
	counts.set(nodeId, sideCounts);
}

export function anchorSideForEndpoint(
	anchor: NormalizedEdge["source"]["anchor"] | undefined,
	ownBox: Box,
	otherBox: Box,
	direction: NormalizedDiagram["direction"],
): AnchorSide {
	if (
		anchor === "top" ||
		anchor === "right" ||
		anchor === "bottom" ||
		anchor === "left"
	) {
		return anchor;
	}
	const ownCenter = boxCenter(ownBox);
	const otherCenter = boxCenter(otherBox);
	const dx = otherCenter.x - ownCenter.x;
	const dy = otherCenter.y - ownCenter.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		if (dx !== 0) {
			return dx > 0 ? "right" : "left";
		}
		return direction === "RL" ? "left" : "right";
	}
	if (dy !== 0) {
		return dy > 0 ? "bottom" : "top";
	}
	return direction === "BT" ? "top" : "bottom";
}

export function distributedAnchorPointsByEndpoint(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[] = [],
): Map<string, DistributedAnchor> {
	const enabled =
		options.anchorCapacity !== false &&
		(options.anchorCapacity !== undefined ||
			(options.routeKind ?? "orthogonal") === "obstacle-avoiding");
	if (!enabled) return new Map();

	const config =
		typeof options.anchorCapacity === "object" ? options.anchorCapacity : {};
	const minSpacing = Math.max(1, config.minSpacing ?? 16);
	const endpointsByNodeSide = new Map<
		string,
		{
			edgeId: string;
			role: EndpointRole;
			nodeId: string;
			side: AnchorSide;
		}[]
	>();

	for (const edge of edges) {
		const sourceBox = boxes.get(edge.source.nodeId)?.box;
		const targetBox = boxes.get(edge.target.nodeId)?.box;
		if (sourceBox === undefined || targetBox === undefined) {
			continue;
		}
		if (edge.source.portId === undefined) {
			const sourceSide = distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			);
			if (sourceSide !== undefined) {
				const key = `${edge.source.nodeId}:${sourceSide}`;
				const endpoints = endpointsByNodeSide.get(key) ?? [];
				endpoints.push({
					edgeId: edge.id,
					role: "source",
					nodeId: edge.source.nodeId,
					side: sourceSide,
				});
				endpointsByNodeSide.set(key, endpoints);
			}
		}
		if (edge.target.portId === undefined) {
			const targetSide = distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			);
			if (targetSide !== undefined) {
				const key = `${edge.target.nodeId}:${targetSide}`;
				const endpoints = endpointsByNodeSide.get(key) ?? [];
				endpoints.push({
					edgeId: edge.id,
					role: "target",
					nodeId: edge.target.nodeId,
					side: targetSide,
				});
				endpointsByNodeSide.set(key, endpoints);
			}
		}
	}

	const distributed = new Map<string, DistributedAnchor>();
	for (const endpoints of endpointsByNodeSide.values()) {
		if (endpoints.length <= 1) continue;
		const sorted = [...endpoints].sort((a, b) => {
			const byEdge = a.edgeId.localeCompare(b.edgeId);
			return byEdge === 0 ? a.role.localeCompare(b.role) : byEdge;
		});
		const first = sorted[0];
		if (first === undefined) continue;
		const box = boxes.get(first.nodeId)?.box;
		if (box === undefined) continue;
		const primarySide = first.side;
		const vertical = primarySide === "left" || primarySide === "right";
		const availableSpan = vertical ? box.height : box.width;
		const sideCapacity = Math.max(
			1,
			Math.floor((availableSpan - PORT_BOX_SIZE) / minSpacing) + 1,
		);
		const slotCount = Math.max(3, sorted.length);
		const primaryCapacity = Math.min(sideCapacity, slotCount);
		const primaryEndpoints = sorted.slice(0, primaryCapacity);
		const spilledEndpoints = sorted.slice(primaryCapacity);
		for (let index = 0; index < primaryEndpoints.length; index += 1) {
			const endpoint = primaryEndpoints[index];
			if (endpoint === undefined) continue;
			distributed.set(endpointDistributionKey(endpoint.edgeId, endpoint.role), {
				anchor: primarySide,
				point: distributedAnchorPoint(
					box,
					primarySide,
					index,
					Math.max(primaryEndpoints.length, Math.min(3, slotCount)),
					minSpacing,
				),
			});
		}
		if (spilledEndpoints.length > 0) {
			const spillSides = adjacentAnchorSides(primarySide);
			diagnostics.push({
				severity: "warning",
				code: "routing.anchor-capacity.requires-resize",
				message: `Node ${first.nodeId} side ${primarySide} saturated; spilling ${spilledEndpoints.length} anchor(s) to adjacent sides.`,
				path: ["nodes", first.nodeId],
				detail: {
					nodeId: first.nodeId,
					side: primarySide,
					edgeCount: sorted.length,
					slotCount,
					availableSpan: Math.round(availableSpan),
					requiredSpan: (slotCount - 1) * minSpacing + PORT_BOX_SIZE,
					required: (slotCount - 1) * minSpacing + PORT_BOX_SIZE,
					available: Math.round(availableSpan),
					spilled: spilledEndpoints.length,
					conflictClass: "fixed-geometry-block",
					remediationType: "grow-node-anchor-capacity",
					suggestedRemedy:
						"Increase node size, reduce same-side fanout, or enable anchorCapacity.grow.",
				},
			});
			for (
				let spillIndex = 0;
				spillIndex < spilledEndpoints.length;
				spillIndex += 1
			) {
				const endpoint = spilledEndpoints[spillIndex];
				if (endpoint === undefined) continue;
				const spillSide =
					spillSides[spillIndex % spillSides.length] ?? primarySide;
				const spillGroupIndex = Math.floor(spillIndex / spillSides.length);
				const spillGroupSize = Math.ceil(
					spilledEndpoints.length / spillSides.length,
				);
				distributed.set(
					endpointDistributionKey(endpoint.edgeId, endpoint.role),
					{
						anchor: spillSide,
						point: distributedAnchorPoint(
							box,
							spillSide,
							spillGroupIndex,
							Math.max(3, spillGroupSize),
							minSpacing,
						),
					},
				);
			}
		}
	}
	return distributed;
}

function adjacentAnchorSides(side: AnchorSide): AnchorSide[] {
	switch (side) {
		case "left":
		case "right":
			return ["top", "bottom"];
		case "top":
		case "bottom":
			return ["left", "right"];
	}
}

export function distributableAnchorSide(
	anchor: NormalizedEdge["source"]["anchor"] | undefined,
	ownBox: Box,
	otherBox: Box,
	direction: NormalizedDiagram["direction"],
): AnchorSide | undefined {
	if (anchor === undefined) {
		return anchorSideForEndpoint(anchor, ownBox, otherBox, direction);
	}
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

export function distributedAnchorPoint(
	box: Box,
	side: AnchorSide,
	index: number,
	count: number,
	minSpacing: number,
): Point {
	const center = boxCenter(box);
	const vertical = side === "left" || side === "right";
	const span = vertical ? box.height : box.width;
	const usableSpan = Math.max(0, span - PORT_BOX_SIZE);
	const spacing =
		count <= 1 ? 0 : Math.min(minSpacing, usableSpan / Math.max(1, count - 1));
	const offset = (index - (count - 1) / 2) * spacing;
	switch (side) {
		case "left":
			return { x: box.x, y: center.y + offset };
		case "right":
			return { x: box.x + box.width, y: center.y + offset };
		case "top":
			return { x: center.x + offset, y: box.y };
		case "bottom":
			return { x: center.x + offset, y: box.y + box.height };
	}
}

export function endpointDistributionKey(
	edgeId: string,
	role: EndpointRole,
): string {
	return `${edgeId}:${role}`;
}

export function withDistributedAnchor(
	geometry: ReturnType<typeof computeShapeGeometry>,
	distributed: DistributedAnchor | undefined,
): ReturnType<typeof computeShapeGeometry> {
	if (distributed === undefined) return geometry;
	return {
		...geometry,
		anchors: geometry.anchors.map((anchor) =>
			anchor.name === distributed.anchor
				? { ...anchor, point: distributed.point }
				: anchor,
		),
	};
}

export function coordinatePorts(
	node: NormalizedNode,
	nodeBox: Box,
	portShifting: PortShiftingOptions | undefined,
): CoordinatedPort[] {
	const portsBySide = new Map<string, NormalizedNode["ports"]>();
	for (const port of node.ports ?? []) {
		const ports = portsBySide.get(port.side) ?? [];
		ports.push(port);
		portsBySide.set(port.side, ports);
	}

	const coordinated: CoordinatedPort[] = [];
	for (const [side, ports] of portsBySide) {
		const sorted = [...(ports ?? [])].sort((a, b) => {
			const order = (a.order ?? 0) - (b.order ?? 0);
			return order === 0 ? a.id.localeCompare(b.id) : order;
		});
		for (let index = 0; index < sorted.length; index += 1) {
			const port = sorted[index];
			if (port === undefined) {
				continue;
			}
			const anchor = portAnchor(
				nodeBox,
				side as CoordinatedPort["side"],
				index,
				sorted.length,
				portShifting,
			);
			const box = portBox(anchor);
			coordinated.push({ ...port, box, anchor });
		}
	}

	return coordinated.sort((a, b) => a.id.localeCompare(b.id));
}

export function portAnchor(
	nodeBox: Box,
	side: CoordinatedPort["side"],
	index: number,
	count: number,
	_portShifting: PortShiftingOptions | undefined,
): Point {
	// #91: named ports use equal-division fractions (25/50/75 contract),
	// not mid-centered even spacing that ignores quarter slots.
	const fractions = equalDivisionFractions(count);
	const fraction = fractions[Math.min(index, fractions.length - 1)] ?? 0.5;
	return sidePointAtFraction(nodeBox, side, fraction);
}

export function portBox(anchor: Point): Box {
	const size = PORT_BOX_SIZE;
	return {
		x: anchor.x - size / 2,
		y: anchor.y - size / 2,
		width: size,
		height: size,
	};
}

export function portLabelBox(port: CoordinatedPort): Box {
	const textWidth = Math.max(0, (port.label?.text.length ?? 0) * 6);
	const height = 12;
	const gap = 8;
	const x =
		port.side === "left"
			? port.anchor.x - gap - textWidth
			: port.anchor.x + gap;
	return {
		x,
		y: port.anchor.y - 8 - height,
		width: textWidth,
		height,
	};
}

export function isHorizontalRailEndpointSide(side: AnchorSide): boolean {
	return side === "left" || side === "right";
}

export function isVerticalRailEndpointSide(side: AnchorSide): boolean {
	return side === "top" || side === "bottom";
}

export function buildAnchorCenteredTextAnnotation(input: {
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	layout: LabelLayout;
	typography?: CjkTypography;
	anchor: Box;
}): SolvedTextAnnotation {
	return buildCenteredTextAnnotation({
		ownerId: input.ownerId,
		surfaceKind: input.surfaceKind,
		...(input.surfaceIndex === undefined
			? {}
			: { surfaceIndex: input.surfaceIndex }),
		layout: input.layout,
		...(input.typography === undefined ? {} : { typography: input.typography }),
		center: {
			x: input.anchor.x + input.anchor.width / 2,
			y: input.anchor.y + input.anchor.height / 2,
		},
		anchor: input.anchor,
	});
}

export function textExtendsOutsideAnchor(
	annotation: SolvedTextAnnotation,
): boolean {
	if (!("width" in annotation.anchor)) {
		return true;
	}
	const epsilon = 0.001;
	return (
		annotation.box.x < annotation.anchor.x - epsilon ||
		annotation.box.y < annotation.anchor.y - epsilon ||
		annotation.box.x + annotation.box.width >
			annotation.anchor.x + annotation.anchor.width + epsilon ||
		annotation.box.y + annotation.box.height >
			annotation.anchor.y + annotation.anchor.height + epsilon
	);
}

export function portGeometry(
	nodeGeometry: ReturnType<typeof computeShapeGeometry>,
	port: CoordinatedPort | undefined,
): ReturnType<typeof computeShapeGeometry> {
	if (port === undefined) {
		return nodeGeometry;
	}
	// #91: pin only the port's own side (and center) to the port anchor.
	// Sibling free edges must still see normal cardinal side slots.
	return {
		...nodeGeometry,
		center: port.anchor,
		anchors: nodeGeometry.anchors.map((anchor) =>
			anchor.name === port.side || anchor.name === "center"
				? { name: anchor.name, point: port.anchor }
				: { ...anchor, point: { ...anchor.point } },
		),
		obstacleBox: nodeGeometry.obstacleBox,
	};
}

export function normalizeOutputFontFamily(font: TextStyleOptions): string {
	return font.fontFamily === "Arial" ? "Arial, sans-serif" : font.fontFamily;
}

export function buildCenteredTextAnnotation(input: {
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	placement?: SolvedTextAnnotation["placement"];
	placementDetail?: SolvedTextAnnotation["placementDetail"];
	layout: LabelLayout;
	typography?: CjkTypography;
	center: Point;
	anchor?: Box | Point;
}): SolvedTextAnnotation {
	return {
		text: input.layout.text,
		ownerId: input.ownerId,
		surfaceKind: input.surfaceKind,
		...(input.surfaceIndex === undefined
			? {}
			: { surfaceIndex: input.surfaceIndex }),
		...(input.placement === undefined ? {} : { placement: input.placement }),
		...(input.placementDetail === undefined
			? {}
			: { placementDetail: input.placementDetail }),
		box: {
			x: input.center.x - input.layout.box.width / 2,
			y: input.center.y - input.layout.box.height / 2,
			width: input.layout.box.width,
			height: input.layout.box.height,
		},
		anchor: input.anchor ?? input.center,
		paddings: input.layout.padding,
		lines: input.layout.lines,
		fontFamily:
			input.typography?.fontFamily ??
			normalizeOutputFontFamily(input.layout.font),
		fontSize: input.typography?.fontSize ?? input.layout.font.fontSize,
		textBackend: input.layout.textBackend,
	};
}
