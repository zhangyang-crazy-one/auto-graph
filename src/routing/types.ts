import type { ShapeGeometry } from "../geometry/shapes.js";
import type { BoxSpatialIndex } from "../geometry/spatial-index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	AnchorName,
	Box,
	DiagramDirection,
	Point,
} from "../ir/geometry.js";
import type { RoutingBudgetValue } from "./budget.js";

export type RouteKind = "orthogonal" | "straight" | "obstacle-avoiding";

export type RouteHardObstacleKind = "evidence" | "text";

export interface RouteHardObstacleMetadata {
	kind: RouteHardObstacleKind;
	ownerId?: string;
	surfaceKind?: string;
	surfaceIndex?: number;
}

export interface RouteEdgeInput {
	kind?: RouteKind;
	direction: DiagramDirection;
	source: ShapeGeometry;
	target: ShapeGeometry;
	sourceAnchor?: AnchorName;
	targetAnchor?: AnchorName;
	obstacles?: readonly Box[];
	hardObstacles?: readonly Box[];
	hardObstacleMetadata?: readonly RouteHardObstacleMetadata[];
	obstacleIndex?: BoxSpatialIndex;
	hardObstacleIndex?: BoxSpatialIndex;
	/** Maximum greedy rerouting iterations (default 5). */
	maxRoutingAttempts?: number;
	/** Corridor expansion margin in px for corner-graph prefilter (default 32).
	 * Larger values include more obstacles in the local routing window. */
	corridorMargin?: number;
	/** Maximum corner-graph vertices before falling back.
	 * - number: caller-specified cap
	 * - "auto" or undefined: scale with corridor margin and obstacle count */
	maxCorners?: RoutingBudgetValue;
	/** Maximum grid A* nodes before falling back.
	 * - number: caller-specified cap
	 * - "auto" or undefined: scale with corridor margin and obstacle count */
	maxNodes?: RoutingBudgetValue;
	/** Route-length / direct-distance ratio above which a backtracking
	 * warning is emitted (default 20). */
	maxBacktrackingRatio?: number;
	/** Add mid-edge vertices around compact text obstacles to improve clearance. */
	textObstacleVertices?: boolean;
}

export interface RouteEdgeResult {
	points: Point[];
	diagnostics: Diagnostic[];
}
