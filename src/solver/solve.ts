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
	CoordinatedGroup,
	CoordinatedNode,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
} from "../ir/elements.js";
import type { Box, Insets } from "../ir/geometry.js";
import { runDagreInitialLayout } from "../layout/index.js";
import { type RouteKind, routeEdge } from "../routing/index.js";

export interface SolveDiagramOptions {
	routeKind?: RouteKind;
	obstacleMargin?: number | Insets;
	overlapSpacing?: number;
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
	const groupBoxes = new Map(
		coordinatedGroups.map((group) => [group.id, group.box]),
	);
	const coordinatedEdges = coordinateEdges(
		edges,
		nodeGeometryById,
		[...nodeGeometryById.values()].map((geometry) => geometry.obstacleBox),
		diagram.direction,
		options,
		diagnostics,
	);
	const allBoxes = [
		...coordinatedNodes.map((node) => node.box),
		...groupBoxes.values(),
	];

	return {
		id: diagram.id,
		...(diagram.title === undefined ? {} : { title: diagram.title }),
		direction: diagram.direction,
		nodes: coordinatedNodes,
		edges: coordinatedEdges,
		groups: coordinatedGroups,
		diagnostics,
		bounds:
			allBoxes.length === 0
				? { x: 0, y: 0, width: 0, height: 0 }
				: unionBoxes(allBoxes),
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
	obstacles: readonly Box[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): CoordinatedEdge[] {
	const coordinated: CoordinatedEdge[] = [];

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

		const route = routeEdge({
			kind: options.routeKind ?? "orthogonal",
			direction,
			source,
			target,
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
