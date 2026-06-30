import type { ShapeGeometry } from "../geometry/shapes.js";
import type { BoxSpatialIndex } from "../geometry/spatial-index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	AnchorName,
	Box,
	DiagramDirection,
	Point,
} from "../ir/geometry.js";

export type RouteKind = "orthogonal" | "straight" | "obstacle-avoiding";

export interface RouteEdgeInput {
	kind?: RouteKind;
	direction: DiagramDirection;
	source: ShapeGeometry;
	target: ShapeGeometry;
	sourceAnchor?: AnchorName;
	targetAnchor?: AnchorName;
	obstacles?: readonly Box[];
	hardObstacles?: readonly Box[];
	obstacleIndex?: BoxSpatialIndex;
	hardObstacleIndex?: BoxSpatialIndex;
	/** Maximum greedy rerouting iterations (default 5). */
	maxRoutingAttempts?: number;
	/** Corridor expansion margin in px for corner-graph prefilter (default 32).
	 * Larger values include more obstacles in the local routing window. */
	corridorMargin?: number;
	/** Route-length / direct-distance ratio above which a backtracking
	 * warning is emitted (default 20). */
	maxBacktrackingRatio?: number;
}

export interface RouteEdgeResult {
	points: Point[];
	diagnostics: Diagnostic[];
}
