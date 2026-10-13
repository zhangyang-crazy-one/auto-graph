import type { CoordinatedDiagram } from "../ir/diagram.js";
import type { Box, Point } from "../ir/geometry.js";

/**
 * Route readability defects: places where two routes, or a label and a
 * route, read as something they are not. Reads only the solved IR; every
 * count is 0 on a clean diagram. Sequence diagrams are not measured
 * (their messages are horizontal by construction).
 */
export interface RouteReadability {
	/**
	 * Segment pairs of different routes on one line (within 1 px) whose
	 * ends stop less than {@link COLLINEAR_TOUCH_GAP} apart: they read as
	 * one broken line.
	 */
	collinearTouches: number;
	/**
	 * Total length (px) where segments of different routes run parallel
	 * less than {@link NEAR_PARALLEL_GAP} apart (but not on one line).
	 */
	nearParallelLength: number;
	/** Edge labels nearer (by more than 2 px) another route than their own. */
	labelsNearerOtherRoute: number;
	/** Edge labels on a group title's row less than 8 px beside the title. */
	labelsBesideGroupTitles: number;
	/**
	 * Route ends more than 2 px off their node's outline (rectangles,
	 * rounded rectangles, diamonds and ellipses are checked).
	 */
	endsOffOutline: number;
}

/** Ends of two routes on one line closer than this read as one line. */
export const COLLINEAR_TOUCH_GAP = 12;
/** Parallel routes closer than this read as one line. */
export const NEAR_PARALLEL_GAP = 6;
const TITLE_GAP = 8;

export function measureRouteReadability(
	diagram: CoordinatedDiagram,
): RouteReadability {
	const result: RouteReadability = {
		collinearTouches: 0,
		nearParallelLength: 0,
		labelsNearerOtherRoute: 0,
		labelsBesideGroupTitles: 0,
		endsOffOutline: 0,
	};
	if (diagram.sequence !== undefined) return result;
	const routes = diagram.edges.map((edge) => axisSegments(edge.points));
	for (let i = 0; i < routes.length; i += 1) {
		for (let j = i + 1; j < routes.length; j += 1) {
			for (const s of routes[i] ?? []) {
				for (const t of routes[j] ?? []) {
					if (s.horizontal !== t.horizontal) continue;
					const offset = Math.abs(s.at - t.at);
					const gap = Math.max(s.lo, t.lo) - Math.min(s.hi, t.hi);
					if (offset <= 1 && gap > 0 && gap < COLLINEAR_TOUCH_GAP) {
						result.collinearTouches += 1;
					}
					if (offset > 0.5 && offset < NEAR_PARALLEL_GAP && gap < 0) {
						result.nearParallelLength += -gap;
					}
				}
			}
		}
	}

	const annotations = diagram.textAnnotations ?? [];
	const titles = annotations.filter(
		(annotation) => annotation.surfaceKind === "group-label",
	);
	const edgeById = new Map(diagram.edges.map((edge) => [edge.id, edge]));
	for (const label of annotations) {
		if (label.surfaceKind !== "edge-label") continue;
		const own = edgeById.get(label.ownerId);
		if (own === undefined) continue;
		const ownDistance = boxPolylineDistance(label.box, own.points);
		if (
			diagram.edges.some(
				(edge) =>
					edge.id !== own.id &&
					boxPolylineDistance(label.box, edge.points) + 2 < ownDistance,
			)
		) {
			result.labelsNearerOtherRoute += 1;
		}
		for (const title of titles) {
			const sameRow =
				label.box.y < title.box.y + title.box.height &&
				label.box.y + label.box.height > title.box.y;
			const gap = Math.max(
				label.box.x - (title.box.x + title.box.width),
				title.box.x - (label.box.x + label.box.width),
			);
			if (sameRow && gap < TITLE_GAP) result.labelsBesideGroupTitles += 1;
		}
	}

	const nodeById = new Map(diagram.nodes.map((node) => [node.id, node]));
	for (const edge of diagram.edges) {
		const ends: [Point | undefined, string][] = [
			[edge.points[0], edge.source.nodeId],
			[edge.points.at(-1), edge.target.nodeId],
		];
		for (const [point, nodeId] of ends) {
			const node = nodeById.get(nodeId);
			if (point === undefined || node === undefined) continue;
			if (outlineOffset(node.shape, node.box, point) > 2) {
				result.endsOffOutline += 1;
			}
		}
	}
	return result;
}

interface AxisSegment {
	horizontal: boolean;
	at: number;
	lo: number;
	hi: number;
}

function axisSegments(points: readonly Point[]): AxisSegment[] {
	const out: AxisSegment[] = [];
	for (let index = 0; index + 1 < points.length; index += 1) {
		const a = points[index] as Point;
		const b = points[index + 1] as Point;
		if (Math.abs(a.y - b.y) < 0.01 && Math.abs(a.x - b.x) > 0.01) {
			out.push({
				horizontal: true,
				at: a.y,
				lo: Math.min(a.x, b.x),
				hi: Math.max(a.x, b.x),
			});
		} else if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) > 0.01) {
			out.push({
				horizontal: false,
				at: a.x,
				lo: Math.min(a.y, b.y),
				hi: Math.max(a.y, b.y),
			});
		}
	}
	return out;
}

function boxPolylineDistance(box: Box, points: readonly Point[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let index = 0; index + 1 < points.length; index += 1) {
		const a = points[index] as Point;
		const b = points[index + 1] as Point;
		const dx = Math.max(
			0,
			Math.min(a.x, b.x) - (box.x + box.width),
			box.x - Math.max(a.x, b.x),
		);
		const dy = Math.max(
			0,
			Math.min(a.y, b.y) - (box.y + box.height),
			box.y - Math.max(a.y, b.y),
		);
		best = Math.min(best, Math.hypot(dx, dy));
	}
	return best;
}

/** How far a point lies off a node's outline (0 for unchecked shapes). */
function outlineOffset(shape: string, box: Box, point: Point): number {
	const halfWidth = box.width / 2;
	const halfHeight = box.height / 2;
	if (halfWidth <= 0 || halfHeight <= 0) return 0;
	const dx = Math.abs(point.x - (box.x + halfWidth));
	const dy = Math.abs(point.y - (box.y + halfHeight));
	const scale = Math.min(halfWidth, halfHeight);
	switch (shape) {
		case "diamond":
			return Math.abs(dx / halfWidth + dy / halfHeight - 1) * scale;
		case "ellipse":
			return Math.abs(Math.hypot(dx / halfWidth, dy / halfHeight) - 1) * scale;
		case "rectangle":
		case "rounded-rectangle":
			return (
				Math.min(Math.abs(dx - halfWidth), Math.abs(dy - halfHeight)) +
				Math.max(0, dx - halfWidth) +
				Math.max(0, dy - halfHeight)
			);
		default:
			return 0;
	}
}
