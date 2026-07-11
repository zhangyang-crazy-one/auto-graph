import type { JsonObject } from "./geometry.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticPathSegment = string | number;

/**
 * Stable taxonomy for deliverability-relevant route/text conflicts.
 * Attached via `detail.conflictClass` without changing diagnostic codes.
 */
export type RouteConflictClass =
	| "node-label-strike"
	| "edge-label-pileup"
	| "label-bbox-graze"
	| "fixed-geometry-block"
	| "rail-lane-overflow"
	| "evidence-crossing";

export interface Diagnostic {
	severity: DiagnosticSeverity;
	code: string;
	message: string;
	path?: DiagnosticPathSegment[];
	detail?: JsonObject;
}

/**
 * Diagnostic codes that indicate the solver produced a degraded
 * (non-deliverable) layout.  Downstream consumers can gate on the
 * {@link CoordinatedDiagram.degraded} flag or use the
 * {@link SolveDiagramOptions.strict} option to promote these to
 * errors.
 */
export const DELIVERABILITY_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
	"constraints.locked-target-not-moved",
	"constraints.overlap.locked-conflict",
	"constraints.overlap.post-growth",
	"routing.evidence.crossing_forbidden",
	"routing.endpoint-interior.unavoidable",
	"routing.label-hard-obstacle.unavoidable",
	"routing.obstacle.unavoidable",
	"routing.label-congestion.unresolved",
	"routing.label-externalization.required",
	"routing.route-label-loop.exhausted",
	"routing.rail-capacity.exceeded",
	"routing.channel.capacity_exhausted",
	"routing.anchor-capacity.requires-resize",
	"routing.container-fixed-bounds-overflow",
	"routing.deliverability.unsatisfiable",
	"layout.container-fixed-bounds-overflow",
	"route_obstacle_fallback",
	"routing.text-clearance.unresolved",
]);
