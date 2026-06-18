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
	bounds: Box;
	frame?: CoordinatedFrame;
	metadata?: DiagramMetadata;
}
