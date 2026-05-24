import type { Diagnostic } from "../ir/diagnostics.js";
import type { AnchorPoint, Box, Insets, Size } from "../ir/geometry.js";
import type { LabelLayout } from "../labels/index.js";
import { expandBox, normalizeInsets, unionBoxes } from "./boxes.js";
import { computeShapeGeometry } from "./shapes.js";

export interface ContainerGeometryInput {
	id: string;
	childBoxes: readonly Box[];
	padding: Insets | number;
	labelLayout?: LabelLayout;
	minSize?: Partial<Size>;
	obstacleMargin?: number | Insets;
}

export interface ContainerGeometry {
	id: string;
	box: Box;
	contentBox: Box;
	childBounds: Box;
	labelLayout?: LabelLayout;
	anchors: AnchorPoint[];
	obstacleBox: Box;
	diagnostics: Diagnostic[];
}

export function computeContainerGeometry(
	input: ContainerGeometryInput,
): ContainerGeometry {
	const childBounds = unionBoxes(input.childBoxes);
	const padding = normalizeInsets(input.padding);
	const minSize = normalizeMinSize(input.minSize);
	const headerHeight =
		input.labelLayout?.fittedSize.height ?? input.labelLayout?.box.height ?? 0;
	const intrinsicBox = {
		x: childBounds.x - padding.left,
		y: childBounds.y - padding.top - headerHeight,
		width: childBounds.width + padding.left + padding.right,
		height: childBounds.height + padding.top + padding.bottom + headerHeight,
	};
	const box = {
		...intrinsicBox,
		width: Math.max(intrinsicBox.width, minSize.width ?? 0),
		height: Math.max(intrinsicBox.height, minSize.height ?? 0),
	};
	const contentBox = {
		x: childBounds.x,
		y: childBounds.y,
		width: childBounds.width,
		height: childBounds.height,
	};
	const shape = computeShapeGeometry({
		shape: "rectangle",
		box,
	});
	const obstacleBox = expandBox(box, input.obstacleMargin ?? 0);

	return {
		id: input.id,
		box,
		contentBox,
		childBounds,
		...(input.labelLayout === undefined
			? {}
			: { labelLayout: input.labelLayout }),
		anchors: shape.anchors,
		obstacleBox,
		diagnostics: [],
	};
}

function normalizeMinSize(minSize: Partial<Size> = {}): Partial<Size> {
	if (minSize.width !== undefined) {
		validateSize(minSize.width, "minSize.width");
	}

	if (minSize.height !== undefined) {
		validateSize(minSize.height, "minSize.height");
	}

	return { ...minSize };
}

function validateSize(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError(`${label} must be finite and non-negative`);
	}
}
