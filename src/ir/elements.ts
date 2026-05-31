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
	style?: VisualStyle;
	ports?: NodePort[];
	compartments?: NodeCompartments;
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
	ports?: CoordinatedPort[];
	parentId?: string;
	labelLayout?: LabelLayout;
}

export interface EdgeEndpoint {
	nodeId: string;
	anchor?: AnchorName;
	portId?: string;
}

export type EdgeStrokeStyle = "solid" | "dashed";
export type EdgeArrowhead = "triangle" | "hollowTriangle";
export type PortSide = "top" | "right" | "bottom" | "left";
export type PortKind = "proxy" | "flow";

export interface VisualStyle {
	fill?: string;
	stroke?: string;
}

export interface EvidenceCell {
	text: string;
	style?: VisualStyle;
}

export interface MatrixBlock {
	id: string;
	rows: string[];
	cols: string[];
	cells: EvidenceCell[][];
	position?: Point;
	size?: Size;
	style?: VisualStyle;
}

export interface TableColumn {
	id: string;
	label: Label;
}

export interface TableRow {
	id: string;
	cells: Record<string, EvidenceCell>;
}

export interface TableBlock {
	id: string;
	columns: TableColumn[];
	rows: TableRow[];
	position?: Point;
	size?: Size;
	style?: VisualStyle;
}

export type EvidencePanelKind = "legend" | "rule" | "note" | "verification";

export interface EvidencePanelItem {
	id?: string;
	label: Label;
	detail?: Label;
	style?: VisualStyle;
}

export interface EvidencePanel {
	id: string;
	kind: EvidencePanelKind;
	items: EvidencePanelItem[];
	position?: Point;
	size?: Size;
	style?: VisualStyle;
}

export interface NodePort {
	id: string;
	label?: Label;
	side: PortSide;
	kind: PortKind;
	order?: number;
	style?: VisualStyle;
}

export interface CoordinatedPort extends NodePort {
	box: Box;
	anchor: Point;
}

export interface NodeCompartments {
	stereotype?: string;
	name?: string;
	properties?: string[];
	constraints?: string[];
}

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

export type SwimlaneOrientation = "vertical" | "horizontal";
export type SwimlaneLayout = "overlay" | "contract";

export interface SwimlaneLane {
	id: string;
	label?: Label;
	children: string[];
	box?: Box;
	headerBox?: Box;
	contentBox?: Box;
}

export interface Swimlane {
	id: string;
	label?: Label;
	orientation: SwimlaneOrientation;
	layout?: SwimlaneLayout;
	lanes: SwimlaneLane[];
	box?: Box;
	headerHeight?: number;
	padding?: number;
}

export interface DiagramFrame {
	kind: string;
	context?: string;
	name?: string;
	titleTab: string;
	style?: VisualStyle;
}

export interface CoordinatedFrame extends DiagramFrame {
	box: Box;
	titleBox: Box;
}
