import type { LayoutLock } from "../../constraints/types.js";
import type { ShapeGeometry } from "../../geometry/shapes.js";
import type { Constraint } from "../../ir/constraints.js";
import type { Diagnostic } from "../../ir/diagnostics.js";
import type { NormalizedDiagram } from "../../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedEvidencePanel,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedMatrixBlock,
	CoordinatedNode,
	CoordinatedTableBlock,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
} from "../../ir/elements.js";
import type { Box } from "../../ir/geometry.js";
import type { SolvedTextAnnotation } from "../../ir/label-layout.js";
import type { SolveDiagramOptions } from "../solve.js";
import type { QualityReport } from "./quality.js";

// ---------------------------------------------------------------------------
// Pipeline types (Issue #54 — Scheme D)
// ---------------------------------------------------------------------------

/** Shared mutable state flowing through every pipeline phase. */
export interface LayoutState {
	diagram: NormalizedDiagram;
	options: SolveDiagramOptions;

	nodes: NormalizedNode[];
	edges: NormalizedEdge[];
	groups: NormalizedGroup[];
	swimlanes: Swimlane[];
	constraints: Constraint[];

	boxes: Map<string, Box>;
	locks: Map<string, LayoutLock>;
	nodeGeometry: Map<string, ShapeGeometry>;

	coordinatedNodes: CoordinatedNode[];
	coordinatedEdges: CoordinatedEdge[];
	coordinatedGroups: CoordinatedGroup[];
	coordinatedMatrices: CoordinatedMatrixBlock[];
	coordinatedTables: CoordinatedTableBlock[];
	coordinatedEvidencePanels: CoordinatedEvidencePanel[];
	frame?: CoordinatedFrame;

	baseTextAnnotations: SolvedTextAnnotation[];
	edgeTextAnnotations: SolvedTextAnnotation[];

	contentBounds: Box;
	bounds: Box;
	degraded: boolean;

	diagnostics: Diagnostic[];
	qualityReport?: QualityReport;
	phaseTrace: PhaseTraceEntry[];
}

export interface PhaseTraceEntry {
	phase: string;
	durationMs: number;
	diagnosticsAdded: number;
}

/** A single pipeline phase — mutates `state` in-place. */
export interface LayoutPhase {
	readonly name: string;
	run(state: LayoutState): void;
}
