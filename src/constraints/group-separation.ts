import { computeContainerGeometry } from "../geometry/containers.js";
import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { NormalizedGroup } from "../ir/elements.js";
import type { Box } from "../ir/geometry.js";
import type { LayoutLock } from "./types.js";

/**
 * Keep group rectangles apart after explicit constraints.
 *
 * Constraints move individual nodes; nothing stops them from pulling a
 * node into another group's area or two groups on top of each other (the
 * layout that placed the groups apart ran before the constraints). This
 * pass rebuilds every group box the way `coordinateGroups` draws it
 * (members + padding + title) and resolves, in id order:
 *
 * - two groups that are not nested in each other and share no member but
 *   overlap: the group whose members are all free moves (the smaller one
 *   when both are free) by the shortest translation that clears the other
 *   by `spacing`;
 * - a node outside a group that lies inside the group's box: the free
 *   side moves (the node, or else the group) the same way.
 *
 * A node is pinned when it is locked or named by any constraint, so the
 * pass never breaks what the author asked for; conflicts between pinned
 * sides are left alone (the metrics report them). Repeats until stable,
 * at most `MAX_PASSES` times. Mutates `boxes`.
 */
const MAX_PASSES = 8;

export function separateGroups(input: {
	groups: readonly NormalizedGroup[];
	constraints: readonly Constraint[];
	boxes: Map<string, Box>;
	locks: ReadonlyMap<string, LayoutLock>;
	spacing: number;
	/** Gap below which a pair counts as overlapping (default `spacing`). */
	detectionGap?: number;
	diagnostics: Diagnostic[];
}): void {
	const { groups, boxes, spacing } = input;
	const detectionGap = input.detectionGap ?? spacing;
	if (groups.length === 0) return;
	const groupById = new Map(groups.map((group) => [group.id, group]));
	const members = new Map<string, Set<string>>();
	const collect = (id: string, seen: Set<string>): Set<string> => {
		const cached = members.get(id);
		if (cached !== undefined) return cached;
		const group = groupById.get(id);
		const result = new Set<string>();
		if (group === undefined || seen.has(id)) return result;
		seen.add(id);
		for (const nodeId of group.nodeIds) {
			if (boxes.has(nodeId)) result.add(nodeId);
		}
		for (const childId of group.groupIds) {
			for (const nodeId of collect(childId, seen)) result.add(nodeId);
		}
		members.set(id, result);
		return result;
	};
	for (const group of groups) collect(group.id, new Set());
	const ancestors = new Map<string, Set<string>>();
	for (const group of groups) {
		for (const childId of group.groupIds) {
			const set = ancestors.get(childId) ?? new Set<string>();
			set.add(group.id);
			ancestors.set(childId, set);
		}
	}
	const isAncestor = (a: string, b: string): boolean => {
		const seen = new Set<string>();
		const stack = [...(ancestors.get(b) ?? [])];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (id === a) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			stack.push(...(ancestors.get(id) ?? []));
		}
		return false;
	};

	const pinned = new Set<string>(input.locks.keys());
	for (const constraint of input.constraints) {
		for (const id of constraintNodeIds(constraint)) pinned.add(id);
	}
	const free = (nodeIds: Iterable<string>) => {
		for (const id of nodeIds) if (pinned.has(id)) return false;
		return true;
	};

	const groupBox = (id: string, cache: Map<string, Box | undefined>) => {
		if (cache.has(id)) return cache.get(id);
		const group = groupById.get(id);
		cache.set(id, undefined);
		if (group === undefined) return undefined;
		const childBoxes: Box[] = [];
		for (const nodeId of group.nodeIds) {
			const box = boxes.get(nodeId);
			if (box !== undefined) childBoxes.push(box);
		}
		for (const childId of group.groupIds) {
			const box = groupBox(childId, cache);
			if (box !== undefined) childBoxes.push(box);
		}
		const box =
			childBoxes.length === 0
				? undefined
				: computeContainerGeometry({
						id,
						childBoxes,
						padding: group.padding,
						...(group.labelLayout === undefined
							? {}
							: { labelLayout: group.labelLayout }),
					}).box;
		cache.set(id, box);
		return box;
	};
	const move = (nodeIds: Iterable<string>, dx: number, dy: number) => {
		for (const id of nodeIds) {
			const box = boxes.get(id);
			if (box !== undefined) {
				boxes.set(id, { ...box, x: box.x + dx, y: box.y + dy });
			}
		}
	};

	const ordered = [...groups].sort((a, b) => a.id.localeCompare(b.id));
	const nodeIds = [...boxes.keys()].sort();
	let moved = 0;
	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		let changed = false;
		const cache = new Map<string, Box | undefined>();
		for (let i = 0; i < ordered.length; i += 1) {
			for (let j = i + 1; j < ordered.length; j += 1) {
				const a = ordered[i] as NormalizedGroup;
				const b = ordered[j] as NormalizedGroup;
				if (isAncestor(a.id, b.id) || isAncestor(b.id, a.id)) continue;
				const ma = members.get(a.id) ?? new Set<string>();
				const mb = members.get(b.id) ?? new Set<string>();
				if ([...ma].some((id) => mb.has(id))) continue;
				const boxA = groupBox(a.id, cache);
				const boxB = groupBox(b.id, cache);
				if (boxA === undefined || boxB === undefined) continue;
				if (!overlaps(boxA, boxB, Math.min(spacing, detectionGap))) continue;
				const freeA = free(ma);
				const freeB = free(mb);
				if (!freeA && !freeB) continue;
				const moveA =
					freeA &&
					(!freeB || ma.size < mb.size || (ma.size === mb.size && a.id > b.id));
				const [mover, anchor, ids] = moveA
					? [boxA, boxB, ma]
					: [boxB, boxA, mb];
				const [dx, dy] = clearance(mover, anchor, spacing);
				move(ids, dx, dy);
				moved += 1;
				changed = true;
				cache.clear();
			}
		}
		for (const group of ordered) {
			const groupMembers = members.get(group.id) ?? new Set<string>();
			for (const nodeId of nodeIds) {
				if (groupMembers.has(nodeId)) continue;
				const box = groupBox(group.id, cache);
				const node = boxes.get(nodeId);
				if (box === undefined || node === undefined) continue;
				if (!overlaps(node, box, Math.min(spacing, detectionGap) / 2)) continue;
				// A node of a group nested inside this one's ancestor chain is
				// handled by the group pass; only truly foreign nodes here.
				if (
					groups.some(
						(other) =>
							other.id !== group.id &&
							(members.get(other.id)?.has(nodeId) ?? false) &&
							(isAncestor(group.id, other.id) ||
								isAncestor(other.id, group.id)),
					)
				) {
					continue;
				}
				if (!pinned.has(nodeId)) {
					const [dx, dy] = clearance(node, box, spacing / 2);
					move([nodeId], dx, dy);
				} else if (free(groupMembers)) {
					const [dx, dy] = clearance(box, node, spacing / 2);
					move(groupMembers, dx, dy);
				} else {
					continue;
				}
				moved += 1;
				changed = true;
				cache.clear();
			}
		}
		if (!changed) break;
	}
	if (moved > 0) {
		input.diagnostics.push({
			severity: "info",
			code: "constraints.groups-separated",
			message: `Moved ${moved} free group(s) or node(s) out of overlapping group areas after applying constraints.`,
			path: ["groups"],
			detail: { moves: moved },
		});
	}
}

function constraintNodeIds(constraint: Constraint): string[] {
	const ids: string[] = [];
	if (constraint.targetId !== undefined) ids.push(constraint.targetId);
	if (constraint.target?.id !== undefined) ids.push(constraint.target.id);
	switch (constraint.kind) {
		case "relative-position":
			ids.push(constraint.sourceId, constraint.referenceId);
			break;
		case "align":
		case "distribute":
			ids.push(...constraint.targetIds);
			break;
		case "containment":
			ids.push(constraint.containerId, ...constraint.childIds);
			break;
		default:
			break;
	}
	return ids;
}

function overlaps(a: Box, b: Box, gap: number): boolean {
	return (
		a.x < b.x + b.width + gap &&
		b.x < a.x + a.width + gap &&
		a.y < b.y + b.height + gap &&
		b.y < a.y + a.height + gap
	);
}

/** Shortest axis-aligned translation of `mover` that clears `anchor`. */
function clearance(mover: Box, anchor: Box, gap: number): [number, number] {
	const options: [number, number][] = [
		[anchor.x + anchor.width + gap - mover.x, 0],
		[anchor.x - gap - (mover.x + mover.width), 0],
		[0, anchor.y + anchor.height + gap - mover.y],
		[0, anchor.y - gap - (mover.y + mover.height)],
	];
	let best = options[0] as [number, number];
	for (const option of options) {
		if (Math.hypot(...option) < Math.hypot(...best) - 1e-9) best = option;
	}
	return best;
}
