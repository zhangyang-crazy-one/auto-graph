/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	type computeShapeGeometry,
	createBoxSpatialIndex,
	expandBox,
	intersectsAabb,
	queryBoxSpatialIndex,
	shapeSideAttachRange,
	shapeSidePoint,
	sidePointAtFraction,
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
import {
	type RouteEdgeInput,
	type RouteHardObstacleMetadata,
	routeEdge,
	routeEndDirectionPenalty,
	separateParallelSegments,
	simplifyRoute,
} from "../routing/index.js";
import {
	assignSameSideSlots,
	freeFractions,
} from "../routing/same-side-slots.js";
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

	const layeredCheck = layeredRouteValidator(
		nodes,
		textObstacles,
		hardObstacles,
		softObstacles,
		options,
	);
	const shortPath =
		(options.routeKind ?? "orthogonal") === "short-orthogonal-jumps";
	const sameSideSlots = shortPath
		? assignSameSideSlots({
				edges: allocationEdges,
				nodes,
				direction,
				maxAttachPointsPerSide: options.maxAttachPointsPerSide ?? 3,
				occupied: occupiedPortFractions(coordinatedNodes, nodes),
			})
		: undefined;
	if (sameSideSlots !== undefined) {
		diagnostics.push(...sameSideSlots.diagnostics);
	}
	// Fractions taken per node side (ports and slots), for slot retries.
	const slotOccupancy =
		sameSideSlots === undefined
			? undefined
			: occupiedPortFractions(coordinatedNodes, nodes);
	for (const slot of sameSideSlots?.assignments.values() ?? []) {
		const key = `${slot.nodeId}:${slot.anchor}`;
		slotOccupancy?.set(key, [...(slotOccupancy.get(key) ?? []), slot.fraction]);
	}

	for (const edge of edges) {
		railAllocations?.delete(edge.id);
		const source = nodes.get(edge.source.nodeId);
		const target = nodes.get(edge.target.nodeId);
		const layered =
			source === undefined || target === undefined
				? undefined
				: layeredCheck(edge, source.box, target.box);
		if (layered !== undefined) {
			const points = layered.map((point) => ({ ...point }));
			LAYERED_ROUTES.add(points);
			coordinated.push({ ...edge, points });
			continue;
		}
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
			edge.source.anchor ??
			sourceDistributedAnchor?.anchor ??
			sourcePort?.side ??
			sameSideSlots?.assignments.get(`${edge.id}:source`)?.anchor;
		const targetAnchor =
			edge.target.anchor ??
			targetDistributedAnchor?.anchor ??
			targetPort?.side ??
			sameSideSlots?.assignments.get(`${edge.id}:target`)?.anchor;
		const sourcePreassign =
			sourcePort !== undefined
				? { point: sourcePort.anchor, anchor: sourcePort.side }
				: sameSideSlots?.assignments.get(`${edge.id}:source`);
		const targetPreassign =
			targetPort !== undefined
				? { point: targetPort.anchor, anchor: targetPort.side }
				: sameSideSlots?.assignments.get(`${edge.id}:target`);
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

		// RSOP (#86/#87): foreign nodes/groups are hard; text stays soft with
		// finite cost so micro-clear can run without treating nodes as soft.
		const routeSoftObstacles = shortPath
			? [...softObstacles, ...routeTextObstacles]
			: [
					...routeNodeObstacles,
					...softObstacles,
					...routeGroupObstacles,
					...routeTextObstacles,
				];
		const routeHardObstacles = shortPath
			? [...hardObstacles, ...routeNodeObstacles, ...routeGroupObstacles]
			: hardObstacles;
		const routeHardMetadata: readonly RouteHardObstacleMetadata[] = shortPath
			? [
					...routeHardObstacleMetadata,
					...routeNodeObstacles.map(() => ({ kind: "node" as const })),
					...routeGroupObstacles.map(() => ({ kind: "node" as const })),
				]
			: routeHardObstacleMetadata;
		const nudgePitch = options.idealNudgingDistance ?? 10;
		const routeInput: RouteEdgeInput = {
			kind: options.routeKind ?? "orthogonal",
			direction,
			source: sourceGeometry,
			target: targetGeometry,
			...(sourceAnchor === undefined ? {} : { sourceAnchor }),
			...(targetAnchor === undefined ? {} : { targetAnchor }),
			...(sourcePreassign === undefined
				? {}
				: { sourcePoint: sourcePreassign.point }),
			...(targetPreassign === undefined
				? {}
				: { targetPoint: targetPreassign.point }),
			obstacles: routeSoftObstacles,
			blockingObstacles: nodeObstacles
				.filter(
					(entry) =>
						entry.id !== edge.source.nodeId && entry.id !== edge.target.nodeId,
				)
				.map((entry) => entry.box),
			hardObstacles: routeHardObstacles,
			hardObstacleMetadata: routeHardMetadata,
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
			...(shortPath ? { softTextClearPitch: nudgePitch } : {}),
			...(() => {
				const densePolicy =
					shortPath ||
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
		};
		let route = routeEdge(routeInput);
		// Implicit anchor distribution pins an endpoint to one side. When that
		// side is blocked (e.g. a neighbour sits right in front of it), retry
		// with the router's free side choice and keep the cleaner result.
		if (
			route.diagnostics.length > 0 &&
			implicitAnchorDistribution(options) &&
			(sourceDistributedAnchor !== undefined ||
				targetDistributedAnchor !== undefined)
		) {
			const freeSourceAnchor = edge.source.anchor ?? sourcePort?.side;
			const freeTargetAnchor = edge.target.anchor ?? targetPort?.side;
			const {
				sourceAnchor: _pinnedSource,
				targetAnchor: _pinnedTarget,
				...unpinned
			} = routeInput;
			// Keep the distributed geometry: if the router still picks the
			// pinned side it lands on its own slot instead of the side midpoint
			// (which may be another edge's slot).
			const retry = routeEdge({
				...unpinned,
				...(freeSourceAnchor === undefined
					? {}
					: { sourceAnchor: freeSourceAnchor }),
				...(freeTargetAnchor === undefined
					? {}
					: { targetAnchor: freeTargetAnchor }),
			});
			// A retry may land on a side midpoint another edge already uses;
			// spreadCollidingEndpoints separates such endpoints afterwards.
			if (
				compareRouteSeverity(
					routeSeverity(retry, hardObstacles, routeInput.obstacles ?? []),
					routeSeverity(route, hardObstacles, routeInput.obstacles ?? []),
				) < 0
			) {
				route = retry;
			}
		}
		// Same-side slots (#92) are a preference: the facing side can be
		// walled off by nodes between the two ends (a column of nodes) or by
		// port labels. When the pinned route cannot clear a hard obstacle, or
		// can only reach its slot along the node border, try the slotted end
		// on the node's other sides (at a free fraction there) and keep the
		// cleanest result.
		if (sameSideSlots !== undefined && slotOccupancy !== undefined) {
			const misdirected = (points: readonly Point[]): number =>
				routeEndDirectionPenalty(points, {
					sourceAnchor: sideOfBox(points[0], source.box),
					targetAnchor: sideOfBox(points.at(-1), target.box),
				});
			const score = (candidate: typeof route) => [
				...routeSeverity(
					candidate,
					routeHardObstacles,
					routeInput.obstacles ?? [],
				),
				misdirected(candidate.points),
			];
			const blocked = (candidate: typeof route) =>
				routeObstacleHits(candidate.points, routeHardObstacles) > 0 ||
				misdirected(candidate.points) > 0;
			let relocated: Partial<RouteEdgeInput> = {};
			for (const endpoint of ["source", "target"] as const) {
				if (!blocked(route)) break;
				const endEdge = endpoint === "source" ? edge.source : edge.target;
				const slot = sameSideSlots.assignments.get(`${edge.id}:${endpoint}`);
				const port = endpoint === "source" ? sourcePort : targetPort;
				const geometry = endpoint === "source" ? source : target;
				if (slot === undefined || port !== undefined || endEdge.anchor) {
					continue;
				}
				let best = {
					route,
					score: score(route),
					side: slot.anchor,
					fraction: slot.fraction,
				};
				for (const side of ["right", "bottom", "left", "top"] as const) {
					if (side === slot.anchor) continue;
					const key = `${endEdge.nodeId}:${side}`;
					const fraction =
						freeFractions(1, slotOccupancy.get(key) ?? [])[0] ?? 0.5;
					const point = sidePointAtFraction(geometry.box, side, fraction);
					const candidate = routeEdge({
						...routeInput,
						...relocated,
						...(endpoint === "source"
							? { sourceAnchor: side, sourcePoint: point }
							: { targetAnchor: side, targetPoint: point }),
					});
					const candidateScore = score(candidate);
					if (compareRouteSeverity(candidateScore, best.score) < 0) {
						best = { route: candidate, score: candidateScore, side, fraction };
					}
				}
				if (best.route !== route) {
					route = best.route;
					const point = sidePointAtFraction(
						geometry.box,
						best.side,
						best.fraction,
					);
					relocated = {
						...relocated,
						...(endpoint === "source"
							? { sourceAnchor: best.side, sourcePoint: point }
							: { targetAnchor: best.side, targetPoint: point }),
					};
					const key = `${endEdge.nodeId}:${best.side}`;
					slotOccupancy.set(key, [
						...(slotOccupancy.get(key) ?? []),
						best.fraction,
					]);
				}
			}
		}
		// #95: a short-orthogonal route that still enters a hard obstacle
		// (foreign node, group, hard text) is never delivered as the answer
		// when the general obstacle-avoiding router finds a clean one within
		// the detour and bend budget; otherwise the pierce stays reported
		// (`routing.obstacle.unavoidable`).
		// Strict pages keep the 0–2 bend contract (#84) and report unsat.
		if (
			shortPath &&
			options.deliverabilityMode !== "strict" &&
			routeObstacleHits(route.points, routeHardObstacles) > 0
		) {
			const detour = routeInput.maxDetourRatio ?? 3;
			const routed = routeEdge({
				...routeInput,
				kind: "obstacle-avoiding",
			});
			// Keep slot and port points: the fallback may slide an end along
			// its side, onto another edge's slot.
			const around = {
				...routed,
				points: pinRouteEnds(
					routed.points,
					routeInput.sourcePoint,
					routeInput.targetPoint,
				),
			};
			if (
				routeObstacleHits(around.points, routeHardObstacles) === 0 &&
				around.points.length - 2 <= SHORT_PATH_FALLBACK_MAX_BENDS &&
				polylineLength(around.points) <=
					detour * manhattan(around.points[0], around.points.at(-1))
			) {
				route = {
					points: around.points,
					diagnostics: [
						...around.diagnostics.filter(
							(diagnostic) => diagnostic.severity !== "error",
						),
						{
							severity: "info",
							code: "routing.short-orthogonal.obstacle-fallback",
							message:
								"No 0–2 bend short-orthogonal route clears the hard obstacles; used an obstacle-avoiding route within maxDetourRatio instead of piercing.",
							detail: {
								routingPolicy: "short-orthogonal-jumps",
								bends: around.points.length - 2,
							},
						},
					],
				};
			}
		}
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

	const finalized = finalizeCoordinatedEdges(
		coordinated,
		nodes,
		nodeObstacles,
		hardObstacles,
		softObstacles,
		textObstacles,
		railAllocations,
		options,
		groups,
	);
	pruneResolvedRouteDiagnostics(
		diagnostics,
		finalized,
		nodeObstacles,
		hardObstacles,
		softObstacles,
		textObstacles,
		groups,
		options,
	);
	return finalized;
}

/**
 * How bad a routed candidate is, most serious first: hard-obstacle hits,
 * soft-obstacle hits, error diagnostics, warnings, then any diagnostic. A
 * retry must beat the original lexicographically, so trading search-budget
 * warnings for a real collision never wins.
 */
function routeSeverity(
	route: { points: readonly Point[]; diagnostics: readonly Diagnostic[] },
	hardObstacles: readonly Box[],
	softObstacles: readonly Box[],
): number[] {
	return [
		routeObstacleHits(route.points, hardObstacles),
		routeObstacleHits(route.points, softObstacles),
		route.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
			.length,
		route.diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
			.length,
		route.diagnostics.length,
	];
}

function compareRouteSeverity(
	left: readonly number[],
	right: readonly number[],
): number {
	for (let index = 0; index < left.length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** Route diagnostics that post-route repairs can make obsolete. */
const RESOLVABLE_ROUTE_DIAGNOSTIC_CODES = new Set([
	"routing.obstacle.unavoidable",
	"route_obstacle_fallback",
]);

/**
 * Post-route repairs (obstacle escape, endpoint spreading, …) can turn a
 * fallback route clean. Drop obstacle diagnostics whose edge now avoids
 * every obstacle the router considered, so remediation and deliverability
 * are not triggered by stale evidence. Mutates `diagnostics` in place.
 */
export function pruneResolvedRouteDiagnostics(
	diagnostics: Diagnostic[],
	edges: readonly CoordinatedEdge[],
	nodeObstacles: readonly NodeObstacleEntry[],
	hardObstacles: readonly Box[],
	softObstacles: readonly Box[],
	textObstacles: readonly SolvedTextAnnotation[],
	groups: readonly CoordinatedGroup[],
	options: SolveDiagramOptions,
): void {
	const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
	const clean = new Map<string, boolean>();
	const isClean = (edge: CoordinatedEdge): boolean => {
		const cached = clean.get(edge.id);
		if (cached !== undefined) return cached;
		const obstacles = [
			...nodeObstacles
				.filter(
					(entry) =>
						entry.id !== edge.source.nodeId && entry.id !== edge.target.nodeId,
				)
				.map((entry) => entry.box),
			...hardObstacles,
			...softObstacles,
			...groupObstaclesForEdge(edge, groups, options.obstacleMargin ?? 0),
			...textObstacles
				.filter(isLocalRouteClearanceText)
				.filter(
					(annotation) => !isEdgeConnectedTextAnnotation(edge, annotation),
				)
				.map((annotation) => textObstacleBox(annotation, options)),
		];
		const result = routeObstacleHits(edge.points, obstacles) === 0;
		clean.set(edge.id, result);
		return result;
	};
	for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
		const diagnostic = diagnostics[index];
		if (
			diagnostic === undefined ||
			!RESOLVABLE_ROUTE_DIAGNOSTIC_CODES.has(diagnostic.code) ||
			// A clean route over its detour budget is still over budget: that
			// diagnostic is not about a collision, so keep it for remediation.
			diagnostic.detail?.maxDetourRatio !== undefined ||
			diagnostic.detail?.detourRatio !== undefined
		) {
			continue;
		}
		const edgeId = diagnostic.detail?.edgeId;
		const edge = typeof edgeId === "string" ? edgeById.get(edgeId) : undefined;
		if (edge !== undefined && isClean(edge)) diagnostics.splice(index, 1);
	}
}

/**
 * Cross-edge post-passes: spread coincident endpoints, nudge shared
 * corridors into parallel tracks, detach border-hugging ends and snap
 * endpoints onto non-rectangular outlines. Runs at the end of every
 * `coordinateEdges` call and again over the whole edge set after single-edge
 * reroutes (which cannot see their neighbours).
 */
export function finalizeCoordinatedEdges(
	edges: CoordinatedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	nodeObstacles: readonly NodeObstacleEntry[],
	hardObstacles: readonly Box[],
	softObstacles: readonly Box[],
	textObstacles: readonly SolvedTextAnnotation[],
	railAllocations: ReadonlyMap<string, RoutingRailAllocation> | undefined,
	options: SolveDiagramOptions,
	groups: readonly CoordinatedGroup[] = [],
): CoordinatedEdge[] {
	const implicit = implicitAnchorDistribution(options);
	// Every post-pass move is validated against the same obstacles the
	// router avoided: nodes, hard blocks, policy soft obstacles (tables,
	// panels, title bars, lane corridors) and text surfaces.
	// Node obstacles are the router's (obstacleMargin / routingGutter
	// expanded) boxes, so no pass can move a route into requested clearance.
	// Each edge is validated without its own endpoint nodes: with a margin
	// or gutter its endpoints sit inside those expanded boxes, and such
	// unavoidable hits must not act as a budget that hides a new hit.
	// Groups and text surfaces follow the router's per-edge rules too: a
	// group is only an obstacle for edges with no endpoint inside it, and an
	// edge's own label and its endpoints' node labels are not obstacles for
	// it. Port labels stay obstacles here: they sit outside the node, and a
	// nudged track running over its own port label would push the final
	// edge label onto it.
	const margin = options.obstacleMargin ?? 0;
	const ancestorCache = new Map<string, Set<string>>();
	const ancestorsOf = (nodeId: string): Set<string> => {
		let ancestors = ancestorCache.get(nodeId);
		if (ancestors === undefined) {
			ancestors = ancestorGroupIds(groups, nodeId);
			ancestorCache.set(nodeId, ancestors);
		}
		return ancestors;
	};
	const obstacles: PostPassObstacle[] = [
		...nodeObstacles.map((entry) => ({ box: entry.box, ownerId: entry.id })),
		// The drawn node itself, inside its expanded obstacle box: grazing the
		// clearance is not the same as cutting through the node.
		...nodeObstacles.flatMap((entry) => {
			const box = nodes.get(entry.id)?.box;
			return box === undefined
				? []
				: [{ box, ownerId: entry.id, weight: NODE_HIT_WEIGHT }];
		}),
		...hardObstacles.map((box) => ({ box })),
		...softObstacles.map((box) => ({ box })),
		...textObstacles.filter(isLocalRouteClearanceText).map((annotation) => ({
			box: textObstacleBox(annotation, options),
			exemptEdgeIds: new Set(
				edges
					.filter(
						(edge) =>
							annotation.surfaceKind !== "port-label" &&
							isEdgeConnectedTextAnnotation(edge, annotation),
					)
					.map((edge) => edge.id),
			),
		})),
		...groups.map((group) => ({
			box: margin === 0 ? group.box : expandBox(group.box, margin),
			exemptEdgeIds: new Set(
				edges
					.filter(
						(edge) =>
							ancestorsOf(edge.source.nodeId).has(group.id) ||
							ancestorsOf(edge.target.nodeId).has(group.id),
					)
					.map((edge) => edge.id),
			),
		})),
	];
	// Border detachment, endpoint spreading and outline snapping belong to
	// implicit distribution. Obstacle-avoiding / explicit anchorCapacity
	// pages keep the router's geometry: the strict dense label gate is tuned
	// against it and extra stubs there create unresolved label crossings.
	// Detach first so every endpoint has its final side before coincident
	// endpoints on that side are spread apart.
	// Routes taken from the global layout are final: the post-passes route
	// the others around them, and only their ends are snapped to outlines.
	const layered = new Set(
		edges
			.filter((edge) => LAYERED_ROUTES.has(edge.points))
			.map((edge) => edge.id),
	);
	const free = edges.filter((edge) => !layered.has(edge.id));
	const detached = implicit
		? detachBorderHuggingEnds(free, nodes, obstacles)
		: free;
	const detachedById = new Map(detached.map((edge) => [edge.id, edge]));
	// Layered ends stay put; the others move off them.
	const spread = implicit
		? spreadCollidingEndpoints(
				edges.map((edge) => detachedById.get(edge.id) ?? edge),
				nodes,
				obstacles,
				layered,
			)
		: detached;
	const byId = new Map(spread.map((edge) => [edge.id, edge]));
	const separated = separateCoordinatedEdges(
		edges.map((edge) => byId.get(edge.id) ?? edge),
		obstacles,
		railAllocations,
		options,
		layered,
	);
	const snapped = snapEndpointsToShapeOutline(
		separated,
		nodes,
		implicit ? undefined : layered,
	);
	for (const edge of snapped) {
		if (layered.has(edge.id)) LAYERED_ROUTES.add(edge.points);
	}
	return snapped;
}

interface PostPassObstacle {
	box: Box;
	/** Node the obstacle belongs to, if any. */
	ownerId?: string;
	/** Weight of a hit in the separation pass (default 1). */
	weight?: number;
	/**
	 * Edges this obstacle does not apply to: a group's own edges, or the
	 * edges a text surface belongs to (their label, their endpoint labels).
	 */
	exemptEdgeIds?: ReadonlySet<string>;
}

/** Whether an edge must avoid the obstacle, mirroring the router's rules. */
function obstacleAppliesTo(
	obstacle: PostPassObstacle,
	edge: CoordinatedEdge,
): boolean {
	if (
		obstacle.ownerId !== undefined &&
		(obstacle.ownerId === edge.source.nodeId ||
			obstacle.ownerId === edge.target.nodeId)
	) {
		return false;
	}
	return obstacle.exemptEdgeIds?.has(edge.id) !== true;
}

/** Obstacle boxes an edge must avoid (the router's per-edge obstacle set). */
function obstaclesForEdge(
	edge: CoordinatedEdge,
	obstacles: readonly PostPassObstacle[],
): Box[] {
	return obstacles
		.filter((obstacle) => obstacleAppliesTo(obstacle, edge))
		.map((obstacle) => obstacle.box);
}

/** Number of (segment, obstacle) pairs where a route enters an obstacle. */
function routeObstacleHits(
	points: readonly Point[],
	obstacles: readonly Box[],
): number {
	let hits = 0;
	for (let index = 0; index + 1 < points.length; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) continue;
		for (const box of obstacles) {
			if (segmentIntersectsBox(start, end, box)) hits += 1;
		}
	}
	return hits;
}

/** Point arrays of routes taken from the global layout. */
const LAYERED_ROUTES = new WeakSet<readonly Point[]>();

/**
 * The global layout's route for an edge, if it may be used as is: no port
 * or explicit anchor, both ends on their node boxes, orthogonal, and no
 * pass through another node, a fixed text surface or a policy obstacle (a
 * constraint or repair pass may have moved things since the layout).
 */
function layeredRouteValidator(
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	textObstacles: readonly SolvedTextAnnotation[],
	hardObstacles: readonly Box[],
	softObstacles: readonly Box[],
	options: SolveDiagramOptions,
): (
	edge: NormalizedEdge,
	sourceBox: Box,
	targetBox: Box,
) => Point[] | undefined {
	const routes = options.layeredRoutes;
	if (routes === undefined || routes.size === 0) return () => undefined;
	const nodeBoxes = [...nodes.entries()].map(([id, geometry]) => ({
		id,
		box: insetBox(geometry.box, 1),
	}));
	// Edge labels are placed after routing (these are rough estimates) and
	// the label feedback pass moves them off routes: only fixed text counts.
	const texts = textObstacles.filter(
		(annotation) =>
			isLocalRouteClearanceText(annotation) &&
			annotation.surfaceKind !== "edge-label",
	);
	const onBorder = (point: Point, box: Box) => {
		const tolerance = 0.6;
		const inside =
			point.x >= box.x - tolerance &&
			point.x <= box.x + box.width + tolerance &&
			point.y >= box.y - tolerance &&
			point.y <= box.y + box.height + tolerance;
		return (
			inside &&
			(Math.abs(point.x - box.x) < tolerance ||
				Math.abs(point.x - box.x - box.width) < tolerance ||
				Math.abs(point.y - box.y) < tolerance ||
				Math.abs(point.y - box.y - box.height) < tolerance)
		);
	};
	return (edge, sourceBox, targetBox) => {
		const route = routes.get(edge.id);
		if (route === undefined || route.length < 2) return undefined;
		if (
			edge.source.portId !== undefined ||
			edge.target.portId !== undefined ||
			edge.source.anchor !== undefined ||
			edge.target.anchor !== undefined
		) {
			return undefined;
		}
		const points = route as Point[];
		const first = points[0] as Point;
		const last = points[points.length - 1] as Point;
		if (!onBorder(first, sourceBox) || !onBorder(last, targetBox)) {
			return undefined;
		}
		for (let index = 0; index + 1 < points.length; index += 1) {
			const a = points[index] as Point;
			const b = points[index + 1] as Point;
			if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
				return undefined;
			}
		}
		const others = nodeBoxes
			.filter(
				(entry) =>
					entry.id !== edge.source.nodeId && entry.id !== edge.target.nodeId,
			)
			.map((entry) => entry.box);
		if (routeObstacleHits(points, others) > 0) return undefined;
		if (routeObstacleHits(points, hardObstacles) > 0) return undefined;
		if (routeObstacleHits(points, softObstacles) > 0) return undefined;
		const textBoxes = texts
			.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
			.map((annotation) => textObstacleBox(annotation, options));
		if (routeObstacleHits(points, textBoxes) > 0) return undefined;
		return points;
	};
}

/** Weight of a node hit against label / group hits in the post-passes. */
const NODE_HIT_WEIGHT = 1000;

/**
 * Outward offsets tried, longest first, for an end segment that runs along
 * its node border.
 */
const BORDER_HUGGING_STUBS = [12, 6, 3];

/**
 * Fallback routes can leave an anchor by running along the node's own
 * border (e.g. straight down the right edge). Shift that end segment
 * outward by a short stub so the edge visibly leaves the node; the adjacent
 * segment is perpendicular, so the route stays orthogonal.
 */
function detachBorderHuggingEnds(
	edges: readonly CoordinatedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	allObstacles: readonly PostPassObstacle[],
): CoordinatedEdge[] {
	return edges.map((edge) => {
		const obstacles = obstaclesForEdge(edge, allObstacles);
		let points = edge.points.map((point) => ({ ...point }));
		let changed = false;
		for (const role of ["source", "target"] as const) {
			if (points.length < 3) break;
			const box = nodes.get(
				role === "source" ? edge.source.nodeId : edge.target.nodeId,
			)?.box;
			if (box === undefined) continue;
			const ordered = role === "source" ? points : [...points].reverse();
			const end = ordered[0];
			const next = ordered[1];
			if (end === undefined || next === undefined) continue;
			const vertical = Math.abs(end.x - next.x) < 0.5;
			const horizontal = Math.abs(end.y - next.y) < 0.5;
			let direction: Point | undefined;
			if (vertical && Math.abs(end.x - (box.x + box.width)) < 0.5) {
				direction = { x: 1, y: 0 };
			} else if (vertical && Math.abs(end.x - box.x) < 0.5) {
				direction = { x: -1, y: 0 };
			} else if (horizontal && Math.abs(end.y - (box.y + box.height)) < 0.5) {
				direction = { x: 0, y: 1 };
			} else if (horizontal && Math.abs(end.y - box.y) < 0.5) {
				direction = { x: 0, y: -1 };
			}
			if (direction === undefined) continue;
			// A label right beside the node may block the full stub; a shorter
			// one still gets the route off the border.
			for (const length of BORDER_HUGGING_STUBS) {
				const offset = { x: direction.x * length, y: direction.y * length };
				const shiftedEnd = { x: end.x + offset.x, y: end.y + offset.y };
				const shiftedNext = { x: next.x + offset.x, y: next.y + offset.y };
				const rebuilt = compactRoutePoints([
					end,
					shiftedEnd,
					shiftedNext,
					...ordered.slice(2),
				]);
				const candidate = role === "source" ? rebuilt : rebuilt.reverse();
				// The outward stub must not trade a border graze for a collision.
				if (
					routeObstacleHits(candidate, obstacles) >
					routeObstacleHits(points, obstacles)
				) {
					continue;
				}
				points = candidate;
				changed = true;
				break;
			}
		}
		return changed ? { ...edge, points } : edge;
	});
}

/**
 * Routes attach to bounding-box sides. For non-rectangular shapes an
 * off-centre attach point would float beside the drawn outline, so extend
 * (or trim) the first/last segment along its own axis until it meets the
 * outline. The segment direction is unchanged, so routes stay orthogonal.
 */
function snapEndpointsToShapeOutline(
	edges: readonly CoordinatedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	only?: ReadonlySet<string>,
): CoordinatedEdge[] {
	return edges.map((edge) => {
		if (edge.points.length < 2) return edge;
		if (only !== undefined && !only.has(edge.id)) return edge;
		const points = edge.points.map((point) => ({ ...point }));
		let changed = false;
		for (const role of ["source", "target"] as const) {
			const endpoint = role === "source" ? edge.source : edge.target;
			// An explicit port is drawn at its own anchor; moving the connector
			// onto the outline would detach it from the port marker.
			if (endpoint.portId !== undefined) continue;
			const geometry = nodes.get(endpoint.nodeId);
			if (
				geometry === undefined ||
				geometry.shape === "rectangle" ||
				geometry.shape === "rounded-rectangle"
			) {
				continue;
			}
			const at = role === "source" ? 0 : points.length - 1;
			const end = points[at];
			const neighbour = points[role === "source" ? 1 : points.length - 2];
			if (end === undefined || neighbour === undefined) continue;
			const { box } = geometry;
			const horizontal = Math.abs(end.y - neighbour.y) < 0.5;
			let side: "top" | "right" | "bottom" | "left" | undefined;
			if (horizontal && Math.abs(end.x - box.x) < 0.5 && neighbour.x < end.x) {
				side = "left";
			} else if (
				horizontal &&
				Math.abs(end.x - (box.x + box.width)) < 0.5 &&
				neighbour.x > end.x
			) {
				side = "right";
			} else if (
				!horizontal &&
				Math.abs(end.y - box.y) < 0.5 &&
				neighbour.y < end.y
			) {
				side = "top";
			} else if (
				!horizontal &&
				Math.abs(end.y - (box.y + box.height)) < 0.5 &&
				neighbour.y > end.y
			) {
				side = "bottom";
			}
			if (side === undefined) continue;
			const t = horizontal
				? (end.y - box.y) / Math.max(1e-9, box.height)
				: (end.x - box.x) / Math.max(1e-9, box.width);
			const outline = shapeSidePoint(geometry.shape, box, side, t);
			if (
				Math.abs(outline.x - end.x) > 1e-6 ||
				Math.abs(outline.y - end.y) > 1e-6
			) {
				points[at] = outline;
				changed = true;
			}
		}
		return changed ? { ...edge, points } : edge;
	});
}

/** Gap between endpoints spread apart on a shared node side. */
const COLLIDING_ENDPOINT_SPACING = 12;

type EndpointSide = "top" | "right" | "bottom" | "left";

/**
 * Routers pick sides per edge, so two edges that were not distributed
 * together can still land on the same side midpoint of a node. Spread such
 * coincident endpoints along the side (ordered by where each route turns
 * next), moving the first bend with them so routes stay orthogonal.
 */
function spreadCollidingEndpoints(
	edges: readonly CoordinatedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	allObstacles: readonly PostPassObstacle[],
	fixedEdgeIds: ReadonlySet<string> = new Set(),
): CoordinatedEdge[] {
	// A straight 2-point route cannot slide an endpoint without breaking
	// orthogonality, so give it a zero-length dogleg at its midpoint; moving
	// an endpoint then becomes a small jog there. Unused doglegs are
	// simplified away at the end.
	const expanded = new Set<number>();
	const routes = edges.map((edge, index) => {
		const points = edge.points.map((point) => ({ ...point }));
		const [a, b] = points;
		if (
			points.length === 2 &&
			a !== undefined &&
			b !== undefined &&
			(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5)
		) {
			const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			expanded.add(index);
			return [a, middle, { ...middle }, b];
		}
		return points;
	});
	interface EndpointRef {
		edgeIndex: number;
		role: "source" | "target";
		nodeId: string;
		side: EndpointSide;
		/** Coordinate of the route's next turn along the side axis. */
		heading: number;
	}
	const groups = new Map<string, EndpointRef[]>();
	edges.forEach((edge, edgeIndex) => {
		const route = routes[edgeIndex] ?? [];
		if (route.length < 3) return;
		for (const role of ["source", "target"] as const) {
			const at = role === "source" ? 0 : route.length - 1;
			const step = role === "source" ? 1 : -1;
			const end = route[at];
			const bend = route[at + step];
			const next = route[at + 2 * step];
			if (end === undefined || bend === undefined || next === undefined) {
				continue;
			}
			const horizontal = Math.abs(end.y - bend.y) < 0.5;
			const side: EndpointSide = horizontal
				? bend.x > end.x
					? "right"
					: "left"
				: bend.y > end.y
					? "bottom"
					: "top";
			const endpoint = role === "source" ? edge.source : edge.target;
			// An explicit port is drawn at its anchor: several edges may share
			// it on purpose, and moving them would detach them from the port.
			if (endpoint.portId !== undefined) continue;
			const nodeId = endpoint.nodeId;
			const along = horizontal ? end.y : end.x;
			const key = `${nodeId}|${side}|${Math.round(along)}`;
			const group = groups.get(key) ?? [];
			group.push({
				edgeIndex,
				role,
				nodeId,
				side,
				heading: horizontal ? next.y : next.x,
			});
			groups.set(key, group);
		}
	});

	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const first = group[0];
		if (first === undefined) continue;
		const geometry = nodes.get(first.nodeId);
		if (geometry === undefined) continue;
		const side = first.side;
		const alongY = side === "left" || side === "right";
		const sideStart = alongY ? geometry.box.y : geometry.box.x;
		const sideLength = alongY ? geometry.box.height : geometry.box.width;
		if (sideLength <= 0) continue;
		const [rangeStart, rangeEnd] = shapeSideAttachRange(
			geometry.shape,
			geometry.box,
			side,
		);
		const sorted = [...group].sort(
			(a, b) =>
				a.heading - b.heading ||
				(edges[a.edgeIndex]?.id ?? "").localeCompare(
					edges[b.edgeIndex]?.id ?? "",
				) ||
				a.role.localeCompare(b.role),
		);
		const count = sorted.length;
		const endpointOf = (ref: EndpointRef): Point | undefined => {
			const route = routes[ref.edgeIndex] ?? [];
			return ref.role === "source" ? route[0] : route.at(-1);
		};
		const origin = endpointOf(first);
		if (origin === undefined) continue;
		const centerT = ((alongY ? origin.y : origin.x) - sideStart) / sideLength;
		const stepT = Math.min(
			COLLIDING_ENDPOINT_SPACING / sideLength,
			(rangeEnd - rangeStart) / count,
		);
		const halfSpan = (stepT * (count - 1)) / 2;
		const startT = Math.min(
			Math.max(centerT - halfSpan, rangeStart),
			Math.max(rangeStart, rangeEnd - 2 * halfSpan),
		);
		const tryMove = (ref: EndpointRef, t: number): boolean => {
			if (fixedEdgeIds.has(edges[ref.edgeIndex]?.id ?? "")) return false;
			const route = routes[ref.edgeIndex] ?? [];
			const at = ref.role === "source" ? 0 : route.length - 1;
			const step = ref.role === "source" ? 1 : -1;
			const end = route[at];
			const bend = route[at + step];
			const next = route[at + 2 * step];
			if (end === undefined || bend === undefined || next === undefined) {
				return false;
			}
			const moved = shapeSidePoint("rectangle", geometry.box, side, t);
			const oldAlong = alongY ? bend.y : bend.x;
			const newAlong = alongY ? moved.y : moved.x;
			const nextAlong = alongY ? next.y : next.x;
			// Keep the segment after the bend pointing the same way (a dogleg
			// placeholder, where next == bend, may point either way).
			const placeholder = Math.abs(nextAlong - oldAlong) < 1e-9;
			if (
				!placeholder &&
				(Math.sign(nextAlong - newAlong) !== Math.sign(nextAlong - oldAlong) ||
					Math.abs(nextAlong - newAlong) < 1)
			) {
				return false;
			}
			const shifted = route.map((point) => ({ ...point }));
			shifted[at] = moved;
			shifted[at + step] = alongY
				? { x: bend.x, y: moved.y }
				: { x: moved.x, y: bend.y };
			// The separation pass never moves first/last segments, so a spread
			// that creates a collision could not be repaired later: reject it.
			const edge = edges[ref.edgeIndex];
			const obstacles =
				edge === undefined ? [] : obstaclesForEdge(edge, allObstacles);
			if (
				routeObstacleHits(shifted, obstacles) >
				routeObstacleHits(route, obstacles)
			) {
				return false;
			}
			route[at] = shifted[at] as Point;
			route[at + step] = shifted[at + step] as Point;
			return true;
		};
		sorted.forEach((ref, index) => {
			tryMove(ref, startT + index * stepT);
		});
		// A slot the spread could not use (an obstacle beside the node, a
		// bend in the way) leaves two ends on one point: try the free slots
		// nearest to it on either side.
		const key = (ref: EndpointRef) => {
			const point = endpointOf(ref);
			return point === undefined
				? ""
				: `${point.x.toFixed(1)}|${point.y.toFixed(1)}`;
		};
		const slotStep =
			stepT > 0 ? stepT : COLLIDING_ENDPOINT_SPACING / sideLength;
		for (const ref of sorted) {
			const taken = new Set(
				sorted.filter((other) => other !== ref).map((other) => key(other)),
			);
			if (!taken.has(key(ref))) continue;
			const point = endpointOf(ref);
			if (point === undefined) continue;
			const here = ((alongY ? point.y : point.x) - sideStart) / sideLength;
			// Half steps too: the full-step slots may all be taken.
			for (let k = 1; k <= 2 * (count + 2); k += 1) {
				const offset = (k * slotStep) / 2;
				const options = [here + offset, here - offset].filter(
					(t) => t >= rangeStart - 1e-6 && t <= rangeEnd + 1e-6,
				);
				const moved = options.some((t) => {
					const probe = shapeSidePoint("rectangle", geometry.box, side, t);
					if (taken.has(`${probe.x.toFixed(1)}|${probe.y.toFixed(1)}`)) {
						return false;
					}
					return tryMove(ref, t);
				});
				if (moved) break;
			}
		}
	}

	return edges.map((edge, index) => {
		const route = routes[index] ?? edge.points;
		return {
			...edge,
			points: expanded.has(index) ? simplifyRoute(route) : route,
		};
	});
}

/** Bends allowed on the obstacle-avoiding fallback of a short route (#95). */
const SHORT_PATH_FALLBACK_MAX_BENDS = 6;

/**
 * Move a route's ends back onto pinned points by shifting the first/last
 * segment across (it keeps its direction). Ends whose segment cannot be
 * shifted that way are left as they are.
 */
function pinRouteEnds(
	points: readonly Point[],
	sourcePoint: Point | undefined,
	targetPoint: Point | undefined,
): Point[] {
	const pinned = points.map((point) => ({ ...point }));
	const pin = (endIndex: number, nextIndex: number, to: Point) => {
		const end = pinned[endIndex];
		const next = pinned[nextIndex];
		if (end === undefined || next === undefined || pinned.length < 3) return;
		if (Math.abs(end.y - next.y) < 0.5 && Math.abs(end.x - to.x) < 0.5) {
			end.y = to.y;
			next.y = to.y;
		} else if (Math.abs(end.x - next.x) < 0.5 && Math.abs(end.y - to.y) < 0.5) {
			end.x = to.x;
			next.x = to.x;
		}
	};
	if (sourcePoint !== undefined) pin(0, 1, sourcePoint);
	if (targetPoint !== undefined) {
		pin(pinned.length - 1, pinned.length - 2, targetPoint);
	}
	return pinned;
}

function polylineLength(points: readonly Point[]): number {
	let length = 0;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as Point;
		const b = points[index] as Point;
		length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
	}
	return length;
}

function manhattan(a: Point | undefined, b: Point | undefined): number {
	if (a === undefined || b === undefined) return 0;
	return Math.max(1, Math.abs(b.x - a.x) + Math.abs(b.y - a.y));
}

/** The side of `box` that `point` lies on (the nearest one). */
function sideOfBox(point: Point | undefined, box: Box): AnchorName {
	if (point === undefined) return "center";
	const distances: [AnchorName, number][] = [
		["left", Math.abs(point.x - box.x)],
		["right", Math.abs(point.x - (box.x + box.width))],
		["top", Math.abs(point.y - box.y)],
		["bottom", Math.abs(point.y - (box.y + box.height))],
	];
	distances.sort((left, right) => left[1] - right[1]);
	return (distances[0] as [AnchorName, number])[0];
}

/** Side fractions taken by named ports, keyed `${nodeId}:${side}`. */
function occupiedPortFractions(
	coordinatedNodes: readonly CoordinatedNode[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
): Map<string, number[]> {
	const occupied = new Map<string, number[]>();
	for (const node of coordinatedNodes) {
		const box = nodes.get(node.id)?.box;
		if (box === undefined) continue;
		for (const port of node.ports ?? []) {
			const horizontal = port.side === "top" || port.side === "bottom";
			const span = horizontal ? box.width : box.height;
			if (!(span > 0)) continue;
			const fraction = horizontal
				? (port.anchor.x - box.x) / span
				: (port.anchor.y - box.y) / span;
			const key = `${node.id}:${port.side}`;
			occupied.set(key, [...(occupied.get(key) ?? []), fraction]);
		}
	}
	return occupied;
}

function implicitAnchorDistribution(options: SolveDiagramOptions): boolean {
	return (
		options.anchorCapacity === undefined &&
		(options.routeKind ?? "orthogonal") === "orthogonal"
	);
}

/**
 * Post-route nudging: spread edges that share a corridor into parallel
 * tracks so fan-out / fan-in bundles stay readable. Rail-allocated edges
 * are kept fixed.
 */
function separateCoordinatedEdges(
	edges: CoordinatedEdge[],
	obstacles: readonly PostPassObstacle[],
	railAllocations: ReadonlyMap<string, RoutingRailAllocation> | undefined,
	options: SolveDiagramOptions,
	fixedEdgeIds: ReadonlySet<string> = new Set(),
): CoordinatedEdge[] {
	const routeKind = options.routeKind ?? "orthogonal";
	if (routeKind === "straight" || edges.length === 0) {
		return edges;
	}
	// Track spreading can be switched off (or has nothing to spread); the
	// obstacle-escape repair always runs on orthogonal routes.
	const separate = !(edges.length < 2 || options.edgeSeparation === false);
	const spacing =
		typeof options.edgeSeparation === "object"
			? options.edgeSeparation.spacing
			: undefined;
	const separated = separateParallelSegments(
		edges.map((edge) => {
			const ignoreObstacles = new Set<number>();
			obstacles.forEach((obstacle, index) => {
				if (!obstacleAppliesTo(obstacle, edge)) ignoreObstacles.add(index);
			});
			return {
				id: edge.id,
				points: edge.points,
				fixed:
					railAllocations?.has(edge.id) === true || fixedEdgeIds.has(edge.id),
				ignoreObstacles,
			};
		}),
		obstacles.map((obstacle) => obstacle.box),
		{
			separate,
			// End splitting belongs to implicit distribution, like border
			// detachment: explicit rail/gutter pages keep their port segments.
			splitEnds: implicitAnchorDistribution(options),
			// Short-orthogonal end segments are most of the route.
			lockEnds: routeKind === "short-orthogonal-jumps",
			// A node hit outweighs any number of label or group grazes.
			obstacleWeights: obstacles.map((obstacle) => obstacle.weight ?? 1),
			...(spacing === undefined ? {} : { spacing }),
		},
	);
	return edges.map((edge, index) => ({
		...edge,
		points: separated[index] ?? edge.points,
	}));
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
	if (
		routeKind !== "orthogonal" &&
		routeKind !== "obstacle-avoiding" &&
		routeKind !== "short-orthogonal-jumps"
	) {
		return 0;
	}
	if (typeof setting === "object") {
		return Math.max(0, Math.floor(setting.maxIterations ?? 4));
	}
	if (
		setting === true ||
		routeKind === "obstacle-avoiding" ||
		routeKind === "short-orthogonal-jumps"
	) {
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
