import { intersectsAabb, validateBox } from "../geometry/boxes.js";
import { getEdgePort } from "../geometry/shapes.js";
import {
	type BoxSpatialIndex,
	createBoxSpatialIndex,
	querySegmentSpatialIndex,
} from "../geometry/spatial-index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	AnchorName,
	Box,
	DiagramDirection,
	Point,
} from "../ir/geometry.js";
import { filterObstaclesByCorridor, findObstacleFreePath } from "./astar.js";
import { resolveMaxCorners, resolveMaxNodes } from "./budget.js";
import type {
	RouteEdgeInput,
	RouteEdgeResult,
	RouteHardObstacleMetadata,
} from "./types.js";
import { findCornerGraphPath } from "./visibility-router.js";

/**
 * Emit a diagnostic when the route length exceeds `threshold` × the
 * straight-line distance between source and target (Issue #49, P0-4).
 */
function checkBacktracking(
	points: readonly Point[],
	source: Point,
	target: Point,
	diagnostics: Diagnostic[],
	maxRatio?: number,
): void {
	const diagnostic = backtrackingDiagnostic(points, source, target, maxRatio);
	if (diagnostic !== undefined) {
		diagnostics.push(diagnostic);
	}
}

function backtrackingDiagnostic(
	points: readonly Point[],
	source: Point,
	target: Point,
	maxRatio?: number,
): Diagnostic | undefined {
	if (points.length < 2) return;
	const direct = Math.hypot(target.x - source.x, target.y - source.y);
	if (direct <= 0) return;
	const routeLen = routeLength(points);
	const threshold = maxRatio ?? 20;
	if (routeLen > direct * threshold) {
		return {
			severity: "warning",
			code: "routing.backtracking_excessive",
			message: `Route length ${Math.round(routeLen)} px exceeds ${threshold}× direct distance ${Math.round(direct)} px.`,
			detail: {
				routeLength: Math.round(routeLen),
				directDistance: Math.round(direct),
				threshold,
			},
		};
	}
}

function routeLength(points: readonly Point[]): number {
	let routeLen = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i] as Point;
		const b = points[i + 1] as Point;
		routeLen += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return routeLen;
}

interface RouteQuality {
	readonly hardCrossings: number;
	readonly hardCrossingLength: number;
	readonly endpointCrossings: number;
	readonly endpointCrossingLength: number;
	readonly softCrossings: number;
	readonly softCrossingLength: number;
	readonly excessiveLength: number;
	readonly backtrackDistance: number;
	readonly anchorPenalty: number;
	readonly bendCount: number;
	readonly routeLength: number;
}

function routeQuality(
	points: readonly Point[],
	source: Point,
	target: Point,
	softObstacles: readonly Box[],
	hardObstacles: readonly Box[],
	endpointObstacles: readonly Box[],
	maxBacktrackingRatio?: number,
	anchorPenalty = 0,
): RouteQuality {
	const hard = routeObstacleCrossingStats(points, hardObstacles);
	const endpoints = routeObstacleCrossingStats(points, endpointObstacles);
	const soft = routeObstacleCrossingStats(points, softObstacles);
	const length = routeLength(points);
	const direct = Math.hypot(target.x - source.x, target.y - source.y);
	const threshold = maxBacktrackingRatio ?? 20;
	const excessiveLength =
		direct <= 0 ? 0 : Math.max(0, length - direct * threshold);
	return {
		hardCrossings: hard.count,
		hardCrossingLength: hard.length,
		endpointCrossings: endpoints.count,
		endpointCrossingLength: endpoints.length,
		softCrossings: soft.count,
		softCrossingLength: soft.length,
		excessiveLength,
		backtrackDistance: routeBacktrackDistance(points, source, target),
		anchorPenalty,
		bendCount: routeBendCount(points),
		routeLength: length,
	};
}

function compareRouteQuality(left: RouteQuality, right: RouteQuality): number {
	return (
		left.hardCrossings - right.hardCrossings ||
		left.hardCrossingLength - right.hardCrossingLength ||
		left.endpointCrossings - right.endpointCrossings ||
		left.endpointCrossingLength - right.endpointCrossingLength ||
		left.softCrossings - right.softCrossings ||
		left.softCrossingLength - right.softCrossingLength ||
		left.excessiveLength - right.excessiveLength ||
		left.routeLength - right.routeLength ||
		left.bendCount - right.bendCount ||
		left.backtrackDistance - right.backtrackDistance ||
		left.anchorPenalty - right.anchorPenalty
	);
}

function routeObstacleCrossingStats(
	points: readonly Point[],
	obstacles: readonly Box[],
): { count: number; length: number } {
	let count = 0;
	let length = 0;
	for (const obstacle of obstacles) {
		validateBox(obstacle);
		let obstacleLength = 0;
		for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
			const a = points[pointIndex];
			const b = points[pointIndex + 1];
			if (a === undefined || b === undefined) {
				continue;
			}
			obstacleLength += segmentObstacleOverlapLength(a, b, obstacle);
		}
		if (obstacleLength > 0) {
			count += 1;
			length += obstacleLength;
		}
	}
	return { count, length };
}

function segmentObstacleOverlapLength(
	start: Point,
	end: Point,
	obstacle: Box,
): number {
	if (!segmentIntersectsBox(start, end, obstacle)) {
		return 0;
	}
	if (start.y === end.y) {
		const low = Math.max(Math.min(start.x, end.x), obstacle.x);
		const high = Math.min(
			Math.max(start.x, end.x),
			obstacle.x + obstacle.width,
		);
		return Math.max(0, high - low);
	}
	if (start.x === end.x) {
		const low = Math.max(Math.min(start.y, end.y), obstacle.y);
		const high = Math.min(
			Math.max(start.y, end.y),
			obstacle.y + obstacle.height,
		);
		return Math.max(0, high - low);
	}
	return Math.hypot(end.x - start.x, end.y - start.y);
}

function routeBacktrackDistance(
	points: readonly Point[],
	source: Point,
	target: Point,
): number {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const direct = Math.hypot(dx, dy);
	if (direct <= 0) {
		return 0;
	}
	const ux = dx / direct;
	const uy = dy / direct;
	let distance = 0;
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const projection = (end.x - start.x) * ux + (end.y - start.y) * uy;
		if (projection < 0) {
			distance += -projection;
		}
	}
	return distance;
}

function routeBendCount(points: readonly Point[]): number {
	let bends = 0;
	let previousDirection: "h" | "v" | "d" | undefined;
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const direction = start.y === end.y ? "h" : start.x === end.x ? "v" : "d";
		if (previousDirection !== undefined && previousDirection !== direction) {
			bends += 1;
		}
		previousDirection = direction;
	}
	return bends;
}

export function routeEdge(input: RouteEdgeInput): RouteEdgeResult {
	const diagnostics: Diagnostic[] = [];
	const softObstacles = input.obstacles ?? [];
	const hardObstacles = input.hardObstacles ?? [];
	const hardObstacleMetadata = input.hardObstacleMetadata ?? [];
	const fallbackDetail: Record<string, string | number | boolean | undefined> =
		{
			fallbackSeverity: input.fallbackSeverity,
		};
	const maxAttachPoints = Math.min(
		5,
		Math.max(1, input.maxAttachPointsPerSide ?? 1),
	);
	// Best rejected path from A* routing — used as fallback when all
	// heuristic candidates also fail, to avoid returning a 2-point
	// direct connection that is always worse than a path with minor
	// crossings (Issue #66, root cause 3). Only hard/endpoint-clear paths are
	// stored, and among those the shared route quality model decides which
	// fallback is least bad for large obstacles and dense text.
	let bestRejectedPath: Point[] | undefined;
	let bestRejectedQuality: RouteQuality | undefined;
	const softObstacleIndex =
		input.obstacleIndex ?? createBoxSpatialIndex(indexedBoxes(softObstacles));
	const hardObstacleIndex =
		input.hardObstacleIndex ??
		createBoxSpatialIndex(indexedBoxes(hardObstacles));
	// Record a rejected but hard-clear finalized path, keeping the one with
	// the lowest route cost (Issue #66, Codex P2).
	const recordRejected = (
		candidate: Point[],
		source: Point,
		target: Point,
		endpointObstacles: readonly Box[],
	): void => {
		const quality = routeQuality(
			candidate,
			source,
			target,
			softObstacles,
			hardObstacles,
			endpointObstacles,
			input.maxBacktrackingRatio,
		);
		if (quality.hardCrossings > 0 || quality.endpointCrossings > 0) {
			return;
		}
		if (
			bestRejectedQuality === undefined ||
			compareRouteQuality(quality, bestRejectedQuality) < 0
		) {
			bestRejectedQuality = quality;
			bestRejectedPath = candidate;
		}
	};
	const maxAttempts = input.maxRoutingAttempts ?? 5;
	const defaultAnchors = defaultAnchorsForGeometry(
		input.source.box,
		input.target.box,
		input.direction,
	);
	let bestExcessiveCleanRoute:
		| { points: Point[]; diagnostic: Diagnostic; routeLength: number }
		| undefined;
	const acceptCleanRoute = (
		points: Point[],
		source: Point,
		target: Point,
	): RouteEdgeResult | undefined => {
		const diagnostic = backtrackingDiagnostic(
			points,
			source,
			target,
			input.maxBacktrackingRatio,
		);
		if (diagnostic === undefined) {
			return { points, diagnostics };
		}
		const candidateLength = routeLength(points);
		if (
			bestExcessiveCleanRoute === undefined ||
			candidateLength < bestExcessiveCleanRoute.routeLength
		) {
			bestExcessiveCleanRoute = {
				points,
				diagnostic,
				routeLength: candidateLength,
			};
		}
		return undefined;
	};
	const returnBestExcessiveCleanRoute = (): RouteEdgeResult | undefined => {
		if (bestExcessiveCleanRoute === undefined) {
			return undefined;
		}
		diagnostics.push(bestExcessiveCleanRoute.diagnostic);
		return {
			points: bestExcessiveCleanRoute.points,
			diagnostics,
		};
	};

	if ((input.kind ?? "orthogonal") === "straight") {
		const source = getEdgePort(
			input.source,
			input.target.center,
			input.sourceAnchor ?? defaultAnchors.sourceAnchor,
		);
		const target = getEdgePort(
			input.target,
			input.source.center,
			input.targetAnchor ?? defaultAnchors.targetAnchor,
		);
		const points = commitFinalizedRoute(
			finalizeRoute(
				[source, target],
				softObstacles,
				hardObstacles,
				diagnostics,
				softObstacleIndex,
				hardObstacleIndex,
				fallbackDetail,
			),
			diagnostics,
		);
		if (routeCrossesBoxes(points, hardObstacles, hardObstacleIndex)) {
			diagnostics.push(
				hardObstacleFailureDiagnostic({
					points,
					hardObstacles,
					hardObstacleMetadata,
					evidenceMessage:
						"Straight route crosses hard evidence block obstacles.",
					textMessage: "Straight route crosses hard text label obstacles.",
				}),
			);
			return { points, diagnostics };
		}
		if (routeCrossesBoxes(points, softObstacles, softObstacleIndex)) {
			diagnostics.push({
				severity: "warning",
				code: "routing.obstacle.unavoidable",
				message: "Straight route crosses soft obstacles.",
				detail: {
					conflictClass: "fixed-geometry-block",
				},
			});
		}
		return { points, diagnostics };
	}

	// For obstacle-avoiding edges, try A* visibility-graph routing
	// first.  Fall through to heuristic candidates if it fails (#39).
	// Collect clearance-feasible candidates across attach-point pairs and
	// pick the shortest feasible (#76 tournament) instead of first-clean.
	if ((input.kind ?? "orthogonal") === "obstacle-avoiding") {
		const endpointObstacles = endpointInteriorObstacles(input);
		const cleanTournament: Array<{
			points: Point[];
			source: Point;
			target: Point;
			quality: RouteQuality;
		}> = [];
		const allObstacles = [...softObstacles, ...hardObstacles];
		const corridorMargin = input.corridorMargin ?? 32;
		const cornerBudget = (obstacleCount: number): number =>
			resolveMaxCorners(input.maxCorners, {
				corridorMargin,
				obstacleCount,
			});
		const gridBudget = resolveMaxNodes(input.maxNodes, {
			corridorMargin,
			obstacleCount: allObstacles.length + endpointObstacles.length,
		});
		const considerClean = (
			candidate: Point[],
			source: Point,
			target: Point,
			anchorPenalty: number,
		): void => {
			if (
				routeIntersectsObstacles(candidate, softObstacles, softObstacleIndex) ||
				routeIntersectsObstacles(candidate, hardObstacles, hardObstacleIndex) ||
				routeIntersectsEndpointInteriors(candidate, endpointObstacles)
			) {
				recordRejected(candidate, source, target, endpointObstacles);
				return;
			}
			const quality = routeQuality(
				candidate,
				source,
				target,
				softObstacles,
				hardObstacles,
				endpointObstacles,
				input.maxBacktrackingRatio,
				anchorPenalty,
			);
			cleanTournament.push({ points: candidate, source, target, quality });
		};
		const detourBudget = input.maxDetourRatio ?? 3;
		const hasGoodEnoughClean = (): boolean =>
			cleanTournament.some(
				(candidate) =>
					candidate.quality.softCrossings === 0 &&
					candidate.quality.hardCrossings === 0 &&
					detourRatio(candidate.points, candidate.source, candidate.target) <=
						detourBudget,
			);
		let previousSideKey: string | undefined;

		for (const pair of routeTournamentPairs(
			input,
			defaultAnchors,
			maxAttachPoints,
		)) {
			const sideKey = `${pair.sourceAnchor}->${pair.targetAnchor}`;
			// Finish the current side-pair's attach-point tournament, then stop
			// once a soft/hard-clear path is within detour budget. This keeps
			// #76 multi-port selection without multiplying A* across every
			// alternate side on sparse diagrams (CI stress).
			if (
				previousSideKey !== undefined &&
				sideKey !== previousSideKey &&
				hasGoodEnoughClean()
			) {
				break;
			}
			previousSideKey = sideKey;
			const { source, target, anchorPenalty } = pair;
			const corridorObstacles = filterObstaclesByCorridor(
				source,
				target,
				allObstacles,
				[],
				corridorMargin,
			);
			const cornerObstacles =
				corridorObstacles.length === 0 && allObstacles.length > 0
					? allObstacles
					: corridorObstacles;
			let cornerPath = findCornerGraphPath(
				source,
				target,
				cornerObstacles,
				{
					endpointObstacles,
					margin: 2,
					maxCorners: cornerBudget(cornerObstacles.length),
					textObstacleVertices: input.textObstacleVertices === true,
				},
				diagnostics,
			);
			if (cornerPath === null && cornerObstacles.length < allObstacles.length) {
				cornerPath = findCornerGraphPath(
					source,
					target,
					allObstacles,
					{
						endpointObstacles,
						margin: 2,
						maxCorners: cornerBudget(allObstacles.length),
						textObstacleVertices: input.textObstacleVertices === true,
					},
					diagnostics,
				);
			}
			const path =
				cornerPath ??
				findObstacleFreePath(
					source,
					target,
					allObstacles,
					{
						endpointObstacles,
						margin: 0,
						corridorMargin,
						maxNodes: gridBudget,
						textObstacleVertices: input.textObstacleVertices === true,
					},
					diagnostics,
				);
			if (path === null || path.length < 2) {
				continue;
			}
			const finalized = finalizeRoutePoints(
				path,
				softObstacles,
				hardObstacles,
				diagnostics,
				softObstacleIndex,
				hardObstacleIndex,
			);
			if (
				!routeIntersectsObstacles(
					finalized,
					softObstacles,
					softObstacleIndex,
				) &&
				!routeIntersectsObstacles(
					finalized,
					hardObstacles,
					hardObstacleIndex,
				) &&
				!routeIntersectsEndpointInteriors(finalized, endpointObstacles)
			) {
				considerClean(finalized, source, target, anchorPenalty);
				continue;
			}
			recordRejected(finalized, source, target, endpointObstacles);
			if (cornerPath === null) {
				continue;
			}
			const fullCornerPath =
				cornerObstacles.length < allObstacles.length
					? findCornerGraphPath(
							source,
							target,
							allObstacles,
							{
								endpointObstacles,
								margin: 2,
								maxCorners: cornerBudget(allObstacles.length),
								textObstacleVertices: input.textObstacleVertices === true,
							},
							diagnostics,
						)
					: null;
			if (fullCornerPath !== null && fullCornerPath.length >= 2) {
				const fullFinalized = finalizeRoutePoints(
					fullCornerPath,
					softObstacles,
					hardObstacles,
					diagnostics,
					softObstacleIndex,
					hardObstacleIndex,
				);
				if (
					!routeIntersectsObstacles(
						fullFinalized,
						softObstacles,
						softObstacleIndex,
					) &&
					!routeIntersectsObstacles(
						fullFinalized,
						hardObstacles,
						hardObstacleIndex,
					) &&
					!routeIntersectsEndpointInteriors(fullFinalized, endpointObstacles)
				) {
					considerClean(fullFinalized, source, target, anchorPenalty);
					continue;
				}
				recordRejected(fullFinalized, source, target, endpointObstacles);
			}
			const gridPath = findObstacleFreePath(
				source,
				target,
				allObstacles,
				{
					endpointObstacles,
					margin: 0,
					corridorMargin,
					maxNodes: gridBudget,
					textObstacleVertices: input.textObstacleVertices === true,
				},
				diagnostics,
			);
			if (gridPath !== null && gridPath.length >= 2) {
				const gridFinalized = finalizeRoutePoints(
					gridPath,
					softObstacles,
					hardObstacles,
					diagnostics,
					softObstacleIndex,
					hardObstacleIndex,
				);
				if (
					!routeIntersectsObstacles(
						gridFinalized,
						softObstacles,
						softObstacleIndex,
					) &&
					!routeIntersectsObstacles(
						gridFinalized,
						hardObstacles,
						hardObstacleIndex,
					) &&
					!routeIntersectsEndpointInteriors(gridFinalized, endpointObstacles)
				) {
					considerClean(gridFinalized, source, target, anchorPenalty);
				} else {
					recordRejected(gridFinalized, source, target, endpointObstacles);
				}
			}
		}

		if (cleanTournament.length > 0) {
			cleanTournament.sort((left, right) =>
				compareRouteQuality(left.quality, right.quality),
			);
			const best = cleanTournament[0];
			if (best !== undefined) {
				const detour = detourRatio(best.points, best.source, best.target);
				if (
					input.maxDetourRatio !== undefined &&
					detour > input.maxDetourRatio
				) {
					diagnostics.push({
						severity: "warning",
						code: "routing.obstacle.unavoidable",
						message: `Shortest clearance-feasible route exceeds maxDetourRatio ${input.maxDetourRatio} (detour ${detour.toFixed(2)}).`,
						detail: {
							conflictClass: "fixed-geometry-block",
							remediationType: "route-rail-or-page-split",
							detourRatio: Number(detour.toFixed(2)),
							maxDetourRatio: input.maxDetourRatio,
							routeLength: Math.round(best.quality.routeLength),
						},
					});
					recordRejected(
						best.points,
						best.source,
						best.target,
						endpointObstacles,
					);
				} else {
					const accepted = acceptCleanRoute(
						best.points,
						best.source,
						best.target,
					);
					if (accepted !== undefined) {
						return accepted;
					}
				}
			}
		}
	}

	const routeLaneObstacles = [...softObstacles, ...hardObstacles];
	const anchorPairs = routeAnchorPairs(input, defaultAnchors);
	const candidateRoutes = anchorPairs.flatMap(
		({ sourceAnchor, targetAnchor, anchorPenalty }) => {
			const source = getEdgePort(
				input.source,
				input.target.center,
				sourceAnchor,
			);
			const target = getEdgePort(
				input.target,
				input.source.center,
				targetAnchor,
			);
			const routes = [
				...orthogonalCandidates(source, target, input.direction),
				...endpointEscapeCandidates(
					source,
					target,
					sourceAnchor,
					targetAnchor,
					input.direction,
				),
				...expandedObstacleCandidates(
					source,
					target,
					input.direction,
					routeLaneObstacles,
				),
				...outerDoglegCandidates(
					source,
					target,
					input.direction,
					routeLaneObstacles,
				),
			];
			const endpointObstacles = endpointInteriorObstacles(input);
			return routes.map((points) => ({
				points,
				source,
				target,
				endpointObstacles,
				quality: routeQuality(
					points,
					source,
					target,
					softObstacles,
					hardObstacles,
					endpointObstacles,
					input.maxBacktrackingRatio,
					anchorPenalty,
				),
			}));
		},
	);
	const rankedCandidateRoutes = [...candidateRoutes].sort((left, right) =>
		compareRouteQuality(left.quality, right.quality),
	);
	for (const candidate of rankedCandidateRoutes) {
		if (
			!routeIntersectsObstacles(candidate.points, softObstacles) &&
			!routeIntersectsObstacles(
				candidate.points,
				softObstacles,
				softObstacleIndex,
			) &&
			!routeIntersectsObstacles(
				candidate.points,
				hardObstacles,
				hardObstacleIndex,
			) &&
			!routeIntersectsEndpointInteriors(
				candidate.points,
				candidate.endpointObstacles,
			)
		) {
			const finalizedClean = finalizeRoutePoints(
				candidate.points,
				softObstacles,
				hardObstacles,
				diagnostics,
				softObstacleIndex,
				hardObstacleIndex,
			);
			const accepted = acceptCleanRoute(
				finalizedClean,
				candidate.source,
				candidate.target,
			);
			if (accepted !== undefined) {
				return accepted;
			}
		}
	}

	const bestExcessiveClean = returnBestExcessiveCleanRoute();
	if (bestExcessiveClean !== undefined) {
		return bestExcessiveClean;
	}

	const hardClearCandidate = rankedCandidateRoutes.find(
		(candidate) =>
			!routeIntersectsObstacles(
				candidate.points,
				hardObstacles,
				hardObstacleIndex,
			) &&
			!routeIntersectsEndpointInteriors(
				candidate.points,
				candidate.endpointObstacles,
			),
	);
	if (hardClearCandidate !== undefined) {
		let bestPoints = hardClearCandidate.points;
		if (input.kind === "obstacle-avoiding") {
			const allObstacles = [...softObstacles, ...hardObstacles];
			// Try greedy rerouting on all hard-clear candidates, not just the first.
			for (const candidate of rankedCandidateRoutes) {
				if (
					routeCrossesBoxes(candidate.points, hardObstacles) ||
					routeIntersectsEndpointInteriors(
						candidate.points,
						candidate.endpointObstacles,
					)
				) {
					continue;
				}
				const rerouted = greedyRerouteAroundObstacles(
					candidate.points,
					allObstacles,
					maxAttempts,
				);
				if (
					!routeCrossesBoxes(rerouted, allObstacles) &&
					!routeIntersectsEndpointInteriors(
						rerouted,
						candidate.endpointObstacles,
					)
				) {
					const finalized = finalizeRoutePoints(
						rerouted,
						softObstacles,
						hardObstacles,
						diagnostics,
					);
					const accepted = acceptCleanRoute(
						finalized,
						candidate.source,
						candidate.target,
					);
					if (accepted !== undefined) {
						return accepted;
					}
				}
			}
			const excessiveClean = returnBestExcessiveCleanRoute();
			if (excessiveClean !== undefined) {
				return excessiveClean;
			}
			// Fall back to improving the first hard-clear candidate
			const rerouted = greedyRerouteAroundObstacles(
				bestPoints,
				allObstacles,
				maxAttempts,
			);
			const reroutedAvoidsEndpointInteriors = !routeIntersectsEndpointInteriors(
				rerouted,
				hardClearCandidate.endpointObstacles,
			);
			if (reroutedAvoidsEndpointInteriors) {
				if (
					routeCrossesBoxes(rerouted, hardObstacles) &&
					!routeCrossesBoxes(bestPoints, hardObstacles)
				) {
					// keep original hard-clear candidate
				} else {
					bestPoints = rerouted;
				}
			}
		}
		diagnostics.push({
			severity: "warning",
			code: "routing.obstacle.unavoidable",
			message:
				"No bounded orthogonal route candidate avoided all soft obstacles.",
			detail: {
				conflictClass: "fixed-geometry-block",
			},
		});

		// Prefer the path with fewer soft-obstacle crossings between the A*
		// rejected path and the heuristic candidate (Codex P2). Compare AFTER
		// finalization — only prefer rejected when strictly better. Commit the
		// chosen path's fallback diagnostic only (#75 Stage-3).
		const softBestResult = preferHardClearOverFatalFallback(
			finalizeRoute(
				bestPoints,
				softObstacles,
				hardObstacles,
				undefined,
				softObstacleIndex,
				hardObstacleIndex,
				fallbackDetail,
			),
			bestRejectedPath,
			softObstacles,
			hardObstacles,
			softObstacleIndex,
			hardObstacleIndex,
			fallbackDetail,
		);
		let chosenSoft = softBestResult;
		if (bestRejectedPath !== undefined) {
			const rejectedResult = finalizeRoute(
				bestRejectedPath,
				softObstacles,
				hardObstacles,
				undefined,
				softObstacleIndex,
				hardObstacleIndex,
				fallbackDetail,
			);
			const rejectedQuality = routeQuality(
				rejectedResult.points,
				rejectedResult.points[0] as Point,
				rejectedResult.points[rejectedResult.points.length - 1] as Point,
				softObstacles,
				hardObstacles,
				hardClearCandidate.endpointObstacles,
				input.maxBacktrackingRatio,
			);
			const heuristicQuality = routeQuality(
				softBestResult.points,
				softBestResult.points[0] as Point,
				softBestResult.points[softBestResult.points.length - 1] as Point,
				softObstacles,
				hardObstacles,
				hardClearCandidate.endpointObstacles,
				input.maxBacktrackingRatio,
			);
			if (compareRouteQuality(rejectedQuality, heuristicQuality) < 0) {
				chosenSoft = rejectedResult;
			}
		}
		const softFallback = commitFinalizedRoute(chosenSoft, diagnostics);

		// Run backtracking check on the chosen fallback too (Codex P2).
		checkBacktracking(
			softFallback,
			softFallback[0] as Point,
			softFallback[softFallback.length - 1] as Point,
			diagnostics,
			input.maxBacktrackingRatio,
		);
		return {
			points: softFallback,
			diagnostics,
		};
	}

	if (hardObstacles.length > 0) {
		let bestPoints =
			rankedCandidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors);
		if (input.kind === "obstacle-avoiding") {
			const allObstacles = [...softObstacles, ...hardObstacles];
			// Try greedy rerouting on all candidates, return first clean one.
			for (const candidate of rankedCandidateRoutes) {
				const rerouted = greedyRerouteAroundObstacles(
					candidate.points,
					allObstacles,
					maxAttempts,
				);
				if (
					!routeCrossesBoxes(rerouted, allObstacles) &&
					!routeIntersectsEndpointInteriors(
						rerouted,
						candidate.endpointObstacles,
					)
				) {
					const finalized = finalizeRoutePoints(
						rerouted,
						softObstacles,
						hardObstacles,
						diagnostics,
					);
					const accepted = acceptCleanRoute(
						finalized,
						candidate.source,
						candidate.target,
					);
					if (accepted !== undefined) {
						return accepted;
					}
				}
			}
			const excessiveClean = returnBestExcessiveCleanRoute();
			if (excessiveClean !== undefined) {
				return excessiveClean;
			}
			bestPoints = greedyRerouteAroundObstacles(
				rankedCandidateRoutes[0]?.points ??
					fallbackRoute(input, defaultAnchors),
				allObstacles,
				maxAttempts,
			);
		}
		// If A* found a hard-clear path (bestRejectedPath is only ever set
		// to hard-clear routes), prefer it over a heuristic candidate that
		// crosses hard evidence obstacles (Issue #66, Codex P1).
		if (bestRejectedPath !== undefined) {
			diagnostics.push({
				severity: "warning",
				code: "routing.obstacle.unavoidable",
				message:
					"Using A* route with minor soft-obstacle crossings to avoid hard evidence obstacles.",
				detail: {
					conflictClass: "fixed-geometry-block",
				},
			});
			const rejectedFinal = commitFinalizedRoute(
				finalizeRoute(
					bestRejectedPath,
					softObstacles,
					hardObstacles,
					undefined,
					softObstacleIndex,
					hardObstacleIndex,
					fallbackDetail,
				),
				diagnostics,
			);
			return {
				points: rejectedFinal,
				diagnostics,
			};
		}
		const finalResult = preferHardClearOverFatalFallback(
			finalizeRoute(
				bestPoints,
				softObstacles,
				hardObstacles,
				undefined,
				softObstacleIndex,
				hardObstacleIndex,
				fallbackDetail,
			),
			bestRejectedPath,
			softObstacles,
			hardObstacles,
			softObstacleIndex,
			hardObstacleIndex,
			fallbackDetail,
		);
		const finalPoints = commitFinalizedRoute(finalResult, diagnostics);
		const finalEndpointObstacles =
			rankedCandidateRoutes[0]?.endpointObstacles ??
			endpointInteriorObstacles(input);
		if (routeCrossesBoxes(finalPoints, hardObstacles, hardObstacleIndex)) {
			diagnostics.push(
				hardObstacleFailureDiagnostic({
					points: finalPoints,
					hardObstacles,
					hardObstacleMetadata,
					evidenceMessage:
						"No bounded orthogonal route candidate avoided hard evidence block obstacles.",
					textMessage:
						"No bounded orthogonal route candidate avoided hard text label obstacles.",
				}),
			);
		}
		if (routeIntersectsEndpointInteriors(finalPoints, finalEndpointObstacles)) {
			diagnostics.push(endpointInteriorFailureDiagnostic());
		}

		return {
			points: finalPoints,
			diagnostics,
		};
	}

	let bestPoints =
		rankedCandidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors);
	if (input.kind === "obstacle-avoiding") {
		const allObstacles = [...softObstacles, ...hardObstacles];
		// Try greedy rerouting on multiple candidates, not just the first.
		for (const candidate of rankedCandidateRoutes) {
			const rerouted = greedyRerouteAroundObstacles(
				candidate.points,
				allObstacles,
				maxAttempts,
			);
			if (
				!routeCrossesBoxes(rerouted, allObstacles) &&
				!routeIntersectsEndpointInteriors(rerouted, candidate.endpointObstacles)
			) {
				const finalized = finalizeRoutePoints(
					rerouted,
					softObstacles,
					hardObstacles,
					diagnostics,
				);
				const accepted = acceptCleanRoute(
					finalized,
					candidate.source,
					candidate.target,
				);
				if (accepted !== undefined) {
					return accepted;
				}
			}
		}
		// Keep the best attempt from the first candidate
		bestPoints = greedyRerouteAroundObstacles(
			rankedCandidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors),
			allObstacles,
			maxAttempts,
		);
	}
	diagnostics.push({
		severity: "warning",
		code: "routing.obstacle.unavoidable",
		message: "No bounded orthogonal route candidate avoided all obstacles.",
		detail: {
			conflictClass: "fixed-geometry-block",
		},
	});

	// Prefer the path with fewer soft-obstacle crossings between the A*
	// rejected path and the heuristic fallback (Codex P2). Compare AFTER
	// finalization — finalizeRoute can expand/simplify routes to avoid
	// obstacles, so raw crossing counts on unfinalized paths are misleading.
	// Only prefer the A* path when it is strictly better after finalization.
	const finalizedBest = preferHardClearOverFatalFallback(
		finalizeRoute(
			bestPoints,
			softObstacles,
			hardObstacles,
			undefined,
			softObstacleIndex,
			hardObstacleIndex,
			fallbackDetail,
		),
		bestRejectedPath,
		softObstacles,
		hardObstacles,
		softObstacleIndex,
		hardObstacleIndex,
		fallbackDetail,
	);
	let chosenFallback = finalizedBest;
	if (bestRejectedPath !== undefined) {
		const finalizedRejected = finalizeRoute(
			bestRejectedPath,
			softObstacles,
			hardObstacles,
			undefined,
			softObstacleIndex,
			hardObstacleIndex,
			fallbackDetail,
		);
		const endpointObstacles = endpointInteriorObstacles(input);
		const rejectedQuality = routeQuality(
			finalizedRejected.points,
			finalizedRejected.points[0] as Point,
			finalizedRejected.points[finalizedRejected.points.length - 1] as Point,
			softObstacles,
			hardObstacles,
			endpointObstacles,
			input.maxBacktrackingRatio,
		);
		const heuristicQuality = routeQuality(
			finalizedBest.points,
			finalizedBest.points[0] as Point,
			finalizedBest.points[finalizedBest.points.length - 1] as Point,
			softObstacles,
			hardObstacles,
			endpointObstacles,
			input.maxBacktrackingRatio,
		);
		if (compareRouteQuality(rejectedQuality, heuristicQuality) < 0) {
			chosenFallback = finalizedRejected;
		}
	}
	const fallbackPoints = commitFinalizedRoute(chosenFallback, diagnostics);

	// Run backtracking check on the chosen fallback too (Codex P2).
	checkBacktracking(
		fallbackPoints,
		fallbackPoints[0] as Point,
		fallbackPoints[fallbackPoints.length - 1] as Point,
		diagnostics,
		input.maxBacktrackingRatio,
	);
	return {
		points: fallbackPoints,
		diagnostics,
	};
}

interface FinalizeRouteResult {
	points: Point[];
	/** Attach only when this path is the chosen route result (#75 Stage-3). */
	fallbackDiagnostic?: Diagnostic;
}

/**
 * Finalize a candidate polyline. Does not mutate diagnostics — callers must
 * push `fallbackDiagnostic` only when returning this path as the result.
 */
function finalizeRoute(
	points: readonly Point[],
	softObstacles: readonly Box[],
	hardObstacles: readonly Box[],
	_diagnostics: Diagnostic[] | undefined,
	softObstacleIndex?: BoxSpatialIndex,
	hardObstacleIndex?: BoxSpatialIndex,
	detail: Record<string, string | number | boolean | undefined> = {},
): FinalizeRouteResult {
	const simplified = simplifyRoute(points);
	if (simplified.length >= 3) {
		return { points: simplified };
	}
	const crossesHardObstacles = routeCrossesBoxes(
		simplified,
		hardObstacles,
		hardObstacleIndex,
	);
	const crossesSoftObstacles = routeCrossesBoxes(
		simplified,
		softObstacles,
		softObstacleIndex,
	);
	if (!crossesHardObstacles && !crossesSoftObstacles) {
		return { points: simplified };
	}
	const expanded = expandFallbackRoute(simplified, [
		...softObstacles,
		...hardObstacles,
	]);
	const expandedCrossesHard = routeCrossesBoxes(
		expanded,
		hardObstacles,
		hardObstacleIndex,
	);
	const expandedCrossesSoft = routeCrossesBoxes(
		expanded,
		softObstacles,
		softObstacleIndex,
	);
	if (expandedCrossesHard || expandedCrossesSoft) {
		const severity: Diagnostic["severity"] =
			expandedCrossesHard && detail.fallbackSeverity !== "warning"
				? "error"
				: "warning";
		const { fallbackSeverity: _ignored, ...restDetail } = detail;
		return {
			points: expanded,
			fallbackDiagnostic: {
				severity,
				code: "route_obstacle_fallback",
				message:
					"Obstacle-aware routing fell back to fewer than three route points.",
				detail: {
					pointCount: simplified.length,
					conflictClass: expandedCrossesHard
						? "fixed-geometry-block"
						: "soft-obstacle",
					remediationType: "route-rail-or-page-split",
					...Object.fromEntries(
						Object.entries(restDetail).filter(
							([, value]) => value !== undefined,
						),
					),
				},
			},
		};
	}
	return { points: expanded };
}

function finalizeRoutePoints(
	points: readonly Point[],
	softObstacles: readonly Box[],
	hardObstacles: readonly Box[],
	diagnostics: Diagnostic[] | undefined,
	softObstacleIndex?: BoxSpatialIndex,
	hardObstacleIndex?: BoxSpatialIndex,
	detail: Record<string, string | number | boolean | undefined> = {},
): Point[] {
	return finalizeRoute(
		points,
		softObstacles,
		hardObstacles,
		diagnostics,
		softObstacleIndex,
		hardObstacleIndex,
		detail,
	).points;
}

function commitFinalizedRoute(
	finalized: FinalizeRouteResult,
	diagnostics: Diagnostic[],
): Point[] {
	if (finalized.fallbackDiagnostic !== undefined) {
		diagnostics.push(finalized.fallbackDiagnostic);
	}
	return finalized.points;
}

function preferHardClearOverFatalFallback(
	candidate: FinalizeRouteResult,
	rejectedPath: Point[] | undefined,
	softObstacles: readonly Box[],
	hardObstacles: readonly Box[],
	softObstacleIndex: BoxSpatialIndex | undefined,
	hardObstacleIndex: BoxSpatialIndex | undefined,
	detail: Record<string, string | number | boolean | undefined>,
): FinalizeRouteResult {
	if (
		candidate.fallbackDiagnostic?.severity !== "error" ||
		rejectedPath === undefined
	) {
		return candidate;
	}
	const rejected = finalizeRoute(
		rejectedPath,
		softObstacles,
		hardObstacles,
		undefined,
		softObstacleIndex,
		hardObstacleIndex,
		detail,
	);
	if (rejected.fallbackDiagnostic?.severity === "error") {
		return candidate;
	}
	return rejected;
}

function expandFallbackRoute(
	points: readonly Point[],
	obstacles: readonly Box[],
): Point[] {
	if (points.length !== 2) {
		return points.map((point) => ({ ...point }));
	}
	const [source, target] = points;
	if (source === undefined || target === undefined) {
		return points.map((point) => ({ ...point }));
	}
	if (source.y === target.y) {
		const detourY = horizontalDetourLane(source, target, obstacles);
		return [
			{ ...source },
			{ x: source.x, y: detourY },
			{ x: target.x, y: detourY },
			{ ...target },
		];
	}
	if (source.x === target.x) {
		const detourX = verticalDetourLane(source, target, obstacles);
		return [
			{ ...source },
			{ x: detourX, y: source.y },
			{ x: detourX, y: target.y },
			{ ...target },
		];
	}
	// Generate two L-shaped detour candidates for diagonal edges,
	// picking the one that avoids all obstacles with the smallest
	// path-length increase (issue #21 approach A).
	const hv = diagonalDetourHV(source, target, obstacles);
	const vh = diagonalDetourVH(source, target, obstacles);
	// Filter to obstacle-free candidates, preferring shorter paths.
	const viable = [hv, vh].filter((c) => !routeCrossesBoxes(c, obstacles));
	const [firstViable, ...remainingViable] = viable;
	if (firstViable !== undefined) {
		const directLen = Math.hypot(target.x - source.x, target.y - source.y);
		let best = firstViable;
		for (const cand of remainingViable) {
			if (pathLength(cand) - directLen < pathLength(best) - directLen) {
				best = cand;
			}
		}
		return best;
	}
	// Fallback: midpoint L-shape (same as before).
	return [
		{ ...source },
		{ x: (source.x + target.x) / 2, y: source.y },
		{ x: (source.x + target.x) / 2, y: target.y },
		{ ...target },
	];
}

function horizontalDetourLane(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
): number {
	const crossing = obstacles.filter((obstacle) =>
		segmentIntersectsBox(source, target, obstacle),
	);
	if (crossing.length === 0) {
		return source.y + (source.x <= target.x ? 1 : -1) * 24;
	}
	const margin = 24;
	const above = Math.min(...crossing.map((obstacle) => obstacle.y)) - margin;
	const below =
		Math.max(...crossing.map((obstacle) => obstacle.y + obstacle.height)) +
		margin;
	return Math.abs(above - source.y) <= Math.abs(below - source.y)
		? above
		: below;
}

function verticalDetourLane(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
): number {
	const crossing = obstacles.filter((obstacle) =>
		segmentIntersectsBox(source, target, obstacle),
	);
	if (crossing.length === 0) {
		return source.x + (source.y <= target.y ? 1 : -1) * 24;
	}
	const margin = 24;
	const left = Math.min(...crossing.map((obstacle) => obstacle.x)) - margin;
	const right =
		Math.max(...crossing.map((obstacle) => obstacle.x + obstacle.width)) +
		margin;
	return Math.abs(left - source.x) <= Math.abs(right - source.x) ? left : right;
}

function diagonalDetourHV(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
): Point[] {
	const detourY = horizontalDetourLane(source, target, obstacles);
	return [
		{ ...source },
		{ x: source.x, y: detourY },
		{ x: target.x, y: detourY },
		{ ...target },
	];
}

function diagonalDetourVH(
	source: Point,
	target: Point,
	obstacles: readonly Box[],
): Point[] {
	const detourX = verticalDetourLane(source, target, obstacles);
	return [
		{ ...source },
		{ x: detourX, y: source.y },
		{ x: detourX, y: target.y },
		{ ...target },
	];
}

function pathLength(points: readonly Point[]): number {
	let len = 0;
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		if (a !== undefined && b !== undefined) {
			len += Math.hypot(b.x - a.x, b.y - a.y);
		}
	}
	return len;
}

function endpointInteriorObstacles(input: RouteEdgeInput): Box[] {
	const boxes: Box[] = [];
	if (hasDistinctAnchors(input.source) && input.sourceAnchor !== "center") {
		boxes.push(insetBox(input.source.box, 1));
	}
	if (hasDistinctAnchors(input.target) && input.targetAnchor !== "center") {
		boxes.push(insetBox(input.target.box, 1));
	}
	return boxes.filter((box) => box.width > 0 && box.height > 0);
}

function hasDistinctAnchors(geometry: RouteEdgeInput["source"]): boolean {
	const points = new Set(
		geometry.anchors.map((anchor) => `${anchor.point.x},${anchor.point.y}`),
	);
	return points.size > 1;
}

function insetBox(box: Box, margin: number): Box {
	return {
		x: box.x + margin,
		y: box.y + margin,
		width: box.width - margin * 2,
		height: box.height - margin * 2,
	};
}

/**
 * Iteratively pushes route segments away from intersecting obstacles,
 * up to maxIterations times. Returns the improved route (may still
 * cross obstacles if avoidance was not possible).
 */
function greedyRerouteAroundObstacles(
	points: readonly Point[],
	obstacles: readonly Box[],
	maxIterations: number,
): Point[] {
	let current = [...points];
	for (let iter = 0; iter < maxIterations; iter++) {
		const improved = pushRouteAwayFromObstacles(current, obstacles);
		if (improved === null) {
			break; // no improvements possible
		}
		current = improved;
		if (!routeCrossesBoxes(current, obstacles)) {
			break; // route is clean
		}
	}
	return current;
}

/**
 * Tries to push each segment of the route away from intersecting obstacles.
 * Returns a new route with waypoints inserted, or null if no push was possible.
 */
function pushRouteAwayFromObstacles(
	points: readonly Point[],
	obstacles: readonly Box[],
): Point[] | null {
	const result: Point[] = [];
	let improved = false;

	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (a === undefined || b === undefined) {
			result.push(a ?? b ?? { x: 0, y: 0 });
			continue;
		}
		result.push(a);

		const intersectors = obstacles.filter((obs) =>
			segmentIntersectsBox(a, b, obs),
		);
		if (intersectors.length === 0) {
			continue;
		}

		// Find the obstacle whose edge is closest to the segment midpoint.
		const mx = (a.x + b.x) / 2;
		const my = (a.y + b.y) / 2;
		const isHorizontal = a.y === b.y;
		const margin = 12;

		let bestWaypoint: Point | null = null;
		let bestDist = Infinity;

		for (const obs of intersectors) {
			// Try escaping above/below (for horizontal segments) or left/right (for vertical)
			const candidates: Point[] = isHorizontal
				? [
						{ x: mx, y: obs.y - margin },
						{ x: mx, y: obs.y + obs.height + margin },
					]
				: [
						{ x: obs.x - margin, y: my },
						{ x: obs.x + obs.width + margin, y: my },
					];

			for (const wp of candidates) {
				const dist = Math.hypot(wp.x - mx, wp.y - my);
				if (dist < bestDist) {
					bestDist = dist;
					bestWaypoint = wp;
				}
			}
		}

		if (bestWaypoint !== null) {
			result.push(bestWaypoint);
			improved = true;
		}
	}

	const last = points[points.length - 1];
	if (last !== undefined) {
		result.push(last);
	}

	return improved ? result : null;
}

function fallbackRoute(
	input: RouteEdgeInput,
	defaultAnchors: { sourceAnchor: AnchorName; targetAnchor: AnchorName },
): Point[] {
	return [
		getEdgePort(
			input.source,
			input.target.center,
			input.sourceAnchor ?? defaultAnchors.sourceAnchor,
		),
		getEdgePort(
			input.target,
			input.source.center,
			input.targetAnchor ?? defaultAnchors.targetAnchor,
		),
	];
}

function detourRatio(
	points: readonly Point[],
	source: Point,
	target: Point,
): number {
	const direct = Math.hypot(target.x - source.x, target.y - source.y);
	if (direct <= 0) {
		return 0;
	}
	return routeLength(points) / direct;
}

function fractionalSidePoints(
	box: Box,
	side: AnchorName,
	count: number,
): Point[] {
	const n = Math.max(1, count);
	const fractions =
		n === 1
			? [0.5]
			: n === 3
				? [0.5, 0.25, 0.75]
				: Array.from({ length: n }, (_, index) => (index + 1) / (n + 1));
	return fractions.map((fraction) => sidePointAtFraction(box, side, fraction));
}

function sidePointAtFraction(
	box: Box,
	side: AnchorName,
	fraction: number,
): Point {
	const t = Math.min(1, Math.max(0, fraction));
	switch (side) {
		case "left":
			return { x: box.x, y: box.y + box.height * t };
		case "right":
			return { x: box.x + box.width, y: box.y + box.height * t };
		case "top":
			return { x: box.x + box.width * t, y: box.y };
		case "bottom":
			return { x: box.x + box.width * t, y: box.y + box.height };
		default:
			return {
				x: box.x + box.width / 2,
				y: box.y + box.height / 2,
			};
	}
}

function routeTournamentPairs(
	input: RouteEdgeInput,
	defaultAnchors: { sourceAnchor: AnchorName; targetAnchor: AnchorName },
	maxAttachPoints: number,
): Array<{
	source: Point;
	target: Point;
	sourceAnchor: AnchorName;
	targetAnchor: AnchorName;
	anchorPenalty: number;
}> {
	const pairs = routeAnchorPairs(input, defaultAnchors);
	const results: Array<{
		source: Point;
		target: Point;
		sourceAnchor: AnchorName;
		targetAnchor: AnchorName;
		anchorPenalty: number;
	}> = [];
	const seen = new Set<string>();
	for (const pair of pairs) {
		const sourceIsPrimary = pair.sourceAnchor === defaultAnchors.sourceAnchor;
		const targetIsPrimary = pair.targetAnchor === defaultAnchors.targetAnchor;
		const sourcePoints =
			input.sourceAnchor !== undefined ||
			!sourceIsPrimary ||
			!isCardinalAnchor(pair.sourceAnchor)
				? [getEdgePort(input.source, input.target.center, pair.sourceAnchor)]
				: fractionalSidePoints(
						input.source.box,
						pair.sourceAnchor,
						maxAttachPoints,
					);
		const targetPoints =
			input.targetAnchor !== undefined ||
			!targetIsPrimary ||
			!isCardinalAnchor(pair.targetAnchor)
				? [getEdgePort(input.target, input.source.center, pair.targetAnchor)]
				: fractionalSidePoints(
						input.target.box,
						pair.targetAnchor,
						maxAttachPoints,
					);
		for (let si = 0; si < sourcePoints.length; si += 1) {
			for (let ti = 0; ti < targetPoints.length; ti += 1) {
				const source = sourcePoints[si];
				const target = targetPoints[ti];
				if (source === undefined || target === undefined) continue;
				const key = `${source.x},${source.y}->${target.x},${target.y}`;
				if (seen.has(key)) continue;
				seen.add(key);
				results.push({
					source,
					target,
					sourceAnchor: pair.sourceAnchor,
					targetAnchor: pair.targetAnchor,
					anchorPenalty: pair.anchorPenalty + si + ti,
				});
			}
		}
	}
	return results;
}

function isCardinalAnchor(
	anchor: AnchorName,
): anchor is "top" | "right" | "bottom" | "left" {
	return (
		anchor === "top" ||
		anchor === "right" ||
		anchor === "bottom" ||
		anchor === "left"
	);
}

function routeAnchorPairs(
	input: RouteEdgeInput,
	defaultAnchors: { sourceAnchor: AnchorName; targetAnchor: AnchorName },
): Array<{
	sourceAnchor: AnchorName;
	targetAnchor: AnchorName;
	anchorPenalty: number;
}> {
	const sourceAnchors = routeAnchorCandidates(
		input.sourceAnchor,
		defaultAnchors.sourceAnchor,
		input.source,
		input.target.center,
	);
	const targetAnchors = routeAnchorCandidates(
		input.targetAnchor,
		defaultAnchors.targetAnchor,
		input.target,
		input.source.center,
	);
	const pairs = sourceAnchors.flatMap((sourceAnchor, sourceIndex) =>
		targetAnchors.map((targetAnchor, targetIndex) => ({
			sourceAnchor,
			targetAnchor,
			anchorPenalty: sourceIndex * 10 + targetIndex,
		})),
	);
	const seen = new Set<string>();
	return pairs.filter((pair) => {
		const key = `${pair.sourceAnchor}->${pair.targetAnchor}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function routeAnchorCandidates(
	explicitAnchor: AnchorName | undefined,
	defaultAnchor: AnchorName,
	geometry: RouteEdgeInput["source"],
	toward: Point,
): AnchorName[] {
	if (explicitAnchor !== undefined) {
		return [explicitAnchor];
	}
	const ranked = rankedSideAnchors(geometry, toward);
	return [defaultAnchor, ...ranked].filter(
		(anchor, index, anchors) => anchors.indexOf(anchor) === index,
	);
}

function rankedSideAnchors(
	geometry: RouteEdgeInput["source"],
	toward: Point,
): AnchorName[] {
	const anchors = outwardSideAnchors(geometry.box, toward);
	return anchors.sort((left, right) => {
		const leftPoint = getEdgePort(geometry, toward, left);
		const rightPoint = getEdgePort(geometry, toward, right);
		const distance =
			squaredDistance(leftPoint, toward) - squaredDistance(rightPoint, toward);
		return distance === 0 ? left.localeCompare(right) : distance;
	});
}

function outwardSideAnchors(box: Box, toward: Point): AnchorName[] {
	const center = {
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
	};
	const dx = toward.x - center.x;
	const dy = toward.y - center.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? ["right", "top", "bottom"] : ["left", "top", "bottom"];
	}
	return dy >= 0 ? ["bottom", "left", "right"] : ["top", "left", "right"];
}

function squaredDistance(a: Point, b: Point): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

export function simplifyRoute(points: readonly Point[]): Point[] {
	const withoutDuplicates: Point[] = [];
	for (const point of points) {
		const previous = withoutDuplicates.at(-1);
		if (
			previous === undefined ||
			previous.x !== point.x ||
			previous.y !== point.y
		) {
			withoutDuplicates.push({ ...point });
		}
	}

	const simplified: Point[] = [];
	for (const point of withoutDuplicates) {
		const previous = simplified.at(-1);
		const beforePrevious = simplified.at(-2);
		if (
			previous !== undefined &&
			beforePrevious !== undefined &&
			areCollinear(beforePrevious, previous, point)
		) {
			simplified[simplified.length - 1] = { ...point };
		} else {
			simplified.push({ ...point });
		}
	}

	return simplified;
}

function orthogonalCandidates(
	source: Point,
	target: Point,
	direction: RouteEdgeInput["direction"],
): Point[][] {
	const midpointX = (source.x + target.x) / 2;
	const midpointY = (source.y + target.y) / 2;
	const candidates: Point[][] = [];

	if (direction === "TB" || direction === "BT") {
		candidates.push([
			source,
			{ x: source.x, y: midpointY },
			{ x: target.x, y: midpointY },
			target,
		]);
	} else {
		candidates.push([
			source,
			{ x: midpointX, y: source.y },
			{ x: midpointX, y: target.y },
			target,
		]);
	}

	candidates.push(
		[source, { x: target.x, y: source.y }, target],
		[source, { x: source.x, y: target.y }, target],
	);

	return candidates;
}

function endpointEscapeCandidates(
	source: Point,
	target: Point,
	sourceAnchor: AnchorName,
	targetAnchor: AnchorName,
	direction: RouteEdgeInput["direction"],
): Point[][] {
	const sourceEscape = offsetPoint(source, anchorEscapeDelta(sourceAnchor, 24));
	const targetEscape = offsetPoint(target, anchorEscapeDelta(targetAnchor, 24));
	const candidates: Point[][] = [
		compactCandidate([
			source,
			sourceEscape,
			{ x: sourceEscape.x, y: targetEscape.y },
			targetEscape,
			target,
		]),
		compactCandidate([
			source,
			sourceEscape,
			{ x: targetEscape.x, y: sourceEscape.y },
			targetEscape,
			target,
		]),
	];
	const laneOffsets =
		direction === "TB" || direction === "BT"
			? [
					Math.min(sourceEscape.x, targetEscape.x) - 24,
					Math.max(sourceEscape.x, targetEscape.x) + 24,
				]
			: [
					Math.min(sourceEscape.y, targetEscape.y) - 24,
					Math.max(sourceEscape.y, targetEscape.y) + 24,
				];
	for (const lane of laneOffsets) {
		candidates.push(
			direction === "TB" || direction === "BT"
				? compactCandidate([
						source,
						sourceEscape,
						{ x: lane, y: sourceEscape.y },
						{ x: lane, y: targetEscape.y },
						targetEscape,
						target,
					])
				: compactCandidate([
						source,
						sourceEscape,
						{ x: sourceEscape.x, y: lane },
						{ x: targetEscape.x, y: lane },
						targetEscape,
						target,
					]),
		);
	}
	return candidates;
}

function anchorEscapeDelta(anchor: AnchorName, amount: number): Point {
	if (anchor.includes("left")) {
		return { x: -amount, y: 0 };
	}
	if (anchor.includes("right")) {
		return { x: amount, y: 0 };
	}
	if (anchor.includes("top")) {
		return { x: 0, y: -amount };
	}
	if (anchor.includes("bottom")) {
		return { x: 0, y: amount };
	}
	return { x: amount, y: 0 };
}

function offsetPoint(point: Point, delta: Point): Point {
	return { x: point.x + delta.x, y: point.y + delta.y };
}

function compactCandidate(points: readonly Point[]): Point[] {
	const compacted: Point[] = [];
	for (const point of points) {
		const previous = compacted.at(-1);
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

function defaultSourceAnchor(direction: DiagramDirection): AnchorName {
	switch (direction) {
		case "LR":
			return "right";
		case "RL":
			return "left";
		case "TB":
			return "bottom";
		case "BT":
			return "top";
	}
}

function defaultAnchorsForGeometry(
	source: Box,
	target: Box,
	direction: DiagramDirection,
): { sourceAnchor: AnchorName; targetAnchor: AnchorName } {
	const dx = target.x + target.width / 2 - (source.x + source.width / 2);
	const dy = target.y + target.height / 2 - (source.y + source.height / 2);

	if (Math.abs(dy) > Math.abs(dx)) {
		return dy >= 0
			? { sourceAnchor: "bottom", targetAnchor: "top" }
			: { sourceAnchor: "top", targetAnchor: "bottom" };
	}

	if (Math.abs(dx) > 0) {
		return dx >= 0
			? { sourceAnchor: "right", targetAnchor: "left" }
			: { sourceAnchor: "left", targetAnchor: "right" };
	}

	return {
		sourceAnchor: defaultSourceAnchor(direction),
		targetAnchor: defaultTargetAnchor(direction),
	};
}

function defaultTargetAnchor(direction: DiagramDirection): AnchorName {
	switch (direction) {
		case "LR":
			return "left";
		case "RL":
			return "right";
		case "TB":
			return "top";
		case "BT":
			return "bottom";
	}
}

function expandedObstacleCandidates(
	source: Point,
	target: Point,
	direction: RouteEdgeInput["direction"],
	obstacles: readonly Box[],
): Point[][] {
	if (obstacles.length === 0) {
		return [];
	}

	const margin = 16;
	const candidates: Point[][] = [];

	if (direction === "TB" || direction === "BT") {
		const lanes = sortedUniqueLanes(
			obstacles.flatMap((obstacle) => [
				obstacle.x - margin,
				obstacle.x + obstacle.width + margin,
			]),
			(source.x + target.x) / 2,
		);

		for (const laneX of lanes) {
			candidates.push([
				source,
				{ x: laneX, y: source.y },
				{ x: laneX, y: target.y },
				target,
			]);
		}
	} else {
		const lanes = sortedUniqueLanes(
			obstacles.flatMap((obstacle) => [
				obstacle.y - margin,
				obstacle.y + obstacle.height + margin,
			]),
			(source.y + target.y) / 2,
		);

		for (const laneY of lanes) {
			candidates.push([
				source,
				{ x: source.x, y: laneY },
				{ x: target.x, y: laneY },
				target,
			]);
		}
	}

	return candidates;
}

function outerDoglegCandidates(
	source: Point,
	target: Point,
	direction: RouteEdgeInput["direction"],
	obstacles: readonly Box[],
): Point[][] {
	if (obstacles.length === 0) {
		return [];
	}

	const margin = 24;
	const minX = Math.min(...obstacles.map((obstacle) => obstacle.x)) - margin;
	const maxX =
		Math.max(...obstacles.map((obstacle) => obstacle.x + obstacle.width)) +
		margin;
	const minY = Math.min(...obstacles.map((obstacle) => obstacle.y)) - margin;
	const maxY =
		Math.max(...obstacles.map((obstacle) => obstacle.y + obstacle.height)) +
		margin;

	if (direction === "TB" || direction === "BT") {
		const exit = exitDelta(source, target, "y");
		return sortedUniqueLanes([minX, maxX], (source.x + target.x) / 2).map(
			(laneX) => [
				source,
				{ x: source.x, y: source.y + exit },
				{ x: laneX, y: source.y + exit },
				{ x: laneX, y: target.y - exit },
				{ x: target.x, y: target.y - exit },
				target,
			],
		);
	}

	const exit = exitDelta(source, target, "x");
	return sortedUniqueLanes([minY, maxY], (source.y + target.y) / 2).map(
		(laneY) => [
			source,
			{ x: source.x + exit, y: source.y },
			{ x: source.x + exit, y: laneY },
			{ x: target.x - exit, y: laneY },
			{ x: target.x - exit, y: target.y },
			target,
		],
	);
}

function exitDelta(source: Point, target: Point, axis: "x" | "y"): number {
	const delta = axis === "x" ? target.x - source.x : target.y - source.y;
	return (delta >= 0 ? 1 : -1) * 24;
}

function sortedUniqueLanes(
	lanes: readonly number[],
	midpoint: number,
): number[] {
	return [...new Set(lanes)]
		.filter((lane) => Number.isFinite(lane))
		.sort((left, right) => {
			const distance = Math.abs(left - midpoint) - Math.abs(right - midpoint);
			return distance === 0 ? left - right : distance;
		});
}

function routeIntersectsObstacles(
	points: readonly Point[],
	obstacles: readonly Box[],
	spatialIndex?: BoxSpatialIndex,
): boolean {
	for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
		const a = points[pointIndex];
		const b = points[pointIndex + 1];
		if (a === undefined || b === undefined) {
			continue;
		}

		const segment = segmentBox(a, b);
		for (const obstacle of candidateBoxesForSegment(
			obstacles,
			a,
			b,
			spatialIndex,
		)) {
			validateBox(obstacle);
			if (intersectsAabb(segment, obstacle)) {
				return true;
			}
		}
	}

	return false;
}

function routeIntersectsEndpointInteriors(
	points: readonly Point[],
	endpointInteriors: readonly Box[],
): boolean {
	for (let index = 0; index < points.length - 1; index += 1) {
		const a = points[index];
		const b = points[index + 1];
		if (a === undefined || b === undefined) {
			continue;
		}

		const segment = segmentBox(a, b);
		for (const endpointInterior of endpointInteriors) {
			validateBox(endpointInterior);
			if (intersectsAabb(segment, endpointInterior)) {
				return true;
			}
		}
	}

	return false;
}

function endpointInteriorFailureDiagnostic(): Diagnostic {
	return {
		severity: "warning",
		code: "routing.endpoint-interior.unavoidable",
		message:
			"No bounded orthogonal route candidate avoided endpoint node interiors.",
		detail: {
			conflictClass: "fixed-geometry-block",
			remediationType: "adjust-anchors-or-page-split",
			suggestedRemedy:
				"Move the explicit anchor, add endpoint-side clearance, or split the dense view.",
		},
	};
}

function hardObstacleFailureDiagnostic(input: {
	points: readonly Point[];
	hardObstacles: readonly Box[];
	hardObstacleMetadata: readonly RouteHardObstacleMetadata[];
	evidenceMessage: string;
	textMessage: string;
}): Diagnostic {
	const sources = crossedHardObstacleSources(
		input.points,
		input.hardObstacles,
		input.hardObstacleMetadata,
	);
	const kinds = stableUniqueStrings(sources.map((source) => source.kind));
	const textOnly =
		sources.length > 0 && sources.every((source) => source.kind === "text");
	if (textOnly) {
		return {
			severity: "warning",
			code: "routing.label-hard-obstacle.unavoidable",
			message: input.textMessage,
			detail: {
				obstacleSource: "text",
				hardObstacleKinds: kinds.join(","),
				conflictClass: "edge-label-pileup",
				ownerIds: stableUniqueStrings(
					sources
						.map((source) => source.ownerId)
						.filter((ownerId): ownerId is string => ownerId !== undefined),
				).join(","),
				textSurfaceKinds: stableUniqueStrings(
					sources
						.map((source) => source.surfaceKind)
						.filter(
							(surfaceKind): surfaceKind is string => surfaceKind !== undefined,
						),
				).join(","),
				remediationType: "external-label-or-split",
			},
		};
	}
	return {
		severity: "error",
		code: "routing.evidence.crossing_forbidden",
		message: input.evidenceMessage,
		detail: {
			obstacleSource:
				sources.length > 0 && kinds.includes("text") ? "mixed" : "evidence",
			hardObstacleKinds: kinds.length === 0 ? "evidence" : kinds.join(","),
			conflictClass: "evidence-crossing",
		},
	};
}

function crossedHardObstacleSources(
	points: readonly Point[],
	obstacles: readonly Box[],
	metadata: readonly RouteHardObstacleMetadata[],
): RouteHardObstacleMetadata[] {
	const sources: RouteHardObstacleMetadata[] = [];
	const seen = new Set<string>();
	for (
		let obstacleIndex = 0;
		obstacleIndex < obstacles.length;
		obstacleIndex += 1
	) {
		const obstacle = obstacles[obstacleIndex];
		if (obstacle === undefined) {
			continue;
		}
		validateBox(obstacle);
		let crossed = false;
		for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
			const a = points[pointIndex];
			const b = points[pointIndex + 1];
			if (a === undefined || b === undefined) {
				continue;
			}
			if (segmentIntersectsBox(a, b, obstacle)) {
				crossed = true;
				break;
			}
		}
		if (!crossed) {
			continue;
		}
		const source = metadata[obstacleIndex] ?? { kind: "evidence" as const };
		const key = [
			source.kind,
			source.ownerId ?? "",
			source.surfaceKind ?? "",
			source.surfaceIndex ?? "",
		].join("\u0000");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		sources.push(source);
	}
	return sources;
}

function stableUniqueStrings(values: readonly string[]): string[] {
	return Array.from(new Set(values)).sort();
}

function routeCrossesBoxes(
	points: readonly Point[],
	obstacles: readonly Box[],
	spatialIndex?: BoxSpatialIndex,
): boolean {
	for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
		const a = points[pointIndex];
		const b = points[pointIndex + 1];
		if (a === undefined || b === undefined) {
			continue;
		}
		for (const obstacle of candidateBoxesForSegment(
			obstacles,
			a,
			b,
			spatialIndex,
		)) {
			validateBox(obstacle);
			if (segmentIntersectsBox(a, b, obstacle)) {
				return true;
			}
		}
	}
	return false;
}

function candidateBoxesForSegment(
	obstacles: readonly Box[],
	start: Point,
	end: Point,
	index: BoxSpatialIndex | undefined,
): readonly Box[] {
	return index === undefined
		? obstacles
		: querySegmentSpatialIndex(index, start, end).map((entry) => entry.box);
}

function indexedBoxes(
	obstacles: readonly Box[],
): Array<{ id: string; box: Box }> {
	return obstacles.map((box, index) => ({ id: `obstacle:${index}`, box }));
}

function segmentIntersectsBox(start: Point, end: Point, box: Box): boolean {
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

function pointInsideBox(point: Point, box: Box): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return high > min && low < max;
}

function segmentIntersectsBoxEdge(
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

function segmentBox(a: Point, b: Point): Box {
	const minX = Math.min(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	return {
		x: minX,
		y: minY,
		width: Math.max(1, Math.abs(a.x - b.x)),
		height: Math.max(1, Math.abs(a.y - b.y)),
	};
}

function areCollinear(a: Point, b: Point, c: Point): boolean {
	return (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
}
