import type { LayoutState } from "./types.js";

/**
 * Build the initial pipeline state from the raw diagram input.
 * Deduplication and constraint normalization happen here so
 * downstream phases always operate on clean data.
 */
export function createInitialState(
	diagram: LayoutState["diagram"],
	options: LayoutState["options"],
): LayoutState {
	const diagnostics = [...diagram.diagnostics];

	// Reuse the local dedup helpers — these live in solve.ts and are
	// not exported, so we inline the trivial implementation here.
	function stableUniqueById<T extends { id: string }>(
		items: readonly T[],
	): T[] {
		const seen = new Set<string>();
		return items.filter((item) => {
			if (seen.has(item.id)) {
				diagnostics.push({
					severity: "error",
					code: "solver.duplicate_id",
					message: `Duplicate id "${item.id}" — only the first occurrence is kept.`,
					path: [],
					detail: { id: item.id },
				});
				return false;
			}
			seen.add(item.id);
			return true;
		});
	}

	function stableByConstraintId(
		constraints: LayoutState["constraints"],
	): LayoutState["constraints"] {
		const seen = new Set<string>();
		return constraints.filter((c) => {
			if (c.id === undefined) return true;
			if (seen.has(c.id)) {
				diagnostics.push({
					severity: "error",
					code: "solver.duplicate_constraint_id",
					message: `Duplicate constraint id "${c.id}" — only the first occurrence is kept.`,
					path: [],
					detail: { id: c.id },
				});
				return false;
			}
			seen.add(c.id);
			return true;
		});
	}

	return {
		diagram,
		options,
		nodes: stableUniqueById(diagram.nodes),
		edges: stableUniqueById(diagram.edges),
		groups: stableUniqueById(diagram.groups),
		swimlanes: diagram.swimlanes ?? [],
		constraints: stableByConstraintId(diagram.constraints),
		boxes: new Map(),
		locks: new Map(),
		nodeGeometry: new Map(),
		coordinatedNodes: [],
		coordinatedEdges: [],
		coordinatedGroups: [],
		coordinatedMatrices: [],
		coordinatedTables: [],
		coordinatedEvidencePanels: [],
		baseTextAnnotations: [],
		edgeTextAnnotations: [],
		contentBounds: { x: 0, y: 0, width: 0, height: 0 },
		bounds: { x: 0, y: 0, width: 0, height: 0 },
		degraded: false,
		diagnostics,
		phaseTrace: [],
	};
}
