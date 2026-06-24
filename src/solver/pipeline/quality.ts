import { intersectsAabb } from "../../geometry/boxes.js";
import type { Diagnostic } from "../../ir/diagnostics.js";
import type { CoordinatedEdge, CoordinatedNode } from "../../ir/elements.js";
import type { Box, Point } from "../../ir/geometry.js";

// ---------------------------------------------------------------------------
// Quality scoring (Issue #54, 方案 E)
// ---------------------------------------------------------------------------

export interface QualityMetric {
	readonly kind: QualityMetricKind;
	readonly value: number;
	readonly label: string;
}

export type QualityMetricKind =
	| "node-overlap"
	| "edge-crossing"
	| "bend-count"
	| "route-backtrack"
	| "label-collision";

export interface QualityReport {
	readonly metrics: QualityMetric[];
	/** Aggregate score 0–100 (higher = better). */
	readonly score: number;
	readonly diagnostics: Diagnostic[];
}

/**
 * Score diagram quality across 5 dimensions.
 *
 * - node-overlap:  pairs of nodes whose AABB intersect
 * - edge-crossing: pairs of edge routes whose segments cross
 * - bend-count:    total turns across all edges
 * - route-backtrack: edges whose length > 3× direct distance
 * - label-collision: text annotations overlapping nodes or edges
 *
 * Each dimension contributes up to 20 points.  The total is
 * clamped to 0–100.
 */
export function scoreLayoutQuality(
	nodes: readonly CoordinatedNode[],
	edges: readonly CoordinatedEdge[],
): QualityReport {
	const diagnostics: Diagnostic[] = [];
	const metrics: QualityMetric[] = [];

	// 1. Node overlap (20 pts)
	const overlapCount = countNodeOverlaps(nodes);
	const overlapScore = Math.max(0, 20 - overlapCount * 5);
	metrics.push({
		kind: "node-overlap",
		value: overlapCount,
		label: `${overlapCount} overlaps`,
	});
	if (overlapCount > 0) {
		diagnostics.push({
			severity: "warning",
			code: "quality.node_overlap",
			message: `${overlapCount} node pair(s) overlap.`,
			detail: { overlapCount },
		});
	}

	// 2. Edge crossing (20 pts)
	const crossingCount = countEdgeCrossings(edges);
	const crossingScore = Math.max(0, 20 - crossingCount * 2);
	metrics.push({
		kind: "edge-crossing",
		value: crossingCount,
		label: `${crossingCount} crossings`,
	});
	if (crossingCount > 0) {
		diagnostics.push({
			severity: "warning",
			code: "quality.edge_crossing",
			message: `${crossingCount} edge segment pair(s) cross.`,
			detail: { crossingCount },
		});
	}

	// 3. Bend count (20 pts)
	const totalBends = countTotalBends(edges);
	const bendScore = Math.max(0, 20 - totalBends * 0.5);
	metrics.push({
		kind: "bend-count",
		value: totalBends,
		label: `${totalBends} bends`,
	});

	// 4. Route backtracking (20 pts)
	const backtrackCount = countBacktrackingEdges(edges);
	const backtrackScore = Math.max(0, 20 - backtrackCount * 5);
	metrics.push({
		kind: "route-backtrack",
		value: backtrackCount,
		label: `${backtrackCount} backtracking`,
	});
	if (backtrackCount > 0) {
		diagnostics.push({
			severity: "warning",
			code: "quality.route_backtrack",
			message: `${backtrackCount} edge(s) are excessively long (>3× direct).`,
			detail: { backtrackCount },
		});
	}

	// 5. Label collision (20 pts)
	const labelCollisions = countLabelCollisions(nodes, edges);
	const labelScore = Math.max(0, 20 - labelCollisions * 3);
	metrics.push({
		kind: "label-collision",
		value: labelCollisions,
		label: `${labelCollisions} label collisions`,
	});

	const score = Math.max(
		0,
		Math.min(
			100,
			overlapScore + crossingScore + bendScore + backtrackScore + labelScore,
		),
	);

	return { metrics, score, diagnostics };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function countNodeOverlaps(nodes: readonly CoordinatedNode[]): number {
	let count = 0;
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			if (intersectsAabb(nodes[i]!.box, nodes[j]!.box)) {
				count++;
			}
		}
	}
	return count;
}

function countEdgeCrossings(edges: readonly CoordinatedEdge[]): number {
	let count = 0;
	for (let i = 0; i < edges.length; i++) {
		const aPts = edges[i]!.points;
		for (let j = i + 1; j < edges.length; j++) {
			const bPts = edges[j]!.points;
			for (let ai = 0; ai < aPts.length - 1; ai++) {
				for (let bi = 0; bi < bPts.length - 1; bi++) {
					if (
						segmentsIntersect(
							aPts[ai]!,
							aPts[ai + 1]!,
							bPts[bi]!,
							bPts[bi + 1]!,
						)
					) {
						count++;
					}
				}
			}
		}
	}
	return count;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);
	return (
		((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
		((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
	);
}

function cross(o: Point, a: Point, b: Point): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function countTotalBends(edges: readonly CoordinatedEdge[]): number {
	let bends = 0;
	for (const e of edges) {
		bends += Math.max(0, e.points.length - 2);
	}
	return bends;
}

function countBacktrackingEdges(edges: readonly CoordinatedEdge[]): number {
	let count = 0;
	for (const e of edges) {
		if (e.points.length < 2) continue;
		const first = e.points[0]!;
		const last = e.points[e.points.length - 1]!;
		const direct = Math.hypot(last.x - first.x, last.y - first.y);
		if (direct <= 0) continue;
		let routeLen = 0;
		for (let i = 0; i < e.points.length - 1; i++) {
			routeLen += Math.hypot(
				e.points[i + 1]!.x - e.points[i]!.x,
				e.points[i + 1]!.y - e.points[i]!.y,
			);
		}
		if (routeLen > direct * 3) count++;
	}
	return count;
}

function countLabelCollisions(
	nodes: readonly CoordinatedNode[],
	edges: readonly CoordinatedEdge[],
): number {
	let count = 0;
	const nodeBoxes = new Map<string, Box>();
	for (const n of nodes) {
		nodeBoxes.set(n.id, n.box);
		if (n.label?.text !== undefined) {
			// Estimate label box at center of node
			const lw = n.label.text.length * 8;
			const labelBox: Box = {
				x: n.box.x + n.box.width / 2 - lw / 2,
				y: n.box.y - 8,
				width: lw,
				height: 14,
			};
			// Check label vs other node boxes
			for (const [id, box] of nodeBoxes) {
				if (id === n.id) continue;
				if (intersectsAabb(labelBox, box)) count++;
			}
			// Check label vs edge paths
			for (const e of edges) {
				for (let i = 0; i < e.points.length - 1; i++) {
					if (segmentIntersectsBox(e.points[i]!, e.points[i + 1]!, labelBox)) {
						count++;
						break;
					}
				}
			}
		}
	}
	return count;
}

function segmentIntersectsBox(start: Point, end: Point, box: Box): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;

	if (
		(start.x > left && start.x < right && start.y > top && start.y < bottom) ||
		(end.x > left && end.x < right && end.y > top && end.y < bottom)
	)
		return true;

	if (start.x === end.x) {
		return (
			start.x > left &&
			start.x < right &&
			rangesOverlap(start.y, end.y, top, bottom)
		);
	}
	if (start.y === end.y) {
		return (
			start.y > top &&
			start.y < bottom &&
			rangesOverlap(start.x, end.x, left, right)
		);
	}

	return (
		edgeIntersect(start, end, left, top, right, top) ||
		edgeIntersect(start, end, right, top, right, bottom) ||
		edgeIntersect(start, end, right, bottom, left, bottom) ||
		edgeIntersect(start, end, left, bottom, left, top)
	);
}

function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	return hi > min && lo < max;
}

function edgeIntersect(
	start: Point,
	end: Point,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): boolean {
	const denom = (end.x - start.x) * (y2 - y1) - (end.y - start.y) * (x2 - x1);
	if (denom === 0) return false;
	const t = ((start.x - x1) * (y2 - y1) - (start.y - y1) * (x2 - x1)) / denom;
	const u =
		((start.x - x1) * (end.y - start.y) - (start.y - y1) * (end.x - start.x)) /
		denom;
	return t > 0 && t < 1 && u > 0 && u < 1;
}
