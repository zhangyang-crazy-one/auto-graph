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
import { findObstacleFreePath } from "./astar.js";
import type { RouteEdgeInput, RouteEdgeResult } from "./types.js";
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
): void {
	if (points.length < 2) return;
	const direct = Math.hypot(target.x - source.x, target.y - source.y);
	if (direct <= 0) return;
	let routeLen = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i] as Point;
		const b = points[i + 1] as Point;
		routeLen += Math.hypot(b.x - a.x, b.y - a.y);
	}
	const threshold = 10;
	if (routeLen > direct * threshold) {
		diagnostics.push({
			severity: "warning",
			code: "routing.backtracking_excessive",
			message: `Route length ${Math.round(routeLen)} px exceeds ${threshold}× direct distance ${Math.round(direct)} px.`,
			detail: {
				routeLength: Math.round(routeLen),
				directDistance: Math.round(direct),
				threshold,
			},
		});
	}
}

export function routeEdge(input: RouteEdgeInput): RouteEdgeResult {
	const diagnostics: Diagnostic[] = [];
	const softObstacles = input.obstacles ?? [];
	const hardObstacles = input.hardObstacles ?? [];
	const softObstacleIndex =
		input.obstacleIndex ?? createBoxSpatialIndex(indexedBoxes(softObstacles));
	const hardObstacleIndex =
		input.hardObstacleIndex ??
		createBoxSpatialIndex(indexedBoxes(hardObstacles));
	const maxAttempts = input.maxRoutingAttempts ?? 5;
	const defaultAnchors = defaultAnchorsForGeometry(
		input.source.box,
		input.target.box,
		input.direction,
	);

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
		const points = finalizeRoute(
			[source, target],
			softObstacles,
			hardObstacles,
			diagnostics,
			softObstacleIndex,
			hardObstacleIndex,
		);
		if (routeCrossesBoxes(points, hardObstacles, hardObstacleIndex)) {
			diagnostics.push({
				severity: "error",
				code: "routing.evidence.crossing_forbidden",
				message: "Straight route crosses hard evidence block obstacles.",
			});
			return { points, diagnostics };
		}
		if (routeCrossesBoxes(points, softObstacles, softObstacleIndex)) {
			diagnostics.push({
				severity: "warning",
				code: "routing.obstacle.unavoidable",
				message: "Straight route crosses soft obstacles.",
			});
		}
		return { points, diagnostics };
	}

	// For obstacle-avoiding edges, try A* visibility-graph routing
	// first.  Fall through to heuristic candidates if it fails (#39).
	if ((input.kind ?? "orthogonal") === "obstacle-avoiding") {
		const endpointObstacles = endpointObstaclesForAutoAnchors(input);
		for (const { sourceAnchor, targetAnchor } of routeAnchorPairs(
			input,
			defaultAnchors,
		)) {
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
			// Try corner visibility graph first (Issue #54, 方案 B).
			// Use margin 2 so the resulting path stays outside the
			// obstacle boundary and avoids tangent-touch rejections
			// by the loose AABB intersection check.
			const cornerPath = findCornerGraphPath(
				source,
				target,
				[...softObstacles, ...hardObstacles],
				{ endpointObstacles, margin: 2 },
				diagnostics,
			);
			// Fall back to grid A* if corner graph fails.
			const path =
				cornerPath ??
				findObstacleFreePath(
					source,
					target,
					[...softObstacles, ...hardObstacles],
					{ endpointObstacles, margin: 0 },
					diagnostics,
				);
			if (path !== null && path.length >= 2) {
				const finalized = finalizeRoute(
					path,
					softObstacles,
					hardObstacles,
					diagnostics,
					softObstacleIndex,
					hardObstacleIndex,
				);
				// Verify the A* path against the router.s AABB
				// collision contract (segmentBox with 1 px floor)
				// so we do not accept routes that the existing
				// non-A* path would reject (Codex P2).
				if (
					!routeIntersectsObstacles(
						finalized,
						softObstacles,
						softObstacleIndex,
					) &&
					!routeIntersectsObstacles(finalized, hardObstacles, hardObstacleIndex)
				) {
					checkBacktracking(finalized, source, target, diagnostics);
					return { points: finalized, diagnostics };
				}
			}
		}
	}

	const routeLaneObstacles = [...softObstacles, ...hardObstacles];
	const anchorPairs = routeAnchorPairs(input, defaultAnchors);
	const candidateRoutes = anchorPairs.flatMap(
		({ sourceAnchor, targetAnchor }) => {
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
			const endpointObstacles = endpointObstaclesForAutoAnchors(input);
			return routes.map((points) => ({ points, endpointObstacles }));
		},
	);
	for (const candidate of candidateRoutes) {
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
			const finalizedClean = finalizeRoute(
				candidate.points,
				softObstacles,
				hardObstacles,
				diagnostics,
				softObstacleIndex,
				hardObstacleIndex,
			);
			checkBacktracking(
				finalizedClean,
				candidate.points[0] as Point,
				candidate.points[candidate.points.length - 1] as Point,
				diagnostics,
			);
			return { points: finalizedClean, diagnostics };
		}
	}

	const hardClearCandidate = candidateRoutes.find(
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
			for (const candidate of candidateRoutes) {
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
					return {
						points: finalizeRoute(
							rerouted,
							softObstacles,
							hardObstacles,
							diagnostics,
						),
						diagnostics,
					};
				}
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
		});

		return {
			points: finalizeRoute(
				bestPoints,
				softObstacles,
				hardObstacles,
				diagnostics,
			),
			diagnostics,
		};
	}

	if (hardObstacles.length > 0) {
		let bestPoints =
			candidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors);
		if (input.kind === "obstacle-avoiding") {
			const allObstacles = [...softObstacles, ...hardObstacles];
			// Try greedy rerouting on all candidates, return first clean one.
			for (const candidate of candidateRoutes) {
				const rerouted = greedyRerouteAroundObstacles(
					candidate.points,
					allObstacles,
					maxAttempts,
				);
				if (!routeCrossesBoxes(rerouted, allObstacles)) {
					return {
						points: finalizeRoute(
							rerouted,
							softObstacles,
							hardObstacles,
							diagnostics,
						),
						diagnostics,
					};
				}
			}
			bestPoints = greedyRerouteAroundObstacles(
				candidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors),
				allObstacles,
				maxAttempts,
			);
		}
		diagnostics.push({
			severity: "error",
			code: "routing.evidence.crossing_forbidden",
			message:
				"No bounded orthogonal route candidate avoided hard evidence block obstacles.",
		});

		return {
			points: finalizeRoute(
				bestPoints,
				softObstacles,
				hardObstacles,
				diagnostics,
			),
			diagnostics,
		};
	}

	let bestPoints =
		candidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors);
	if (input.kind === "obstacle-avoiding") {
		const allObstacles = [...softObstacles, ...hardObstacles];
		// Try greedy rerouting on multiple candidates, not just the first.
		for (const candidate of candidateRoutes) {
			const rerouted = greedyRerouteAroundObstacles(
				candidate.points,
				allObstacles,
				maxAttempts,
			);
			if (!routeCrossesBoxes(rerouted, allObstacles)) {
				return {
					points: finalizeRoute(
						rerouted,
						softObstacles,
						hardObstacles,
						diagnostics,
					),
					diagnostics,
				};
			}
		}
		// Keep the best attempt from the first candidate
		bestPoints = greedyRerouteAroundObstacles(
			candidateRoutes[0]?.points ?? fallbackRoute(input, defaultAnchors),
			allObstacles,
			maxAttempts,
		);
	}
	diagnostics.push({
		severity: "warning",
		code: "routing.obstacle.unavoidable",
		message: "No bounded orthogonal route candidate avoided all obstacles.",
	});

	return {
		points: finalizeRoute(
			bestPoints,
			softObstacles,
			hardObstacles,
			diagnostics,
		),
		diagnostics,
	};
}

function finalizeRoute(
	points: readonly Point[],
	softObstacles: readonly Box[],
	hardObstacles: readonly Box[],
	diagnostics: Diagnostic[],
	softObstacleIndex?: BoxSpatialIndex,
	hardObstacleIndex?: BoxSpatialIndex,
): Point[] {
	const simplified = simplifyRoute(points);
	if (simplified.length >= 3) {
		return simplified;
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
		return simplified;
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
		diagnostics.push({
			severity: expandedCrossesHard ? "error" : "warning",
			code: "route_obstacle_fallback",
			message:
				"Obstacle-aware routing fell back to fewer than three route points.",
			detail: { pointCount: simplified.length },
		});
	}
	return expanded;
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

function endpointObstaclesForAutoAnchors(input: RouteEdgeInput): Box[] {
	const boxes: Box[] = [];
	if (input.sourceAnchor === undefined && hasDistinctAnchors(input.source)) {
		boxes.push(insetBox(input.source.box, 1));
	}
	if (input.targetAnchor === undefined && hasDistinctAnchors(input.target)) {
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

function routeAnchorPairs(
	input: RouteEdgeInput,
	defaultAnchors: { sourceAnchor: AnchorName; targetAnchor: AnchorName },
): Array<{ sourceAnchor: AnchorName; targetAnchor: AnchorName }> {
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
	const pairs = sourceAnchors.flatMap((sourceAnchor) =>
		targetAnchors.map((targetAnchor) => ({ sourceAnchor, targetAnchor })),
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
