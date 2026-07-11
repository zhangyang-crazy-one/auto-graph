import type { NodeSemanticRole, NodeShape } from "./elements.js";

const ROLE_TO_SHAPE: Readonly<Record<NodeSemanticRole, NodeShape>> = {
	start: "ellipse",
	end: "ellipse",
	decision: "diamond",
	process: "rounded-rectangle",
	data: "cylinder",
	concept: "rectangle",
};

export function isNodeSemanticRole(value: string): value is NodeSemanticRole {
	return Object.hasOwn(ROLE_TO_SHAPE, value);
}

/** Map a semantic role to its fixed catalog shape (#84 §D). */
export function shapeForSemanticRole(role: NodeSemanticRole): NodeShape {
	return ROLE_TO_SHAPE[role];
}

/**
 * Resolve shape: explicit `shape` wins; otherwise map `role`; else rectangle.
 */
export function resolveNodeShape(input: {
	shape?: NodeShape;
	role?: NodeSemanticRole;
}): NodeShape {
	if (input.shape !== undefined) {
		return input.shape;
	}
	if (input.role !== undefined) {
		return shapeForSemanticRole(input.role);
	}
	return "rectangle";
}

/** Circle diameter rule for ellipse terminators (#84 §A/D). */
export function applyEllipseCircleSize(size: {
	width: number;
	height: number;
}): { width: number; height: number } {
	const diameter = Math.max(size.width, size.height);
	return { width: diameter, height: diameter };
}
