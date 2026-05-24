import type { NodeShape } from "../ir/elements.js";
import type { AnchorName, AnchorPoint, Box, Insets, Point } from "../ir/geometry.js";
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
	const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
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
