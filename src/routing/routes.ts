import { intersectsAabb, validateBox } from "../geometry/boxes.js";
import { getEdgePort } from "../geometry/shapes.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, Point } from "../ir/geometry.js";
import type { RouteEdgeInput, RouteEdgeResult } from "./types.js";

export function routeEdge(input: RouteEdgeInput): RouteEdgeResult {
	const diagnostics: Diagnostic[] = [];
	const source = getEdgePort(
		input.source,
		input.target.center,
		input.sourceAnchor,
	);
	const target = getEdgePort(
		input.target,
		input.source.center,
		input.targetAnchor,
	);

	if ((input.kind ?? "orthogonal") === "straight") {
		return { points: simplifyRoute([source, target]), diagnostics };
	}

	const candidates = orthogonalCandidates(source, target, input.direction);
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
	const candidates = [
		[source, { x: target.x, y: source.y }, target],
		[source, { x: source.x, y: target.y }, target],
	];

	if (direction === "TB" || direction === "BT") {
		candidates.push([
			source,
			{ x: midpointX, y: source.y },
			{ x: midpointX, y: target.y },
			target,
		]);
	} else {
		candidates.push([
			source,
			{ x: source.x, y: midpointY },
			{ x: target.x, y: midpointY },
			target,
		]);
	}

	return candidates;
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
