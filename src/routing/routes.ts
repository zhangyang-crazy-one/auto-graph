import { intersectsAabb, validateBox } from "../geometry/boxes.js";
import { getEdgePort } from "../geometry/shapes.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	AnchorName,
	Box,
	DiagramDirection,
	Point,
} from "../ir/geometry.js";
import type { RouteEdgeInput, RouteEdgeResult } from "./types.js";

export function routeEdge(input: RouteEdgeInput): RouteEdgeResult {
	const diagnostics: Diagnostic[] = [];
	const softObstacles = input.obstacles ?? [];
	const hardObstacles = input.hardObstacles ?? [];
	const defaultAnchors = defaultAnchorsForGeometry(
		input.source.box,
		input.target.box,
		input.direction,
	);
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

	if ((input.kind ?? "orthogonal") === "straight") {
		const points = simplifyRoute([source, target]);
		if (routeIntersectsObstacles(points, hardObstacles)) {
			diagnostics.push({
				severity: "error",
				code: "routing.evidence.crossing_forbidden",
				message: "Straight route crosses hard evidence block obstacles.",
			});
			return { points: [], diagnostics };
		}
		if (routeIntersectsObstacles(points, softObstacles)) {
			diagnostics.push({
				severity: "warning",
				code: "routing.obstacle.unavoidable",
				message: "Straight route crosses soft obstacles.",
			});
		}
		return { points, diagnostics };
	}

	const routeLaneObstacles = [...softObstacles, ...hardObstacles];
	const candidates = orthogonalCandidates(source, target, input.direction);
	candidates.push(
		...expandedObstacleCandidates(
			source,
			target,
			input.direction,
			routeLaneObstacles,
		),
	);
	for (const candidate of candidates) {
		if (
			!routeIntersectsObstacles(candidate, softObstacles) &&
			!routeIntersectsObstacles(candidate, hardObstacles)
		) {
			return { points: simplifyRoute(candidate), diagnostics };
		}
	}

	const hardClearCandidate = candidates.find(
		(candidate) => !routeIntersectsObstacles(candidate, hardObstacles),
	);
	if (hardClearCandidate !== undefined) {
		diagnostics.push({
			severity: "warning",
			code: "routing.obstacle.unavoidable",
			message:
				"No bounded orthogonal route candidate avoided all soft obstacles.",
		});

		return {
			points: simplifyRoute(hardClearCandidate),
			diagnostics,
		};
	}

	if (hardObstacles.length > 0) {
		diagnostics.push({
			severity: "error",
			code: "routing.evidence.crossing_forbidden",
			message:
				"No bounded orthogonal route candidate avoided hard evidence block obstacles.",
		});

		return {
			points: [],
			diagnostics,
		};
	}

	diagnostics.push({
		severity: "warning",
		code: "routing.obstacle.unavoidable",
		message: "No bounded orthogonal route candidate avoided all obstacles.",
	});

	return {
		points: simplifyRoute(candidates[0] ?? [source, target]),
		diagnostics,
	};
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
): boolean {
	for (let index = 0; index < points.length - 1; index += 1) {
		const a = points[index];
		const b = points[index + 1];
		if (a === undefined || b === undefined) {
			continue;
		}

		const segment = segmentBox(a, b);
		for (const obstacle of obstacles) {
			validateBox(obstacle);
			if (intersectsAabb(segment, obstacle)) {
				return true;
			}
		}
	}

	return false;
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
