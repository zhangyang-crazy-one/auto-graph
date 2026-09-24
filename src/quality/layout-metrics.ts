import { cylinderCapRadius, shapeSkew } from "../geometry/shapes.js";
import type { Constraint } from "../ir/constraints.js";
import type { CoordinatedDiagram } from "../ir/diagram.js";
import type { NodeShape } from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";

/**
 * Whole-canvas layout quality metrics.
 *
 * Reads only the solved IR, so every solver stage (current pipeline or the
 * planned global solver) is measured with the same ruler. All values are
 * deterministic numbers; lower is better unless noted.
 */
export interface LayoutMetrics {
	// --- Hard geometry (target 0) -------------------------------------
	/** Node pairs whose boxes overlap by more than 0.5 px. */
	nodeOverlaps: number;
	/** Group pairs (neither contains the other) whose boxes overlap. */
	groupOverlaps: number;
	/** Total overlapping area of such group pairs, as a fraction of the canvas. */
	groupOverlapAreaRatio: number;
	/** Nodes whose centre lies inside a group they are not a member of. */
	foreignNodesInGroups: number;
	/** Node labels whose rendered text box leaves the drawn shape outline. */
	labelOverflows: number;
	/** Edge segments that cross the interior of a non-endpoint node. */
	edgesThroughNodes: number;
	/** Edge labels overlapping a node box or another label. */
	edgeLabelCollisions: number;

	// --- Edge readability ----------------------------------------------
	/** Proper orthogonal edge–edge crossings. */
	crossings: number;
	/** Total direction changes over all edges. */
	bends: number;
	/** Mean bends per edge. */
	bendsPerEdge: number;
	/** Pairs of edges ending on the same point of the same node. */
	sharedEndpoints: number;
	/** Total length where two different edges run on top of each other (px). */
	overlappingSegmentLength: number;
	/** Mean route length divided by straight-line endpoint distance (>= 1). */
	meanDetour: number;
	/** Coefficient of variation of route lengths. */
	edgeLengthCV: number;

	// --- Space distribution --------------------------------------------
	width: number;
	height: number;
	aspectRatio: number;
	/** |ln(aspect / target)|; 0 means the canvas matches the target aspect. */
	aspectDeviation: number;
	/** 1 - (sum of node areas / canvas area). */
	whitespaceRatio: number;
	/** Coefficient of variation of each node's clearance to its nearest neighbour. */
	gapCV: number;
	/** Largest empty axis-aligned rectangle on an occupancy grid / canvas area. */
	largestEmptyRatio: number;
	/** Mean (content bounding area / lane area) across lanes; higher is better. */
	laneFill: number;
	/** Lanes whose content spans less than 25% of the lane area. */
	sparseLanes: number;

	// --- Counts ---------------------------------------------------------
	nodeCount: number;
	edgeCount: number;
	groupCount: number;
	laneCount: number;
}

export interface LayoutMetricsOptions {
	/**
	 * Intentional containment (a node placed inside another node, e.g. from
	 * `containment` constraints). These pairs are not counted as overlaps.
	 * Nodes whose `parentId` names another node are excluded automatically.
	 */
	containment?: ReadonlyArray<{
		containerId: string;
		childIds: readonly string[];
	}>;
	/** Target width / height ratio for `aspectDeviation` (default 16/9). */
	targetAspectRatio?: number;
	/** Occupancy grid resolution per axis for `largestEmptyRatio` (default 48). */
	gridResolution?: number;
}

const EPSILON = 0.5;

export function measureLayoutQuality(
	diagram: CoordinatedDiagram,
	options: LayoutMetricsOptions = {},
): LayoutMetrics {
	const targetAspect = options.targetAspectRatio ?? 16 / 9;
	const nodes = diagram.nodes;
	const edges = diagram.edges;
	const annotations = diagram.textAnnotations ?? [];
	const canvas = canvasBox(diagram);
	const canvasArea = Math.max(1, canvas.width * canvas.height);
	const nodeById = new Map(nodes.map((node) => [node.id, node]));

	// Hard geometry --------------------------------------------------------
	const containedPairs = new Set<string>();
	const pairKey = (a: string, b: string): string =>
		a < b ? `${a}|${b}` : `${b}|${a}`;
	for (const relation of options.containment ?? []) {
		for (const childId of relation.childIds) {
			containedPairs.add(pairKey(relation.containerId, childId));
		}
	}
	for (const node of nodes) {
		if (node.parentId !== undefined && nodeById.has(node.parentId)) {
			containedPairs.add(pairKey(node.parentId, node.id));
		}
	}
	let nodeOverlaps = 0;
	for (let i = 0; i < nodes.length; i += 1) {
		for (let j = i + 1; j < nodes.length; j += 1) {
			const a = nodes[i];
			const b = nodes[j];
			if (a === undefined || b === undefined) continue;
			if (containedPairs.has(pairKey(a.id, b.id))) continue;
			if (overlapArea(a.box, b.box) > EPSILON) nodeOverlaps += 1;
		}
	}

	const groupMembers = new Map<string, Set<string>>();
	const groupDescendants = new Map<string, Set<string>>();
	const groupsById = new Map(diagram.groups.map((group) => [group.id, group]));
	const collectMembers = (
		groupId: string,
		seen: Set<string>,
	): { nodes: Set<string>; groups: Set<string> } => {
		const group = groupsById.get(groupId);
		const nodesInGroup = new Set<string>(group?.nodeIds ?? []);
		const groups = new Set<string>();
		if (group === undefined || seen.has(groupId)) {
			return { nodes: nodesInGroup, groups };
		}
		seen.add(groupId);
		for (const childId of group.groupIds) {
			groups.add(childId);
			const child = collectMembers(childId, seen);
			for (const id of child.nodes) nodesInGroup.add(id);
			for (const id of child.groups) groups.add(id);
		}
		return { nodes: nodesInGroup, groups };
	};
	for (const group of diagram.groups) {
		const members = collectMembers(group.id, new Set());
		groupMembers.set(group.id, members.nodes);
		groupDescendants.set(group.id, members.groups);
	}
	let groupOverlaps = 0;
	let groupOverlapArea = 0;
	for (let i = 0; i < diagram.groups.length; i += 1) {
		for (let j = i + 1; j < diagram.groups.length; j += 1) {
			const a = diagram.groups[i];
			const b = diagram.groups[j];
			if (a === undefined || b === undefined) continue;
			if (
				groupDescendants.get(a.id)?.has(b.id) ||
				groupDescendants.get(b.id)?.has(a.id)
			) {
				continue;
			}
			const area = overlapArea(a.box, b.box);
			if (area > EPSILON) {
				groupOverlaps += 1;
				groupOverlapArea += area;
			}
		}
	}
	let foreignNodesInGroups = 0;
	for (const group of diagram.groups) {
		const members = groupMembers.get(group.id) ?? new Set<string>();
		for (const node of nodes) {
			if (members.has(node.id)) continue;
			if (pointInBox(center(node.box), group.box)) foreignNodesInGroups += 1;
		}
	}

	let labelOverflows = 0;
	for (const annotation of annotations) {
		if (annotation.surfaceKind !== "node-label") continue;
		const node = nodeById.get(annotation.ownerId);
		if (node === undefined) continue;
		const text = renderedTextBox(annotation);
		if (text === undefined) continue;
		if (!boxInsideShape(text, node.shape, node.box)) labelOverflows += 1;
	}

	let edgesThroughNodes = 0;
	for (const edge of edges) {
		for (const node of nodes) {
			if (node.id === edge.source.nodeId || node.id === edge.target.nodeId) {
				continue;
			}
			const inner = insetBox(node.box, 1);
			// Every traversing segment counts, so a route that enters the same
			// node again is a regression even when one crossing was baseline.
			edgesThroughNodes += segments(edge.points).filter(
				([a, b]) =>
					segmentHitsBox(a, b, inner) &&
					segmentEntersShape(a, b, node.shape, node.box),
			).length;
		}
	}

	const edgeLabels = annotations.filter(
		(annotation) => annotation.surfaceKind === "edge-label",
	);
	let edgeLabelCollisions = 0;
	for (const label of edgeLabels) {
		const hitsNode = nodes.some(
			(node) => overlapArea(label.box, node.box) > EPSILON,
		);
		// Any other text surface: edge labels, group / swimlane / frame
		// titles, port labels, … (node labels are covered by the node box).
		// Compared by visible text extent: group labels are fitted with a
		// node-sized minimum and padding that is not drawn.
		const hitsLabel = annotations.some(
			(other) =>
				other !== label &&
				overlapArea(label.box, annotationContentBox(other)) > EPSILON,
		);
		if (hitsNode || hitsLabel) edgeLabelCollisions += 1;
	}

	// Edge readability ---------------------------------------------------------
	let crossings = 0;
	let overlappingSegmentLength = 0;
	for (let i = 0; i < edges.length; i += 1) {
		for (let j = i + 1; j < edges.length; j += 1) {
			const a = edges[i];
			const b = edges[j];
			if (a === undefined || b === undefined) continue;
			for (const [a0, a1] of segments(a.points)) {
				for (const [b0, b1] of segments(b.points)) {
					if (segmentsCross(a0, a1, b0, b1)) crossings += 1;
					overlappingSegmentLength += collinearOverlap(a0, a1, b0, b1);
				}
			}
		}
	}
	const bendCounts = edges.map((edge) => bendCount(edge.points));
	const bends = sum(bendCounts);
	// Pairs of *distinct* edges ending on the same point of the same node
	// (a self-loop touching one point twice is not a collision).
	let sharedEndpoints = 0;
	const endpointEdges = new Map<string, Set<string>>();
	const addEndpoint = (nodeId: string, point: Point, edgeId: string): void => {
		const key = `${nodeId}|${point.x.toFixed(1)}|${point.y.toFixed(1)}`;
		const set = endpointEdges.get(key) ?? new Set<string>();
		set.add(edgeId);
		endpointEdges.set(key, set);
	};
	for (const edge of edges) {
		const first = edge.points[0];
		const last = edge.points.at(-1);
		if (first) addEndpoint(edge.source.nodeId, first, edge.id);
		if (last) addEndpoint(edge.target.nodeId, last, edge.id);
	}
	for (const set of endpointEdges.values()) {
		sharedEndpoints += (set.size * (set.size - 1)) / 2;
	}
	const lengths = edges.map((edge) => routeLength(edge.points));
	const detours = edges
		.map((edge, index) => {
			const first = edge.points[0];
			const last = edge.points.at(-1);
			if (!first || !last) return undefined;
			const direct = Math.hypot(last.x - first.x, last.y - first.y);
			return direct > EPSILON ? (lengths[index] ?? 0) / direct : undefined;
		})
		.filter((value): value is number => value !== undefined);

	// Space distribution -------------------------------------------------------
	const nodeArea = sum(nodes.map((node) => node.box.width * node.box.height));
	const aspectRatio = canvas.width / Math.max(1, canvas.height);
	const clearances = nodes.map((node) => {
		let nearest = Number.POSITIVE_INFINITY;
		for (const other of nodes) {
			if (other === node) continue;
			nearest = Math.min(nearest, boxGap(node.box, other.box));
		}
		return Number.isFinite(nearest) ? nearest : 0;
	});
	const lanes = (diagram.swimlanes ?? []).flatMap((swimlane) => swimlane.lanes);
	const laneFills: number[] = [];
	for (const lane of lanes) {
		const laneBox = lane.contentBox ?? lane.box;
		if (laneBox === undefined || laneBox.width <= 0 || laneBox.height <= 0) {
			continue;
		}
		const children = lane.children
			.map((id) => nodeById.get(id)?.box)
			.filter((box): box is Box => box !== undefined);
		if (children.length === 0) {
			laneFills.push(0);
			continue;
		}
		// Area of the lane actually spanned by its content (2-D), so both an
		// over-tall horizontal lane and an over-long vertical lane count.
		const content = union(children);
		laneFills.push(
			Math.min(
				1,
				(content.width * content.height) / (laneBox.width * laneBox.height),
			),
		);
	}

	return {
		nodeOverlaps,
		groupOverlaps,
		groupOverlapAreaRatio: round(groupOverlapArea / canvasArea),
		foreignNodesInGroups,
		labelOverflows,
		edgesThroughNodes,
		edgeLabelCollisions,
		crossings,
		bends,
		bendsPerEdge: round(edges.length === 0 ? 0 : bends / edges.length),
		sharedEndpoints,
		overlappingSegmentLength: round(overlappingSegmentLength),
		meanDetour: round(detours.length === 0 ? 1 : mean(detours)),
		edgeLengthCV: round(coefficientOfVariation(lengths)),
		width: round(canvas.width),
		height: round(canvas.height),
		aspectRatio: round(aspectRatio),
		aspectDeviation: round(Math.abs(Math.log(aspectRatio / targetAspect))),
		whitespaceRatio: round(1 - nodeArea / canvasArea),
		gapCV: round(coefficientOfVariation(clearances)),
		largestEmptyRatio: round(
			largestEmptyRatio(diagram, canvas, options.gridResolution ?? 48),
		),
		laneFill: round(laneFills.length === 0 ? 1 : mean(laneFills)),
		sparseLanes: laneFills.filter((fill) => fill < 0.25).length,
		nodeCount: nodes.length,
		edgeCount: edges.length,
		groupCount: diagram.groups.length,
		laneCount: lanes.length,
	};
}

/** Containment relations from normalized constraints, for `containment`. */
export function containmentRelations(
	constraints: readonly Constraint[] | undefined,
): Array<{ containerId: string; childIds: string[] }> {
	return (constraints ?? []).flatMap((constraint) =>
		constraint.kind === "containment"
			? [
					{
						containerId: constraint.containerId,
						childIds: [...constraint.childIds],
					},
				]
			: [],
	);
}

/** Keys where a larger value is worse, used by regression ratchets. */
export const LAYOUT_METRIC_HARD_KEYS = [
	"nodeOverlaps",
	"groupOverlaps",
	"groupOverlapAreaRatio",
	"foreignNodesInGroups",
	"labelOverflows",
	"edgesThroughNodes",
	"edgeLabelCollisions",
	"sharedEndpoints",
] as const satisfies readonly (keyof LayoutMetrics)[];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function canvasBox(diagram: CoordinatedDiagram): Box {
	const boxes: Box[] = [
		...diagram.nodes.map((node) => node.box),
		...diagram.groups.map((group) => group.box),
		...(diagram.swimlanes ?? []).flatMap((swimlane) =>
			swimlane.box === undefined ? [] : [swimlane.box],
		),
		...(diagram.textAnnotations ?? []).map((annotation) => annotation.box),
		// Every coordinated element that is rendered on the page.
		...(diagram.matrices ?? []).map((block) => block.box),
		...(diagram.tables ?? []).map((block) => block.box),
		...(diagram.evidencePanels ?? []).map((panel) => panel.box),
		...(diagram.frame === undefined
			? []
			: [diagram.frame.box, diagram.frame.titleBox]),
	];
	for (const edge of diagram.edges) {
		for (const point of edge.points) {
			boxes.push({ x: point.x, y: point.y, width: 0, height: 0 });
		}
	}
	return boxes.length === 0 ? diagram.bounds : union(boxes);
}

function annotationContentBox(annotation: SolvedTextAnnotation): Box {
	return {
		x: annotation.box.x + annotation.paddings.left,
		y: annotation.box.y + annotation.paddings.top,
		width: Math.max(
			0,
			annotation.box.width -
				annotation.paddings.left -
				annotation.paddings.right,
		),
		height: Math.max(
			0,
			annotation.box.height -
				annotation.paddings.top -
				annotation.paddings.bottom,
		),
	};
}

/**
 * Rendered text extent of a label, following the exporter contract: a
 * single line is centred on the annotation box, multiple lines are drawn
 * from their solved line boxes (centred on each line box).
 */
function renderedTextBox(annotation: SolvedTextAnnotation): Box | undefined {
	if (annotation.lines.length === 0) return undefined;
	if (annotation.lines.length === 1) {
		const line = annotation.lines[0];
		if (line === undefined) return undefined;
		return {
			x: annotation.box.x + annotation.box.width / 2 - line.width / 2,
			y: annotation.box.y + annotation.box.height / 2 - line.box.height / 2,
			width: line.width,
			height: line.box.height,
		};
	}
	return union(
		annotation.lines.map((line) => ({
			x: annotation.box.x + line.box.x + line.box.width / 2 - line.width / 2,
			y: annotation.box.y + line.box.y,
			width: line.width,
			height: line.box.height,
		})),
	);
}

/** True when all four corners of `inner` lie inside the drawn outline. */
export function boxInsideShape(
	inner: Box,
	shape: NodeShape,
	box: Box,
): boolean {
	const tolerance = 1;
	const corners: Point[] = [
		{ x: inner.x + tolerance, y: inner.y + tolerance },
		{ x: inner.x + inner.width - tolerance, y: inner.y + tolerance },
		{ x: inner.x + tolerance, y: inner.y + inner.height - tolerance },
		{
			x: inner.x + inner.width - tolerance,
			y: inner.y + inner.height - tolerance,
		},
	];
	return corners.every((corner) => pointInsideShape(corner, shape, box));
}

function pointInsideShape(point: Point, shape: NodeShape, box: Box): boolean {
	if (!pointInBox(point, box)) return false;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const u = box.width <= 0 ? 0 : Math.abs(point.x - cx) / (box.width / 2);
	const v = box.height <= 0 ? 0 : Math.abs(point.y - cy) / (box.height / 2);
	switch (shape) {
		case "rectangle":
		case "rounded-rectangle":
			return true;
		case "diamond":
			return u + v <= 1 + 1e-9;
		case "ellipse":
			return u * u + v * v <= 1 + 1e-9;
		case "hexagon": {
			// Pointed left/right: inset shrinks linearly towards the tips.
			const skew = shapeSkew(box);
			const inset = skew * v;
			return (
				point.x >= box.x + inset - 1e-9 &&
				point.x <= box.x + box.width - inset + 1e-9
			);
		}
		case "parallelogram": {
			const skew = shapeSkew(box);
			const fromTop = box.height <= 0 ? 0 : (point.y - box.y) / box.height;
			const left = box.x + skew * (1 - fromTop);
			const right = box.x + box.width - skew * fromTop;
			return point.x >= left - 1e-9 && point.x <= right + 1e-9;
		}
		case "cylinder": {
			// Text must sit below the top cap's front arc and above the bottom arc.
			const ry = cylinderCapRadius(box);
			const du = box.width <= 0 ? 0 : (point.x - cx) / (box.width / 2);
			const arc = ry * Math.sqrt(Math.max(0, 1 - du * du));
			return (
				point.y >= box.y + ry + arc - 1e-9 &&
				point.y <= box.y + box.height - ry + arc + 1e-9
			);
		}
	}
}

function largestEmptyRatio(
	diagram: CoordinatedDiagram,
	canvas: Box,
	resolution: number,
): number {
	if (canvas.width <= 0 || canvas.height <= 0) return 0;
	const columns = resolution;
	const rows = Math.max(
		1,
		Math.round((resolution * canvas.height) / canvas.width),
	);
	const cellWidth = canvas.width / columns;
	const cellHeight = canvas.height / rows;
	const occupied: boolean[][] = Array.from({ length: rows }, () =>
		new Array<boolean>(columns).fill(false),
	);
	const mark = (box: Box): void => {
		const c0 = Math.max(0, Math.floor((box.x - canvas.x) / cellWidth));
		const c1 = Math.min(
			columns - 1,
			Math.floor((box.x + box.width - canvas.x) / cellWidth),
		);
		const r0 = Math.max(0, Math.floor((box.y - canvas.y) / cellHeight));
		const r1 = Math.min(
			rows - 1,
			Math.floor((box.y + box.height - canvas.y) / cellHeight),
		);
		for (let r = r0; r <= r1; r += 1) {
			const row = occupied[r];
			if (row === undefined) continue;
			for (let c = c0; c <= c1; c += 1) row[c] = true;
		}
	};
	for (const node of diagram.nodes) mark(node.box);
	for (const annotation of diagram.textAnnotations ?? []) mark(annotation.box);
	for (const block of [
		...(diagram.matrices ?? []),
		...(diagram.tables ?? []),
		...(diagram.evidencePanels ?? []),
	]) {
		mark(block.box);
	}
	for (const edge of diagram.edges) {
		for (const [a, b] of segments(edge.points)) {
			mark({
				x: Math.min(a.x, b.x),
				y: Math.min(a.y, b.y),
				width: Math.abs(a.x - b.x),
				height: Math.abs(a.y - b.y),
			});
		}
	}
	// Maximal empty rectangle via the histogram / monotonic-stack method.
	const heights = new Array<number>(columns).fill(0);
	let best = 0;
	for (const row of occupied) {
		for (let c = 0; c < columns; c += 1) {
			heights[c] = row[c] ? 0 : (heights[c] ?? 0) + 1;
		}
		const stack: number[] = [];
		for (let c = 0; c <= columns; c += 1) {
			const h = c === columns ? 0 : (heights[c] ?? 0);
			while (stack.length > 0 && (heights[stack.at(-1) ?? 0] ?? 0) >= h) {
				const top = stack.pop() ?? 0;
				const height = heights[top] ?? 0;
				const left = stack.length === 0 ? -1 : (stack.at(-1) ?? 0);
				best = Math.max(best, height * (c - left - 1));
			}
			stack.push(c);
		}
	}
	return best / (rows * columns);
}

function segments(points: readonly Point[]): Array<[Point, Point]> {
	const result: Array<[Point, Point]> = [];
	for (let index = 0; index + 1 < points.length; index += 1) {
		const a = points[index];
		const b = points[index + 1];
		if (a && b) result.push([a, b]);
	}
	return result;
}

function segmentsCross(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
	const aVertical = Math.abs(a0.x - a1.x) < EPSILON;
	const bVertical = Math.abs(b0.x - b1.x) < EPSILON;
	const aHorizontal = Math.abs(a0.y - a1.y) < EPSILON;
	const bHorizontal = Math.abs(b0.y - b1.y) < EPSILON;
	if (!((aVertical && bHorizontal) || (aHorizontal && bVertical))) return false;
	const [v0, v1, h0, h1] = aVertical ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
	return (
		v0.x > Math.min(h0.x, h1.x) + EPSILON &&
		v0.x < Math.max(h0.x, h1.x) - EPSILON &&
		h0.y > Math.min(v0.y, v1.y) + EPSILON &&
		h0.y < Math.max(v0.y, v1.y) - EPSILON
	);
}

function collinearOverlap(a0: Point, a1: Point, b0: Point, b1: Point): number {
	const aVertical = Math.abs(a0.x - a1.x) < EPSILON;
	const bVertical = Math.abs(b0.x - b1.x) < EPSILON;
	const aHorizontal = Math.abs(a0.y - a1.y) < EPSILON;
	const bHorizontal = Math.abs(b0.y - b1.y) < EPSILON;
	if (aVertical && bVertical && Math.abs(a0.x - b0.x) < 1) {
		return Math.max(0, rangeOverlap(a0.y, a1.y, b0.y, b1.y));
	}
	if (aHorizontal && bHorizontal && Math.abs(a0.y - b0.y) < 1) {
		return Math.max(0, rangeOverlap(a0.x, a1.x, b0.x, b1.x));
	}
	return 0;
}

/**
 * Whether an axis-aligned segment enters the drawn outline (not just the
 * bounding box) of a node, sampled every 2 px with a 1 px inset.
 */
function segmentEntersShape(
	a: Point,
	b: Point,
	shape: NodeShape,
	box: Box,
): boolean {
	const inner = insetBox(box, 1);
	const length = Math.hypot(b.x - a.x, b.y - a.y);
	const steps = Math.max(1, Math.ceil(length / 2));
	for (let step = 0; step <= steps; step += 1) {
		const t = step / steps;
		const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		if (pointInsideShape(point, shape, inner)) return true;
	}
	return false;
}

function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
	if (box.width <= 0 || box.height <= 0) return false;
	const minX = Math.min(a.x, b.x);
	const maxX = Math.max(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	const maxY = Math.max(a.y, b.y);
	return (
		maxX > box.x &&
		minX < box.x + box.width &&
		maxY > box.y &&
		minY < box.y + box.height
	);
}

function bendCount(points: readonly Point[]): number {
	let bends = 0;
	for (let index = 1; index + 1 < points.length; index += 1) {
		const prev = points[index - 1];
		const curr = points[index];
		const next = points[index + 1];
		if (!prev || !curr || !next) continue;
		const dx1 = Math.sign(Math.round(curr.x - prev.x));
		const dy1 = Math.sign(Math.round(curr.y - prev.y));
		const dx2 = Math.sign(Math.round(next.x - curr.x));
		const dy2 = Math.sign(Math.round(next.y - curr.y));
		if (dx1 !== dx2 || dy1 !== dy2) bends += 1;
	}
	return bends;
}

function routeLength(points: readonly Point[]): number {
	return sum(
		segments(points).map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y)),
	);
}

function boxGap(a: Box, b: Box): number {
	const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
	const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
	return Math.hypot(dx, dy);
}

function overlapArea(a: Box, b: Box): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): number {
	return (
		Math.min(Math.max(a0, a1), Math.max(b0, b1)) -
		Math.max(Math.min(a0, a1), Math.min(b0, b1))
	);
}

function pointInBox(point: Point, box: Box): boolean {
	return (
		point.x >= box.x - 1e-9 &&
		point.x <= box.x + box.width + 1e-9 &&
		point.y >= box.y - 1e-9 &&
		point.y <= box.y + box.height + 1e-9
	);
}

function insetBox(box: Box, inset: number): Box {
	return {
		x: box.x + inset,
		y: box.y + inset,
		width: Math.max(0, box.width - 2 * inset),
		height: Math.max(0, box.height - 2 * inset),
	};
}

function center(box: Box): Point {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function union(boxes: readonly Box[]): Box {
	const minX = Math.min(...boxes.map((box) => box.x));
	const minY = Math.min(...boxes.map((box) => box.y));
	const maxX = Math.max(...boxes.map((box) => box.x + box.width));
	const maxY = Math.max(...boxes.map((box) => box.y + box.height));
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number {
	return values.length === 0 ? 0 : sum(values) / values.length;
}

function coefficientOfVariation(values: readonly number[]): number {
	if (values.length < 2) return 0;
	const average = mean(values);
	if (average <= 1e-9) return 0;
	const variance = mean(values.map((value) => (value - average) ** 2));
	return Math.sqrt(variance) / average;
}

function round(value: number): number {
	return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}
