import { applyLayoutConstraints } from "../constraints/index.js";
import {
	computeContainerGeometry,
	computeShapeGeometry,
	unionBoxes,
} from "../geometry/index.js";
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
import { runDagreInitialLayout } from "../layout/index.js";
import { type RouteKind, routeEdge } from "../routing/index.js";

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
	);
	const groupBoxes = new Map(
		coordinatedGroups.map((group) => [group.id, group.box]),
	);
	const coordinatedEdges = coordinateEdges(
		edges,
		nodeGeometryById,
		coordinatedNodes,
		[...nodeGeometryById.values()].map((geometry) => geometry.obstacleBox),
		diagram.direction,
		options,
		diagnostics,
	);
	const allBoxes = [
		...coordinatedNodes.map((node) => node.box),
		...groupBoxes.values(),
		...coordinatedSwimlanes.flatMap((swimlane) =>
			swimlane.box === undefined ? [] : [swimlane.box],
		),
	];
	const contentBounds =
		allBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(allBoxes);
	const frame =
		diagram.frame === undefined
			? undefined
			: coordinateFrame(diagram.frame, contentBounds);

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
				? contentBounds
				: unionBoxes([contentBounds, frame.box, frame.titleBox]),
		...(frame === undefined ? {} : { frame }),
		...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
	};
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
			const box = portBox(anchor, side as CoordinatedPort["side"]);
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

function portBox(anchor: Point, side: CoordinatedPort["side"]): Box {
	const size = 10;
	const horizontal = side === "left" || side === "right";
	return {
		x: anchor.x - size / 2,
		y: anchor.y - size / 2,
		width: horizontal ? size : size,
		height: horizontal ? size : size,
	};
}

function coordinateSwimlanes(
	swimlanes: readonly Swimlane[],
	nodeBoxes: ReadonlyMap<string, Box>,
): Swimlane[] {
	const titleSize = 28;
	const padding = 16;
	return swimlanes.map((swimlane) => {
		const laneBoxes = swimlane.lanes.map((lane) => {
			const childBoxes = lane.children
				.map((child) => nodeBoxes.get(child))
				.filter((box): box is Box => box !== undefined);
			return childBoxes.length === 0
				? { x: 0, y: 0, width: 120, height: 80 }
				: unionBoxes(childBoxes);
		});
		const laneUnion =
			laneBoxes.length === 0
				? { x: 0, y: 0, width: 120, height: 80 }
				: unionBoxes(laneBoxes);
		const outer = expand(laneUnion, padding, titleSize);
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
			return { ...lane, box };
		});
		return { ...swimlane, lanes, box: outer };
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
