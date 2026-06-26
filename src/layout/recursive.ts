import { unionBoxes } from "../geometry/boxes.js";
import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
} from "../ir/elements.js";
import type { Box } from "../ir/geometry.js";
import {
	runComponentAwareDagreInitialLayout,
	runDagreInitialLayout,
} from "./dagre.js";
import type { DagreLayoutOptions, InitialLayoutResult } from "./types.js";

// ---------------------------------------------------------------------------
// Recursive container layout (Issue #54, 方案 A)
// ---------------------------------------------------------------------------

export interface RecursiveLayoutInput {
	direction: "TB" | "LR" | "BT" | "RL";
	nodes: readonly NormalizedNode[];
	groups: readonly NormalizedGroup[];
	edges: readonly NormalizedEdge[];
	constraints: readonly Constraint[];
	options?: Partial<DagreLayoutOptions>;
}

export interface RecursiveLayoutResult {
	boxes: Map<string, Box>;
	groupBoxes: Map<string, Box>;
	diagnostics: Diagnostic[];
}

/**
 * Build parent→children maps from groups and containment constraints.
 *
 * A node is a child of group G if G.nodeIds includes the node's id.
 * A group C is a child of group G if G.groupIds includes C's id.
 * Containment constraints supplement (or override) group membership.
 */
export function buildContainerTree(
	groups: readonly NormalizedGroup[],
	constraints: readonly Constraint[],
	edges: readonly NormalizedEdge[],
): {
	childrenOf: Map<string, string[]>; // groupId → child node/group ids (leaf nodes + nested groups)
	rootIds: Set<string>; // groups with no parent
	edgesInGroup: Map<string, NormalizedEdge[]>; // groupId → edges internal to that group
	diagnostics: Diagnostic[];
} {
	const childrenOf = new Map<string, string[]>();
	const parentOf = new Map<string, string>(); // childId → parent groupId

	// Populate from group.nodeIds / group.groupIds
	for (const group of groups) {
		const children: string[] = [];
		for (const nodeId of group.nodeIds) {
			children.push(nodeId);
			parentOf.set(nodeId, group.id);
		}
		for (const childGroupId of group.groupIds) {
			children.push(childGroupId);
			parentOf.set(childGroupId, group.id);
		}
		childrenOf.set(group.id, children);
	}

	// Supplement from containment constraints
	for (const c of constraints) {
		if (c.kind !== "containment") continue;
		for (const childId of c.childIds) {
			const existing = parentOf.get(childId);
			if (existing !== undefined) {
				// Already parented — containment constraint takes precedence.
				// Migrate child from old parent to new container.
				if (existing === c.containerId) continue;
				const oldSiblings = childrenOf.get(existing) ?? [];
				const pruned = oldSiblings.filter((id) => id !== childId);
				if (pruned.length === 0) {
					childrenOf.delete(existing);
				} else {
					childrenOf.set(existing, pruned);
				}
				const newSiblings = childrenOf.get(c.containerId) ?? [];
				newSiblings.push(childId);
				childrenOf.set(c.containerId, newSiblings);
				parentOf.set(childId, c.containerId);
			} else {
				const list = childrenOf.get(c.containerId) ?? [];
				list.push(childId);
				childrenOf.set(c.containerId, list);
				parentOf.set(childId, c.containerId);
			}
		}
	}

	// Identify root groups (groups not contained by any other group)
	const rootIds = new Set<string>();
	for (const group of groups) {
		if (!parentOf.has(group.id)) {
			rootIds.add(group.id);
		}
	}

	// Map edges to their innermost containing group
	const edgesInGroup = new Map<string, NormalizedEdge[]>();
	for (const edge of edges) {
		const srcParent = parentOf.get(edge.source.nodeId);
		const tgtParent = parentOf.get(edge.target.nodeId);
		if (srcParent !== undefined && srcParent === tgtParent) {
			const list = edgesInGroup.get(srcParent) ?? [];
			list.push(edge);
			edgesInGroup.set(srcParent, list);
		}
	}

	const treeDiagnostics: Diagnostic[] = [];
	return { childrenOf, rootIds, edgesInGroup, diagnostics: treeDiagnostics };
}

/**
 * Run recursive bottom-up container layout.
 *
 * Leaf containers are laid out first (DFS post-order). Container
 * size = union of child boxes + padding. The global pass treats
 * containers as atomic nodes.
 */
export function runRecursiveContainerLayout(
	input: RecursiveLayoutInput,
): RecursiveLayoutResult {
	const diagnostics: Diagnostic[] = [];
	const boxes = new Map<string, Box>();
	const groupBoxes = new Map<string, Box>();

	// Build O(1) lookup maps
	const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
	const groupById = new Map(input.groups.map((g) => [g.id, g]));
	const groupIdSet = new Set(input.groups.map((g) => g.id));

	const {
		childrenOf,
		rootIds,
		edgesInGroup,
		diagnostics: treeDiagnostics,
	} = buildContainerTree(input.groups, input.constraints, input.edges);
	diagnostics.push(...treeDiagnostics);

	// If no groups, fall through to flat layout
	if (input.groups.length === 0) {
		const flat = runComponentAwareDagreInitialLayout({
			direction: input.direction,
			nodes: input.nodes.map((n) => ({ id: n.id, size: n.size })),
			edges: input.edges.map((e) => ({
				id: e.id,
				sourceId: e.source.nodeId,
				targetId: e.target.nodeId,
			})),
			...(input.options === undefined ? {} : { options: input.options }),
		});
		diagnostics.push(...flat.diagnostics);
		for (const [id, box] of flat.boxes) {
			boxes.set(id, box);
		}
		return { boxes, groupBoxes, diagnostics };
	}

	// Collect all descendant node/group IDs for a given group
	const descendants = new Map<string, Set<string>>();
	function collectDescendants(groupId: string): Set<string> {
		const cached = descendants.get(groupId);
		if (cached !== undefined) return cached;
		const result = new Set<string>();
		const children = childrenOf.get(groupId) ?? [];
		for (const childId of children) {
			result.add(childId);
			const childDesc = collectDescendants(childId);
			for (const d of childDesc) result.add(d);
		}
		descendants.set(groupId, result);
		return result;
	}

	// DFS post-order: lay out each group from leaves to root
	const groupOrder = topologicalSort(input.groups, childrenOf, groupIdSet);

	for (const groupId of groupOrder) {
		const group = groupById.get(groupId);
		if (group === undefined) continue;

		const children = childrenOf.get(groupId) ?? [];
		if (children.length === 0) {
			// Empty group — min size with padding
			const box: Box = {
				x: 0,
				y: 0,
				width: (group.padding?.left ?? 8) + (group.padding?.right ?? 8) + 40,
				height: (group.padding?.top ?? 8) + (group.padding?.bottom ?? 8) + 20,
			};
			groupBoxes.set(groupId, box);
			boxes.set(groupId, box);
			continue;
		}

		// Separate leaf nodes from nested groups
		const leafNodeIds: string[] = [];
		const nestedGroupIds: string[] = [];
		for (const childId of children) {
			if (groupIdSet.has(childId)) {
				nestedGroupIds.push(childId);
			} else {
				leafNodeIds.push(childId);
			}
		}

		// Collect child sizes: leaf nodes use their declared size,
		// nested groups use their already-computed box
		const childSizes = new Map<string, { width: number; height: number }>();
		for (const nodeId of leafNodeIds) {
			const node = nodeById.get(nodeId);
			if (node !== undefined) {
				childSizes.set(nodeId, {
					width: node.size.width,
					height: node.size.height,
				});
			}
		}
		for (const nestedId of nestedGroupIds) {
			const nestedBox = groupBoxes.get(nestedId);
			if (nestedBox !== undefined) {
				childSizes.set(nestedId, {
					width: nestedBox.width,
					height: nestedBox.height,
				});
			}
		}

		// Build mini-Dagre input for this group's children + internal edges
		const groupEdges = edgesInGroup.get(groupId) ?? [];
		const childLayout = runDagreInitialLayout({
			direction: input.direction,
			nodes: children.flatMap((childId) => {
				const size = childSizes.get(childId);
				return size === undefined ? [] : [{ id: childId, size }];
			}),
			edges: groupEdges.map((e) => ({
				id: e.id,
				sourceId: e.source.nodeId,
				targetId: e.target.nodeId,
			})),
			options: {
				...(input.options ?? {}),
				ranksep: (input.options?.ranksep ?? 100) * 0.6, // tighter inside containers
				nodesep: (input.options?.nodesep ?? 80) * 0.6,
			},
		});
		diagnostics.push(...childLayout.diagnostics);

		if (childLayout.boxes.size === 0) continue;

		// Compute container box from child bounds + padding
		const childBoxes = [...childLayout.boxes.values()];
		const contentBounds = unionBoxes(childBoxes);
		const padding = group.padding ?? {
			top: 8,
			right: 8,
			bottom: 8,
			left: 8,
		};
		const containerBox: Box = {
			x: 0,
			y: 0,
			width: contentBounds.width + (padding.left ?? 8) + (padding.right ?? 8),
			height: contentBounds.height + (padding.top ?? 8) + (padding.bottom ?? 8),
		};

		// Offset children inside the container
		const offsetX = padding.left ?? 8;
		const offsetY = padding.top ?? 8;
		for (const [childId, childBox] of childLayout.boxes) {
			boxes.set(childId, {
				...childBox,
				x: childBox.x + offsetX,
				y: childBox.y + offsetY,
			});
		}

		groupBoxes.set(groupId, containerBox);
		boxes.set(groupId, containerBox);
	}

	// Global layout for top-level entities:
	// root groups (as atomic nodes) + uncontained leaf nodes + cross-group edges.
	// Use childrenOf to determine containment (covers group.nodeIds,
	// group.groupIds, and containment constraints).
	const allContainedIds = new Set<string>();
	for (const [, childIds] of childrenOf) {
		for (const cid of childIds) allContainedIds.add(cid);
	}
	const topLevelNodeIds = new Set<string>();
	for (const node of input.nodes) {
		if (!allContainedIds.has(node.id)) {
			topLevelNodeIds.add(node.id);
		}
	}

	// Build global Dagre input
	const globalNodes: Array<{
		id: string;
		size: { width: number; height: number };
	}> = [];
	for (const nodeId of topLevelNodeIds) {
		const node = nodeById.get(nodeId);
		if (node !== undefined) {
			globalNodes.push({ id: nodeId, size: node.size });
		}
	}
	for (const rootId of rootIds) {
		const gb = groupBoxes.get(rootId);
		if (gb !== undefined) {
			globalNodes.push({
				id: rootId,
				size: { width: gb.width, height: gb.height },
			});
		}
	}

	// Map a node/group id to its outermost container root (if any).
	function rootContainerOf(id: string): string | undefined {
		for (const rootId of rootIds) {
			const desc = collectDescendants(rootId);
			if (desc.has(id)) return rootId;
		}
		return undefined;
	}

	// Cross-group edges (not internal to any group).
	// Map internal endpoints to their containing root group so
	// Dagre always references nodes that exist in globalNodes.
	const globalEdges = input.edges
		.filter((e) => {
			for (const group of input.groups) {
				const desc = collectDescendants(group.id);
				if (desc.has(e.source.nodeId) && desc.has(e.target.nodeId)) {
					return false; // internal to a group
				}
			}
			return true;
		})
		.map((e) => ({
			id: e.id,
			sourceId: rootContainerOf(e.source.nodeId) ?? e.source.nodeId,
			targetId: rootContainerOf(e.target.nodeId) ?? e.target.nodeId,
		}));

	if (globalNodes.length > 0) {
		const globalLayout = runDagreInitialLayout({
			direction: input.direction,
			nodes: globalNodes,
			edges: globalEdges,
			...(input.options === undefined ? {} : { options: input.options }),
		});
		diagnostics.push(...globalLayout.diagnostics);

		// Apply global positions to root groups
		for (const [id, box] of globalLayout.boxes) {
			if (groupBoxes.has(id)) {
				groupBoxes.set(id, box);
				boxes.set(id, box);
			} else if (topLevelNodeIds.has(id)) {
				boxes.set(id, box);
			}
		}

		// Translate contained children by their container's global position
		for (const groupId of groupOrder) {
			const containerBox = groupBoxes.get(groupId);
			if (containerBox === undefined) continue;
			const offsetX = containerBox.x;
			const offsetY = containerBox.y;
			const children = childrenOf.get(groupId) ?? [];
			for (const childId of children) {
				const childBox = boxes.get(childId);
				if (childBox !== undefined) {
					boxes.set(childId, {
						...childBox,
						x: childBox.x + offsetX,
						y: childBox.y + offsetY,
					});
				}
				// Recurse into nested groups
				translateDescendants(childId, offsetX, offsetY, boxes, childrenOf);
			}
		}
	}

	return { boxes, groupBoxes, diagnostics };
}

function translateDescendants(
	groupId: string,
	dx: number,
	dy: number,
	boxes: Map<string, Box>,
	childrenOf: Map<string, string[]>,
): void {
	const children = childrenOf.get(groupId) ?? [];
	for (const childId of children) {
		const box = boxes.get(childId);
		if (box !== undefined) {
			boxes.set(childId, { ...box, x: box.x + dx, y: box.y + dy });
		}
		translateDescendants(childId, dx, dy, boxes, childrenOf);
	}
}

/**
 * Topological sort of groups: leaves first (DFS post-order).
 */
function topologicalSort(
	groups: readonly NormalizedGroup[],
	childrenOf: Map<string, string[]>,
	groupIdSet: Set<string>,
): string[] {
	const visited = new Set<string>();
	const result: string[] = [];

	function visit(id: string): void {
		if (visited.has(id)) return;
		visited.add(id);
		const children = childrenOf.get(id) ?? [];
		for (const childId of children) {
			if (groupIdSet.has(childId)) {
				visit(childId);
			}
		}
		result.push(id);
	}

	for (const group of groups) {
		visit(group.id);
	}

	return result;
}
