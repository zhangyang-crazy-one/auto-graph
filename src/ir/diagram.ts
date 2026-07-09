import type { Constraint } from "./constraints.js";
import type { Diagnostic } from "./diagnostics.js";
import type {
	CoordinatedEdge,
	CoordinatedEvidencePanel,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedMatrixBlock,
	CoordinatedNode,
	CoordinatedTableBlock,
	DiagramFrame,
	EvidencePanel,
	IntentEdge,
	IntentGroup,
	IntentNode,
	MatrixBlock,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
	TableBlock,
} from "./elements.js";
import type { Box, DiagramDirection, JsonObject } from "./geometry.js";
import type { SolvedTextAnnotation } from "./label-layout.js";

export type DiagramStage = "intent" | "normalized" | "coordinated";

export type DiagramMetadata = JsonObject;

export type DeliverabilityStatus = "clean" | "degraded" | "unsatisfiable";

export type DeliverabilityMode = "strict" | "degraded-ok";

export type RemediationPolicyMode = "off" | "suggest" | "auto";

export type PageSplitPolicyMode = Exclude<RemediationPolicyMode, "auto">;

export interface RemediationPolicy {
	externalLabels?: RemediationPolicyMode;
	routeRails?: RemediationPolicyMode;
	growFixedGeometry?: RemediationPolicyMode;
	pageSplit?: PageSplitPolicyMode;
}

export type RemediationPlanStatus = "suggested" | "applied" | "blocked";

export type RemediationPlanType =
	| "external-label"
	| "route-rail"
	| "grow-fixed-geometry"
	| "page-split";

export interface ExternalLabelCallout {
	edgeId: string;
	key: string;
	text: string;
	shelfSide: "top" | "right" | "bottom" | "left";
	keyBox: Box;
	calloutBox: Box;
}

export interface ExternalLabelRemediationDetail {
	strategy: "keyed-callouts";
	policy: RemediationPolicyMode;
	labelCount: number;
	callouts?: ExternalLabelCallout[];
}

export interface RouteRailRemediationDetail {
	strategy: "dependency-rails";
	policy: RemediationPolicyMode;
	requiredRailCount: number;
}

export interface GrowFixedGeometryRemediationDetail {
	strategy: "grow-or-relax-fixed-geometry";
	policy: RemediationPolicyMode;
	affectedNodeCount: number;
}

export interface PageSplitRemediationDetail {
	strategy: "split-over-capacity-page";
	policy: PageSplitPolicyMode;
	edgeCount: number;
	nodeCount: number;
}

export type RemediationPlanDetail =
	| ExternalLabelRemediationDetail
	| RouteRailRemediationDetail
	| GrowFixedGeometryRemediationDetail
	| PageSplitRemediationDetail;

export interface RemediationPlan {
	id: string;
	type: RemediationPlanType;
	status: RemediationPlanStatus;
	reason: string;
	diagnosticCodes: string[];
	edgeIds: string[];
	nodeIds: string[];
	detail: RemediationPlanDetail;
}

export interface DeliverabilityReport {
	status: DeliverabilityStatus;
	strict: boolean;
	degraded: boolean;
	diagnosticCodes: string[];
	remediationTypes: string[];
	remediationPlans: RemediationPlan[];
}

export interface RoutingRailAllocation {
	edgeId: string;
	axis: "x" | "y";
	side: "top" | "right" | "bottom" | "left";
	coordinate: number;
	index: number;
}

export interface RoutingGutterAllocation {
	side: "top" | "right" | "bottom" | "left";
	box: Box;
	railCount: number;
}

export interface RoutingAllocationReport {
	rails: RoutingRailAllocation[];
	gutters: RoutingGutterAllocation[];
}

// Authoring intent consumed by the future prepare stage.
export interface IntentDiagram {
	id?: string;
	title?: string;
	direction?: DiagramDirection;
	nodes: IntentNode[];
	edges?: IntentEdge[];
	groups?: IntentGroup[];
	swimlanes?: Swimlane[];
	matrices?: MatrixBlock[];
	tables?: TableBlock[];
	evidencePanels?: EvidencePanel[];
	constraints?: Constraint[];
	frame?: DiagramFrame;
	metadata?: DiagramMetadata;
}

// Prepare output consumed by the future solve stage.
export interface NormalizedDiagram {
	id: string;
	title?: string;
	direction: DiagramDirection;
	nodes: NormalizedNode[];
	edges: NormalizedEdge[];
	groups: NormalizedGroup[];
	swimlanes?: Swimlane[];
	matrices?: MatrixBlock[];
	tables?: TableBlock[];
	evidencePanels?: EvidencePanel[];
	constraints: Constraint[];
	diagnostics: Diagnostic[];
	frame?: DiagramFrame;
	metadata?: DiagramMetadata;
}

// Solve output consumed by future exporters.
export interface CoordinatedDiagram {
	id: string;
	title?: string;
	direction: DiagramDirection;
	nodes: CoordinatedNode[];
	edges: CoordinatedEdge[];
	groups: CoordinatedGroup[];
	swimlanes?: Swimlane[];
	matrices?: CoordinatedMatrixBlock[];
	tables?: CoordinatedTableBlock[];
	evidencePanels?: CoordinatedEvidencePanel[];
	textAnnotations?: SolvedTextAnnotation[];
	diagnostics: Diagnostic[];
	/** True when any deliverability-breaking diagnostic was emitted. */
	degraded: boolean;
	deliverability?: DeliverabilityReport;
	routing?: RoutingAllocationReport;
	bounds: Box;
	frame?: CoordinatedFrame;
	metadata?: DiagramMetadata;
	qualityReport?: import("../solver/pipeline/quality.js").QualityReport;
}
