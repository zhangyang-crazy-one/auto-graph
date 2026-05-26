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
	const source = getEdgePort(
		input.source,
		input.target.center,
		input.sourceAnchor ?? defaultSourceAnchor(input.direction),
	);
	const target = getEdgePort(
		input.target,
		input.source.center,
		input.targetAnchor ?? defaultTargetAnchor(input.direction),
	);

	if ((input.kind ?? "orthogonal") === "straight") {
		return { points: simplifyRoute([source, target]), diagnostics };
	}

	const candidates = orthogonalCandidates(source, target, input.direction);
	candidates.push(
		...expandedObstacleCandidates(
			source,
			target,
			input.direction,
			input.obstacles ?? [],
		),
	);
	for (const candidate of candidates) {
		if (!routeIntersectsObstacles(candidate, input.obstacles ?? [])) {
			return { points: simplifyRoute(candidate), diagnostics };
		}
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
