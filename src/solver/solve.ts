import { applyLayoutConstraints } from "../constraints/index.js";
import {
	computeContainerGeometry,
	computeShapeGeometry,
	intersectsAabb,
	unionBoxes,
} from "../geometry/index.js";
import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedNode,
	CoordinatedPort,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
} from "../ir/elements.js";
import type { Box, Insets, Point } from "../ir/geometry.js";
import type {
	LabelLayout,
	SolvedTextAnnotation,
	TextSurfaceKind,
} from "../ir/label-layout.js";
import { fitLabel } from "../labels/index.js";
import { runDagreInitialLayout } from "../layout/index.js";
import { type RouteKind, routeEdge } from "../routing/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";

export interface SolveDiagramOptions {
	routeKind?: RouteKind;
	obstacleMargin?: number | Insets;
	overlapSpacing?: number;
	portShifting?: PortShiftingOptions;
}

export interface PortShiftingOptions {
	enabled?: boolean;
	spacing?: number;
}

interface SwimlaneContractLayout {
	box: Box;
	slotWidth: number;
	slotHeight: number;
}

interface SwimlaneContractResult {
	layouts: Map<string, SwimlaneContractLayout>;
	diagnostics: Diagnostic[];
	movedChildIds: Set<string>;
}

interface LayoutLockLike {
	nodeId: string;
	source: string;
}

export function solveDiagram(
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions = {},
): CoordinatedDiagram {
	const diagnostics: Diagnostic[] = [...diagram.diagnostics];
	const nodes = stableById(diagram.nodes);
	const edges = stableById(diagram.edges);
	const groups = stableById(diagram.groups);
	const constraints = stableByConstraintId(diagram.constraints);
	const layout = runDagreInitialLayout({
		direction: diagram.direction,
		nodes: nodes.map((node) => ({ id: node.id, size: node.size })),
		edges: edges.map((edge) => ({
			id: edge.id,
			sourceId: edge.source.nodeId,
			targetId: edge.target.nodeId,
		})),
	});

	diagnostics.push(...layout.diagnostics);

	const constrained = applyLayoutConstraints({
		direction: diagram.direction,
		overlapSpacing: options?.overlapSpacing ?? 40,
		boxes: layout.boxes,
		nodes,
		groups,
		constraints,
	});

	diagnostics.push(...constrained.diagnostics);
	const swimlaneContracts = applySwimlaneLayoutContracts(
		diagram.swimlanes ?? [],
		constraints,
		edges,
		isTopToBottomReadingDirection(diagram.metadata?.primaryReadingDirection),
		constrained.boxes,
		constrained.locks,
		options?.overlapSpacing ?? 40,
	);
	if (swimlaneContracts.layouts.size > 0) {
		removeResolvedOverlapDiagnostics(diagnostics, constrained.boxes);
	}
	diagnostics.push(...swimlaneContracts.diagnostics);

	const coordinatedNodes = coordinateNodes(
		nodes,
		constrained.boxes,
		options,
		diagnostics,
	);
	const nodeGeometryById = new Map(
		coordinatedNodes.map((node) => [
			node.id,
			computeShapeGeometry({
				shape: node.shape,
				box: node.box,
				obstacleMargin: options.obstacleMargin ?? 0,
			}),
		]),
	);
	const coordinatedGroups = coordinateGroups(
		groups,
		constrained.boxes,
		options,
		diagnostics,
	);
	const coordinatedSwimlanes = coordinateSwimlanes(
		diagram.swimlanes ?? [],
		constrained.boxes,
		swimlaneContracts.layouts,
	);
	const groupBoxes = new Map(
		coordinatedGroups.map((group) => [group.id, group.box]),
	);
	const baseTextAnnotations = coordinateBaseTextAnnotations({
		nodes: coordinatedNodes,
		groups: coordinatedGroups,
		swimlanes: coordinatedSwimlanes,
	});
	const allBoxes = [
		...coordinatedNodes.map((node) => node.box),
		...coordinatedNodes.flatMap((node) =>
			(node.ports ?? []).flatMap((port) =>
				port.label === undefined ? [port.box] : [port.box, portLabelBox(port)],
			),
		),
		...groupBoxes.values(),
		...coordinatedSwimlanes.flatMap((swimlane) =>
			swimlane.box === undefined ? [] : [swimlane.box],
		),
		...baseTextAnnotations.map((annotation) => annotation.box),
	];
	const contentBounds =
		allBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(allBoxes);
	const frame =
		diagram.frame === undefined
			? undefined
			: coordinateFrame(diagram.frame, contentBounds);
	const frameTextAnnotation =
		frame === undefined ? [] : [coordinateFrameTextAnnotation(frame)];
	const coordinatedEdges = coordinateEdges(
		edges,
		nodeGeometryById,
		coordinatedNodes,
		[...nodeGeometryById.values()].map((geometry) => geometry.obstacleBox),
		diagram.direction,
		options,
		diagnostics,
	);
	const edgeTextAnnotations = coordinateEdgeTextAnnotations(coordinatedEdges);
	const textAnnotations = [
		...baseTextAnnotations,
		...frameTextAnnotation,
		...edgeTextAnnotations,
	];

	return {
		id: diagram.id,
		...(diagram.title === undefined ? {} : { title: diagram.title }),
		direction: diagram.direction,
		nodes: coordinatedNodes,
		edges: coordinatedEdges,
		groups: coordinatedGroups,
		...(coordinatedSwimlanes.length === 0
			? {}
			: { swimlanes: coordinatedSwimlanes }),
		diagnostics,
		bounds:
			frame === undefined
				? unionBoxes([
						contentBounds,
						...edgeTextAnnotations.map((annotation) => annotation.box),
					])
				: unionBoxes([
						contentBounds,
						frame.box,
						frame.titleBox,
						...edgeTextAnnotations.map((annotation) => annotation.box),
					]),
		...(frame === undefined ? {} : { frame }),
		...(textAnnotations.length === 0 ? {} : { textAnnotations }),
		...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
	};
}

function applySwimlaneLayoutContracts(
	swimlanes: readonly Swimlane[],
	constraints: readonly Constraint[],
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	overlapSpacing: number,
): SwimlaneContractResult {
	const layouts = new Map<string, SwimlaneContractLayout>();
	const diagnostics: Diagnostic[] = [];
	const movedChildIds = new Set<string>();
	for (const swimlane of swimlanes) {
		if ((swimlane.layout ?? "overlay") !== "contract") {
			continue;
		}
		if (swimlane.lanes.length === 0) {
			continue;
		}
		const layout = applySingleSwimlaneContract(
			swimlane,
			edges,
			topToBottomFlow,
			nodeBoxes,
			locks,
			diagnostics,
			movedChildIds,
		);
		if (layout !== undefined) {
			layouts.set(swimlane.id, layout);
		}
	}
	if (layouts.size > 0) {
		diagnostics.push(
			...reportSwimlaneOverlaps(nodeBoxes, locks, overlapSpacing),
			...reportSwimlaneConstraintInvalidations(
				constraints,
				nodeBoxes,
				movedChildIds,
			),
		);
	}
	return { layouts, diagnostics, movedChildIds };
}

function applySingleSwimlaneContract(
	swimlane: Swimlane,
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
): SwimlaneContractLayout | undefined {
	const headerHeight = swimlane.headerHeight ?? 28;
	const padding = swimlane.padding ?? 16;
	const laneBounds = swimlane.lanes.map((lane) => {
		const childBoxes = lane.children
			.map((child) => nodeBoxes.get(child))
			.filter((box): box is Box => box !== undefined);
		return childBoxes.length === 0 ? undefined : unionBoxes(childBoxes);
	});
	const populatedBounds = laneBounds.filter(
		(box): box is Box => box !== undefined,
	);
	if (populatedBounds.length === 0) {
		return undefined;
	}

	if (swimlane.orientation === "vertical") {
		return applyVerticalSwimlaneContract(
			swimlane,
			edges,
			topToBottomFlow,
			nodeBoxes,
			laneBounds,
			headerHeight,
			padding,
			locks,
			diagnostics,
			movedChildIds,
		);
	}
	return applyHorizontalSwimlaneContract(
		swimlane,
		nodeBoxes,
		laneBounds,
		headerHeight,
		padding,
		locks,
		diagnostics,
		movedChildIds,
	);
}

function applyVerticalSwimlaneContract(
	swimlane: Swimlane,
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	laneBounds: ReadonlyArray<Box | undefined>,
	headerHeight: number,
	padding: number,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
): SwimlaneContractLayout {
	const populatedBounds = laneBounds.filter(
		(box): box is Box => box !== undefined,
	);
	const top = Math.min(...populatedBounds.map((box) => box.y));
	const left = Math.min(...populatedBounds.map((box) => box.x));
	const maxChildHeight = Math.max(...populatedBounds.map((box) => box.height));
	const flowRanks = topToBottomFlow
		? rankVerticalSwimlaneChildren(swimlane, edges)
		: new Map<string, number>();
	const maxRank =
		flowRanks.size === 0 ? 0 : Math.max(...Array.from(flowRanks.values()));
	const rankStackGap = Math.max(8, padding / 2);
	const maxRankStackHeight = maxVerticalRankStackHeight(
		swimlane,
		nodeBoxes,
		flowRanks,
		rankStackGap,
	);
	const rankSpacing = Math.max(96, maxRankStackHeight + padding);
	const contentHeight =
		maxRank === 0 ? maxChildHeight : maxRankStackHeight + maxRank * rankSpacing;
	const slotWidth =
		Math.max(...populatedBounds.map((box) => box.width)) + padding * 2;
	const laneContentTop = top + headerHeight + padding;

	for (let index = 0; index < swimlane.lanes.length; index += 1) {
		const lane = swimlane.lanes[index];
		const bounds = laneBounds[index];
		if (lane === undefined || bounds === undefined) {
			continue;
		}
		const target = {
			x: left + slotWidth * index + padding,
			y: laneContentTop,
		};
		if (maxRank === 0) {
			moveLaneChildren(
				lane.children,
				nodeBoxes,
				locks,
				diagnostics,
				movedChildIds,
				{
					x: target.x - bounds.x,
					y: target.y - bounds.y,
				},
			);
			continue;
		}
		moveRankedVerticalLaneChildren(
			lane.children,
			nodeBoxes,
			locks,
			diagnostics,
			movedChildIds,
			flowRanks,
			rankSpacing,
			rankStackGap,
			{
				x: target.x - bounds.x,
				y: laneContentTop,
			},
		);
	}

	return {
		box: {
			x: left,
			y: top,
			width: slotWidth * swimlane.lanes.length,
			height: contentHeight + padding * 2 + headerHeight,
		},
		slotWidth,
		slotHeight: contentHeight + padding * 2 + headerHeight,
	};
}

function isTopToBottomReadingDirection(value: unknown): boolean {
	return value === "top_to_bottom" || value === "top-to-bottom";
}

function rankVerticalSwimlaneChildren(
	swimlane: Swimlane,
	edges: readonly NormalizedEdge[],
): Map<string, number> {
	const childOrder = new Map<string, number>();
	for (const lane of swimlane.lanes) {
		for (const childId of lane.children) {
			if (!childOrder.has(childId)) {
				childOrder.set(childId, childOrder.size);
			}
		}
	}
	if (childOrder.size === 0) {
		return new Map();
	}

	const childIds = new Set(childOrder.keys());
	const relevantEdges = edges.filter(
		(edge) =>
			childIds.has(edge.source.nodeId) &&
			childIds.has(edge.target.nodeId) &&
			edge.source.nodeId !== edge.target.nodeId,
	);
	if (relevantEdges.length === 0) {
		return new Map();
	}

	const ranks = new Map([...childIds].map((id) => [id, 0]));
	const outgoing = new Map<string, string[]>();
	const inDegree = new Map([...childIds].map((id) => [id, 0]));
	for (const edge of relevantEdges) {
		const targets = outgoing.get(edge.source.nodeId) ?? [];
		targets.push(edge.target.nodeId);
		outgoing.set(edge.source.nodeId, targets);
		inDegree.set(
			edge.target.nodeId,
			(inDegree.get(edge.target.nodeId) ?? 0) + 1,
		);
	}

	const queue = [...childIds]
		.filter((id) => (inDegree.get(id) ?? 0) === 0)
		.sort((a, b) => (childOrder.get(a) ?? 0) - (childOrder.get(b) ?? 0));
	let visited = 0;
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const sourceId = queue[cursor];
		if (sourceId === undefined) {
			continue;
		}
		visited += 1;
		for (const targetId of outgoing.get(sourceId) ?? []) {
			ranks.set(
				targetId,
				Math.max(ranks.get(targetId) ?? 0, (ranks.get(sourceId) ?? 0) + 1),
			);
			const nextInDegree = (inDegree.get(targetId) ?? 0) - 1;
			inDegree.set(targetId, nextInDegree);
			if (nextInDegree === 0) {
				queue.push(targetId);
			}
		}
	}

	return visited === childIds.size
		? ranks
		: rankCyclicSwimlaneChildren(childIds, relevantEdges);
}

function rankCyclicSwimlaneChildren(
	childIds: ReadonlySet<string>,
	edges: readonly NormalizedEdge[],
): Map<string, number> {
	const maxRank = Math.max(0, childIds.size - 1);
	const ranks = new Map([...childIds].map((id) => [id, 0]));
	for (let iteration = 0; iteration < childIds.size; iteration += 1) {
		let changed = false;
		for (const edge of edges) {
			const nextRank = Math.min(
				maxRank,
				(ranks.get(edge.source.nodeId) ?? 0) + 1,
			);
			if (nextRank > (ranks.get(edge.target.nodeId) ?? 0)) {
				ranks.set(edge.target.nodeId, nextRank);
				changed = true;
			}
		}
		if (!changed) {
			break;
		}
	}
	return ranks;
}

function maxVerticalRankStackHeight(
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

function moveRankedVerticalLaneChildren(
	childIds: readonly string[],
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	flowRanks: ReadonlyMap<string, number>,
	rankSpacing: number,
	rankStackGap: number,
	target: Point,
): void {
	for (const [rank, stack] of rankStacks(childIds, nodeBoxes, flowRanks)) {
		let yOffset = 0;
		for (const item of stack) {
			const { childId, box } = item;
			if (locks.has(childId)) {
				diagnostics.push({
					severity: "warning",
					code: "constraints.locked-target-not-moved",
					message: `Locked child ${childId} was not moved into contract swimlane slot.`,
					path: ["swimlanes"],
					detail: { nodeId: childId },
				});
				continue;
			}
			const next = {
				...box,
				x: box.x + target.x,
				y: target.y + rank * rankSpacing + yOffset,
			};
			if (next.x !== box.x || next.y !== box.y) {
				movedChildIds.add(childId);
			}
			nodeBoxes.set(childId, next);
			yOffset += box.height + rankStackGap;
		}
	}
}

function rankStacks(
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

function applyHorizontalSwimlaneContract(
	swimlane: Swimlane,
	nodeBoxes: Map<string, Box>,
	laneBounds: ReadonlyArray<Box | undefined>,
	headerHeight: number,
	padding: number,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
): SwimlaneContractLayout {
	const populatedBounds = laneBounds.filter(
		(box): box is Box => box !== undefined,
	);
	const top = Math.min(...populatedBounds.map((box) => box.y));
	const left = Math.min(...populatedBounds.map((box) => box.x));
	const slotWidth =
		Math.max(...populatedBounds.map((box) => box.width)) +
		headerHeight +
		padding * 2;
	const slotHeight =
		Math.max(...populatedBounds.map((box) => box.height)) + padding * 2;

	for (let index = 0; index < swimlane.lanes.length; index += 1) {
		const lane = swimlane.lanes[index];
		const bounds = laneBounds[index];
		if (lane === undefined || bounds === undefined) {
			continue;
		}
		const target = {
			x: left + headerHeight + padding,
			y: top + slotHeight * index + padding,
		};
		moveLaneChildren(
			lane.children,
			nodeBoxes,
			locks,
			diagnostics,
			movedChildIds,
			{
				x: target.x - bounds.x,
				y: target.y - bounds.y,
			},
		);
	}

	return {
		box: {
			x: left,
			y: top,
			width: slotWidth,
			height: slotHeight * swimlane.lanes.length,
		},
		slotWidth,
		slotHeight,
	};
}

function moveLaneChildren(
	childIds: readonly string[],
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	offset: Point,
): void {
	for (const childId of childIds) {
		const box = nodeBoxes.get(childId);
		if (box === undefined) {
			continue;
		}
		if (locks.has(childId)) {
			diagnostics.push({
				severity: "warning",
				code: "constraints.locked-target-not-moved",
				message: `Locked child ${childId} was not moved into contract swimlane slot.`,
				path: ["swimlanes"],
				detail: { nodeId: childId },
			});
			continue;
		}
		if (offset.x !== 0 || offset.y !== 0) {
			movedChildIds.add(childId);
		}
		nodeBoxes.set(childId, {
			...box,
			x: box.x + offset.x,
			y: box.y + offset.y,
		});
	}
}

function removeResolvedOverlapDiagnostics(
	diagnostics: Diagnostic[],
	nodeBoxes: ReadonlyMap<string, Box>,
): void {
	for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
		const diagnostic = diagnostics[index];
		if (diagnostic?.code !== "constraints.overlap.unresolved") {
			continue;
		}
		const firstId = detailString(diagnostic, "firstId");
		const secondId = detailString(diagnostic, "secondId");
		const first = firstId === undefined ? undefined : nodeBoxes.get(firstId);
		const second = secondId === undefined ? undefined : nodeBoxes.get(secondId);
		if (
			first !== undefined &&
			second !== undefined &&
			!intersectsAabb(first, second)
		) {
			diagnostics.splice(index, 1);
		}
	}
}

function reportSwimlaneConstraintInvalidations(
	constraints: readonly Constraint[],
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const constraint of constraints) {
		const invalidatedNodeIds = movedConstraintNodeIds(
			constraint,
			nodeBoxes,
			movedChildIds,
		);
		if (invalidatedNodeIds.length === 0) {
			continue;
		}
		diagnostics.push({
			severity: "warning",
			code: "constraints.swimlane-contract.invalidated",
			message: `Contract swimlane placement moved node(s) after ${constraint.kind} constraint solving; final geometry no longer satisfies that constraint.`,
			path: ["swimlanes"],
			detail: {
				constraintKind: constraint.kind,
				...(constraint.id === undefined ? {} : { constraintId: constraint.id }),
				nodeIds: invalidatedNodeIds,
			},
		});
	}
	return diagnostics;
}

function movedConstraintNodeIds(
	constraint: Constraint,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	switch (constraint.kind) {
		case "exact-position":
			return [];
		case "containment":
			return movedContainmentViolations(constraint, nodeBoxes, movedChildIds);
		case "relative-position":
			return movedRelativeViolations(constraint, nodeBoxes, movedChildIds);
		case "align":
			return movedAlignViolations(constraint, nodeBoxes, movedChildIds);
		case "distribute":
			return movedDistributeViolations(constraint, nodeBoxes, movedChildIds);
	}
}

function movedContainmentViolations(
	constraint: Extract<Constraint, { kind: "containment" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	const container = nodeBoxes.get(constraint.containerId);
	if (container === undefined) {
		return [];
	}
	const content = paddedContentBox(container, constraint.padding);
	return constraint.childIds.filter((childId) => {
		if (!movedChildIds.has(childId)) {
			return false;
		}
		const child = nodeBoxes.get(childId);
		return child !== undefined && !boxInside(child, content);
	});
}

function movedRelativeViolations(
	constraint: Extract<Constraint, { kind: "relative-position" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	if (
		!movedChildIds.has(constraint.sourceId) &&
		!movedChildIds.has(constraint.referenceId)
	) {
		return [];
	}
	const source = nodeBoxes.get(constraint.sourceId);
	const reference = nodeBoxes.get(constraint.referenceId);
	if (source === undefined || reference === undefined) {
		return [];
	}
	return sameBoxPosition(
		source,
		expectedRelativeBox(source, reference, constraint),
	)
		? []
		: [constraint.sourceId];
}

function movedAlignViolations(
	constraint: Extract<Constraint, { kind: "align" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	if (!constraint.targetIds.some((id) => movedChildIds.has(id))) {
		return [];
	}
	const targets = constraint.targetIds
		.map((id) => ({ id, box: nodeBoxes.get(id) }))
		.filter(
			(target): target is { id: string; box: Box } => target.box !== undefined,
		);
	const anchor = targets[0];
	if (anchor === undefined) {
		return [];
	}
	const expected = alignmentValue(anchor.box, constraint.axis);
	return targets
		.filter(
			(target) =>
				movedChildIds.has(target.id) &&
				!sameNumber(alignmentValue(target.box, constraint.axis), expected),
		)
		.map((target) => target.id);
}

function movedDistributeViolations(
	constraint: Extract<Constraint, { kind: "distribute" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	if (!constraint.targetIds.some((id) => movedChildIds.has(id))) {
		return [];
	}
	const targets = constraint.targetIds
		.map((id) => ({ id, box: nodeBoxes.get(id) }))
		.filter(
			(target): target is { id: string; box: Box } => target.box !== undefined,
		)
		.sort((a, b) => {
			const delta =
				constraint.axis === "horizontal"
					? a.box.x - b.box.x
					: a.box.y - b.box.y;
			return delta === 0 ? a.id.localeCompare(b.id) : delta;
		});
	if (targets.length < 3) {
		return [];
	}
	const first = targets[0];
	const last = targets.at(-1);
	if (first === undefined || last === undefined) {
		return [];
	}
	const expectedSpacing =
		constraint.spacing ??
		(distributionStart(last.box, constraint.axis) -
			distributionStart(first.box, constraint.axis)) /
			(targets.length - 1);
	return targets
		.slice(1)
		.filter((target, index) => {
			const previous = targets[index];
			if (previous === undefined || !movedChildIds.has(target.id)) {
				return false;
			}
			return !sameNumber(
				distributionStart(target.box, constraint.axis) -
					distributionStart(previous.box, constraint.axis),
				expectedSpacing,
			);
		})
		.map((target) => target.id);
}

function expectedRelativeBox(
	source: Box,
	reference: Box,
	constraint: Extract<Constraint, { kind: "relative-position" }>,
): Box {
	const offset = constraint.offset ?? { x: 0, y: 0 };
	switch (constraint.relation) {
		case "above":
			return {
				...source,
				x: reference.x + offset.x,
				y: reference.y - source.height + offset.y,
			};
		case "right-of":
			return {
				...source,
				x: reference.x + reference.width + offset.x,
				y: reference.y + offset.y,
			};
		case "below":
			return {
				...source,
				x: reference.x + offset.x,
				y: reference.y + reference.height + offset.y,
			};
		case "left-of":
			return {
				...source,
				x: reference.x - source.width + offset.x,
				y: reference.y + offset.y,
			};
	}
}

function paddedContentBox(container: Box, padding: Insets | undefined): Box {
	const margin = padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
	return {
		x: container.x + margin.left,
		y: container.y + margin.top,
		width: container.width - margin.left - margin.right,
		height: container.height - margin.top - margin.bottom,
	};
}

function boxInside(child: Box, container: Box): boolean {
	return (
		child.x >= container.x &&
		child.y >= container.y &&
		child.x + child.width <= container.x + container.width &&
		child.y + child.height <= container.y + container.height
	);
}

function sameBoxPosition(first: Box, second: Box): boolean {
	return sameNumber(first.x, second.x) && sameNumber(first.y, second.y);
}

function sameNumber(first: number, second: number): boolean {
	return Math.abs(first - second) < 0.001;
}

function alignmentValue(
	box: Box,
	axis: Extract<Constraint, { kind: "align" }>["axis"],
): number {
	switch (axis) {
		case "x":
		case "left":
			return box.x;
		case "y":
		case "top":
			return box.y;
		case "center-x":
			return box.x + box.width / 2;
		case "center-y":
			return box.y + box.height / 2;
		case "right":
			return box.x + box.width;
		case "bottom":
			return box.y + box.height;
	}
}

function distributionStart(
	box: Box,
	axis: Extract<Constraint, { kind: "distribute" }>["axis"],
): number {
	return axis === "horizontal" ? box.x : box.y;
}

function detailString(
	diagnostic: Diagnostic,
	key: "firstId" | "secondId",
): string | undefined {
	const value = diagnostic.detail?.[key];
	return typeof value === "string" ? value : undefined;
}

function reportSwimlaneOverlaps(
	nodeBoxes: ReadonlyMap<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	overlapSpacing: number,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const ids = [...nodeBoxes.keys()].sort();
	for (const firstId of ids) {
		for (const secondId of ids) {
			if (firstId >= secondId) {
				continue;
			}
			const first = nodeBoxes.get(firstId);
			const second = nodeBoxes.get(secondId);
			if (first === undefined || second === undefined) {
				continue;
			}
			if (!intersectsAabb(first, second)) {
				continue;
			}
			diagnostics.push({
				severity: "warning",
				code: "constraints.overlap.unresolved",
				message: `Boxes ${firstId} and ${secondId} still overlap after contract swimlane placement with configured spacing ${overlapSpacing}.`,
				path: ["swimlanes"],
				detail: {
					firstId,
					secondId,
					firstLocked: locks.has(firstId),
					secondLocked: locks.has(secondId),
				},
			});
		}
	}
	return diagnostics;
}

function coordinateNodes(
	nodes: readonly NormalizedNode[],
	boxes: ReadonlyMap<string, Box>,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): CoordinatedNode[] {
	const coordinated: CoordinatedNode[] = [];

	for (const node of nodes) {
		const box = boxes.get(node.id);
		if (box === undefined) {
			diagnostics.push({
				severity: "error",
				code: "solver.node-box.missing",
				message: `Node ${node.id} has no solved box.`,
				path: ["nodes", node.id],
				detail: { nodeId: node.id },
			});
			continue;
		}

		const geometry = computeShapeGeometry({
			shape: node.shape,
			box,
			obstacleMargin: options.obstacleMargin ?? 0,
		});

		coordinated.push({
			id: node.id,
			...(node.label === undefined ? {} : { label: node.label }),
			...(node.style === undefined ? {} : { style: node.style }),
			...(node.ports === undefined
				? {}
				: { ports: coordinatePorts(node, box, options.portShifting) }),
			...(node.compartments === undefined
				? {}
				: { compartments: node.compartments }),
			...(node.labelLayout === undefined
				? {}
				: { labelLayout: node.labelLayout }),
			shape: node.shape,
			...(node.metadata === undefined ? {} : { metadata: node.metadata }),
			box: geometry.box,
			anchors: geometry.anchors,
			...(node.parentId === undefined ? {} : { parentId: node.parentId }),
		});
	}

	return coordinated;
}

function coordinatePorts(
	node: NormalizedNode,
	nodeBox: Box,
	portShifting: PortShiftingOptions | undefined,
): CoordinatedPort[] {
	const portsBySide = new Map<string, NormalizedNode["ports"]>();
	for (const port of node.ports ?? []) {
		const ports = portsBySide.get(port.side) ?? [];
		ports.push(port);
		portsBySide.set(port.side, ports);
	}

	const coordinated: CoordinatedPort[] = [];
	for (const [side, ports] of portsBySide) {
		const sorted = [...(ports ?? [])].sort((a, b) => {
			const order = (a.order ?? 0) - (b.order ?? 0);
			return order === 0 ? a.id.localeCompare(b.id) : order;
		});
		for (let index = 0; index < sorted.length; index += 1) {
			const port = sorted[index];
			if (port === undefined) {
				continue;
			}
			const anchor = portAnchor(
				nodeBox,
				side as CoordinatedPort["side"],
				index,
				sorted.length,
				portShifting,
			);
			const box = portBox(anchor);
			coordinated.push({ ...port, box, anchor });
		}
	}

	return coordinated.sort((a, b) => a.id.localeCompare(b.id));
}

function portAnchor(
	nodeBox: Box,
	side: CoordinatedPort["side"],
	index: number,
	count: number,
	portShifting: PortShiftingOptions | undefined,
): Point {
	const shiftingEnabled = portShifting?.enabled ?? true;
	const spacing = portShifting?.spacing ?? 24;
	const centeredOffset = shiftingEnabled
		? (index - (count - 1) / 2) * spacing
		: 0;
	switch (side) {
		case "left":
			return {
				x: nodeBox.x,
				y: nodeBox.y + nodeBox.height / 2 + centeredOffset,
			};
		case "right":
			return {
				x: nodeBox.x + nodeBox.width,
				y: nodeBox.y + nodeBox.height / 2 + centeredOffset,
			};
		case "top":
			return {
				x: nodeBox.x + nodeBox.width / 2 + centeredOffset,
				y: nodeBox.y,
			};
		case "bottom":
			return {
				x: nodeBox.x + nodeBox.width / 2 + centeredOffset,
				y: nodeBox.y + nodeBox.height,
			};
	}
}

function portBox(anchor: Point): Box {
	const size = 10;
	return {
		x: anchor.x - size / 2,
		y: anchor.y - size / 2,
		width: size,
		height: size,
	};
}

function portLabelBox(port: CoordinatedPort): Box {
	const textWidth = Math.max(0, (port.label?.text.length ?? 0) * 6);
	const height = 12;
	const gap = 8;
	const x =
		port.side === "left"
			? port.anchor.x - gap - textWidth
			: port.anchor.x + gap;
	return {
		x,
		y: port.anchor.y - 8 - height,
		width: textWidth,
		height,
	};
}

function coordinateSwimlanes(
	swimlanes: readonly Swimlane[],
	nodeBoxes: ReadonlyMap<string, Box>,
	layouts: ReadonlyMap<string, SwimlaneContractLayout>,
): Swimlane[] {
	return swimlanes.map((swimlane) => {
		const layout = swimlane.layout ?? "overlay";
		const headerHeight = swimlane.headerHeight ?? 28;
		const padding = swimlane.padding ?? 16;
		const contractLayout = layouts.get(swimlane.id);
		if (layout === "contract" && contractLayout !== undefined) {
			const lanes = swimlane.lanes.map((lane, index) => {
				const box =
					swimlane.orientation === "vertical"
						? {
								x: contractLayout.box.x + contractLayout.slotWidth * index,
								y: contractLayout.box.y,
								width: contractLayout.slotWidth,
								height: contractLayout.box.height,
							}
						: {
								x: contractLayout.box.x,
								y: contractLayout.box.y + contractLayout.slotHeight * index,
								width: contractLayout.box.width,
								height: contractLayout.slotHeight,
							};
				const headerBox =
					swimlane.orientation === "vertical"
						? {
								x: box.x,
								y: box.y,
								width: box.width,
								height: headerHeight,
							}
						: {
								x: box.x,
								y: box.y,
								width: headerHeight,
								height: box.height,
							};
				const contentBox =
					swimlane.orientation === "vertical"
						? {
								x: box.x,
								y: box.y + headerHeight,
								width: box.width,
								height: Math.max(0, box.height - headerHeight),
							}
						: {
								x: box.x + headerHeight,
								y: box.y,
								width: Math.max(0, box.width - headerHeight),
								height: box.height,
							};
				return {
					...lane,
					box,
					headerBox,
					contentBox,
				};
			});
			return {
				...swimlane,
				lanes,
				box: contractLayout.box,
				...(headerHeight === undefined ? {} : { headerHeight }),
				...(padding === undefined ? {} : { padding }),
			};
		}
		const laneContentBoxes = swimlane.lanes.map((lane) => {
			const childBoxes = lane.children
				.map((child) => nodeBoxes.get(child))
				.filter((box): box is Box => box !== undefined);
			return childBoxes.length === 0 ? undefined : unionBoxes(childBoxes);
		});
		const laneUnion =
			laneContentBoxes.filter((box): box is Box => box !== undefined).length ===
			0
				? { x: 0, y: 0, width: 120, height: 80 }
				: unionBoxes(
						laneContentBoxes.filter((box): box is Box => box !== undefined),
					);
		const outer = expand(laneUnion, padding, headerHeight);
		const laneCount = Math.max(1, swimlane.lanes.length);
		const lanes = swimlane.lanes.map((lane, index) => {
			const box =
				swimlane.orientation === "vertical"
					? {
							x: outer.x + (outer.width / laneCount) * index,
							y: outer.y,
							width: outer.width / laneCount,
							height: outer.height,
						}
					: {
							x: outer.x,
							y: outer.y + (outer.height / laneCount) * index,
							width: outer.width,
							height: outer.height / laneCount,
						};
			const headerBox =
				layout === "contract"
					? swimlane.orientation === "vertical"
						? {
								x: box.x,
								y: box.y,
								width: box.width,
								height: headerHeight,
							}
						: {
								x: box.x,
								y: box.y,
								width: headerHeight,
								height: box.height,
							}
					: undefined;
			const contentBox =
				layout === "contract"
					? swimlane.orientation === "vertical"
						? {
								x: box.x,
								y: box.y + headerHeight,
								width: box.width,
								height: Math.max(0, box.height - headerHeight),
							}
						: {
								x: box.x + headerHeight,
								y: box.y,
								width: Math.max(0, box.width - headerHeight),
								height: box.height,
							}
					: undefined;
			return {
				...lane,
				box,
				...(headerBox === undefined ? {} : { headerBox }),
				...(contentBox === undefined ? {} : { contentBox }),
			};
		});
		return {
			...swimlane,
			lanes,
			box: outer,
			...(headerHeight === undefined ? {} : { headerHeight }),
			...(padding === undefined ? {} : { padding }),
		};
	});
}

function coordinateFrame(
	frame: NonNullable<NormalizedDiagram["frame"]>,
	contentBounds: Box,
): CoordinatedFrame {
	const padding = 32;
	const titleHeight = 28;
	const titleWidth = Math.max(180, frame.titleTab.length * 7);
	const box = {
		x: contentBounds.x - padding,
		y: contentBounds.y - padding - titleHeight,
		width: contentBounds.width + padding * 2,
		height: contentBounds.height + padding * 2 + titleHeight,
	};
	return {
		...frame,
		box,
		titleBox: {
			x: box.x,
			y: box.y,
			width: Math.min(titleWidth, box.width * 0.8),
			height: titleHeight,
		},
	};
}

function expand(box: Box, padding: number, titleSize: number): Box {
	return {
		x: box.x - padding,
		y: box.y - padding - titleSize,
		width: box.width + padding * 2,
		height: box.height + padding * 2 + titleSize,
	};
}

function coordinateGroups(
	groups: readonly NormalizedGroup[],
	nodeBoxes: ReadonlyMap<string, Box>,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): CoordinatedGroup[] {
	const coordinated: CoordinatedGroup[] = [];
	const groupBoxes = new Map<string, Box>();

	for (const group of groups) {
		const childBoxes: Box[] = [];
		let missing = false;

		for (const nodeId of group.nodeIds) {
			const box = nodeBoxes.get(nodeId);
			if (box === undefined) {
				missing = true;
				diagnostics.push(groupReferenceMissing(group.id, "node", nodeId));
			} else {
				childBoxes.push(box);
			}
		}

		for (const childGroupId of group.groupIds) {
			const box = groupBoxes.get(childGroupId);
			if (box === undefined) {
				missing = true;
				diagnostics.push(
					groupReferenceMissing(group.id, "group", childGroupId),
				);
			} else {
				childBoxes.push(box);
			}
		}

		if (missing || childBoxes.length === 0) {
			if (childBoxes.length === 0) {
				diagnostics.push(groupReferenceMissing(group.id, "child", undefined));
			}
			continue;
		}

		const geometry = computeContainerGeometry({
			id: group.id,
			childBoxes,
			padding: group.padding,
			...(group.labelLayout === undefined
				? {}
				: { labelLayout: group.labelLayout }),
			obstacleMargin: options.obstacleMargin ?? 0,
		});
		groupBoxes.set(group.id, geometry.box);
		diagnostics.push(...geometry.diagnostics);
		coordinated.push({
			...group,
			box: geometry.box,
		});
	}

	return coordinated;
}

function coordinateEdges(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	coordinatedNodes: readonly CoordinatedNode[],
	obstacles: readonly Box[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): CoordinatedEdge[] {
	const coordinated: CoordinatedEdge[] = [];
	const coordinatedNodeById = new Map(
		coordinatedNodes.map((node) => [node.id, node]),
	);

	for (const edge of edges) {
		const source = nodes.get(edge.source.nodeId);
		const target = nodes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) {
			diagnostics.push({
				severity: "error",
				code: "solver.edge-reference.missing",
				message: `Edge ${edge.id} references a missing coordinated node.`,
				path: ["edges", edge.id],
				detail: {
					edgeId: edge.id,
					sourceId: edge.source.nodeId,
					targetId: edge.target.nodeId,
				},
			});
			continue;
		}
		const sourcePort = coordinatedNodeById
			.get(edge.source.nodeId)
			?.ports?.find((port) => port.id === edge.source.portId);
		const targetPort = coordinatedNodeById
			.get(edge.target.nodeId)
			?.ports?.find((port) => port.id === edge.target.portId);

		const route = routeEdge({
			kind: options.routeKind ?? "orthogonal",
			direction,
			source: portGeometry(source, sourcePort),
			target: portGeometry(target, targetPort),
			...(edge.source.anchor === undefined
				? {}
				: { sourceAnchor: edge.source.anchor }),
			...(edge.target.anchor === undefined
				? {}
				: { targetAnchor: edge.target.anchor }),
			obstacles: obstacles.filter(
				(obstacle) =>
					obstacle !== source.obstacleBox && obstacle !== target.obstacleBox,
			),
		});
		diagnostics.push(
			...route.diagnostics.map((diagnostic) => ({
				...diagnostic,
				detail: { ...diagnostic.detail, edgeId: edge.id },
			})),
		);
		coordinated.push({
			...edge,
			points: route.points,
		});
	}

	return coordinated;
}

function coordinateBaseTextAnnotations(input: {
	nodes: readonly CoordinatedNode[];
	groups: readonly CoordinatedGroup[];
	swimlanes: readonly Swimlane[];
}): SolvedTextAnnotation[] {
	const measurer = createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];

	for (const node of input.nodes) {
		if (node.labelLayout === undefined && node.label === undefined) {
			continue;
		}
		const layout =
			node.labelLayout ?? fallbackLabelLayout(node.label?.text ?? "");
		annotations.push(
			buildTextAnnotation({
				ownerId: node.id,
				surfaceKind: "node-label",
				layout,
				anchor: node.box,
			}),
		);
	}

	for (const group of input.groups) {
		if (group.labelLayout === undefined && group.label === undefined) {
			continue;
		}
		const layout =
			group.labelLayout ?? fallbackLabelLayout(group.label?.text ?? "");
		annotations.push(
			buildTextAnnotation({
				ownerId: group.id,
				surfaceKind: "group-label",
				layout,
				anchor: group.box,
			}),
		);
	}

	for (const node of input.nodes) {
		for (const port of node.ports ?? []) {
			if (port.label?.text === undefined) {
				continue;
			}
			const layout = fitLabel(
				port.label.text,
				{
					font: { fontFamily: "Arial", fontSize: 10, lineHeight: 12 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					minSize: { width: 0, height: 0 },
					maxWidth: 160,
				},
				measurer,
			);
			annotations.push(
				buildTextAnnotation({
					ownerId: `${node.id}.${port.id}`,
					surfaceKind: "port-label",
					layout,
					anchor: port.box,
				}),
			);
		}
	}

	for (const node of input.nodes) {
		if (node.compartments === undefined) {
			continue;
		}
		const rows = compartmentRows(node);
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (row === undefined) {
				continue;
			}
			const layout = fitLabel(
				row,
				{
					font: { fontFamily: "Arial", fontSize: 11, lineHeight: 13 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					minSize: { width: 0, height: 0 },
					maxWidth: node.box.width,
				},
				measurer,
			);
			annotations.push(
				buildTextAnnotation({
					ownerId: node.id,
					surfaceKind: "compartment-row",
					surfaceIndex: index,
					layout,
					anchor: {
						x: node.box.x,
						y: node.box.y + 18 + index * 16,
						width: node.box.width,
						height: 16,
					},
				}),
			);
		}
	}

	for (const swimlane of input.swimlanes) {
		for (const lane of swimlane.lanes) {
			if (lane.label?.text === undefined || lane.box === undefined) {
				continue;
			}
			const layout = fitLabel(
				lane.label.text,
				{
					font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					minSize: { width: 0, height: 0 },
					maxWidth: lane.box.width,
				},
				measurer,
			);
			annotations.push(
				buildTextAnnotation({
					ownerId: `${swimlane.id}.${lane.id}`,
					surfaceKind: "swimlane-label",
					layout,
					anchor: lane.headerBox ?? lane.box,
				}),
			);
		}
	}

	return annotations;
}

function coordinateEdgeTextAnnotations(
	edges: readonly CoordinatedEdge[],
): SolvedTextAnnotation[] {
	const measurer = createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];

	for (const edge of edges) {
		if (edge.label?.text === undefined) {
			continue;
		}
		const layout = fitLabel(
			edge.label.text,
			{
				font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				minSize: { width: 0, height: 0 },
				maxWidth: 200,
			},
			measurer,
		);
		annotations.push(
			buildTextAnnotation({
				ownerId: edge.id,
				surfaceKind: "edge-label",
				layout,
				anchor: edgeLabelAnchor(edge.points),
			}),
		);
	}

	return annotations;
}

function coordinateFrameTextAnnotation(
	frame: CoordinatedFrame,
): SolvedTextAnnotation {
	const layout = fitLabel(
		frame.titleTab,
		{
			font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			minSize: { width: 0, height: 0 },
			maxWidth: frame.titleBox.width,
		},
		createDefaultTextMeasurer(),
	);
	return buildTextAnnotation({
		ownerId: frame.kind,
		surfaceKind: "frame-title",
		layout,
		anchor: frame.titleBox,
	});
}

function buildTextAnnotation(input: {
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	layout: LabelLayout;
	anchor: Box;
}): SolvedTextAnnotation {
	return {
		text: input.layout.text,
		ownerId: input.ownerId,
		surfaceKind: input.surfaceKind,
		...(input.surfaceIndex === undefined
			? {}
			: { surfaceIndex: input.surfaceIndex }),
		box: {
			x: input.anchor.x + input.layout.box.x,
			y: input.anchor.y + input.layout.box.y,
			width: input.layout.box.width,
			height: input.layout.box.height,
		},
		anchor: input.anchor,
		paddings: input.layout.padding,
		lines: input.layout.lines,
		fontSize: input.layout.font.fontSize,
		textBackend: input.layout.textBackend,
	};
}

function fallbackLabelLayout(text: string): LabelLayout {
	const width = Math.max(0, text.length * 7);
	return {
		text,
		box: { x: 0, y: 0, width, height: 14 },
		contentBox: { x: 0, y: 0, width, height: 14 },
		naturalSize: { width, height: 14 },
		fittedSize: { width, height: 14 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
		lineHeight: 14,
		lines: [
			{
				text,
				box: { x: 0, y: 0, width, height: 14 },
				baselineY: 11.2,
				width,
				lineIndex: 0,
			},
		],
		overflow: { horizontal: false, vertical: false, truncated: false },
		diagnostics: [],
	};
}

function edgeLabelAnchor(points: readonly Point[]): Box {
	const placement = labelPlacementOnPolyline(points);
	return {
		x: placement?.x ?? 0,
		y: placement?.y ?? 0,
		width: 0,
		height: 0,
	};
}

function labelPlacementOnPolyline(points: readonly Point[]): Point | undefined {
	const segments = nonZeroSegments(points);
	const totalLength = segments.reduce(
		(sum, segment) => sum + segment.length,
		0,
	);
	if (totalLength <= 0) {
		return undefined;
	}

	let remaining = totalLength / 2;
	for (const segment of segments) {
		if (remaining <= segment.length) {
			const ratio = remaining / segment.length;
			const x = segment.start.x + (segment.end.x - segment.start.x) * ratio;
			const y = segment.start.y + (segment.end.y - segment.start.y) * ratio;
			const offset = labelOffset(segment);
			return { x: x + offset.x, y: y + offset.y };
		}
		remaining -= segment.length;
	}

	const last = segments.at(-1);
	if (last === undefined) {
		return undefined;
	}
	const offset = labelOffset(last);
	return { x: last.end.x + offset.x, y: last.end.y + offset.y };
}

function nonZeroSegments(points: readonly Point[]): Array<{
	start: Point;
	end: Point;
	length: number;
}> {
	const segments: Array<{ start: Point; end: Point; length: number }> = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		if (length > 0) {
			segments.push({ start, end, length });
		}
	}
	return segments;
}

function labelOffset(segment: {
	start: Point;
	end: Point;
	length: number;
}): Point {
	const offset = 10;
	const dx = segment.end.x - segment.start.x;
	const dy = segment.end.y - segment.start.y;
	return {
		x: (-dy / segment.length) * offset,
		y: (dx / segment.length) * offset,
	};
}

function compartmentRows(node: CoordinatedNode): string[] {
	const compartments = node.compartments;
	if (compartments === undefined) {
		return [];
	}
	return [
		...(compartments.stereotype === undefined ? [] : [compartments.stereotype]),
		...(compartments.name === undefined
			? [node.label?.text ?? node.id]
			: [compartments.name]),
		...(compartments.properties ?? []),
		...(compartments.constraints ?? []),
	];
}

function portGeometry(
	nodeGeometry: ReturnType<typeof computeShapeGeometry>,
	port: CoordinatedPort | undefined,
): ReturnType<typeof computeShapeGeometry> {
	if (port === undefined) {
		return nodeGeometry;
	}
	return {
		...nodeGeometry,
		box: port.box,
		center: port.anchor,
		anchors: nodeGeometry.anchors.map((anchor) => ({
			name: anchor.name,
			point: port.anchor,
		})),
		obstacleBox: port.box,
	};
}

function stableById<T extends { id: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function stableByConstraintId<T extends { id?: string; kind: string }>(
	items: readonly T[],
): T[] {
	return [...items].sort((a, b) =>
		`${a.id ?? a.kind}`.localeCompare(`${b.id ?? b.kind}`),
	);
}

function groupReferenceMissing(
	groupId: string,
	referenceKind: string,
	id: string | undefined,
): Diagnostic {
	return {
		severity: "error",
		code: "solver.group-reference.missing",
		message: `Group ${groupId} references a missing ${referenceKind}.`,
		path: ["groups", groupId],
		detail: id === undefined ? { groupId } : { groupId, id },
	};
}
