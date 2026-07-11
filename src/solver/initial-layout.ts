/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	DEFAULT_FONT,
	DEFAULT_LABEL_MAX_WIDTH,
	DEFAULT_NODE_MIN_SIZE,
	DEFAULT_NODE_PADDING,
} from "../dsl/normalize.js";
import { computeArrowhead } from "../exporters/arrow.js";
import {
	type computeShapeGeometry,
	intersectsAabb,
	normalizeInsets,
	unionBoxes,
} from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { NormalizedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	NormalizedEdge,
	NormalizedNode,
	Swimlane,
} from "../ir/elements.js";
import type { Box, Insets, Point, Size } from "../ir/geometry.js";
import type { LabelLayout } from "../ir/label-layout.js";
import { applyEllipseCircleSize } from "../ir/semantic-roles.js";
import { fitLabel } from "../labels/index.js";
import {
	type InitialLayoutResult,
	runComponentAwareDagreInitialLayout,
	runDagreInitialLayout,
} from "../layout/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import type { TextStyleOptions } from "../text/types.js";
import { labelCjkTypography } from "./cjk-typography.js";
import {
	CROSS_AXIS_SPREAD_THRESHOLD,
	compactDetail,
	isFiniteInitialPoint,
	isValidInitialDimension,
	sameBox,
} from "./helpers.js";
import type { InitialLayoutMode, SolveDiagramOptions } from "./options.js";

// Reuse DSL defaults — these are the same values as DEFAULT_FONT,
// DEFAULT_NODE_PADDING, DEFAULT_NODE_MIN_SIZE, DEFAULT_LABEL_MAX_WIDTH
// imported from normalize.ts above.
export function prefitLabelFont(
	node: NormalizedNode,
	_options: SolveDiagramOptions,
): TextStyleOptions {
	const cjk = labelCjkTypography(node.label?.metadata);
	const fontFamily = cjk.fontFamily ?? DEFAULT_FONT.fontFamily;
	const fontSize = cjk.fontSize ?? DEFAULT_FONT.fontSize;
	const lineHeight =
		fontSize !== DEFAULT_FONT.fontSize
			? Math.max(DEFAULT_FONT.lineHeight ?? 18, fontSize * 1.2)
			: (DEFAULT_FONT.lineHeight ?? 18);
	return { fontFamily, fontSize, lineHeight };
}

export interface LayoutLockLike {
	nodeId: string;
	source: string;
}

export function reportPostGrowthOverlaps(
	before: ReadonlyMap<string, Box>,
	after: ReadonlyMap<string, Box>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const ids = [...after.keys()].sort((a, b) => a.localeCompare(b));
	for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
		const leftId = ids[leftIndex];
		const leftAfter = leftId === undefined ? undefined : after.get(leftId);
		const leftBefore = leftId === undefined ? undefined : before.get(leftId);
		if (leftId === undefined || leftAfter === undefined) continue;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < ids.length;
			rightIndex += 1
		) {
			const rightId = ids[rightIndex];
			const rightAfter = rightId === undefined ? undefined : after.get(rightId);
			const rightBefore =
				rightId === undefined ? undefined : before.get(rightId);
			if (rightId === undefined || rightAfter === undefined) continue;
			if (!intersectsAabb(leftAfter, rightAfter)) continue;
			const overlappedBefore =
				leftBefore !== undefined &&
				rightBefore !== undefined &&
				intersectsAabb(leftBefore, rightBefore);
			if (overlappedBefore) continue;
			const changed =
				leftBefore === undefined ||
				rightBefore === undefined ||
				!sameBox(leftBefore, leftAfter) ||
				!sameBox(rightBefore, rightAfter);
			if (!changed) continue;
			diagnostics.push({
				severity: "warning",
				code: "constraints.overlap.post-growth",
				message: `Anchor-capacity growth introduced overlap between ${leftId} and ${rightId}.`,
				path: ["nodes"],
				detail: compactDetail({
					firstId: leftId,
					secondId: rightId,
					remediationType: "post-growth-repair",
					suggestedRemedy:
						"Increase spacing, relax fixed positions, reduce same-side fanout, or rerun layout with larger page capacity.",
				}),
			});
		}
	}
	return diagnostics;
}

export function growthDeltasFromDiagnostics(
	diagnostics: readonly Diagnostic[],
): Array<{ nodeId: string; deltaWidth: number; deltaHeight: number }> {
	const byNode = new Map<
		string,
		{ nodeId: string; deltaWidth: number; deltaHeight: number }
	>();
	for (const diagnostic of diagnostics) {
		const nodeId =
			typeof diagnostic.detail?.nodeId === "string" &&
			diagnostic.detail.nodeId.length > 0
				? diagnostic.detail.nodeId
				: typeof diagnostic.detail?.childId === "string" &&
						diagnostic.detail.childId.length > 0
					? diagnostic.detail.childId
					: undefined;
		if (nodeId === undefined) {
			continue;
		}
		const deltaWidth =
			typeof diagnostic.detail?.deltaWidth === "number"
				? diagnostic.detail.deltaWidth
				: 0;
		const deltaHeight =
			typeof diagnostic.detail?.deltaHeight === "number"
				? diagnostic.detail.deltaHeight
				: 0;
		if (deltaWidth <= 0 && deltaHeight <= 0) {
			const requiredSpan =
				typeof diagnostic.detail?.requiredSpan === "number"
					? diagnostic.detail.requiredSpan
					: undefined;
			const availableSpan =
				typeof diagnostic.detail?.availableSpan === "number"
					? diagnostic.detail.availableSpan
					: undefined;
			const side =
				typeof diagnostic.detail?.side === "string"
					? diagnostic.detail.side
					: undefined;
			if (
				requiredSpan === undefined ||
				availableSpan === undefined ||
				side === undefined
			) {
				continue;
			}
			const expansion = Math.max(0, requiredSpan - availableSpan);
			if (expansion <= 0) continue;
			const existing = byNode.get(nodeId) ?? {
				nodeId,
				deltaWidth: 0,
				deltaHeight: 0,
			};
			if (side === "left" || side === "right") {
				existing.deltaHeight = Math.max(existing.deltaHeight, expansion);
			} else {
				existing.deltaWidth = Math.max(existing.deltaWidth, expansion);
			}
			byNode.set(nodeId, existing);
			continue;
		}
		const existing = byNode.get(nodeId) ?? {
			nodeId,
			deltaWidth: 0,
			deltaHeight: 0,
		};
		existing.deltaWidth = Math.max(existing.deltaWidth, deltaWidth);
		existing.deltaHeight = Math.max(existing.deltaHeight, deltaHeight);
		byNode.set(nodeId, existing);
	}
	return [...byNode.values()]
		.filter((delta) => delta.deltaWidth > 0 || delta.deltaHeight > 0)
		.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function capacityFromDiagnostics(
	diagnostics: readonly Diagnostic[],
): { required: number; available: number } | undefined {
	let required: number | undefined;
	let available: number | undefined;
	for (const diagnostic of diagnostics) {
		const detailRequired = diagnostic.detail?.required;
		const detailAvailable = diagnostic.detail?.available;
		if (typeof detailRequired === "number") {
			required =
				required === undefined
					? detailRequired
					: Math.max(required, detailRequired);
		}
		if (typeof detailAvailable === "number") {
			available =
				available === undefined
					? detailAvailable
					: Math.min(available, detailAvailable);
		}
	}
	if (required === undefined || available === undefined) {
		return undefined;
	}
	return { required, available };
}

export function runInitialLayout(input: {
	mode: InitialLayoutMode;
	componentAware: boolean;
	direction: NormalizedDiagram["direction"];
	nodes: readonly NormalizedNode[];
	edges: readonly NormalizedEdge[];
}): InitialLayoutResult {
	if (input.mode === "positions") {
		return runPositionSeededInitialLayout(input);
	}

	const runAutoLayout = input.componentAware
		? runComponentAwareDagreInitialLayout
		: runDagreInitialLayout;
	return runAutoLayout({
		direction: input.direction,
		nodes: input.nodes.map((node) => ({ id: node.id, size: node.size })),
		edges: input.edges.map((edge) => ({
			id: edge.id,
			sourceId: edge.source.nodeId,
			targetId: edge.target.nodeId,
		})),
	});
}

export function runPositionSeededInitialLayout(input: {
	direction: NormalizedDiagram["direction"];
	nodes: readonly NormalizedNode[];
	edges: readonly NormalizedEdge[];
}): InitialLayoutResult {
	const diagnostics: Diagnostic[] = [];
	const boxes = new Map<string, Box>();
	const autoNodes: NormalizedNode[] = [];

	for (const node of input.nodes) {
		if (
			!isValidInitialDimension(node.size.width) ||
			!isValidInitialDimension(node.size.height)
		) {
			diagnostics.push({
				severity: "error",
				code: "layout.node-size.invalid",
				message: `Node ${node.id} has invalid layout dimensions.`,
				path: ["nodes", node.id, "size"],
				detail: { nodeId: node.id },
			});
			continue;
		}

		if (node.position === undefined) {
			diagnostics.push({
				severity: "warning",
				code: "layout.positions.missing",
				message: `Node ${node.id} is missing a seeded position; Dagre fallback placement was used.`,
				path: ["nodes", node.id, "position"],
				detail: { nodeId: node.id },
			});
			autoNodes.push(node);
			continue;
		}

		if (!isFiniteInitialPoint(node.position)) {
			diagnostics.push({
				severity: "error",
				code: "layout.node-position.invalid",
				message: `Node ${node.id} has an invalid seeded position.`,
				path: ["nodes", node.id, "position"],
				detail: { nodeId: node.id },
			});
			continue;
		}

		boxes.set(node.id, {
			x: node.position.x,
			y: node.position.y,
			width: node.size.width,
			height: node.size.height,
		});
	}

	if (autoNodes.length === 0) {
		return { boxes, diagnostics };
	}

	const autoNodeIds = new Set(autoNodes.map((node) => node.id));
	const autoLayout = runComponentAwareDagreInitialLayout({
		direction: input.direction,
		nodes: autoNodes.map((node) => ({ id: node.id, size: node.size })),
		edges: input.edges
			.filter(
				(edge) =>
					autoNodeIds.has(edge.source.nodeId) &&
					autoNodeIds.has(edge.target.nodeId),
			)
			.map((edge) => ({
				id: edge.id,
				sourceId: edge.source.nodeId,
				targetId: edge.target.nodeId,
			})),
	});
	diagnostics.push(...autoLayout.diagnostics);
	for (const [id, box] of autoLayout.boxes) {
		boxes.set(id, box);
	}

	return { boxes, diagnostics };
}

export function prefitNodeLabelSize(
	node: NormalizedNode,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): NormalizedNode {
	if (node.label === undefined) {
		return node;
	}
	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
	const layout = fitLabel(
		node.label.text,
		{
			font: prefitLabelFont(node, options),
			padding: DEFAULT_NODE_PADDING,
			minSize: DEFAULT_NODE_MIN_SIZE,
			maxWidth:
				node.label.maxWidth ??
				Math.max(node.size.width, DEFAULT_LABEL_MAX_WIDTH),
			overflow: "diagnose",
		},
		measurer,
	);
	let width = Math.max(node.size.width, layout.fittedSize.width);
	let height = Math.max(node.size.height, layout.fittedSize.height);
	if (node.shape === "ellipse") {
		const circle = applyEllipseCircleSize({ width, height });
		width = circle.width;
		height = circle.height;
	}
	const resized = width !== node.size.width || height !== node.size.height;
	if (resized) {
		diagnostics.push({
			severity: "info",
			code: "prefit_label_resized",
			message: `Node ${node.id} size expanded to fit its label.`,
			path: ["nodes", node.id],
			detail: {
				nodeId: node.id,
				from: { width: node.size.width, height: node.size.height },
				to: { width, height },
			},
		});
	}
	// Center the label layout within the node dimensions so the
	// annotation is visually centered even when the node is larger
	// than what the label text requires (codex P2).
	const centeredLayout = expandLabelLayoutToNode(layout, { width, height });
	return { ...node, size: { width, height }, labelLayout: centeredLayout };
}
export function expandLabelLayoutToNode(
	layout: LabelLayout,
	nodeSize: Size,
): LabelLayout {
	if (
		layout.box.width >= nodeSize.width &&
		layout.box.height >= nodeSize.height
	) {
		return layout;
	}
	const offsetX = Math.max(0, (nodeSize.width - layout.box.width) / 2);
	const offsetY = Math.max(0, (nodeSize.height - layout.box.height) / 2);
	if (offsetX === 0 && offsetY === 0) {
		return layout;
	}
	return {
		...layout,
		box: {
			x: layout.box.x + offsetX,
			y: layout.box.y + offsetY,
			width: layout.box.width,
			height: layout.box.height,
		},
	};
}

export function wrapVerticalStackIfNeeded(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	edges: readonly NormalizedEdge[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): Map<string, Box> {
	const wrapped = new Map([...boxes].map(([id, box]) => [id, { ...box }]));
	const maxStackDepth = options.maxStackDepth;
	if (
		maxStackDepth === undefined ||
		maxStackDepth <= 0 ||
		nodes.length <= maxStackDepth
	) {
		reportVerticalRunaway(
			wrapped,
			nodes,
			edges,
			direction,
			options,
			diagnostics,
		);
		return wrapped;
	}
	if (edges.length > 0 || !isStackRunaway(wrapped, nodes, direction, options)) {
		reportVerticalRunaway(
			wrapped,
			nodes,
			edges,
			direction,
			options,
			diagnostics,
		);
		return wrapped;
	}

	const ordered = nodes
		.map((node) => ({ node, box: wrapped.get(node.id) }))
		.filter(
			(item): item is { node: NormalizedNode; box: Box } =>
				item.box !== undefined,
		)
		.sort((a, b) => {
			const delta = a.box.y - b.box.y;
			return delta === 0 ? a.node.id.localeCompare(b.node.id) : delta;
		});
	const columns = Math.ceil(ordered.length / maxStackDepth);
	const horizontalGap = options.overlapSpacing ?? 40;
	const verticalGap = Math.max(24, horizontalGap / 2);
	const columnWidths = Array.from({ length: columns }, (_, column) =>
		Math.max(
			0,
			...ordered
				.slice(column * maxStackDepth, (column + 1) * maxStackDepth)
				.map((item) => item.box.width),
		),
	);
	const startX = Math.min(...ordered.map((item) => item.box.x));
	const startY = Math.min(...ordered.map((item) => item.box.y));
	let columnX = startX;
	for (let column = 0; column < columns; column += 1) {
		let y = startY;
		const items = ordered.slice(
			column * maxStackDepth,
			(column + 1) * maxStackDepth,
		);
		for (const item of items) {
			wrapped.set(item.node.id, { ...item.box, x: columnX, y });
			y += item.box.height + verticalGap;
		}
		columnX += (columnWidths[column] ?? 0) + horizontalGap;
	}
	diagnostics.push({
		severity: "warning",
		code: "vertical_runaway",
		message: `Single-column layout exceeded maxStackDepth ${maxStackDepth}; wrapped into ${columns} columns.`,
		path: ["nodes"],
		detail: { nodeCount: ordered.length, maxStackDepth, columns },
	});
	return wrapped;
}

/**
 * Wrap a TB/BT single horizontal row into multiple rows when
 * the layout exceeds maxRowDepth or targetAspectRatio (Issue #60).
 * Mirror of wrapVerticalStackIfNeeded for vertical layouts.
 */
export function wrapHorizontalStackIfNeeded(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): Map<string, Box> {
	if (!isStackRunaway(boxes, nodes, direction, options)) {
		return new Map(boxes);
	}
	let maxRowDepth = options.maxRowDepth;
	if (
		maxRowDepth === undefined ||
		maxRowDepth <= 0 ||
		nodes.length <= maxRowDepth
	) {
		// When called with only targetAspectRatio (no maxRowDepth),
		// derive a row depth so the rewrap is not silently skipped
		// (Issue #61 codex P2).
		if (maxRowDepth === undefined && options.targetAspectRatio !== undefined) {
			maxRowDepth = Math.ceil(Math.sqrt(nodes.length));
			if (nodes.length <= maxRowDepth) return new Map(boxes);
		} else {
			return new Map(boxes);
		}
	}
	const ordered = [...nodes].sort((a, b) => {
		const ba = boxes.get(a.id);
		const bb = boxes.get(b.id);
		if (ba === undefined || bb === undefined) return 0;
		const dx = ba.x - bb.x;
		return dx !== 0 ? dx : ba.y - bb.y;
	});
	const rows = Math.ceil(ordered.length / maxRowDepth);
	const wrapped = new Map(boxes);
	const rowSpacing = options.overlapSpacing ?? 40;
	let minX = Infinity;
	let minY = Infinity;
	let maxH = 0;
	for (const n of ordered) {
		const b = boxes.get(n.id);
		if (b !== undefined) {
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxH = Math.max(maxH, b.height);
		}
	}
	for (let ri = 0; ri < rows; ri++) {
		const rowNodes = ordered.slice(ri * maxRowDepth, (ri + 1) * maxRowDepth);
		let x = minX;
		const y = minY + ri * (maxH + rowSpacing);
		for (const node of rowNodes) {
			const box = boxes.get(node.id);
			if (box === undefined) continue;
			wrapped.set(node.id, { ...box, x, y });
			x += box.width + rowSpacing;
		}
	}
	diagnostics.push({
		severity: "warning",
		code: "horizontal_runaway",
		message: `Single-row layout exceeded maxRowDepth ${maxRowDepth}; wrapped into ${rows} rows.`,
		path: ["nodes"],
		detail: { nodeCount: ordered.length, maxRowDepth, rows },
	});
	return wrapped;
}

export function reportVerticalRunaway(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	edges: readonly NormalizedEdge[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	if (!isStackRunaway(boxes, nodes, direction, options)) {
		return;
	}
	diagnostics.push({
		severity: "warning",
		code: "vertical_runaway",
		message:
			"Layout produced a tall vertical stack beyond the preferred aspect ratio.",
		path: ["nodes"],
		detail: {
			nodeCount: nodes.length,
			edgeCount: edges.length,
			...(options.preferredAspectRatio === undefined
				? {}
				: { preferredAspectRatio: options.preferredAspectRatio }),
			...(options.maxStackDepth === undefined
				? {}
				: { maxStackDepth: options.maxStackDepth }),
		},
	});
}

/**
 * Detect stack runaway in either direction.
 * For LR/RL: height/width > preferred (vertical runaway).
 * For TB/BT: width/height > preferred (horizontal runaway, Issue #60).
 */
export function isStackRunaway(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): boolean {
	if (
		options.maxStackDepth === undefined &&
		options.preferredAspectRatio === undefined &&
		options.targetAspectRatio === undefined &&
		options.maxRowDepth === undefined
	) {
		return false;
	}
	if (nodes.length < 2) {
		return false;
	}
	const nodeBoxes = nodes
		.map((node) => boxes.get(node.id))
		.filter((box): box is Box => box !== undefined);
	if (nodeBoxes.length < 2) {
		return false;
	}
	const bounds = unionBoxes(nodeBoxes);

	const isHorizontal = direction === "TB" || direction === "BT";
	const aspectRatio = isHorizontal
		? bounds.height <= 0
			? Number.POSITIVE_INFINITY
			: bounds.width / bounds.height
		: bounds.width <= 0
			? Number.POSITIVE_INFINITY
			: bounds.height / bounds.width;
	const preferred = isHorizontal
		? (options.targetAspectRatio ?? options.preferredAspectRatio ?? 3)
		: (options.preferredAspectRatio ?? 3);
	if (
		(options.preferredAspectRatio !== undefined ||
			options.targetAspectRatio !== undefined) &&
		aspectRatio < preferred
	) {
		return false;
	}

	if (isHorizontal) {
		// TB/BT: check y-spread vs maxHeight (single row runaway).
		const yCenters = nodeBoxes.map((box) => box.y + box.height / 2);
		const ySpread = Math.max(...yCenters) - Math.min(...yCenters);
		const maxHeight = Math.max(...nodeBoxes.map((box) => box.height));
		return ySpread <= Math.max(maxHeight, options.overlapSpacing ?? 40);
	}

	// LR/RL: check x-spread vs maxWidth (single column runaway).
	const xCenters = nodeBoxes.map((box) => box.x + box.width / 2);
	const xSpread = Math.max(...xCenters) - Math.min(...xCenters);
	const maxWidth = Math.max(...nodeBoxes.map((box) => box.width));
	return xSpread <= Math.max(maxWidth, options.overlapSpacing ?? 40);
}

export function maxVerticalRankStackHeight(
	swimlane: Swimlane,
	nodeBoxes: ReadonlyMap<string, Box>,
	flowRanks: ReadonlyMap<string, number>,
	gap: number,
): number {
	let maxHeight = 0;
	for (const lane of swimlane.lanes) {
		for (const stack of rankStacks(
			lane.children,
			nodeBoxes,
			flowRanks,
		).values()) {
			const height = stack.reduce(
				(total, item, index) =>
					total + item.box.height + (index === 0 ? 0 : gap),
				0,
			);
			maxHeight = Math.max(maxHeight, height);
		}
	}
	return maxHeight;
}

// Width a single rank's children occupy when spread horizontally: sum of
// widths plus inter-child gaps. Used both to pre-size the lane slot and to
// lay the children out, so geometry stays consistent (Codex P2).
export function crossAxisSpreadWidth(
	items: ReadonlyArray<{ box: Box }>,
	gap: number,
): number {
	return items.reduce(
		(sum, item, index) => sum + item.box.width + (index === 0 ? 0 : gap),
		0,
	);
}

// Largest cross-axis spread width across all lanes/ranks of a swimlane.
// Returns 0 when no rank meets the spread threshold. Locked children are
// excluded (they never participate in distribution). Lanes whose children
// are covered by a containment constraint are also excluded — they will use
// moveLaneChildren (pure offset) instead of cross-axis spread (Issue #66).
export function maxCrossAxisSpreadWidth(
	swimlane: Swimlane,
	nodeBoxes: ReadonlyMap<string, Box>,
	flowRanks: ReadonlyMap<string, number>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	gap: number,
	containedChildIds?: ReadonlySet<string>,
): number {
	let maxWidth = 0;
	for (const lane of swimlane.lanes) {
		// Skip lanes covered by containment constraints — they won't spread.
		if (
			containedChildIds !== undefined &&
			lane.children.some((childId) => containedChildIds.has(childId))
		) {
			continue;
		}
		for (const stack of rankStacks(
			lane.children,
			nodeBoxes,
			flowRanks,
		).values()) {
			const unlocked = stack.filter((item) => !locks.has(item.childId));
			if (unlocked.length < CROSS_AXIS_SPREAD_THRESHOLD) continue;
			maxWidth = Math.max(maxWidth, crossAxisSpreadWidth(unlocked, gap));
		}
	}
	return maxWidth;
}

export function rankStacks(
	childIds: readonly string[],
	nodeBoxes: ReadonlyMap<string, Box>,
	flowRanks: ReadonlyMap<string, number>,
): Map<number, Array<{ childId: string; box: Box }>> {
	const stacks = new Map<number, Array<{ childId: string; box: Box }>>();
	for (const childId of childIds) {
		const box = nodeBoxes.get(childId);
		if (box === undefined) {
			continue;
		}
		const rank = flowRanks.get(childId) ?? 0;
		const stack = stacks.get(rank) ?? [];
		stack.push({ childId, box });
		stacks.set(rank, stack);
	}
	for (const stack of stacks.values()) {
		stack.sort((a, b) => {
			const deltaY = a.box.y - b.box.y;
			return deltaY === 0 ? a.childId.localeCompare(b.childId) : deltaY;
		});
	}
	return stacks;
}

export function framePadding(
	value: NonNullable<NormalizedDiagram["frame"]>["padding"],
): Insets {
	return normalizeInsets(value ?? 32);
}

export function edgeBounds(edges: readonly CoordinatedEdge[]): Box[] {
	return edges.flatMap((edge) => {
		if (edge.points.length === 0) {
			return [];
		}
		// Include the rendered arrowhead polygon (tip/left/right) so page
		// overflow accounts for geometry that extends past the route points.
		const extraPoints: Point[] = [];
		if (edge.points.length >= 2) {
			const arrowhead = computeArrowhead(edge.points);
			extraPoints.push(arrowhead.tip, arrowhead.left, arrowhead.right);
		}
		const allPoints = [...edge.points, ...extraPoints];
		const minX = Math.min(...allPoints.map((point) => point.x));
		const minY = Math.min(...allPoints.map((point) => point.y));
		const maxX = Math.max(...allPoints.map((point) => point.x));
		const maxY = Math.max(...allPoints.map((point) => point.y));
		return [
			{
				x: minX,
				y: minY,
				width: maxX - minX,
				height: maxY - minY,
			},
		];
	});
}

export function isSameRankEdge(
	source: ReturnType<typeof computeShapeGeometry>,
	target: ReturnType<typeof computeShapeGeometry>,
	direction: NormalizedDiagram["direction"],
): boolean {
	const dx = Math.abs(target.center.x - source.center.x);
	const dy = Math.abs(target.center.y - source.center.y);
	const maxHeight = Math.max(source.box.height, target.box.height);
	const maxWidth = Math.max(source.box.width, target.box.width);
	return direction === "LR" || direction === "RL"
		? dx >= maxWidth && dy <= maxHeight * 1.5
		: dy >= maxHeight && dx <= maxWidth * 1.5;
}
