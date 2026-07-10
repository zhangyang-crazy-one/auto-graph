/** Extracted from solve.ts — behavior-preserving #77 split. */

import { expandBox, intersectsAabb, unionBoxes } from "../geometry/index.js";
import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { PagePolicy } from "../ir/diagram.js";
import type {
	CoordinatedFrame,
	NormalizedEdge,
	Swimlane,
	SwimlaneLane,
} from "../ir/elements.js";
import type { Box, Insets, Point } from "../ir/geometry.js";
import {
	CROSS_AXIS_SPREAD_THRESHOLD,
	compactDetail,
	containsBox,
	expand,
	movedConstraintNodeIds,
} from "./helpers.js";
import type { LayoutLockLike } from "./initial-layout.js";
import {
	crossAxisSpreadWidth,
	maxCrossAxisSpreadWidth,
	maxVerticalRankStackHeight,
	rankStacks,
} from "./initial-layout.js";
import type { SolveDiagramOptions } from "./options.js";

export interface SwimlaneContractLayout {
	box: Box;
	slotWidth: number;
	slotHeight: number;
	laneStep: number;
}

export interface SwimlaneContractResult {
	layouts: Map<string, SwimlaneContractLayout>;
	diagnostics: Diagnostic[];
	movedChildIds: Set<string>;
}

export function reserveLaneCorridors(
	swimlanes: readonly Swimlane[],
	frame: CoordinatedFrame | undefined,
	pagePolicy: PagePolicy,
	margin: number | Insets,
): { hardBands: Box[]; softCorridors: Box[] } {
	if (pagePolicy !== "lane-behavior") {
		return { hardBands: [], softCorridors: [] };
	}
	const hardBands: Box[] = [];
	if (frame !== undefined) {
		hardBands.push(expandBox(frame.titleBox, margin));
	}
	const softCorridors: Box[] = [];
	for (const swimlane of swimlanes) {
		for (const lane of swimlane.lanes) {
			if (
				lane.headerBox !== undefined &&
				lane.headerBox.width > 0 &&
				lane.headerBox.height > 0
			) {
				hardBands.push(expandBox(lane.headerBox, margin));
			}
			if (
				lane.contentBox !== undefined &&
				lane.contentBox.width > 0 &&
				lane.contentBox.height > 0
			) {
				softCorridors.push(lane.contentBox);
			} else if (
				lane.box !== undefined &&
				lane.box.width > 0 &&
				lane.box.height > 0
			) {
				softCorridors.push(lane.box);
			}
		}
	}
	return { hardBands, softCorridors };
}

export function applySwimlaneLayoutContracts(
	swimlanes: readonly Swimlane[],
	constraints: readonly Constraint[],
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	overlapSpacing: number,
	laneGutter: number,
	distributeContainedChildren: boolean | "spread",
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
			laneGutter,
			constraints,
			distributeContainedChildren,
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
		if (laneGutter > 0) {
			diagnostics.push({
				severity: "info",
				code: "lane_gutter_applied",
				message: `Applied ${laneGutter}px gutter between ${layouts.size} contract swimlane lane(s).`,
				path: ["swimlanes"],
				detail: { laneGutter, swimlaneCount: layouts.size },
			});
		}
	}
	return { layouts, diagnostics, movedChildIds };
}

export function applySingleSwimlaneContract(
	swimlane: Swimlane,
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	laneGutter: number,
	constraints: readonly Constraint[],
	distributeContainedChildren: boolean | "spread",
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
			laneGutter,
			constraints,
			distributeContainedChildren,
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
		laneGutter,
	);
}

export function applyVerticalSwimlaneContract(
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
	laneGutter: number,
	constraints: readonly Constraint[],
	distributeContainedChildren: boolean | "spread",
): SwimlaneContractLayout {
	const populatedBounds = laneBounds.filter(
		(box): box is Box => box !== undefined,
	);
	const top = Math.min(...populatedBounds.map((box) => box.y));
	const left = Math.min(...populatedBounds.map((box) => box.x));
	const maxChildHeight = Math.max(...populatedBounds.map((box) => box.height));

	// Build a set of child IDs that were placed as a UNIT by containment
	// distribution — cross-axis spread must be skipped for them to avoid
	// conflicting with that distribution (Issue #66, root cause 2). Only
	// suppress spread for constraints the distributor actually ran:
	// distributeContainedChildren enabled AND ≥2 children that would be
	// distributed. A child is distributable only if it has a box and is not
	// exact-position locked (fixed-position yields to the distributor). This
	// mirrors applyDistributeContained's `distributable.length < 2` guard so
	// single-child, all-locked, or missing-box containments do NOT suppress
	// spread (Codex P2).
	const containedChildIds = new Set<string>();
	if (distributeContainedChildren) {
		for (const c of constraints) {
			if (c.kind !== "containment") continue;
			// Skip if the container itself has no box — applyDistributeContained
			// skips missing containers (Codex P2).
			if (nodeBoxes.get(c.containerId) === undefined) continue;
			const distributable = c.childIds.filter((childId) => {
				if (nodeBoxes.get(childId) === undefined) return false;
				const lock = locks.get(childId);
				// exact-position (and other non-fixed) locks are reserved, not
				// distributed; fixed-position yields to the distributor.
				return lock === undefined || lock.source === "fixed-position";
			});
			if (distributable.length < 2) continue;
			// Only mark actually distributable children — locked/oversized
			// children that the distributor skips should NOT suppress spread
			// for lanes they happen to be in (Codex P2).
			for (const childId of distributable) {
				containedChildIds.add(childId);
			}
		}
	}

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
	// Base slot width fits the widest single child plus padding. When a rank
	// will be spread horizontally, the slot must also fit the full spread
	// width so children stay inside lane bounds and laneStep/swimlane box
	// (returned below and consumed by coordinateSwimlanes) stay consistent
	// (Codex P2).
	const spreadWidth = maxCrossAxisSpreadWidth(
		swimlane,
		nodeBoxes,
		flowRanks,
		locks,
		rankStackGap,
		containedChildIds,
	);
	const slotWidth =
		Math.max(
			Math.max(...populatedBounds.map((box) => box.width)),
			spreadWidth,
		) +
		padding * 2;
	const laneStep = slotWidth + laneGutter;
	const laneContentTop = top + headerHeight + padding;

	for (let index = 0; index < swimlane.lanes.length; index += 1) {
		const lane = swimlane.lanes[index];
		const bounds = laneBounds[index];
		if (lane === undefined || bounds === undefined) {
			continue;
		}
		const target = {
			x: left + laneStep * index + padding,
			y: laneContentTop,
		};
		if (maxRank === 0) {
			// When ≥3 unlocked children could participate in distribution
			// but there are no flow edges (maxRank=0), route through the
			// ranked function which applies cross-axis spread (Issue #62,
			// Codex P2). Locked children never participate.
			// Skip cross-axis spread if ANY lane child is already covered by
			// a containment constraint — the containment distribution already
			// placed them and cross-axis would conflict (Issue #66).
			const distributable = lane.children.filter(
				(childId) => !locks.has(childId),
			);
			const coveredByContainment = lane.children.some((childId) =>
				containedChildIds.has(childId),
			);
			if (
				!coveredByContainment &&
				distributable.length >= CROSS_AXIS_SPREAD_THRESHOLD
			) {
				moveRankedVerticalLaneChildren(
					lane.children,
					nodeBoxes,
					locks,
					diagnostics,
					movedChildIds,
					flowRanks,
					rankSpacing,
					rankStackGap,
					{ x: target.x, y: laneContentTop },
					slotWidth - padding * 2,
				);
				continue;
			}
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
		// Skip cross-axis spread for ranked lanes when children are already
		// covered by a containment constraint (Issue #66). Keep ranked
		// placement (rank spacing / flow order) but suppress horizontal
		// spread so it doesn't conflict with containment distribution (Codex P2).
		const rankedCoveredByContainment = lane.children.some((childId) =>
			containedChildIds.has(childId),
		);
		moveRankedVerticalLaneChildren(
			lane.children,
			nodeBoxes,
			locks,
			diagnostics,
			movedChildIds,
			flowRanks,
			rankSpacing,
			rankStackGap,
			{ x: target.x, y: laneContentTop },
			slotWidth - padding * 2,
			rankedCoveredByContainment,
		);
	}

	return {
		box: {
			x: left,
			y: top,
			width: laneStep * (swimlane.lanes.length - 1) + slotWidth,
			height: contentHeight + padding * 2 + headerHeight,
		},
		slotWidth,
		slotHeight: contentHeight + padding * 2 + headerHeight,
		laneStep,
	};
}

export function rankVerticalSwimlaneChildren(
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

export function rankCyclicSwimlaneChildren(
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

export function moveRankedVerticalLaneChildren(
	childIds: readonly string[],
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	flowRanks: ReadonlyMap<string, number>,
	rankSpacing: number,
	rankStackGap: number,
	target: Point,
	contentWidth: number,
	suppressSpread?: boolean,
): void {
	for (const [rank, stack] of rankStacks(childIds, nodeBoxes, flowRanks)) {
		// Filter out locked children for layout purposes. All locks are
		// respected (fixed-position and exact-position alike) so lock
		// behavior is consistent across ranked/unranked/horizontal contract
		// paths and does not depend on unrelated flow edges (Codex P2).
		const unlocked: Array<{ childId: string; box: Box }> = [];
		for (const item of stack) {
			if (locks.has(item.childId)) {
				diagnostics.push({
					severity: "warning",
					code: "constraints.locked-target-not-moved",
					message: `Locked child ${item.childId} was not moved into contract swimlane slot.`,
					path: ["swimlanes"],
					detail: { nodeId: item.childId },
				});
			} else {
				unlocked.push(item);
			}
		}
		if (unlocked.length === 0) continue;

		if (unlocked.length === 1) {
			// Single child: center within the lane content width (target.x is
			// already the content-left edge, i.e. lane-left + padding).
			const { childId, box } = unlocked[0]!;
			const next = {
				...box,
				x: target.x + (contentWidth - box.width) / 2,
				y: target.y + rank * rankSpacing,
			};
			if (next.x !== box.x || next.y !== box.y) {
				movedChildIds.add(childId);
			}
			nodeBoxes.set(childId, next);
		} else {
			// Determine whether to spread horizontally or stack vertically.
			// When 3+ children share a rank, horizontal distribution avoids
			// vertical overflow that causes sibling_overlap_collapse (Issue #62).
			// For 2 children, vertical stacking is acceptable.
			const shouldSpread =
				!suppressSpread && unlocked.length >= CROSS_AXIS_SPREAD_THRESHOLD;

			if (!shouldSpread) {
				// Normal vertical stacking (2 children fit within rank).
				let yOffset = 0;
				for (const { childId, box } of unlocked) {
					const next = {
						...box,
						x: target.x + (contentWidth - box.width) / 2,
						y: target.y + rank * rankSpacing + yOffset,
					};
					if (next.x !== box.x || next.y !== box.y) {
						movedChildIds.add(childId);
					}
					nodeBoxes.set(childId, next);
					yOffset += box.height + rankStackGap;
				}
			} else {
				// Cross-axis (horizontal) distribution: pack children left to
				// right by their own widths plus gaps (NOT equal subslots — a
				// child wider than the average subslot would overlap neighbors),
				// then center the whole packed row within the lane content width.
				// contentWidth was pre-sized to fit this row (see
				// maxCrossAxisSpreadWidth), so the row stays within lane bounds,
				// and target.x is already the content-left edge (Codex P2). All
				// children share the same y (same rank → no vertical stagger).
				const packedWidth = crossAxisSpreadWidth(unlocked, rankStackGap);
				let xCursor = target.x + Math.max(0, (contentWidth - packedWidth) / 2);
				for (const { childId, box } of unlocked) {
					const next = {
						...box,
						x: xCursor,
						y: target.y + rank * rankSpacing,
					};
					if (next.x !== box.x || next.y !== box.y) {
						movedChildIds.add(childId);
					}
					nodeBoxes.set(childId, next);
					xCursor += box.width + rankStackGap;
				}
				diagnostics.push({
					severity: "info",
					code: "swimlane_contract.cross_axis_distributed",
					message: `Spread ${unlocked.length} same-rank children horizontally in contract lane (rank ${rank}).`,
					path: ["swimlanes"],
					detail: {
						rank,
						childCount: unlocked.length,
						contentWidth,
					},
				});
			}
		}
	}
}

export function applyHorizontalSwimlaneContract(
	swimlane: Swimlane,
	nodeBoxes: Map<string, Box>,
	laneBounds: ReadonlyArray<Box | undefined>,
	headerHeight: number,
	padding: number,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	laneGutter: number,
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
	const laneStep = slotHeight + laneGutter;

	for (let index = 0; index < swimlane.lanes.length; index += 1) {
		const lane = swimlane.lanes[index];
		const bounds = laneBounds[index];
		if (lane === undefined || bounds === undefined) {
			continue;
		}
		const target = {
			x: left + headerHeight + padding,
			y: top + laneStep * index + padding,
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
			height: laneStep * (swimlane.lanes.length - 1) + slotHeight,
		},
		slotWidth,
		slotHeight,
		laneStep,
	};
}

export function moveLaneChildren(
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

export function reportSwimlaneConstraintInvalidations(
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

export function reportSwimlaneOverlaps(
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

export function coordinateSwimlanes(
	swimlanes: readonly Swimlane[],
	nodeBoxes: ReadonlyMap<string, Box>,
	layouts: ReadonlyMap<string, SwimlaneContractLayout>,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): Swimlane[] {
	return swimlanes.map((swimlane) => {
		const layout = swimlane.layout ?? "overlay";
		const headerHeight = swimlane.headerHeight ?? 28;
		const padding = swimlane.padding ?? 16;
		const contractLayout = layouts.get(swimlane.id);
		if (options.fixedSwimlaneGeometry && hasFixedSwimlaneGeometry(swimlane)) {
			const fixedLanes = swimlane.lanes.map((lane, index) => {
				const box =
					lane.box ??
					(swimlane.box === undefined
						? fixedLaneBoxFromChildren(
								lane,
								nodeBoxes,
								swimlane.orientation,
								headerHeight,
								padding,
							)
						: fixedLaneBoxFromSwimlaneBox(
								swimlane.box,
								swimlane.orientation,
								index,
								Math.max(1, swimlane.lanes.length),
							));
				if (box === undefined) {
					return lane;
				}
				const headerBox = fixedLaneHeaderBox(
					box,
					swimlane.orientation,
					headerHeight,
				);
				const contentBox = fixedLaneContentBox(
					box,
					swimlane.orientation,
					headerHeight,
				);
				if (swimlane.box !== undefined && !containsBox(swimlane.box, box)) {
					reportFixedLaneBoxOverflow(
						swimlane.id,
						lane.id,
						swimlane.box,
						box,
						diagnostics,
					);
				}
				if (lane.box !== undefined || swimlane.box !== undefined) {
					reportFixedSwimlaneOverflow(
						swimlane.id,
						lane,
						contentBox,
						nodeBoxes,
						diagnostics,
					);
				}
				return {
					...lane,
					box,
					headerBox,
					contentBox,
				};
			});
			const fixedLaneBoxes = fixedLanes
				.map((lane) => lane.box)
				.filter((box): box is Box => box !== undefined);
			const fixedBox =
				swimlane.box ??
				(fixedLaneBoxes.length === 0 ? undefined : unionBoxes(fixedLaneBoxes));
			return {
				...swimlane,
				lanes: fixedLanes,
				...(fixedBox === undefined ? {} : { box: fixedBox }),
				headerHeight,
				padding,
			};
		}
		if (layout === "contract" && contractLayout !== undefined) {
			const lanes = swimlane.lanes.map((lane, index) => {
				const box =
					swimlane.orientation === "vertical"
						? {
								x: contractLayout.box.x + contractLayout.laneStep * index,
								y: contractLayout.box.y,
								width: contractLayout.slotWidth,
								height: contractLayout.box.height,
							}
						: {
								x: contractLayout.box.x,
								y: contractLayout.box.y + contractLayout.laneStep * index,
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

export function hasFixedSwimlaneGeometry(swimlane: Swimlane): boolean {
	return (
		swimlane.box !== undefined ||
		swimlane.lanes.some((lane) => lane.box !== undefined)
	);
}

export function fixedLaneBoxFromChildren(
	lane: SwimlaneLane,
	nodeBoxes: ReadonlyMap<string, Box>,
	orientation: Swimlane["orientation"],
	headerHeight: number,
	padding: number,
): Box | undefined {
	const childBoxes = lane.children
		.map((child) => nodeBoxes.get(child))
		.filter((box): box is Box => box !== undefined);
	if (childBoxes.length === 0) return undefined;
	return wrapFixedLaneContentBox(
		unionBoxes(childBoxes),
		orientation,
		headerHeight,
		padding,
	);
}

export function wrapFixedLaneContentBox(
	contentBox: Box,
	orientation: Swimlane["orientation"],
	headerHeight: number,
	padding: number,
): Box {
	return orientation === "vertical"
		? {
				x: contentBox.x - padding,
				y: contentBox.y - padding - headerHeight,
				width: contentBox.width + padding * 2,
				height: contentBox.height + padding * 2 + headerHeight,
			}
		: {
				x: contentBox.x - padding - headerHeight,
				y: contentBox.y - padding,
				width: contentBox.width + padding * 2 + headerHeight,
				height: contentBox.height + padding * 2,
			};
}

export function fixedLaneBoxFromSwimlaneBox(
	box: Box,
	orientation: Swimlane["orientation"],
	index: number,
	count: number,
): Box {
	if (orientation === "vertical") {
		const width = box.width / count;
		return {
			x: box.x + width * index,
			y: box.y,
			width,
			height: box.height,
		};
	}
	const height = box.height / count;
	return {
		x: box.x,
		y: box.y + height * index,
		width: box.width,
		height,
	};
}

export function fixedLaneHeaderBox(
	box: Box,
	orientation: Swimlane["orientation"],
	headerHeight: number,
): Box {
	return orientation === "vertical"
		? { x: box.x, y: box.y, width: box.width, height: headerHeight }
		: { x: box.x, y: box.y, width: headerHeight, height: box.height };
}

export function fixedLaneContentBox(
	box: Box,
	orientation: Swimlane["orientation"],
	headerHeight: number,
): Box {
	return orientation === "vertical"
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
}

export function reportFixedLaneBoxOverflow(
	swimlaneId: string,
	laneId: string,
	swimlaneBox: Box,
	laneBox: Box,
	diagnostics: Diagnostic[],
): void {
	diagnostics.push({
		severity: "warning",
		code: "layout.container-fixed-bounds-overflow",
		message: `Fixed swimlane ${swimlaneId} does not contain fixed lane ${laneId}.`,
		path: ["swimlanes", swimlaneId, "lanes", laneId],
		detail: compactDetail({
			swimlaneId,
			laneId,
			containerX: Math.round(swimlaneBox.x),
			containerY: Math.round(swimlaneBox.y),
			containerWidth: Math.round(swimlaneBox.width),
			containerHeight: Math.round(swimlaneBox.height),
			laneX: Math.round(laneBox.x),
			laneY: Math.round(laneBox.y),
			laneWidth: Math.round(laneBox.width),
			laneHeight: Math.round(laneBox.height),
			suggestedRemedy:
				"Move the fixed lane inside the swimlane box or increase the fixed swimlane bounds.",
		}),
	});
}

export function reportFixedSwimlaneOverflow(
	swimlaneId: string,
	lane: SwimlaneLane,
	contentBox: Box,
	nodeBoxes: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
): void {
	for (const childId of lane.children) {
		const childBox = nodeBoxes.get(childId);
		if (childBox === undefined || containsBox(contentBox, childBox)) {
			continue;
		}
		diagnostics.push({
			severity: "warning",
			code: "routing.container-fixed-bounds-overflow",
			message: `Fixed swimlane ${swimlaneId} lane ${lane.id} does not contain child ${childId}.`,
			path: ["swimlanes", swimlaneId, "lanes", lane.id],
			detail: compactDetail({
				swimlaneId,
				laneId: lane.id,
				childId,
				overflowX: Math.round(childBox.x),
				overflowY: Math.round(childBox.y),
				overflowWidth: Math.round(childBox.width),
				overflowHeight: Math.round(childBox.height),
				suggestedRemedy:
					"Increase the fixed lane bounds, move the child into the content box, or disable fixedSwimlaneGeometry.",
			}),
		});
	}
}
