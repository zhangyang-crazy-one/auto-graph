import type { Diagnostic } from "../../ir/diagnostics.js";
import type { DiagramDirection } from "../../ir/geometry.js";

/**
 * Container hierarchy for the global layout solver (plan P2).
 *
 * root ─┬─ swimlane ── lane (fixed order) ── group … ── node
 *       ├─ group ── group … ── node
 *       └─ node
 *
 * Every node belongs to exactly one deepest container. Ordering keeps each
 * container contiguous inside every layer, and keeps sibling containers in
 * the same relative order across layers, so the coordinate stage can give
 * each container one rectangle without interleaving.
 */
export type ContainerKind = "root" | "swimlane" | "lane" | "group";

export interface LayoutContainer {
	id: string;
	kind: ContainerKind;
	parentId?: string;
	/** Child container ids, deterministic order. */
	childIds: string[];
	/** Nodes whose deepest container is this one. */
	nodeIds: string[];
	/** Lanes keep their declared order; other containers are free. */
	fixedOrder?: number;
}

/**
 * Whether a swimlane's lanes stack across the flow (each lane is a band of
 * the cross axis) or along it (each lane is a block of consecutive layers).
 */
export type LaneAxis = "cross" | "main";

export interface HierarchyInput {
	direction: DiagramDirection;
	nodeIds: readonly string[];
	groups: readonly {
		id: string;
		nodeIds: readonly string[];
		groupIds: readonly string[];
	}[];
	swimlanes: readonly {
		id: string;
		orientation: "horizontal" | "vertical";
		lanes: readonly { id: string; children: readonly string[] }[];
	}[];
}

export interface ContainerHierarchy {
	rootId: string;
	containers: Map<string, LayoutContainer>;
	/** Deepest container of every node. */
	containerOfNode: Map<string, string>;
	/** Lane axis per swimlane id. */
	laneAxis: Map<string, LaneAxis>;
	/** For lanes on the main axis: node id → [swimlane id, lane index]. */
	mainAxisLaneOfNode: Map<string, { swimlaneId: string; laneIndex: number }>;
	/** Number of lanes of every swimlane whose lanes run along the flow. */
	mainAxisLaneCount: Map<string, number>;
	diagnostics: Diagnostic[];
}

export const ROOT_CONTAINER_ID = "__root__";

export function laneAxisFor(
	orientation: "horizontal" | "vertical",
	direction: DiagramDirection,
): LaneAxis {
	const horizontalFlow = direction === "LR" || direction === "RL";
	// Horizontal lanes are rows (stacked along y); vertical lanes are columns.
	const lanesStackAlongY = orientation === "horizontal";
	return lanesStackAlongY === horizontalFlow ? "cross" : "main";
}

export function buildContainerHierarchy(
	input: HierarchyInput,
): ContainerHierarchy {
	const diagnostics: Diagnostic[] = [];
	const containers = new Map<string, LayoutContainer>();
	const root: LayoutContainer = {
		id: ROOT_CONTAINER_ID,
		kind: "root",
		childIds: [],
		nodeIds: [],
	};
	containers.set(root.id, root);
	const nodeSet = new Set(input.nodeIds);
	const laneOfNode = new Map<string, string>();
	const laneAxis = new Map<string, LaneAxis>();
	const mainAxisLaneOfNode = new Map<
		string,
		{ swimlaneId: string; laneIndex: number }
	>();
	const mainAxisLaneCount = new Map<string, number>();

	for (const swimlane of input.swimlanes) {
		const axis = laneAxisFor(swimlane.orientation, input.direction);
		laneAxis.set(swimlane.id, axis);
		if (axis === "main") {
			// Lanes along the flow constrain layering, not cross-axis order,
			// but the swimlane itself is still one container across the flow:
			// two such swimlanes must not overlap with their headers/padding.
			const swimlaneId = containerId("swimlane", swimlane.id);
			containers.set(swimlaneId, {
				id: swimlaneId,
				kind: "swimlane",
				parentId: root.id,
				childIds: [],
				nodeIds: [],
			});
			root.childIds.push(swimlaneId);
			mainAxisLaneCount.set(swimlane.id, swimlane.lanes.length);
			swimlane.lanes.forEach((lane, laneIndex) => {
				for (const child of lane.children) {
					if (!nodeSet.has(child) || mainAxisLaneOfNode.has(child)) continue;
					mainAxisLaneOfNode.set(child, { swimlaneId: swimlane.id, laneIndex });
					if (!laneOfNode.has(child)) laneOfNode.set(child, swimlaneId);
				}
			});
			continue;
		}
		const swimlaneId = containerId("swimlane", swimlane.id);
		containers.set(swimlaneId, {
			id: swimlaneId,
			kind: "swimlane",
			parentId: root.id,
			childIds: [],
			nodeIds: [],
		});
		root.childIds.push(swimlaneId);
		swimlane.lanes.forEach((lane, laneIndex) => {
			const laneId = containerId("lane", `${swimlane.id}/${lane.id}`);
			containers.set(laneId, {
				id: laneId,
				kind: "lane",
				parentId: swimlaneId,
				childIds: [],
				nodeIds: [],
				fixedOrder: laneIndex,
			});
			containers.get(swimlaneId)?.childIds.push(laneId);
			for (const child of lane.children) {
				if (!nodeSet.has(child)) continue;
				if (laneOfNode.has(child)) {
					diagnostics.push({
						severity: "warning",
						code: "layout.global.node-in-multiple-lanes",
						message: `Node ${child} is listed in more than one lane; the first lane wins.`,
						path: ["swimlanes", swimlane.id],
						detail: { nodeId: child },
					});
					continue;
				}
				laneOfNode.set(child, laneId);
			}
		});
	}

	// Groups: nest by groupIds, parent = lane holding all members (or root).
	const groupsById = new Map(input.groups.map((group) => [group.id, group]));
	const parentGroup = new Map<string, string>();
	for (const group of [...input.groups].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		for (const childId of group.groupIds) {
			if (groupsById.has(childId) && !parentGroup.has(childId)) {
				parentGroup.set(childId, group.id);
			}
		}
	}
	const memberNodes = (groupId: string, seen = new Set<string>()): string[] => {
		const group = groupsById.get(groupId);
		if (group === undefined || seen.has(groupId)) return [];
		seen.add(groupId);
		return [
			...group.nodeIds.filter((id) => nodeSet.has(id)),
			...group.groupIds.flatMap((childId) => memberNodes(childId, seen)),
		];
	};
	const groupOfNode = new Map<string, string>();
	const orderedGroups = [...input.groups].sort(
		(a, b) => depth(a.id) - depth(b.id) || a.id.localeCompare(b.id),
	);
	function depth(groupId: string): number {
		let level = 0;
		let cursor = parentGroup.get(groupId);
		const seen = new Set<string>();
		while (cursor !== undefined && !seen.has(cursor)) {
			seen.add(cursor);
			level += 1;
			cursor = parentGroup.get(cursor);
		}
		return level;
	}
	for (const group of orderedGroups) {
		const members = memberNodes(group.id);
		const lanes = new Set(members.map((id) => laneOfNode.get(id)));
		const parent = parentGroup.get(group.id);
		let parentId: string;
		if (parent !== undefined && containers.has(containerId("group", parent))) {
			parentId = containerId("group", parent);
		} else if (lanes.size === 1) {
			parentId = [...lanes][0] ?? root.id;
		} else if (lanes.size > 1 || (lanes.size === 1 && lanes.has(undefined))) {
			diagnostics.push({
				severity: "warning",
				code: "layout.global.group-spans-lanes",
				message: `Group ${group.id} spans several lanes and cannot be laid out as one rectangle; it is ignored for ordering.`,
				path: ["groups", group.id],
				detail: { groupId: group.id },
			});
			continue;
		} else {
			parentId = root.id;
		}
		const id = containerId("group", group.id);
		containers.set(id, {
			id,
			kind: "group",
			parentId,
			childIds: [],
			nodeIds: [],
		});
		containers.get(parentId)?.childIds.push(id);
		for (const nodeId of group.nodeIds) {
			if (!nodeSet.has(nodeId)) continue;
			if (groupOfNode.has(nodeId)) {
				diagnostics.push({
					severity: "warning",
					code: "layout.global.node-in-multiple-groups",
					message: `Node ${nodeId} is a direct member of several groups; ${groupOfNode.get(nodeId)} wins.`,
					path: ["groups", group.id],
					detail: { nodeId },
				});
				continue;
			}
			groupOfNode.set(nodeId, id);
		}
	}

	const containerOfNode = new Map<string, string>();
	for (const nodeId of input.nodeIds) {
		const deepest =
			groupOfNode.get(nodeId) ?? laneOfNode.get(nodeId) ?? root.id;
		containerOfNode.set(nodeId, deepest);
		containers.get(deepest)?.nodeIds.push(nodeId);
	}
	for (const container of containers.values()) {
		container.childIds.sort((a, b) => {
			const left = containers.get(a);
			const right = containers.get(b);
			return (
				(left?.fixedOrder ?? Number.POSITIVE_INFINITY) -
					(right?.fixedOrder ?? Number.POSITIVE_INFINITY) || a.localeCompare(b)
			);
		});
		container.nodeIds.sort();
	}

	return {
		rootId: root.id,
		containers,
		containerOfNode,
		laneAxis,
		mainAxisLaneOfNode,
		mainAxisLaneCount,
		diagnostics,
	};
}

/** Containers from the root down to `containerId` (inclusive). */
export function containerPath(
	hierarchy: ContainerHierarchy,
	id: string,
): string[] {
	const path: string[] = [];
	let cursor: string | undefined = id;
	const seen = new Set<string>();
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		path.unshift(cursor);
		cursor = hierarchy.containers.get(cursor)?.parentId;
	}
	return path;
}

/** Deepest container that contains both `a` and `b`. */
export function lowestCommonContainer(
	hierarchy: ContainerHierarchy,
	a: string,
	b: string,
): string {
	const left = containerPath(hierarchy, a);
	const right = containerPath(hierarchy, b);
	let common = hierarchy.rootId;
	for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
		if (left[index] !== right[index]) break;
		common = left[index] ?? common;
	}
	return common;
}

/** Id of the layout container built for a group, lane or swimlane. */
export function containerId(kind: ContainerKind, id: string): string {
	return `${kind}:${id}`;
}
