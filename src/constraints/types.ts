import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { NormalizedGroup, NormalizedNode } from "../ir/elements.js";
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
	boxes: ReadonlyMap<string, Box>;
	nodes: readonly NormalizedNode[];
	groups: readonly NormalizedGroup[];
	constraints: readonly Constraint[];
}

export interface ConstraintSolverResult {
	boxes: Map<string, Box>;
	locks: Map<string, LayoutLock>;
	diagnostics: Diagnostic[];
}
