import type { ShapeGeometry } from "../geometry/shapes.js";
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
}

export interface RouteEdgeResult {
	points: Point[];
	diagnostics: Diagnostic[];
}
