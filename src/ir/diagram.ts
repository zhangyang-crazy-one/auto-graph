import type { Constraint } from "./constraints.js";
import type { Diagnostic } from "./diagnostics.js";
import type {
	CoordinatedEdge,
	CoordinatedGroup,
	CoordinatedNode,
	IntentEdge,
	IntentGroup,
	IntentNode,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
} from "./elements.js";
import type { Box, DiagramDirection, JsonObject } from "./geometry.js";

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
	constraints?: Constraint[];
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
	constraints: Constraint[];
	diagnostics: Diagnostic[];
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
	diagnostics: Diagnostic[];
	bounds: Box;
	metadata?: DiagramMetadata;
}
