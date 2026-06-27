import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
} from "../ir/elements.js";
import type { Box, DiagramDirection } from "../ir/geometry.js";

export type LayoutLockSource = "fixed-position" | "exact-position";

export interface LayoutLock {
	nodeId: string;
	source: LayoutLockSource;
}

export interface ConstraintSolverInput {
	direction: DiagramDirection;
	overlapSpacing?: number;
	minSiblingGap?: number;
	distributeContainedChildren?: boolean | "spread";
	/** When "spread" or true, distribute children inside non-contract
	 * swimlane lane content boxes (Issue #60). Opt-in: no redistribution
	 * occurs unless explicitly set. */
	distributeSwimlaneChildren?: boolean | "spread";
	boxes: ReadonlyMap<string, Box>;
	/** Swimlanes for lane-aware child distribution (Issue #60). */
	swimlanes?: readonly Swimlane[];
	nodes: readonly NormalizedNode[];
	groups: readonly NormalizedGroup[];
	constraints: readonly Constraint[];
}

export interface ConstraintSolverResult {
	boxes: Map<string, Box>;
	locks: Map<string, LayoutLock>;
	diagnostics: Diagnostic[];
}
