import type {
	AnchorName,
	AnchorPoint,
	Box,
	Insets,
	JsonObject,
	Point,
	Size,
} from "./geometry.js";
import type { LabelLayout } from "./label-layout.js";

export type NodeShape =
	| "rectangle"
	| "rounded-rectangle"
	| "ellipse"
	| "diamond"
	| "parallelogram"
	| "hexagon"
	| "cylinder";

export interface Label {
	text: string;
	id?: string;
	maxWidth?: number;
	metadata?: JsonObject;
}

export interface NodeBase {
	id: string;
	label?: Label;
	shape?: NodeShape;
	metadata?: JsonObject;
}

export interface IntentNode extends NodeBase {
	parentId?: string;
	position?: Point;
	size?: Size;
	padding?: Insets;
}

export interface NormalizedNode extends NodeBase {
	shape: NodeShape;
	parentId?: string;
	position?: Point;
	size: Size;
	padding: Insets;
	labelLayout?: LabelLayout;
}

export interface CoordinatedNode extends NodeBase {
	shape: NodeShape;
	box: Box;
	anchors: AnchorPoint[];
	parentId?: string;
	labelLayout?: LabelLayout;
}

export interface EdgeEndpoint {
	nodeId: string;
	anchor?: AnchorName;
}

export type EdgeStrokeStyle = "solid" | "dashed";
export type EdgeArrowhead = "triangle" | "hollowTriangle";

export interface IntentEdge {
	id?: string;
	sourceId: string;
	targetId: string;
	label?: Label;
	style?: EdgeStrokeStyle;
	arrowhead?: EdgeArrowhead;
	metadata?: JsonObject;
}

export interface NormalizedEdge {
	id: string;
	source: EdgeEndpoint;
	target: EdgeEndpoint;
	label?: Label;
	style?: EdgeStrokeStyle;
	arrowhead?: EdgeArrowhead;
	metadata?: JsonObject;
}

export interface CoordinatedEdge extends NormalizedEdge {
	points: Point[];
	labelPosition?: Point;
}

export interface IntentGroup {
	id: string;
	label?: Label;
	nodeIds?: string[];
	groupIds?: string[];
	padding?: Insets;
	metadata?: JsonObject;
}

export interface NormalizedGroup {
	id: string;
	label?: Label;
	nodeIds: string[];
	groupIds: string[];
	padding: Insets;
	metadata?: JsonObject;
	labelLayout?: LabelLayout;
}

export interface CoordinatedGroup extends NormalizedGroup {
	box: Box;
}
