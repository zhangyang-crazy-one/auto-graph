/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	type computeShapeGeometry,
	createBoxSpatialIndex,
	expandBox,
	intersectsAabb,
	queryBoxSpatialIndex,
} from "../geometry/index.js";
import { getEdgePort } from "../geometry/shapes.js";
import type { Diagnostic, RouteConflictClass } from "../ir/diagnostics.js";
import type {
	NormalizedDiagram,
	PagePolicy,
	RoutingRailAllocation,
} from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedGroup,
	CoordinatedNode,
	NormalizedEdge,
} from "../ir/elements.js";
import type { AnchorName, Box, Insets, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import { type RouteHardObstacleMetadata, routeEdge } from "../routing/index.js";
import {
	ancestorGroupIds,
	compactDetail,
	DEFAULT_RAIL_BUDGET,
	edgeCorridorBox,
	insetBox,
	isEdgeConnectedTextAnnotation,
	labelOffset,
	pointInsideBox,
	policyUsesFanOutBundles,
	RAIL_BAND_SOFT_OBSTACLE_MAX,
	rangesOverlap,
	stableStrings,
} from "./helpers.js";
import { isSameRankEdge } from "./initial-layout.js";
import type { SolveDiagramOptions } from "./options.js";
import { PAGE_POLICY_SAME_RANK_DEPENDENCY_MIN } from "./page-policy.js";
import type { DistributedAnchor } from "./ports.js";
import {
	anchorSideForEndpoint,
	computePolicyFanOutAnchors,
	distributedAnchorPointsByEndpoint,
	endpointDistributionKey,
	isHorizontalRailEndpointSide,
	isVerticalRailEndpointSide,
	portGeometry,
	textExtendsOutsideAnchor,
	withDistributedAnchor,
} from "./ports.js";

export function resourceFlowLabelHardObstacles(
	textAnnotations: readonly SolvedTextAnnotation[],
	pagePolicy: PagePolicy,
	options: SolveDiagramOptions,
): Box[] {
	if (pagePolicy !== "resource-flow" && pagePolicy !== "ibd-high-fan-in") {
		return [];
	}
	return textAnnotations
		.filter((annotation) => annotation.surfaceKind === "node-label")
		.filter((annotation) => {
			const text = annotation.text.trim().toLowerCase();
			return (
				text.includes("resource coordination") ||
				annotation.ownerId === "dense-label-cell"
			);
		})
		.map((annotation) => {
			// Shrink slightly so endpoint stubs on nearby nodes are not trapped
			// inside the hard band while the central cluster remains blocked.
			const box = textObstacleBox(annotation, options);
			const inset = Math.min(8, box.width / 6, box.height / 6);
			return {
				x: box.x + inset,
				y: box.y + inset,
				width: Math.max(0, box.width - inset * 2),
				height: Math.max(0, box.height - inset * 2),
			};
		})
		.filter((box) => box.width > 0 && box.height > 0);
}

export function railAllocationForRoute(
	edgeId: string,
	points: readonly Point[],
	direction: NormalizedDiagram["direction"],
	railIndex: number,
	side: RoutingRailAllocation["side"],
): RoutingRailAllocation {
	const horizontal = direction === "LR" || direction === "RL";
	return {
		edgeId,
		axis: horizontal ? "y" : "x",
		side,
		coordinate: horizontal
			? side === "bottom"
				? Math.max(...points.map((point) => point.y))
				: Math.min(...points.map((point) => point.y))
			: side === "right"
				? Math.max(...points.map((point) => point.x))
				: Math.min(...points.map((point) => point.x)),
		index: railIndex,
	};
}

export interface NodeObstacleEntry {
	id: string;
	box: Box;
}

export function coordinateEdges(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	coordinatedNodes: readonly CoordinatedNode[],
	nodeObstacles: readonly NodeObstacleEntry[],
	softObstacles: readonly Box[],
	textObstacles: readonly SolvedTextAnnotation[],
	hardObstacles: readonly Box[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
	groups: readonly CoordinatedGroup[],
	contentBounds: Box,
	allocationEdges: readonly NormalizedEdge[] = edges,
	avoidFrameTitleRails = false,
	hardObstacleMetadata?: readonly RouteHardObstacleMetadata[],
	railAllocations?: Map<string, RoutingRailAllocation>,
): CoordinatedEdge[] {
	const coordinated: CoordinatedEdge[] = [];
	const coordinatedNodeById = new Map(
		coordinatedNodes.map((node) => [node.id, node]),
	);
	// Compute adaptive corridor margin for corner-graph prefilter (Issue #66).
	// "auto" uses 30% of the content diagonal (min 200 px) so the corridor
	// covers ~60% of the page on dense diagrams instead of the old fixed 32 px.
	const corridorMarginOption = options.corridorMargin ?? "auto";
	const corridorMargin: number =
		typeof corridorMarginOption === "number"
			? corridorMarginOption
			: Math.max(
					200,
					Math.hypot(contentBounds.width, contentBounds.height) * 0.3,
				);

	// Effective query gutter for node-obstacle prefilter. Only widen for
	// obstacle-avoiding routes that actually use the adaptive corridor —
	// other route kinds should respect the caller's routingGutter as-is to
	// avoid unnecessary detours from over-including nodes (Codex P2).
	const routingGutter = options.routingGutter ?? 160;
	const queryGutter =
		(options.routeKind ?? "orthogonal") === "obstacle-avoiding"
			? Math.max(routingGutter, corridorMargin)
			: routingGutter;
	const nodeObstacleIndex = createBoxSpatialIndex(
		nodeObstacles.map((entry) => ({ id: entry.id, box: entry.box })),
		queryGutter,
	);
	const railIndexByEdgeId = railRouteIndexByEdgeId(
		allocationEdges,
		nodes,
		direction,
		options,
	);
	const railOccupancy = createRailOccupancyState();
	// Policy fan-out (resource-flow / ibd-high-fan-in) replaces
	// distributedAnchorPointsByEndpoint for eligible endpoints so each
	// edge is mutated once. Explicit portId / corner anchors are skipped.
	const policyFanOutAnchors = policyUsesFanOutBundles(options.pagePolicy)
		? computePolicyFanOutAnchors(allocationEdges, nodes, direction, options)
		: new Map<string, DistributedAnchor>();
	const distributedAnchors = policyUsesFanOutBundles(options.pagePolicy)
		? new Map<string, DistributedAnchor>()
		: distributedAnchorPointsByEndpoint(
				allocationEdges,
				nodes,
				direction,
				options,
				diagnostics,
			);
	const routeHardObstacleMetadata =
		hardObstacleMetadata ??
		hardObstacles.map(() => ({ kind: "evidence" as const }));

	for (const edge of edges) {
		railAllocations?.delete(edge.id);
		const source = nodes.get(edge.source.nodeId);
		const target = nodes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) {
			diagnostics.push({
				severity: "error",
				code: "solver.edge-reference.missing",
				message: `Edge ${edge.id} references a missing coordinated node.`,
				path: ["edges", edge.id],
				detail: {
					edgeId: edge.id,
					sourceId: edge.source.nodeId,
					targetId: edge.target.nodeId,
				},
			});
			continue;
		}
		const sourcePort = coordinatedNodeById
			.get(edge.source.nodeId)
			?.ports?.find((port) => port.id === edge.source.portId);
		const targetPort = coordinatedNodeById
			.get(edge.target.nodeId)
			?.ports?.find((port) => port.id === edge.target.portId);
		const sourceDistributedAnchor =
			policyFanOutAnchors.get(endpointDistributionKey(edge.id, "source")) ??
			distributedAnchors.get(endpointDistributionKey(edge.id, "source"));
		const targetDistributedAnchor =
			policyFanOutAnchors.get(endpointDistributionKey(edge.id, "target")) ??
			distributedAnchors.get(endpointDistributionKey(edge.id, "target"));
		const sourceGeometry = withDistributedAnchor(
			portGeometry(source, sourcePort),
			sourceDistributedAnchor,
		);
		const targetGeometry = withDistributedAnchor(
			portGeometry(target, targetPort),
			targetDistributedAnchor,
		);
		const sourceAnchor =
			edge.source.anchor ?? sourceDistributedAnchor?.anchor ?? sourcePort?.side;
		const targetAnchor =
			edge.target.anchor ?? targetDistributedAnchor?.anchor ?? targetPort?.side;
		const routeTextObstacles = textObstacles
			.filter(isLocalRouteClearanceText)
			.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
			.map((annotation) => textObstacleBox(annotation, options));
		const railTextObstacles = textObstacles
			.filter(isLocalRouteClearanceText)
			.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
			.map((annotation) => textObstacleBox(annotation, options));
		const corridor = edgeCorridorBox(source.box, target.box, queryGutter);
		const routeNodeObstacles = queryBoxSpatialIndex(nodeObstacleIndex, corridor)
			.filter(
				(entry) =>
					entry.id !== edge.source.nodeId && entry.id !== edge.target.nodeId,
			)
			.map((entry) => entry.box);
		const routeGroupObstacles = groupObstaclesForEdge(
			edge,
			groups,
			options.obstacleMargin ?? 0,
		);
		const railCandidate = railIndexByEdgeId.get(edge.id);
		if (railCandidate !== undefined) {
			const railNodeObstacles = nodeObstacles
				.filter(
					(obstacle) =>
						obstacle.id !== edge.source.nodeId &&
						obstacle.id !== edge.target.nodeId,
				)
				.map((obstacle) => obstacle.box);
			const railSoftObstacles = [
				...railNodeObstacles,
				...softObstacles,
				...routeGroupObstacles,
				...railTextObstacles,
			];
			const acceptedRail = tryAcceptDependencyRail({
				edgeId: edge.id,
				source: sourceGeometry,
				target: targetGeometry,
				sourceAnchor,
				targetAnchor,
				direction,
				contentBounds,
				candidateIndex: railCandidate.index,
				side: railCandidate.side,
				laneIndex: railCandidate.laneIndex,
				avoidFrameTitleRails,
				railSoftObstacles,
				railBandObstacles: railTextObstacles,
				hardObstacles,
				occupancy: railOccupancy,
			});
			if (acceptedRail !== undefined) {
				railAllocations?.set(edge.id, acceptedRail.allocation);
				if (acceptedRail.overBudget) {
					diagnostics.push(
						railCapacityDiagnostic(
							edge.id,
							acceptedRail.allocation.index,
							acceptedRail.required,
							acceptedRail.available,
							edge.source.nodeId,
							edge.target.nodeId,
						),
					);
				}
				coordinated.push({
					...edge,
					points: acceptedRail.points,
				});
				continue;
			}
		}

		const route = routeEdge({
			kind: options.routeKind ?? "orthogonal",
			direction,
			source: sourceGeometry,
			target: targetGeometry,
			...(sourceAnchor === undefined ? {} : { sourceAnchor }),
			...(targetAnchor === undefined ? {} : { targetAnchor }),
			obstacles: [
				...routeNodeObstacles,
				...softObstacles,
				...routeGroupObstacles,
				...routeTextObstacles,
			],
			hardObstacles,
			hardObstacleMetadata: routeHardObstacleMetadata,
			corridorMargin,
			...(options.maxCorners === undefined
				? {}
				: { maxCorners: options.maxCorners }),
			...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
			...(options.maxRoutingAttempts === undefined
				? {}
				: { maxRoutingAttempts: options.maxRoutingAttempts }),
			...(options.maxBacktrackingRatio === undefined
				? {}
				: { maxBacktrackingRatio: options.maxBacktrackingRatio }),
			...(() => {
				const densePolicy =
					options.deliverabilityMode === "strict" ||
					options.pagePolicy === "dependency" ||
					options.pagePolicy === "resource-flow" ||
					options.pagePolicy === "ibd-high-fan-in";
				const maxDetourRatio =
					options.maxDetourRatio ?? (densePolicy ? 3 : undefined);
				const maxAttachPointsPerSide =
					options.maxAttachPointsPerSide ?? (densePolicy ? 3 : undefined);
				return {
					...(maxDetourRatio === undefined ? {} : { maxDetourRatio }),
					...(maxAttachPointsPerSide === undefined
						? {}
						: { maxAttachPointsPerSide }),
				};
			})(),
			...(options.deliverabilityMode === "degraded-ok"
				? { fallbackSeverity: "warning" as const }
				: {}),
			...(options.textObstacleVertices === undefined
				? {}
				: { textObstacleVertices: options.textObstacleVertices }),
		});
		diagnostics.push(
			...route.diagnostics.map((diagnostic) => ({
				...diagnostic,
				detail: { ...diagnostic.detail, edgeId: edge.id },
			})),
		);
		coordinated.push({
			...edge,
			points: route.points,
		});
	}

	return coordinated;
}

export type RailOccupancyState = Map<
	RoutingRailAllocation["side"],
	Set<number>
>;

export interface RailRouteCandidate {
	index: number;
	side: RoutingRailAllocation["side"];
	laneIndex: number;
}

export function createRailOccupancyState(): RailOccupancyState {
	return new Map();
}

export function isRailLaneOccupied(
	occupancy: RailOccupancyState,
	side: RoutingRailAllocation["side"],
	laneIndex: number,
): boolean {
	return occupancy.get(side)?.has(laneIndex) === true;
}

export function markRailLaneOccupied(
	occupancy: RailOccupancyState,
	side: RoutingRailAllocation["side"],
	laneIndex: number,
): void {
	const lanes = occupancy.get(side);
	if (lanes === undefined) {
		occupancy.set(side, new Set([laneIndex]));
		return;
	}
	lanes.add(laneIndex);
}

export function scoreRailBandOccupancy(
	railPoints: readonly Point[],
	softObstacles: readonly Box[],
	side: RoutingRailAllocation["side"],
	direction: NormalizedDiagram["direction"],
): number {
	const band = railBandBox(railPoints, side, direction);
	if (band === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	let count = 0;
	for (const obstacle of softObstacles) {
		if (intersectsAabb(band, obstacle)) {
			count += 1;
		}
	}
	return count;
}

export function railBandBox(
	railPoints: readonly Point[],
	side: RoutingRailAllocation["side"],
	direction: NormalizedDiagram["direction"],
): Box | undefined {
	const horizontal = direction === "LR" || direction === "RL";
	if (horizontal) {
		const railYs = railPoints
			.map((point) => point.y)
			.filter((y, index, values) => values.indexOf(y) === index);
		const railY =
			side === "bottom"
				? Math.max(...railPoints.map((point) => point.y))
				: Math.min(...railPoints.map((point) => point.y));
		if (!railYs.includes(railY)) {
			return undefined;
		}
		const xs = railPoints.map((point) => point.x);
		return {
			x: Math.min(...xs),
			y: railY - 4,
			width: Math.max(0, Math.max(...xs) - Math.min(...xs)),
			height: 8,
		};
	}
	const railX =
		side === "right"
			? Math.max(...railPoints.map((point) => point.x))
			: Math.min(...railPoints.map((point) => point.x));
	const ys = railPoints.map((point) => point.y);
	return {
		x: railX - 4,
		y: Math.min(...ys),
		width: 8,
		height: Math.max(0, Math.max(...ys) - Math.min(...ys)),
	};
}

export function tryAcceptDependencyRail(input: {
	edgeId: string;
	source: ReturnType<typeof computeShapeGeometry>;
	target: ReturnType<typeof computeShapeGeometry>;
	sourceAnchor: AnchorName | undefined;
	targetAnchor: AnchorName | undefined;
	direction: NormalizedDiagram["direction"];
	contentBounds: Box;
	candidateIndex: number;
	side: RoutingRailAllocation["side"];
	laneIndex: number;
	avoidFrameTitleRails: boolean;
	railSoftObstacles: readonly Box[];
	railBandObstacles: readonly Box[];
	hardObstacles: readonly Box[];
	occupancy: RailOccupancyState;
}):
	| {
			points: Point[];
			allocation: RoutingRailAllocation;
			overBudget: boolean;
			required: number;
			available: number;
	  }
	| undefined {
	const { side, laneIndex } = input;
	if (isRailLaneOccupied(input.occupancy, side, laneIndex)) {
		return undefined;
	}
	const railPoints = railRoutePoints(
		input.source,
		input.target,
		input.sourceAnchor,
		input.targetAnchor,
		input.direction,
		input.contentBounds,
		laneIndex,
		side,
		input.avoidFrameTitleRails,
	);
	if (railPoints === undefined) {
		return undefined;
	}
	const softDensity = scoreRailBandOccupancy(
		railPoints,
		input.railBandObstacles,
		side,
		input.direction,
	);
	if (softDensity > RAIL_BAND_SOFT_OBSTACLE_MAX) {
		return undefined;
	}
	if (
		routeCrossesBoxes(railPoints, input.railSoftObstacles) ||
		routeCrossesBoxes(railPoints, input.hardObstacles)
	) {
		return undefined;
	}
	markRailLaneOccupied(input.occupancy, side, laneIndex);
	const required = input.candidateIndex + 1;
	const available = DEFAULT_RAIL_BUDGET;
	return {
		points: railPoints,
		allocation: railAllocationForRoute(
			input.edgeId,
			railPoints,
			input.direction,
			input.candidateIndex,
			side,
		),
		overBudget: required > available,
		required,
		available,
	};
}

export function railCapacityDiagnostic(
	edgeId: string,
	railIndex: number,
	required: number,
	available: number,
	sourceId: string,
	targetId: string,
): Diagnostic {
	return {
		severity: "warning",
		code: "routing.rail-capacity.exceeded",
		message: `Rail routing for edge ${edgeId} exceeded the recommended ${available}-lane budget (required ${required}).`,
		path: ["edges", edgeId],
		detail: {
			edgeId,
			railIndex,
			required,
			available,
			sourceId,
			targetId,
			conflictClass: "rail-lane-overflow",
			remediationType: "increase-rails-or-split",
			suggestedRemedy:
				"Split the dependency group, increase page bounds, or use explicit constraints.",
		},
	};
}

export function railRouteIndexByEdgeId(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): Map<string, RailRouteCandidate> {
	if (!dependencyRailsEnabled(options)) {
		return new Map();
	}
	const candidates = edges
		.filter((edge) => {
			const source = nodes.get(edge.source.nodeId);
			const target = nodes.get(edge.target.nodeId);
			if (source === undefined || target === undefined) return false;
			if (source.box === target.box) return false;
			return isSameRankEdge(source, target, direction);
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	if (
		options.railRouting === "auto" &&
		options.pagePolicy !== "dependency" &&
		candidates.length < PAGE_POLICY_SAME_RANK_DEPENDENCY_MIN
	) {
		return new Map();
	}
	const horizontal = direction === "LR" || direction === "RL";
	return new Map(
		candidates.map((edge, index) => {
			const useSecondary = index % 2 === 1;
			const side: RoutingRailAllocation["side"] = horizontal
				? useSecondary
					? "bottom"
					: "top"
				: useSecondary
					? "right"
					: "left";
			return [
				edge.id,
				{
					index,
					side,
					laneIndex: Math.floor(index / 2),
				} satisfies RailRouteCandidate,
			];
		}),
	);
}

export function dependencyRailsEnabled(options: SolveDiagramOptions): boolean {
	// Explicit opt-out wins over pagePolicy so callers can disable rails on
	// dependency pages without changing the classified policy.
	if (options.railRouting === false) {
		return false;
	}
	if (options.pagePolicy === "dependency") {
		return true;
	}
	if (options.pagePolicy === "off") {
		return (
			options.railRouting === "dependency" || options.railRouting === "auto"
		);
	}
	if (options.railRouting === undefined) {
		return false;
	}
	if (
		options.railRouting === "auto" &&
		(options.routeKind ?? "orthogonal") !== "obstacle-avoiding"
	) {
		return false;
	}
	return options.railRouting === "dependency" || options.railRouting === "auto";
}

export function railRoutePoints(
	source: ReturnType<typeof computeShapeGeometry>,
	target: ReturnType<typeof computeShapeGeometry>,
	sourceAnchor: AnchorName | undefined,
	targetAnchor: AnchorName | undefined,
	direction: NormalizedDiagram["direction"],
	contentBounds: Box,
	laneIndex: number,
	side: RoutingRailAllocation["side"],
	avoidFrameTitleRails: boolean,
): Point[] | undefined {
	const gap = 18;
	if (direction === "LR" || direction === "RL") {
		const sourceSide =
			sourceAnchor === undefined
				? direction === "RL"
					? "left"
					: "right"
				: anchorSideForEndpoint(
						sourceAnchor,
						source.box,
						target.box,
						direction,
					);
		const targetSide =
			targetAnchor === undefined
				? direction === "RL"
					? "right"
					: "left"
				: anchorSideForEndpoint(
						targetAnchor,
						target.box,
						source.box,
						direction,
					);
		if (
			!isHorizontalRailEndpointSide(sourceSide) ||
			!isHorizontalRailEndpointSide(targetSide)
		) {
			return undefined;
		}
		const start = getEdgePort(
			source,
			target.center,
			sourceAnchor ?? sourceSide,
		);
		const end = getEdgePort(target, source.center, targetAnchor ?? targetSide);
		const sourceOutward =
			side === "bottom"
				? sourceSide === "left"
					? contentBounds.x - 64
					: contentBounds.x + contentBounds.width + 64
				: sourceSide === "left"
					? start.x - gap
					: start.x + gap;
		const targetOutward =
			side === "bottom"
				? targetSide === "left"
					? contentBounds.x - 64
					: contentBounds.x + contentBounds.width + 64
				: targetSide === "left"
					? end.x - gap
					: end.x + gap;
		const sourceJogX = avoidFrameTitleJogX(
			sourceOutward,
			contentBounds,
			gap,
			avoidFrameTitleRails,
		);
		const targetJogX = avoidFrameTitleJogX(
			targetOutward,
			contentBounds,
			gap,
			avoidFrameTitleRails,
		);
		const railY =
			side === "bottom"
				? contentBounds.y + contentBounds.height + 64 + laneIndex * gap
				: contentBounds.y -
					64 -
					(avoidFrameTitleRails ? 48 : 0) -
					laneIndex * gap;
		return compactRoutePoints([
			start,
			{ x: sourceJogX, y: start.y },
			{ x: sourceJogX, y: railY },
			{ x: targetJogX, y: railY },
			{ x: targetJogX, y: end.y },
			end,
		]);
	}
	const sourceSide =
		sourceAnchor === undefined
			? direction === "BT"
				? "top"
				: "bottom"
			: anchorSideForEndpoint(sourceAnchor, source.box, target.box, direction);
	const targetSide =
		targetAnchor === undefined
			? direction === "BT"
				? "bottom"
				: "top"
			: anchorSideForEndpoint(targetAnchor, target.box, source.box, direction);
	if (
		!isVerticalRailEndpointSide(sourceSide) ||
		!isVerticalRailEndpointSide(targetSide)
	) {
		return undefined;
	}
	const start = getEdgePort(source, target.center, sourceAnchor ?? sourceSide);
	const end = getEdgePort(target, source.center, targetAnchor ?? targetSide);
	const sourceJogY =
		side === "right"
			? sourceSide === "top"
				? contentBounds.y - 64
				: contentBounds.y + contentBounds.height + 64
			: sourceSide === "top"
				? start.y - gap
				: start.y + gap;
	const targetJogY =
		side === "right"
			? targetSide === "top"
				? contentBounds.y - 64
				: contentBounds.y + contentBounds.height + 64
			: targetSide === "top"
				? end.y - gap
				: end.y + gap;
	const railX =
		side === "right"
			? contentBounds.x + contentBounds.width + 64 + laneIndex * gap
			: contentBounds.x - 64 - laneIndex * gap;
	return compactRoutePoints([
		start,
		{ x: start.x, y: sourceJogY },
		{ x: railX, y: sourceJogY },
		{ x: railX, y: targetJogY },
		{ x: end.x, y: targetJogY },
		end,
	]);
}

export function avoidFrameTitleJogX(
	jogX: number,
	contentBounds: Box,
	gap: number,
	enabled: boolean,
): number {
	if (!enabled) {
		return jogX;
	}
	const reservedTitleLeft = contentBounds.x - 64;
	const reservedTitleRight = contentBounds.x + 220;
	if (jogX >= reservedTitleLeft && jogX <= reservedTitleRight) {
		return reservedTitleRight + gap;
	}
	return jogX;
}

export function compactRoutePoints(points: readonly Point[]): Point[] {
	const compacted: Point[] = [];
	for (const point of points) {
		const previous = compacted[compacted.length - 1];
		if (
			previous === undefined ||
			previous.x !== point.x ||
			previous.y !== point.y
		) {
			compacted.push(point);
		}
	}
	return compacted;
}

export function routeCrossesBoxes(
	points: readonly Point[],
	obstacles: readonly Box[],
): boolean {
	for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
		const start = points[pointIndex];
		const end = points[pointIndex + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const segment = segmentBox(start, end);
		for (const obstacle of obstacles) {
			if (intersectsAabb(segment, obstacle)) {
				return true;
			}
		}
	}
	return false;
}

export function segmentBox(start: Point, end: Point): Box {
	return {
		x: Math.min(start.x, end.x),
		y: Math.min(start.y, end.y),
		width: Math.abs(end.x - start.x),
		height: Math.abs(end.y - start.y),
	};
}

/**
 * Return group boxes that should act as soft routing obstacles for a
 * given edge.  Groups that contain both endpoints (or are ancestors
 * of such groups) are skipped — an edge entirely inside a container
 * is free to route within that container (Issue #41).
 */
export function groupObstaclesForEdge(
	edge: NormalizedEdge,
	groups: readonly CoordinatedGroup[],
	margin: number | Insets,
): Box[] {
	const sourceAncestors = ancestorGroupIds(groups, edge.source.nodeId);
	const targetAncestors = ancestorGroupIds(groups, edge.target.nodeId);
	// Edges that touch a group (at least one endpoint inside)
	// are allowed to cross its boundary; only fully external
	// edges must detour around the group box.
	return groups
		.filter((group) => {
			if (sourceAncestors.has(group.id) || targetAncestors.has(group.id)) {
				return false;
			}
			return true;
		})
		.map((group) => (margin === 0 ? group.box : expandBox(group.box, margin)));
}

export function reportRouteTextClearance(
	edges: readonly CoordinatedEdge[],
	annotations: readonly SolvedTextAnnotation[],
	options: SolveDiagramOptions = {},
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const relevantAnnotations = annotations.filter(isLocalRouteClearanceText);
	const tolerance = options.textIntersectionTolerance ?? 2;

	for (const edge of edges) {
		for (const annotation of relevantAnnotations) {
			if (isEdgeConnectedTextAnnotation(edge, annotation)) {
				continue;
			}
			const obstacle = textObstacleBox(annotation, options);
			if (!routeIntersectsTextBox(edge.points, obstacle, tolerance)) {
				continue;
			}
			diagnostics.push({
				severity: "warning",
				code: "routing.text-clearance.unresolved",
				message: `Edge ${edge.id} intersects solved text surface ${annotation.surfaceKind} for ${annotation.ownerId}.`,
				path: ["edges", edge.id],
				detail: compactDetail({
					edgeId: edge.id,
					textSurfaceKind: annotation.surfaceKind,
					conflictingObjectId: annotation.ownerId,
					surfaceIndex: annotation.surfaceIndex,
					textBackend: annotation.textBackend,
					conflictClass: classifyRouteTextConflict(
						edge.points,
						annotation,
						obstacle,
						tolerance,
					),
				}),
			});
		}
	}

	return diagnostics;
}

export function classifyRouteTextConflict(
	points: readonly Point[],
	annotation: SolvedTextAnnotation,
	obstacle: Box,
	tolerance: number,
): RouteConflictClass {
	// Caller already observed an intersection at `tolerance`. A graze is a
	// shallow bbox touch that disappears once the box is inset further.
	if (!routeIntersectsTextBox(points, obstacle, tolerance + 2)) {
		return "label-bbox-graze";
	}
	if (annotation.surfaceKind === "node-label") {
		return "node-label-strike";
	}
	if (annotation.surfaceKind === "edge-label") {
		return "edge-label-pileup";
	}
	return "label-bbox-graze";
}

export interface RouteLabelFeedbackState {
	readonly edges: readonly CoordinatedEdge[];
	readonly edgeTextAnnotations: readonly SolvedTextAnnotation[];
	readonly edgeRoutingDiagnostics: readonly Diagnostic[];
	readonly conflicts: readonly Diagnostic[];
	readonly iteration: number;
	readonly changedEdgeIds: ReadonlySet<string>;
	readonly acceptedReroutes: number;
	readonly rejectedReroutes: number;
}

export interface RouteLabelFeedbackScore {
	readonly routeTextConflicts: number;
	readonly otherRouteTextConflicts: number;
	readonly edgeRouteTextConflicts: number;
	readonly hardRouteDiagnostics: number;
	readonly softRouteDiagnostics: number;
	readonly backtrackingDiagnostics: number;
	readonly routeLength: number;
	readonly bendCount: number;
}

export interface RouteLabelFeedbackHardTextObstacleEntry {
	readonly box: Box;
	readonly metadata: RouteHardObstacleMetadata;
}

export function edgeIdsFromRouteTextDiagnostics(
	diagnostics: readonly Diagnostic[],
): string[] {
	return stableStrings(
		diagnostics
			.map((diagnostic) => diagnostic.detail?.edgeId)
			.filter((edgeId): edgeId is string => typeof edgeId === "string"),
	);
}

export function scoreRouteLabelFeedbackCandidate(
	edgeId: string,
	edges: readonly CoordinatedEdge[],
	textAnnotations: readonly SolvedTextAnnotation[],
	edgeRoutingDiagnostics: readonly Diagnostic[],
	options: SolveDiagramOptions,
): RouteLabelFeedbackScore {
	const routeTextDiagnostics = reportRouteTextClearance(
		edges,
		textAnnotations,
		options,
	);
	const edgeRouteTextConflicts = routeTextDiagnostics.filter(
		(diagnostic) => diagnostic.detail?.edgeId === edgeId,
	).length;
	const routeDiagnostics = edgeRoutingDiagnostics.filter(
		(diagnostic) => diagnostic.detail?.edgeId === edgeId,
	);
	const edge = edges.find((candidate) => candidate.id === edgeId);
	return {
		routeTextConflicts: routeTextDiagnostics.length,
		otherRouteTextConflicts:
			routeTextDiagnostics.length - edgeRouteTextConflicts,
		edgeRouteTextConflicts,
		hardRouteDiagnostics: routeDiagnostics.filter(
			isRouteLabelFeedbackHardRouteDiagnostic,
		).length,
		softRouteDiagnostics: routeDiagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.obstacle.unavoidable",
		).length,
		backtrackingDiagnostics: routeDiagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.backtracking_excessive",
		).length,
		routeLength: edge === undefined ? 0 : routePointLength(edge.points),
		bendCount: edge === undefined ? 0 : routeBendCount(edge.points),
	};
}

export function compareRouteLabelFeedbackScore(
	left: RouteLabelFeedbackScore,
	right: RouteLabelFeedbackScore,
): number {
	return (
		left.hardRouteDiagnostics - right.hardRouteDiagnostics ||
		left.routeTextConflicts - right.routeTextConflicts ||
		left.otherRouteTextConflicts - right.otherRouteTextConflicts ||
		left.edgeRouteTextConflicts - right.edgeRouteTextConflicts ||
		left.softRouteDiagnostics - right.softRouteDiagnostics ||
		left.backtrackingDiagnostics - right.backtrackingDiagnostics ||
		left.routeLength - right.routeLength ||
		left.bendCount - right.bendCount
	);
}

export function isRouteLabelFeedbackHardRouteDiagnostic(
	diagnostic: Diagnostic,
): boolean {
	return (
		diagnostic.code === "routing.evidence.crossing_forbidden" ||
		diagnostic.code === "routing.endpoint-interior.unavoidable" ||
		diagnostic.code === "routing.label-hard-obstacle.unavoidable" ||
		(diagnostic.code === "route_obstacle_fallback" &&
			diagnostic.severity === "error")
	);
}

export function replaceRouteDiagnosticsForEdge(
	diagnostics: readonly Diagnostic[],
	edgeId: string,
	replacements: readonly Diagnostic[],
): Diagnostic[] {
	return [
		...diagnostics.filter((diagnostic) => diagnostic.detail?.edgeId !== edgeId),
		...replacements,
	];
}

export function routePointLength(points: readonly Point[]): number {
	let length = 0;
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		length += Math.hypot(end.x - start.x, end.y - start.y);
	}
	return length;
}

export function routeBendCount(points: readonly Point[]): number {
	let count = 0;
	let previousDirection: "horizontal" | "vertical" | "diagonal" | undefined;
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const direction =
			start.y === end.y
				? "horizontal"
				: start.x === end.x
					? "vertical"
					: "diagonal";
		if (previousDirection !== undefined && previousDirection !== direction) {
			count += 1;
		}
		previousDirection = direction;
	}
	return count;
}

export function edgeRouteBounds(edge: CoordinatedEdge): Box {
	const xs = edge.points.map((point) => point.x);
	const ys = edge.points.map((point) => point.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	const maxX = Math.max(...xs);
	const maxY = Math.max(...ys);
	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

export function isPreRouteTextObstacle(
	annotation: SolvedTextAnnotation,
): boolean {
	return isLocalRouteClearanceText(annotation);
}

export function isLocalRouteClearanceText(
	annotation: SolvedTextAnnotation,
): boolean {
	if (!isRouteClearanceText(annotation)) {
		return false;
	}
	if (annotation.placement === "external-callout-required") {
		return false;
	}
	// Shelf callout bodies live off-diagram; keyed markers stay on the route
	// and must remain clearance obstacles.
	if (
		annotation.placement === "external-callout" &&
		annotation.placementDetail?.role === "callout"
	) {
		return false;
	}
	return true;
}

export function edgeLabelRerouteIterations(
	options: SolveDiagramOptions,
): number {
	const setting = options.edgeLabelRerouting;
	if (setting === false) {
		return 0;
	}
	const routeKind = options.routeKind ?? "orthogonal";
	if (routeKind !== "orthogonal" && routeKind !== "obstacle-avoiding") {
		return 0;
	}
	if (typeof setting === "object") {
		return Math.max(0, Math.floor(setting.maxIterations ?? 4));
	}
	if (setting === true || routeKind === "obstacle-avoiding") {
		return 4;
	}
	return 0;
}

export function textObstacleBox(
	annotation: SolvedTextAnnotation,
	options: SolveDiagramOptions,
): Box {
	if (!usesCompactTextObstacle(annotation, options)) {
		return annotation.box;
	}
	const horizontalInset = Math.min(
		Math.max(annotation.paddings.left, annotation.paddings.right, 2),
		annotation.box.width / 3,
	);
	const verticalInset = Math.min(
		Math.max(annotation.paddings.top, annotation.paddings.bottom, 2),
		annotation.box.height / 3,
	);
	return {
		x: annotation.box.x + horizontalInset,
		y: annotation.box.y + verticalInset,
		width: Math.max(0, annotation.box.width - horizontalInset * 2),
		height: Math.max(0, annotation.box.height - verticalInset * 2),
	};
}

export function usesCompactTextObstacle(
	annotation: SolvedTextAnnotation,
	options: SolveDiagramOptions,
): boolean {
	if (options.compactTextObstacles === true) {
		return true;
	}
	if (options.compactTextObstacles === "labels-only") {
		return (
			annotation.surfaceKind === "node-label" ||
			annotation.surfaceKind === "edge-label" ||
			annotation.surfaceKind === "port-label" ||
			annotation.surfaceKind === "swimlane-label"
		);
	}
	return false;
}

export function isRouteClearanceText(
	annotation: SolvedTextAnnotation,
): boolean {
	switch (annotation.surfaceKind) {
		case "port-label":
		case "edge-label":
		case "swimlane-label":
		case "frame-title":
			return true;
		case "node-label":
		case "compartment-row":
			return true;
		case "group-label":
			return textExtendsOutsideAnchor(annotation);
	}
}

export function routeIntersectsTextBox(
	points: readonly Point[],
	box: Box,
	tolerance = 0,
): boolean {
	const testBox = insetBox(box, Math.max(0, tolerance));
	if (testBox.width <= 0 || testBox.height <= 0) {
		return false;
	}
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		if (segmentIntersectsBox(start, end, testBox)) {
			return true;
		}
	}
	return false;
}

export function segmentIntersectsBox(
	start: Point,
	end: Point,
	box: Box,
): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	if (pointInsideBox(start, box) || pointInsideBox(end, box)) {
		return true;
	}
	if (start.x === end.x) {
		return (
			start.x > left &&
			start.x < right &&
			rangesOverlap(start.y, end.y, top, bottom)
		);
	}
	if (start.y === end.y) {
		return (
			start.y > top &&
			start.y < bottom &&
			rangesOverlap(start.x, end.x, left, right)
		);
	}
	return (
		segmentIntersectsBoxEdge(start, end, left, top, right, top) ||
		segmentIntersectsBoxEdge(start, end, right, top, right, bottom) ||
		segmentIntersectsBoxEdge(start, end, right, bottom, left, bottom) ||
		segmentIntersectsBoxEdge(start, end, left, bottom, left, top)
	);
}

export function segmentIntersectsBoxEdge(
	start: Point,
	end: Point,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): boolean {
	const denominator =
		(end.x - start.x) * (y2 - y1) - (end.y - start.y) * (x2 - x1);
	if (denominator === 0) {
		return false;
	}
	const t =
		((x1 - start.x) * (y2 - y1) - (y1 - start.y) * (x2 - x1)) / denominator;
	const u =
		((x1 - start.x) * (end.y - start.y) - (y1 - start.y) * (end.x - start.x)) /
		denominator;
	return t > 0 && t < 1 && u > 0 && u < 1;
}

export function labelPlacementOnPolyline(
	points: readonly Point[],
	baseOffset = 10,
): Point | undefined {
	return labelSegmentOnPolyline(points, baseOffset)?.placement;
}

export function labelSegmentOnPolyline(
	points: readonly Point[],
	baseOffset = 10,
): { start: Point; end: Point; placement: Point } | undefined {
	const segments = nonZeroSegments(points);
	const totalLength = segments.reduce(
		(sum, segment) => sum + segment.length,
		0,
	);
	if (totalLength <= 0) {
		return undefined;
	}

	let remaining = totalLength / 2;
	for (const segment of segments) {
		if (remaining <= segment.length) {
			const ratio = remaining / segment.length;
			const x = segment.start.x + (segment.end.x - segment.start.x) * ratio;
			const y = segment.start.y + (segment.end.y - segment.start.y) * ratio;
			const offset = labelOffset(segment, baseOffset);
			return {
				start: segment.start,
				end: segment.end,
				placement: { x: x + offset.x, y: y + offset.y },
			};
		}
		remaining -= segment.length;
	}

	const last = segments.at(-1);
	if (last === undefined) {
		return undefined;
	}
	const offset = labelOffset(last, baseOffset);
	return {
		start: last.start,
		end: last.end,
		placement: { x: last.end.x + offset.x, y: last.end.y + offset.y },
	};
}

export function nonZeroSegments(points: readonly Point[]): Array<{
	start: Point;
	end: Point;
	length: number;
}> {
	const segments: Array<{ start: Point; end: Point; length: number }> = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		if (length > 0) {
			segments.push({ start, end, length });
		}
	}
	return segments;
}
