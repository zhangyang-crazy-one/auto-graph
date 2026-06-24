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
}

export interface RouteEdgeResult {
	points: Point[];
	diagnostics: Diagnostic[];
}
