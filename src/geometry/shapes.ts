import type { NodeShape } from "../ir/elements.js";
import type {
	AnchorName,
	AnchorPoint,
	Box,
	Insets,
	Point,
} from "../ir/geometry.js";
import { boxCenter, expandBox, validateBox } from "./boxes.js";

const SUPPORTED_SHAPES = new Set<NodeShape>([
	"rectangle",
	"rounded-rectangle",
	"ellipse",
	"diamond",
	"parallelogram",
	"hexagon",
	"cylinder",
]);

export interface ShapeGeometryInput {
	shape: NodeShape;
	box: Box;
	obstacleMargin?: number | Insets;
}

export interface ShapeGeometry {
	shape: NodeShape;
	box: Box;
	center: Point;
	anchors: AnchorPoint[];
	obstacleBox: Box;
}

export function computeShapeGeometry(input: ShapeGeometryInput): ShapeGeometry {
	validateShape(input.shape);
	validateBox(input.box);

	const box = { ...input.box };

	return {
		shape: input.shape,
		box,
		center: boxCenter(box),
		anchors: createAnchors(box),
		obstacleBox: expandBox(box, input.obstacleMargin ?? 0),
	};
}

export function getEdgePort(
	geometry: ShapeGeometry,
	toward: Point,
	preferredAnchor?: AnchorName,
): Point {
	validateShape(geometry.shape);
	validateBox(geometry.box);
	validatePoint(toward, "toward");

	if (preferredAnchor !== undefined) {
		const anchor = geometry.anchors.find((candidate) => {
			return candidate.name === preferredAnchor;
		});

		if (anchor === undefined) {
			throw new TypeError(`Unsupported anchor: ${preferredAnchor}`);
		}

		return { ...anchor.point };
	}

	if (
		geometry.shape === "rectangle" ||
		geometry.shape === "rounded-rectangle"
	) {
		return rayToBox(geometry.box, toward);
	}

	// Practical deterministic approximation: precise visual boundary intersections
	// are deferred; Phase 2 returns stable ports inside the outer shape box.
	return snapToNearestAnchor(geometry, toward);
}

export type ShapeSide = "top" | "right" | "bottom" | "left";

/** Horizontal skew used by parallelogram / hexagon outlines (matches SVG). */
export function shapeSkew(box: Box): number {
	return Math.min(box.width * 0.2, 24);
}

/** Cap radius used by cylinder outlines (matches SVG). */
export function cylinderCapRadius(box: Box): number {
	return Math.min(12, box.height / 4);
}

/**
 * Usable parametric range `[start, end]` (0..1 along the side, left→right
 * for top/bottom and top→bottom for left/right) where attach points still
 * sit on a reasonably flat portion of the shape outline. Pointed shapes keep
 * attach points near the tip so orthogonal stubs do not float in the corners
 * of the bounding box.
 */
export function shapeSideAttachRange(
	shape: NodeShape,
	box: Box,
	side: ShapeSide,
): [number, number] {
	const horizontalSide = side === "top" || side === "bottom";
	const span = horizontalSide ? box.width : box.height;
	const cornerInset = span <= 0 ? 0 : Math.min(8, span / 4) / span;
	switch (shape) {
		case "rectangle":
		case "rounded-rectangle":
			return [cornerInset, 1 - cornerInset];
		case "diamond":
			return [0.25, 0.75];
		case "ellipse":
			return [0.2, 0.8];
		case "hexagon": {
			if (!horizontalSide) return [0.15, 0.85];
			const skew = shapeSkew(box) / Math.max(1, box.width);
			return [skew + cornerInset, 1 - skew - cornerInset];
		}
		case "parallelogram": {
			if (!horizontalSide) return [0.15, 0.85];
			const skew = shapeSkew(box) / Math.max(1, box.width);
			return side === "top"
				? [skew + cornerInset, 1 - cornerInset]
				: [cornerInset, 1 - skew - cornerInset];
		}
		case "cylinder": {
			if (horizontalSide) return [0.2, 0.8];
			// The flat body runs between the two cap ellipses' side points.
			const inset = (cylinderCapRadius(box) + 2) / Math.max(1, box.height);
			return [Math.min(0.5, inset), Math.max(0.5, 1 - inset)];
		}
	}
}

/**
 * Point on the visible outline of `shape` for parameter `t` along `side`.
 * The returned point keeps the side's cross-axis coordinate derived from the
 * outline (not the bounding box), so an orthogonal stub leaving the point
 * outward starts exactly on the drawn border.
 */
export function shapeSidePoint(
	shape: NodeShape,
	box: Box,
	side: ShapeSide,
	t: number,
): Point {
	const clamped = Math.min(1, Math.max(0, t));
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const horizontalSide = side === "top" || side === "bottom";
	const along = horizontalSide
		? left + clamped * box.width
		: top + clamped * box.height;
	// Normalized distance from the side's midpoint in [-1, 1].
	const u = horizontalSide
		? box.width <= 0
			? 0
			: (along - cx) / (box.width / 2)
		: box.height <= 0
			? 0
			: (along - cy) / (box.height / 2);
	const absU = Math.min(1, Math.abs(u));
	const outward = (depth: number): Point => {
		switch (side) {
			case "top":
				return { x: along, y: top + depth };
			case "bottom":
				return { x: along, y: bottom - depth };
			case "left":
				return { x: left + depth, y: along };
			case "right":
				return { x: right - depth, y: along };
		}
	};
	const halfCross = horizontalSide ? box.height / 2 : box.width / 2;
	switch (shape) {
		case "rectangle":
		case "rounded-rectangle":
			return outward(0);
		case "diamond":
			return outward(halfCross * absU);
		case "ellipse":
			return outward(halfCross * (1 - Math.sqrt(Math.max(0, 1 - absU * absU))));
		case "hexagon": {
			if (horizontalSide) return outward(0);
			return outward(shapeSkew(box) * absU);
		}
		case "parallelogram": {
			if (horizontalSide) return outward(0);
			const skew = shapeSkew(box);
			// Left edge runs from (left+skew, top) to (left, bottom); right edge
			// runs from (right, top) to (right-skew, bottom).
			const fromTop = box.height <= 0 ? 0 : (along - top) / box.height;
			return side === "left"
				? outward(skew * (1 - fromTop))
				: outward(skew * fromTop);
		}
		case "cylinder": {
			if (!horizontalSide) return outward(0);
			const ry = cylinderCapRadius(box);
			return outward(ry * (1 - Math.sqrt(Math.max(0, 1 - absU * absU))));
		}
	}
}

function createAnchors(box: Box): AnchorPoint[] {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	const center = boxCenter(box);

	return [
		{ name: "center", point: center },
		{ name: "top", point: { x: center.x, y: top } },
		{ name: "right", point: { x: right, y: center.y } },
		{ name: "bottom", point: { x: center.x, y: bottom } },
		{ name: "left", point: { x: left, y: center.y } },
		{ name: "top-left", point: { x: left, y: top } },
		{ name: "top-right", point: { x: right, y: top } },
		{ name: "bottom-right", point: { x: right, y: bottom } },
		{ name: "bottom-left", point: { x: left, y: bottom } },
	];
}

function rayToBox(box: Box, toward: Point): Point {
	const center = boxCenter(box);
	const dx = toward.x - center.x;
	const dy = toward.y - center.y;

	if (dx === 0 && dy === 0) {
		return center;
	}

	const halfWidth = box.width / 2;
	const halfHeight = box.height / 2;
	const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
	const scaleY =
		dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
	const scale = Math.min(scaleX, scaleY);

	return clampPointToBox(
		{
			x: center.x + dx * scale,
			y: center.y + dy * scale,
		},
		box,
	);
}

function snapToNearestAnchor(geometry: ShapeGeometry, toward: Point): Point {
	let best = geometry.anchors[0];
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const anchor of geometry.anchors) {
		if (anchor.name === "center") {
			continue;
		}

		const distance = squaredDistance(anchor.point, toward);

		if (distance < bestDistance) {
			best = anchor;
			bestDistance = distance;
		}
	}

	if (best === undefined) {
		return { ...geometry.center };
	}

	return clampPointToBox(best.point, geometry.box);
}

function clampPointToBox(point: Point, box: Box): Point {
	return {
		x: Math.min(Math.max(point.x, box.x), box.x + box.width),
		y: Math.min(Math.max(point.y, box.y), box.y + box.height),
	};
}

function squaredDistance(a: Point, b: Point): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;

	return dx * dx + dy * dy;
}

function validateShape(shape: NodeShape): void {
	if (!SUPPORTED_SHAPES.has(shape)) {
		throw new TypeError(`Unsupported shape: ${shape}`);
	}
}

function validatePoint(point: Point, label: string): void {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new TypeError(`${label} point must be finite`);
	}
}
