/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	computeContainerGeometry,
	computeShapeGeometry,
} from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { NormalizedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedNode,
	NormalizedGroup,
	NormalizedNode,
} from "../ir/elements.js";
import type { Box } from "../ir/geometry.js";
import { groupReferenceMissing } from "./helpers.js";
import { framePadding } from "./initial-layout.js";
import type { SolveDiagramOptions } from "./options.js";
import { coordinatePorts } from "./ports.js";

export function coordinateNodes(
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

		// Place ports first — they may expand the node box to
		// accommodate minimum port spacing (#42).
		const ports =
			node.ports === undefined
				? undefined
				: coordinatePorts(node, box, options.portShifting);

		const geometry = computeShapeGeometry({
			shape: node.shape,
			box,
			obstacleMargin: options.obstacleMargin ?? 0,
		});

		coordinated.push({
			id: node.id,
			...(node.label === undefined ? {} : { label: node.label }),
			...(node.style === undefined ? {} : { style: node.style }),
			...(ports === undefined ? {} : { ports }),
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

export function coordinateFrame(
	frame: NonNullable<NormalizedDiagram["frame"]>,
	contentBounds: Box,
): CoordinatedFrame {
	const padding = framePadding(frame.padding);
	const titleHeight = frame.headerHeight ?? 28;
	const titleWidth = Math.max(180, frame.titleTab.length * 7);
	const box = {
		x: contentBounds.x - padding.left,
		y: contentBounds.y - padding.top - titleHeight,
		width: contentBounds.width + padding.left + padding.right,
		height: contentBounds.height + padding.top + padding.bottom + titleHeight,
	};
	return {
		...frame,
		headerHeight: titleHeight,
		padding: frame.padding ?? 32,
		box,
		titleBox: {
			x: box.x,
			y: box.y,
			width: Math.min(titleWidth, box.width * 0.8),
			height: titleHeight,
		},
	};
}

export function coordinateGroups(
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
