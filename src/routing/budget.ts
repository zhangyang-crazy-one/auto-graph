export type RoutingBudgetValue = number | "auto";

export interface RoutingBudgetContext {
	readonly corridorMargin: number;
	readonly obstacleCount: number;
}

const MIN_CORNER_BUDGET = 600;
const MAX_CORNER_BUDGET = 3000;
const SMALL_GRID_BUDGET = 4000;
const LARGE_GRID_BUDGET = 16000;
const MAX_GRID_BUDGET = 64000;
const BASE_CORRIDOR_MARGIN = 200;
const CORNER_VERTICES_PER_OBSTACLE = 12;
const GRID_COORDINATES_PER_AXIS_PER_OBSTACLE = 4;
const ENDPOINT_COUNT = 2;

export function resolveMaxCorners(
	value: RoutingBudgetValue | undefined,
	context: RoutingBudgetContext,
): number {
	if (typeof value === "number") {
		return value;
	}
	const baseCorners =
		context.obstacleCount * CORNER_VERTICES_PER_OBSTACLE + ENDPOINT_COUNT;
	const expandedCorners = Math.ceil(
		baseCorners * corridorScale(context.corridorMargin),
	);
	return clamp(expandedCorners, MIN_CORNER_BUDGET, MAX_CORNER_BUDGET);
}

export function resolveMaxNodes(
	value: RoutingBudgetValue | undefined,
	context: RoutingBudgetContext,
): number {
	if (typeof value === "number") {
		return value;
	}
	const thresholdNodes =
		context.obstacleCount > 30 ? LARGE_GRID_BUDGET : SMALL_GRID_BUDGET;
	const coordinateCount =
		context.obstacleCount * GRID_COORDINATES_PER_AXIS_PER_OBSTACLE +
		ENDPOINT_COUNT;
	const estimatedGridNodes = coordinateCount * coordinateCount;
	return Math.min(
		Math.ceil(
			Math.max(thresholdNodes, estimatedGridNodes) *
				corridorScale(context.corridorMargin),
		),
		MAX_GRID_BUDGET,
	);
}

function corridorScale(corridorMargin: number): number {
	return Math.max(1, corridorMargin / BASE_CORRIDOR_MARGIN);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
