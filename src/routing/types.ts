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
	/**
	 * Maximum accepted routeLength/direct ratio among clearance-feasible
	 * candidates (#76). When every feasible path exceeds this budget, emit a
	 * structured capacity/rail remediation diagnostic instead of accepting a
	 * flying detour. Dense deliverable default is 3; omit for legacy behavior.
	 */
	maxDetourRatio?: number;
	/**
	 * Attach-point tournament size per preferred side (#76). Defaults to 3
	 * (≈25%/50%/75%). Capped at 5 to bound source×target combinations.
	 */
	maxAttachPointsPerSide?: number;
	/**
	 * Severity for fatal `route_obstacle_fallback` when expand still crosses
	 * hard obstacles. Use `"warning"` under `deliverabilityMode: "degraded-ok"`.
	 */
	fallbackSeverity?: "error" | "warning";
	/** Add mid-edge vertices around compact text obstacles to improve clearance. */
	textObstacleVertices?: boolean;
}

export interface RouteEdgeResult {
	points: Point[];
	diagnostics: Diagnostic[];
}
