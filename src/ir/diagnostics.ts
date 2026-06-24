import type { JsonObject } from "./geometry.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticPathSegment = string | number;

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
	"routing.evidence.crossing_forbidden",
	"routing.obstacle.unavoidable",
	"route_obstacle_fallback",
	"routing.text-clearance.unresolved",
]);
