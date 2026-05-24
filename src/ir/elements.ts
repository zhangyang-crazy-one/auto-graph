import type {
	AnchorName,
	AnchorPoint,
	Box,
	Insets,
	JsonObject,
	Point,
	Size,
} from "./geometry.js";

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
	size: Size;
	padding: Insets;
}

export interface CoordinatedNode extends NodeBase {
	shape: NodeShape;
	box: Box;
	anchors: AnchorPoint[];
	parentId?: string;
}

export interface EdgeEndpoint {
	nodeId: string;
	anchor?: AnchorName;
}

export interface IntentEdge {
	id?: string;
	sourceId: string;
	targetId: string;
	label?: Label;
	metadata?: JsonObject;
}

export interface NormalizedEdge {
	id: string;
	source: EdgeEndpoint;
	target: EdgeEndpoint;
	label?: Label;
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
}

export interface CoordinatedGroup extends NormalizedGroup {
	box: Box;
}
