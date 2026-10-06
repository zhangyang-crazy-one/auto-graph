/**
 * Groups outer first: a group before every group nested in it (its
 * `groupIds`, transitively), otherwise in input order. Group frames are
 * filled, so painting an outer frame after a nested one would cover it.
 */
export function groupsOuterFirst<
	T extends { id: string; groupIds: readonly string[] },
>(groups: readonly T[]): T[] {
	const parentOf = new Map<string, string>();
	for (const group of groups) {
		for (const child of group.groupIds) {
			if (!parentOf.has(child)) parentOf.set(child, group.id);
		}
	}
	const depthOf = (id: string): number => {
		const seen = new Set<string>([id]);
		let depth = 0;
		for (
			let parent = parentOf.get(id);
			parent !== undefined && !seen.has(parent);
			parent = parentOf.get(parent)
		) {
			seen.add(parent);
			depth += 1;
		}
		return depth;
	};
	return groups
		.map((group, index) => ({ group, index, depth: depthOf(group.id) }))
		.sort((left, right) => left.depth - right.depth || left.index - right.index)
		.map((entry) => entry.group);
}
