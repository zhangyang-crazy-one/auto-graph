import { unionBoxes } from "../geometry/boxes.js";
import { computeContainerGeometry } from "../geometry/containers.js";
import type { NormalizedEdge, NormalizedGroup } from "../ir/elements.js";
import type { Box } from "../ir/geometry.js";

/**
 * Group bands: a group with a `direction` lays its members out as bands.
 *
 * `vertical` stacks the members top to bottom in the order they are listed
 * (nested groups first, then nodes) and draws its nested groups at one
 * common width: the layers of an architecture diagram, run through from
 * edge to edge. `horizontal` does the same left to right at one common
 * height: a cross-cutting column (security, operations) beside a stack of
 * layers spans all of them.
 *
 * Along the band's axis a member linked by an edge to the one before it
 * keeps its place when it already clears it (the layout's spacing between
 * layers stays, with room for the edges and their labels) and is pushed
 * past it otherwise; an unlinked member follows at the band gap (nodes
 * the layout put side by side are stacked, a side column moves up to the
 * layers). Across the axis nested groups keep their place and are
 * stretched to the members' common extent; nodes are centred on it. A
 * banded group stretched along its own axis by its parent spreads its
 * members evenly over the new length (a column beside taller layers).
 *
 * Runs on the initial layout's node boxes, before constraints and routing.
 * Returns the frames of the banded and stretched groups, which the group
 * boxes then cover (coordinateGroups' reserved boxes).
 */
export function arrangeGroupBands(
	groups: readonly NormalizedGroup[],
	boxes: Map<string, Box>,
	edges: readonly NormalizedEdge[],
	gap = BAND_GAP,
): Map<string, Box> {
	if (!groups.some((group) => group.direction !== undefined)) {
		return new Map();
	}
	const byId = new Map(groups.map((group) => [group.id, group]));
	const frames = new Map<string, Frame>();
	const shaped = new Set<string>();

	const childGroups = (group: NormalizedGroup) =>
		group.groupIds.filter((id) => byId.has(id) && id !== group.id);
	const nodesUnder = (id: string, seen = new Set<string>()): string[] => {
		const group = byId.get(id);
		if (group === undefined || seen.has(id)) return [];
		seen.add(id);
		return [
			...group.nodeIds.filter((nodeId) => boxes.has(nodeId)),
			...childGroups(group).flatMap((child) => nodesUnder(child, seen)),
		];
	};
	const groupsUnder = (id: string, seen = new Set<string>()): string[] => {
		const group = byId.get(id);
		if (group === undefined || seen.has(id)) return [];
		seen.add(id);
		return [
			id,
			...childGroups(group).flatMap((child) => groupsUnder(child, seen)),
		];
	};
	const frameOf = (id: string, seen = new Set<string>()): Frame | undefined => {
		const known = frames.get(id);
		if (known !== undefined) return known;
		const group = byId.get(id);
		if (group === undefined || seen.has(id)) return undefined;
		seen.add(id);
		const childBoxes = [
			...group.nodeIds.flatMap((nodeId) => {
				const box = boxes.get(nodeId);
				return box === undefined ? [] : [box];
			}),
			...childGroups(group).flatMap((child) => {
				const frame = frameOf(child, seen);
				return frame === undefined ? [] : [frame.box];
			}),
		];
		if (childBoxes.length === 0) return undefined;
		const geometry = computeContainerGeometry({
			id,
			childBoxes,
			padding: group.padding,
			...(group.labelLayout === undefined
				? {}
				: { labelLayout: group.labelLayout }),
		});
		const { box, childBounds } = geometry;
		const frame: Frame = {
			box: { ...box },
			insets: {
				top: childBounds.y - box.y,
				left: childBounds.x - box.x,
				bottom: box.y + box.height - (childBounds.y + childBounds.height),
				right: box.x + box.width - (childBounds.x + childBounds.width),
			},
		};
		frames.set(id, frame);
		return frame;
	};

	const nodesOf = (member: Member) =>
		new Set(member.group ? nodesUnder(member.id) : [member.id]);
	const linked = (left: Member, right: Member) => {
		const a = nodesOf(left);
		const b = nodesOf(right);
		return edges.some(
			(edge) =>
				(a.has(edge.source.nodeId) && b.has(edge.target.nodeId)) ||
				(b.has(edge.source.nodeId) && a.has(edge.target.nodeId)),
		);
	};
	const members = (group: NormalizedGroup): Member[] => [
		...childGroups(group).map((id) => ({ id, group: true })),
		...group.nodeIds
			.filter((id) => boxes.has(id))
			.map((id) => ({ id, group: false })),
	];
	const boxOf = (member: Member): Box | undefined =>
		member.group ? frameOf(member.id)?.box : boxes.get(member.id);
	const translate = (member: Member, axis: Axis, delta: number) => {
		if (Math.abs(delta) < 1e-9) return;
		const shift = (box: Box): Box =>
			axis === "x"
				? { ...box, x: box.x + delta }
				: { ...box, y: box.y + delta };
		if (!member.group) {
			const box = boxes.get(member.id);
			if (box !== undefined) boxes.set(member.id, shift(box));
			return;
		}
		for (const nodeId of nodesUnder(member.id)) {
			const box = boxes.get(nodeId);
			if (box !== undefined) boxes.set(nodeId, shift(box));
		}
		for (const groupId of groupsUnder(member.id)) {
			const frame = frames.get(groupId);
			if (frame !== undefined) frame.box = shift(frame.box);
		}
	};

	/** Stretch a group's frame along `axis` to [start, start + size]. */
	const stretch = (id: string, axis: Axis, start: number, size: number) => {
		const frame = frameOf(id);
		if (frame === undefined) return;
		frame.box =
			axis === "x"
				? { ...frame.box, x: start, width: size }
				: { ...frame.box, y: start, height: size };
		shaped.add(id);
		const group = byId.get(id);
		if (group?.direction === undefined) return;
		const before = axis === "x" ? frame.insets.left : frame.insets.top;
		const after = axis === "x" ? frame.insets.right : frame.insets.bottom;
		const innerStart = start + before;
		const innerSize = Math.max(0, size - before - after);
		const list = members(group);
		if (axisOf(group) === axis) {
			// Spread the members evenly over the stretched length.
			const sizes = list.map((member) => extent(boxOf(member), axis));
			const total = sizes.reduce((sum, value) => sum + value, 0);
			const spacing =
				list.length > 1 ? (innerSize - total) / (list.length - 1) : 0;
			let cursor =
				list.length > 1 ? innerStart : innerStart + (innerSize - total) / 2;
			list.forEach((member, index) => {
				const box = boxOf(member);
				if (box === undefined) return;
				translate(member, axis, cursor - startOf(box, axis));
				cursor += (sizes[index] ?? 0) + spacing;
			});
			return;
		}
		for (const member of list) {
			if (member.group) {
				stretch(member.id, axis, innerStart, innerSize);
				continue;
			}
			const box = boxOf(member);
			if (box === undefined) continue;
			translate(
				member,
				axis,
				innerStart + (innerSize - extent(box, axis)) / 2 - startOf(box, axis),
			);
		}
	};

	const arrange = (group: NormalizedGroup) => {
		const axis = axisOf(group);
		const cross: Axis = axis === "x" ? "y" : "x";
		const list = members(group);
		if (list.length === 0) return;
		// Along the axis: listed order, each member clear of the one before.
		let previous: Member | undefined;
		let previousEnd = Number.NEGATIVE_INFINITY;
		for (const member of list) {
			const box = boxOf(member);
			if (box === undefined) continue;
			const packed = previousEnd + gap;
			const start =
				previous === undefined || linked(previous, member)
					? Math.max(startOf(box, axis), packed)
					: packed;
			translate(member, axis, start - startOf(box, axis));
			previousEnd = start + extent(box, axis);
			previous = member;
		}
		// Across it: nodes centred, nested groups stretched to the span.
		const placed = list.flatMap((member) => {
			const box = boxOf(member);
			return box === undefined ? [] : [box];
		});
		const span = unionBoxes(placed);
		const spanStart = startOf(span, cross);
		const spanSize = extent(span, cross);
		for (const member of list) {
			const box = boxOf(member);
			if (box === undefined) continue;
			if (member.group) stretch(member.id, cross, spanStart, spanSize);
			else {
				translate(
					member,
					cross,
					spanStart + (spanSize - extent(box, cross)) / 2 - startOf(box, cross),
				);
			}
		}
		frames.delete(group.id);
		frameOf(group.id);
		shaped.add(group.id);
	};

	// Inner groups first: a band's members are final before it is placed.
	const depths = new Map<string, number>();
	const depthOf = (group: NormalizedGroup, seen: Set<string>): number => {
		const known = depths.get(group.id);
		if (known !== undefined) return known;
		let depth = 0;
		for (const childId of childGroups(group)) {
			const child = byId.get(childId);
			if (child === undefined || seen.has(childId)) continue;
			depth = Math.max(depth, depthOf(child, new Set([...seen, childId])) + 1);
		}
		depths.set(group.id, depth);
		return depth;
	};
	const ordered = groups
		.map((group, index) => ({
			group,
			index,
			depth: depthOf(group, new Set([group.id])),
		}))
		.sort(
			(left, right) => left.depth - right.depth || left.index - right.index,
		);
	for (const { group } of ordered) {
		if (group.direction !== undefined) arrange(group);
	}

	return new Map(
		[...shaped].sort().flatMap((id) => {
			const frame = frames.get(id);
			return frame === undefined ? [] : [[id, frame.box] as const];
		}),
	);
}

/** Gap between the members of a band. */
const BAND_GAP = 24;

type Axis = "x" | "y";

interface Member {
	id: string;
	group: boolean;
}

interface Frame {
	box: Box;
	/** Frame edges to its members' bounds (padding, plus the title on top). */
	insets: { top: number; right: number; bottom: number; left: number };
}

function axisOf(group: NormalizedGroup): Axis {
	return group.direction === "horizontal" ? "x" : "y";
}

function startOf(box: Box, axis: Axis): number {
	return axis === "x" ? box.x : box.y;
}

function extent(box: Box | undefined, axis: Axis): number {
	if (box === undefined) return 0;
	return axis === "x" ? box.width : box.height;
}
