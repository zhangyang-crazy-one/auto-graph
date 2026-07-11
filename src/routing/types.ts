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

export type RouteKind =
	| "orthogonal"
	| "straight"
	| "obstacle-avoiding"
	/** Short attach-to-attach orthogonal routes; edge×edge crossings use jumps (#84). */
	| "short-orthogonal-jumps";

export type RouteHardObstacleKind = "evidence" | "text" | "node";

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
	 * Attach-point tournament size per preferred side (#76 / #84).
	 * Defaults to 3 (25%/50%/75%) for `short-orthogonal-jumps`; otherwise 1
	 * unless the solver dense policy sets it. Capped at 5.
	 */
	maxAttachPointsPerSide?: number;
	/**
	 * Soft-text micro-clear / escape-stub track pitch in px (#86 / #87 / #92).
	 * Defaults to 10. Short-orthogonal requires escape stubs of at least this
	 * length so channel nudge has a separable interior span.
	 */
	softTextClearPitch?: number;
	/**
	 * Pre-assigned attach point for the source endpoint (#92). When set,
	 * short-orthogonal skips source-side slot tournament expansion.
	 */
	sourcePoint?: Point;
	/**
	 * Pre-assigned attach point for the target endpoint (#92). When set,
	 * short-orthogonal skips target-side slot tournament expansion.
	 */
	targetPoint?: Point;
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
