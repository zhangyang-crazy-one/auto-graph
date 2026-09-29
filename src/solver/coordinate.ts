/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	computeContainerGeometry,
	computeShapeGeometry,
	unionBoxes,
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
import type { Box, Insets } from "../ir/geometry.js";
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

/**
 * How far a diagram frame reaches past the content it wraps on each side:
 * its padding, plus the title bar on top.
 */
export function frameInsets(
	frame: Pick<
		NonNullable<NormalizedDiagram["frame"]>,
		"padding" | "headerHeight"
	>,
): Insets {
	const padding = framePadding(frame.padding);
	return { ...padding, top: padding.top + (frame.headerHeight ?? 28) };
}

export function coordinateFrame(
	frame: NonNullable<NormalizedDiagram["frame"]>,
	contentBounds: Box,
): CoordinatedFrame {
	const insets = frameInsets(frame);
	const titleHeight = frame.headerHeight ?? 28;
	const titleWidth = Math.max(180, frame.titleTab.length * 7);
	const box = {
		x: contentBounds.x - insets.left,
		y: contentBounds.y - insets.top,
		width: contentBounds.width + insets.left + insets.right,
		height: contentBounds.height + insets.top + insets.bottom,
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

function boxesOverlap(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

export function coordinateGroups(
	groups: readonly NormalizedGroup[],
	nodeBoxes: ReadonlyMap<string, Box>,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
	/**
	 * Boxes a layout reserved for groups (e.g. the global layout widening a
	 * group for its title). A group also covers its reserved box, as long as
	 * the two still overlap (members may have moved since).
	 */
	reservedBoxes?: ReadonlyMap<string, Box>,
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
		const reserved = reservedBoxes?.get(group.id);
		const box =
			reserved !== undefined && boxesOverlap(reserved, geometry.box)
				? unionBoxes([geometry.box, reserved])
				: geometry.box;
		groupBoxes.set(group.id, box);
		diagnostics.push(...geometry.diagnostics);
		coordinated.push({
			...group,
			box,
		});
	}

	return coordinated;
}
