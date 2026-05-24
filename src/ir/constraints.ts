import type { Insets, Point } from "./geometry.js";

export type ConstraintTargetKind = "node" | "group";

export interface ConstraintTarget {
	id: string;
	kind?: ConstraintTargetKind;
}

export interface ConstraintBase {
	id?: string;
	targetId?: string;
	target?: ConstraintTarget;
}

export interface ExactPositionConstraint extends ConstraintBase {
	kind: "exact-position";
	position: Point;
}

export type RelativePositionRelation =
	| "above"
	| "right-of"
	| "below"
	| "left-of";

export interface RelativePositionConstraint extends ConstraintBase {
	kind: "relative-position";
	sourceId: string;
	referenceId: string;
	relation: RelativePositionRelation;
	offset?: Point;
}

export type AlignmentAxis =
	| "x"
	| "y"
	| "center-x"
	| "center-y"
	| "top"
	| "right"
	| "bottom"
	| "left";

export interface AlignConstraint extends ConstraintBase {
	kind: "align";
	axis: AlignmentAxis;
	targetIds: string[];
}

export type DistributionAxis = "horizontal" | "vertical";

export interface DistributeConstraint extends ConstraintBase {
	kind: "distribute";
	axis: DistributionAxis;
	targetIds: string[];
	spacing?: number;
}

export interface ContainmentConstraint extends ConstraintBase {
	kind: "containment";
	containerId: string;
	childIds: string[];
	padding?: Insets;
}

export type Constraint =
	| ExactPositionConstraint
	| RelativePositionConstraint
	| AlignConstraint
	| DistributeConstraint
	| ContainmentConstraint;
