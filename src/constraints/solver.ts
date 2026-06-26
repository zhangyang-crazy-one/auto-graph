import { intersectsAabb, overlapArea, validateBox } from "../geometry/boxes.js";
import {
	createBoxSpatialIndex,
	queryBoxSpatialIndex,
} from "../geometry/spatial-index.js";
import type {
	AlignConstraint,
	Constraint,
	DistributeConstraint,
	RelativePositionConstraint,
} from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { NormalizedNode } from "../ir/elements.js";
import type { Box, Insets, Point } from "../ir/geometry.js";
import type {
	ConstraintSolverInput,
	ConstraintSolverResult,
	LayoutLock,
} from "./types.js";

export function applyLayoutConstraints(
	input: ConstraintSolverInput,
): ConstraintSolverResult {
	const diagnostics: Diagnostic[] = [];
	const boxes = cloneValidBoxes(input.boxes, diagnostics);
	const locks = new Map<string, LayoutLock>();
	const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

	applyFixedPositionLocks(input.nodes, boxes, locks, diagnostics);
	applyExactPositions(input.constraints, boxes, locks, diagnostics, nodeById);

	// When distribution is enabled, drop fixed-position locks early so
	// repairOverlaps and containment treat positioned children as
	// movable instead of displacing unrelated nodes (Codex P2).
	// Only yields locks for children in containment constraints that
	// will actually be distributed (2+ eligible children).
	if (input.distributeContainedChildren) {
		yieldFixedPositionLocks(input, boxes, locks);
	}

	applyContainment(input.constraints, boxes, locks, diagnostics, false);
	applyRelative(input.constraints, boxes, locks, diagnostics);
	applyAlign(input.constraints, boxes, locks, diagnostics);
	applyDistribute(input.constraints, boxes, locks, diagnostics);
	repairOverlaps(
		input,
		boxes,
		locks,
		diagnostics,
		siblingOverlapKeys(input.constraints),
	);
	applyContainment(input.constraints, boxes, locks, diagnostics, true);
	applyDistributeContained(input, boxes, locks, diagnostics);

	// After distribution, re-run containment and distribution for
	// nested containers whose own children may have been displaced,
	// then clean up any remaining loose ends (Codex P2).
	if (input.distributeContainedChildren) {
		const diagBefore = diagnostics.length;
		applyContainment(input.constraints, boxes, locks, diagnostics, true);
		applyDistributeContained(input, boxes, locks, diagnostics);
		// Remove duplicate diagnostics emitted by the re-run on
		// containers that were already handled in the first pass
		// (Codex P3: avoid re-emitting distribution diagnostics).
		dedupReplayDiagnostics(diagnostics, diagBefore);
	}

	// Clean up diagnostics that distribution may have resolved (Codex P2).
	removeResolvedConstraintDiagnostics(input.constraints, boxes, diagnostics);

	reportOverlaps(
		boxes,
		diagnostics,
		containmentOverlapKeys(input.constraints),
		locks,
	);
	reportIntraContainerOverflow(input, boxes, diagnostics);

	return { boxes, locks, diagnostics };
}

function cloneValidBoxes(
	input: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
): Map<string, Box> {
	const boxes = new Map<string, Box>();

	for (const [id, box] of input) {
		if (isFiniteBox(box)) {
			boxes.set(id, { ...box });
		} else {
			diagnostics.push({
				severity: "error",
				code: "constraints.position.invalid",
				message: `Box ${id} contains invalid coordinates.`,
				path: ["boxes", id],
				detail: { nodeId: id },
			});
		}
	}

	return boxes;
}

function applyFixedPositionLocks(
	nodes: readonly NormalizedNode[],
	boxes: Map<string, Box>,
	locks: Map<string, LayoutLock>,
	diagnostics: Diagnostic[],
): void {
	for (const node of nodes) {
		if (node.position === undefined) {
			continue;
		}

		const box = boxes.get(node.id);
		if (box === undefined) {
			missingReference(diagnostics, "node", node.id);
			continue;
		}

		if (!isFinitePoint(node.position)) {
			diagnostics.push({
				severity: "error",
				code: "constraints.position.invalid",
				message: `Fixed position for ${node.id} is invalid.`,
				path: ["nodes", node.id, "position"],
				detail: { nodeId: node.id },
			});
			continue;
		}

		boxes.set(node.id, { ...box, x: node.position.x, y: node.position.y });
		locks.set(node.id, { nodeId: node.id, source: "fixed-position" });
	}
}

/**
 * Remove duplicate diagnostics that the re-run containment/distribution
 * pass may have emitted for containers already handled in the first pass
 * (Codex P3).
 */
function dedupReplayDiagnostics(
	diagnostics: Diagnostic[],
	keepUpTo: number,
): void {
	const seen = new Set<string>();
	// Mark pre-existing diagnostics as seen.
	for (let i = 0; i < keepUpTo && i < diagnostics.length; i += 1) {
		const d = diagnostics[i];
		if (d === undefined) continue;
		seen.add(diagnosticFingerprint(d));
	}
	// Remove new duplicates.
	for (let i = diagnostics.length - 1; i >= keepUpTo; i -= 1) {
		const d = diagnostics[i];
		if (d === undefined) continue;
		const fp = diagnosticFingerprint(d);
		if (seen.has(fp)) {
			diagnostics.splice(i, 1);
		} else {
			seen.add(fp);
		}
	}
}

/**
 * Stable fingerprint of a diagnostic for dedup: code + primary node/container.
 */
function diagnosticFingerprint(d: Diagnostic): string {
	const nodeId = typeof d.detail?.nodeId === "string" ? d.detail.nodeId : "";
	const containerId =
		typeof d.detail?.containerId === "string" ? d.detail.containerId : "";
	return `${d.code}|${nodeId}|${containerId}`;
}

/**
 * Drop fixed-position locks for children that will be distributed,
 * so downstream passes (repairOverlaps, containment) treat them as
 * movable instead of displacing unrelated nodes (Codex P2).
 *
 * Only yields locks on children inside containment constraints with
 * 2+ eligible children — a single positioned child outside a
 * container is intentionally left locked.
 */
function yieldFixedPositionLocks(
	input: ConstraintSolverInput,
	boxes: ReadonlyMap<string, Box>,
	locks: Map<string, LayoutLock>,
): void {
	for (const c of input.constraints) {
		if (c.kind !== "containment") continue;
		const container = boxes.get(c.containerId);
		if (container === undefined) continue;
		const content = contentBox(container, c.padding);
		const mainAxis: "width" | "height" =
			input.direction === "LR" || input.direction === "RL" ? "width" : "height";
		const crossAxis: "width" | "height" =
			mainAxis === "width" ? "height" : "width";
		// Count eligible children: unlocked or fixed-position locked,
		// not oversized (distribution would skip oversized children).
		// Exact-position locks are reserved and not counted.
		let eligible = 0;
		for (const childId of c.childIds) {
			const box = boxes.get(childId);
			if (box === undefined) continue;
			const lock = locks.get(childId);
			if (lock?.source === "exact-position") continue;
			const fits =
				box[mainAxis] <= content[mainAxis] &&
				box[crossAxis] <= content[crossAxis];
			if (fits) {
				eligible += 1;
			}
		}
		if (eligible < 2) continue;
		for (const childId of c.childIds) {
			const lock = locks.get(childId);
			if (lock?.source === "fixed-position") {
				const box = boxes.get(childId);
				if (box === undefined) continue;
				const fits =
					box[mainAxis] <= content[mainAxis] &&
					box[crossAxis] <= content[crossAxis];
				if (fits) {
					locks.delete(childId);
				}
			}
		}
	}
}

function applyExactPositions(
	constraints: readonly Constraint[],
	boxes: Map<string, Box>,
	locks: Map<string, LayoutLock>,
	diagnostics: Diagnostic[],
	nodeById: ReadonlyMap<string, NormalizedNode>,
): void {
	for (const constraint of constraints) {
		if (constraint.kind !== "exact-position") {
			continue;
		}

		const targetId = constraintTargetId(constraint);
		if (targetId === undefined || !nodeById.has(targetId)) {
			missingReference(diagnostics, "target", targetId);
			continue;
		}

		const box = boxes.get(targetId);
		if (box === undefined) {
			missingReference(diagnostics, "box", targetId);
			continue;
		}

		if (!isFinitePoint(constraint.position)) {
			diagnostics.push({
				severity: "error",
				code: "constraints.position.invalid",
				message: `Exact position for ${targetId} is invalid.`,
				path: ["constraints", constraint.id ?? targetId, "position"],
				detail: { nodeId: targetId },
			});
			continue;
		}

		const existingLock = locks.get(targetId);
		if (
			existingLock !== undefined &&
			(box.x !== constraint.position.x || box.y !== constraint.position.y)
		) {
			diagnostics.push({
				severity: "error",
				code: "constraints.conflict.exact-position",
				message: `Exact position conflicts with existing lock for ${targetId}.`,
				path: ["constraints", constraint.id ?? targetId],
				detail: { nodeId: targetId, source: existingLock.source },
			});
			continue;
		}

		boxes.set(targetId, {
			...box,
			x: constraint.position.x,
			y: constraint.position.y,
		});
		locks.set(targetId, { nodeId: targetId, source: "exact-position" });
	}
}

function applyContainment(
	constraints: readonly Constraint[],
	boxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLock>,
	diagnostics: Diagnostic[],
	reportOverflow: boolean,
): void {
	for (const constraint of constraints) {
		if (constraint.kind !== "containment") {
			continue;
		}

		const container = boxes.get(constraint.containerId);
		if (container === undefined) {
			missingReference(diagnostics, "container", constraint.containerId);
			continue;
		}

		const content = contentBox(container, constraint.padding);
		for (const childId of constraint.childIds) {
			const child = boxes.get(childId);
			if (child === undefined) {
				missingReference(diagnostics, "child", childId);
				continue;
			}

			const next = moveInside(child, content);
			if (samePosition(child, next)) {
				continue;
			}

			const lock = locks.get(childId);
			if (lock !== undefined) {
				if (!reportOverflow) {
					diagnostics.push({
						severity: "warning",
						code: "constraints.locked-target-not-moved",
						message: `Locked child ${childId} was not moved into containment.`,
						path: ["constraints", constraint.id ?? constraint.containerId],
						detail: {
							nodeId: childId,
							containerId: constraint.containerId,
							lockSource: lock.source,
						},
					});
					if (!isInside(child, content)) {
						diagnostics.push({
							severity: "error",
							code: "constraints.containment.impossible",
							message: `Locked child ${childId} cannot fit inside ${constraint.containerId}.`,
							path: ["constraints", constraint.id ?? constraint.containerId],
							detail: { nodeId: childId, containerId: constraint.containerId },
						});
					}
				}
				continue;
			}

			if (next.width > content.width || next.height > content.height) {
				diagnostics.push({
					severity: "error",
					code: "constraints.containment.impossible",
					message: `Child ${childId} cannot fit inside ${constraint.containerId}.`,
					path: ["constraints", constraint.id ?? constraint.containerId],
					detail: { nodeId: childId, containerId: constraint.containerId },
				});
				continue;
			}

			boxes.set(childId, next);
			if (reportOverflow) {
				diagnostics.push({
					severity: "warning",
					code: "containment_overflow",
					message: `Child ${childId} was clamped back inside ${constraint.containerId} after constraint solving.`,
					path: ["constraints", constraint.id ?? constraint.containerId],
					detail: { nodeId: childId, containerId: constraint.containerId },
				});
			}
		}
	}
}

function applyRelative(
	constraints: readonly Constraint[],
	boxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLock>,
	diagnostics: Diagnostic[],
): void {
	for (const constraint of constraints) {
		if (constraint.kind !== "relative-position") {
			continue;
		}

		const source = boxes.get(constraint.sourceId);
		const reference = boxes.get(constraint.referenceId);
		if (source === undefined) {
			missingReference(diagnostics, "source", constraint.sourceId);
			continue;
		}
		if (reference === undefined) {
			missingReference(diagnostics, "reference", constraint.referenceId);
			continue;
		}

		const next = relativeBox(source, reference, constraint);
		setUnlockedBox(
			constraint.sourceId,
			next,
			boxes,
			locks,
			diagnostics,
			constraint,
		);
	}
}

function applyAlign(
	constraints: readonly Constraint[],
	boxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLock>,
	diagnostics: Diagnostic[],
): void {
	for (const constraint of constraints) {
		if (constraint.kind !== "align") {
			continue;
		}

		const targets = collectTargets(constraint.targetIds, boxes, diagnostics);
		const anchor = targets[0];
		if (anchor === undefined) {
			continue;
		}

		const value = alignmentValue(anchor.box, constraint.axis);
		for (const { id, box } of targets.slice(1)) {
			const next = alignBox(box, constraint.axis, value);
			setUnlockedBox(id, next, boxes, locks, diagnostics, constraint);
		}
	}
}

function applyDistribute(
	constraints: readonly Constraint[],
	boxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLock>,
	diagnostics: Diagnostic[],
): void {
	for (const constraint of constraints) {
		if (constraint.kind !== "distribute") {
			continue;
		}

		const targets = collectTargets(
			constraint.targetIds,
			boxes,
			diagnostics,
		).sort((a, b) => {
			const delta =
				constraint.axis === "horizontal"
					? a.box.x - b.box.x
					: a.box.y - b.box.y;
			return delta === 0 ? a.id.localeCompare(b.id) : delta;
		});
		if (targets.length < 3) {
			continue;
		}

		const first = targets[0];
		const last = targets[targets.length - 1];
		if (first === undefined || last === undefined) {
			continue;
		}

		const spacing =
			constraint.spacing ??
			(distributionStart(last.box, constraint.axis) -
				distributionStart(first.box, constraint.axis)) /
				(targets.length - 1);

		for (const [index, target] of targets.slice(1, -1).entries()) {
			const nextStart =
				distributionStart(first.box, constraint.axis) + spacing * (index + 1);
			const next =
				constraint.axis === "horizontal"
					? { ...target.box, x: nextStart }
					: { ...target.box, y: nextStart };
			setUnlockedBox(target.id, next, boxes, locks, diagnostics, constraint);
		}
	}
}

function repairOverlaps(
	input: ConstraintSolverInput,
	boxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLock>,
	diagnostics: Diagnostic[],
	siblingPairs: ReadonlySet<string>,
): void {
	const spacing = input.overlapSpacing ?? 40;
	const axis = input.direction === "LR" || input.direction === "RL" ? "x" : "y";
	const secondaryAxis = axis === "x" ? "y" : "x";
	const ignoredPairs = containmentOverlapKeys(input.constraints);
	const ids = [...boxes.keys()].sort();

	const index = createBoxSpatialIndex(
		ids.flatMap((id) => {
			const box = boxes.get(id);
			return box === undefined ? [] : [{ id, box }];
		}),
		spacing,
	);
	for (let pass = 0; pass < 2; pass += 1) {
		for (const firstId of ids) {
			const first = boxes.get(firstId);
			if (first === undefined) {
				continue;
			}
			const candidateIds = queryBoxSpatialIndex(index, first)
				.map((candidate) => candidate.id)
				.filter((id) => id > firstId)
				.sort();
			for (const secondId of candidateIds) {
				if (firstId >= secondId) {
					continue;
				}
				if (ignoredPairs.has(overlapKey(firstId, secondId))) {
					continue;
				}

				const second = boxes.get(secondId);
				if (second === undefined || !intersectsAabb(first, second)) {
					continue;
				}

				const firstLocked = locks.has(firstId);
				const secondLocked = locks.has(secondId);
				if (firstLocked && secondLocked) {
					continue;
				}

				const movingId = firstLocked
					? secondId
					: secondLocked
						? firstId
						: secondId;
				const moving = movingId === firstId ? first : second;
				const fixed = movingId === firstId ? second : first;
				const repairAxis =
					firstLocked === secondLocked && pass === 0 ? secondaryAxis : axis;
				const pairKey = overlapKey(firstId, secondId);
				const effectiveSpacing = siblingPairs.has(pairKey)
					? Math.max(spacing, input.minSiblingGap ?? 0)
					: spacing;
				const moved = movePastOverlap(
					moving,
					fixed,
					repairAxis,
					effectiveSpacing,
				);
				boxes.set(movingId, moved);
			}
		}
	}

	reportOverlaps(boxes, diagnostics, ignoredPairs, locks);
}

function removeResolvedConstraintDiagnostics(
	constraints: readonly Constraint[],
	boxes: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
): void {
	// Remove diagnostics for issues that distribution or a later
	// containment pass may have resolved (Codex P2).
	for (let i = diagnostics.length - 1; i >= 0; i -= 1) {
		const d = diagnostics[i];
		if (d === undefined) continue;

		// ---- stale overlap warnings ----
		if (d.code === "constraints.overlap.unresolved") {
			const aId = d.detail?.firstId;
			const bId = d.detail?.secondId;
			if (typeof aId !== "string" || typeof bId !== "string") continue;
			const a = boxes.get(aId);
			const b = boxes.get(bId);
			if (a !== undefined && b !== undefined && !intersectsAabb(a, b)) {
				diagnostics.splice(i, 1);
			}
			continue;
		}

		// ---- stale containment warnings (from applyContainment,
		// not from applyDistributeContained) ----
		if (
			d.code === "constraints.containment.impossible" ||
			(d.code === "constraints.locked-target-not-moved" &&
				typeof d.message === "string" &&
				d.message.includes("not moved into containment"))
		) {
			const nodeId = d.detail?.nodeId;
			if (typeof nodeId !== "string") continue;
			const child = boxes.get(nodeId);
			if (child === undefined) continue;
			// Extract the specific container that emitted this
			// diagnostic so we only clear it when THAT container
			// is satisfied (Codex P2: multi-container case).
			const diagContainerId =
				typeof d.detail?.containerId === "string"
					? d.detail.containerId
					: undefined;
			let resolved = false;
			for (const c of constraints) {
				if (c.kind !== "containment") continue;
				if (!c.childIds.includes(nodeId)) continue;
				// If we know which container emitted the diagnostic,
				// only match against that one.
				if (
					diagContainerId !== undefined &&
					c.containerId !== diagContainerId
				) {
					continue;
				}
				const container = boxes.get(c.containerId);
				if (container === undefined) continue;
				const content = contentBox(container, c.padding);
				if (isInside(child, content)) {
					diagnostics.splice(i, 1);
					resolved = true;
				}
				break;
			}
			// If we matched a specific container and it wasn't
			// satisfied, keep searching for the right one.
			if (!resolved && diagContainerId !== undefined) {
				for (const c of constraints) {
					if (c.kind !== "containment") continue;
					if (c.containerId !== diagContainerId) continue;
					if (!c.childIds.includes(nodeId)) continue;
					const container = boxes.get(c.containerId);
					if (container === undefined) continue;
					const content = contentBox(container, c.padding);
					if (isInside(child, content)) {
						diagnostics.splice(i, 1);
					}
					break;
				}
			}
		}
	}
}

function reportOverlaps(
	boxes: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
	ignoredPairs: ReadonlySet<string> = new Set(),
	locks: ReadonlyMap<string, LayoutLock> = new Map(),
): void {
	const ids = [...boxes.keys()].sort();
	const reported = new Set(
		diagnostics
			.filter(
				(diagnostic) =>
					diagnostic.code === "constraints.overlap.unresolved" ||
					diagnostic.code === "constraints.overlap.locked-conflict",
			)
			.map((diagnostic) => {
				const firstId = diagnostic.detail?.firstId;
				const secondId = diagnostic.detail?.secondId;
				return typeof firstId === "string" && typeof secondId === "string"
					? overlapKey(firstId, secondId)
					: undefined;
			})
			.filter((key): key is string => key !== undefined),
	);
	const index = createBoxSpatialIndex(
		ids.flatMap((id) => {
			const box = boxes.get(id);
			return box === undefined ? [] : [{ id, box }];
		}),
		40,
	);

	for (const firstId of ids) {
		const first = boxes.get(firstId);
		if (first === undefined) {
			continue;
		}
		const candidateIds = queryBoxSpatialIndex(index, first)
			.map((candidate) => candidate.id)
			.filter((id) => id > firstId)
			.sort();
		for (const secondId of candidateIds) {
			const key = overlapKey(firstId, secondId);
			if (reported.has(key) || ignoredPairs.has(key)) {
				continue;
			}

			const second = boxes.get(secondId);
			if (second !== undefined && intersectsAabb(first, second)) {
				const firstLock = locks.get(firstId);
				const secondLock = locks.get(secondId);
				if (firstLock !== undefined && secondLock !== undefined) {
					diagnostics.push({
						severity: "warning",
						code: "constraints.overlap.locked-conflict",
						message: `Locked boxes ${firstId} (${firstLock.source}) and ${secondId} (${secondLock.source}) overlap and cannot be repaired.`,
						path: ["boxes"],
						detail: {
							firstId,
							secondId,
							firstLockSource: firstLock.source,
							secondLockSource: secondLock.source,
							overlapArea: overlapArea(first, second),
						},
					});
					reported.add(key);
					continue;
				}
				diagnostics.push({
					severity: "warning",
					code: "constraints.overlap.unresolved",
					message: `Boxes ${firstId} and ${secondId} still overlap after stable sorted primary axis repair with configured spacing.`,
					path: ["boxes"],
					detail: { firstId, secondId },
				});
				reported.add(key);
			}
		}
	}
}

function reportIntraContainerOverflow(
	input: ConstraintSolverInput,
	boxes: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
): void {
	if (input.minSiblingGap === undefined) {
		return;
	}
	const minGap = input.minSiblingGap;
	const axis: "x" | "y" =
		input.direction === "LR" || input.direction === "RL" ? "x" : "y";

	for (const constraint of input.constraints) {
		if (constraint.kind !== "containment") {
			continue;
		}
		const container = boxes.get(constraint.containerId);
		if (container === undefined) {
			continue;
		}
		const children: Box[] = [];
		for (const childId of constraint.childIds) {
			const child = boxes.get(childId);
			if (child !== undefined) {
				children.push(child);
			}
		}
		if (children.length < 2) {
			continue;
		}

		// Sort by main-axis position so pair-check can break early.
		const sorted = [...children].sort((a, b) => a[axis] - b[axis]);
		const mainDim = axis === "x" ? "width" : "height";
		let overlapPairs = 0;
		for (let i = 0; i < sorted.length; i += 1) {
			const first = sorted[i];
			if (first === undefined) {
				continue;
			}
			for (let j = i + 1; j < sorted.length; j += 1) {
				const second = sorted[j];
				if (second === undefined) {
					continue;
				}
				// Children are sorted by main-axis position; if second starts
				// beyond first's far edge it cannot overlap first (or any
				// earlier child), so we can break the inner loop.
				if (second[axis] >= first[axis] + first[mainDim]) {
					break;
				}
				if (intersectsAabb(first, second)) {
					overlapPairs += 1;
				}
			}
		}
		if (overlapPairs > 0) {
			diagnostics.push({
				severity: "warning",
				code: "intra_container_overflow",
				message: `${overlapPairs} sibling pair(s) overlap inside ${constraint.containerId}.`,
				path: ["constraints", constraint.id ?? constraint.containerId],
				detail: {
					containerId: constraint.containerId,
					overlapPairs,
					minGap,
				},
			});
		}

		// Compute content size inline to avoid allocating a full Box.
		const pad = constraint.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
		const contentMain =
			mainDim === "width"
				? Math.max(0, container.width - pad.left - pad.right)
				: Math.max(0, container.height - pad.top - pad.bottom);
		// Use actual spatial extent rather than sequential-stack
		// estimate. Children may be laid out along the cross-axis,
		// making the sequential sum too pessimistic.
		let childStart = Infinity;
		let childEnd = -Infinity;
		for (const child of sorted) {
			const start = child[axis];
			const end = start + child[mainDim];
			if (start < childStart) childStart = start;
			if (end > childEnd) childEnd = end;
		}
		if (sorted.length === 0) {
			childStart = 0;
			childEnd = 0;
		}
		const actualExtent = childEnd - childStart;
		if (actualExtent > contentMain) {
			diagnostics.push({
				severity: "error",
				code: "intra_container_overflow_total",
				message: `Container ${constraint.containerId} cannot fit ${sorted.length} siblings along ${axis} (extent ${actualExtent}, available ${contentMain}).`,
				path: ["constraints", constraint.id ?? constraint.containerId],
				detail: {
					containerId: constraint.containerId,
					axis,
					needed: actualExtent,
					available: contentMain,
					siblingCount: sorted.length,
					minGap,
				},
			});
		}
	}
}

function overlapKey(firstId: string, secondId: string): string {
	return firstId < secondId
		? `${firstId}\0${secondId}`
		: `${secondId}\0${firstId}`;
}

function containmentOverlapKeys(
	constraints: readonly Constraint[],
): Set<string> {
	const keys = new Set<string>();
	for (const constraint of constraints) {
		if (constraint.kind !== "containment") {
			continue;
		}
		for (const childId of constraint.childIds) {
			keys.add(overlapKey(constraint.containerId, childId));
		}
	}
	return keys;
}

function siblingOverlapKeys(constraints: readonly Constraint[]): Set<string> {
	const keys = new Set<string>();
	for (const constraint of constraints) {
		if (constraint.kind !== "containment") {
			continue;
		}
		const { childIds } = constraint;
		for (let i = 0; i < childIds.length; i += 1) {
			for (let j = i + 1; j < childIds.length; j += 1) {
				const a = childIds[i];
				const b = childIds[j];
				if (a === undefined || b === undefined) {
					continue;
				}
				keys.add(overlapKey(a, b));
			}
		}
	}
	return keys;
}

function setUnlockedBox(
	id: string,
	next: Box,
	boxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLock>,
	diagnostics: Diagnostic[],
	constraint: Constraint,
): void {
	const current = boxes.get(id);
	if (current === undefined) {
		missingReference(diagnostics, "target", id);
		return;
	}

	if (!isFiniteBox(next)) {
		diagnostics.push({
			severity: "error",
			code: "constraints.position.invalid",
			message: `Constraint produced an invalid position for ${id}.`,
			path: ["constraints", constraint.id ?? id],
			detail: { nodeId: id },
		});
		return;
	}

	if (locks.has(id) && !samePosition(current, next)) {
		const lock = locks.get(id);
		diagnostics.push({
			severity: "warning",
			code: "constraints.locked-target-not-moved",
			message: `Locked target ${id} was not moved by ${constraint.kind}.`,
			path: ["constraints", constraint.id ?? id],
			detail: {
				nodeId: id,
				constraintKind: constraint.kind,
				...(lock === undefined ? {} : { lockSource: lock.source }),
			},
		});
		return;
	}

	boxes.set(id, next);
}

function constraintTargetId(
	constraint: Extract<Constraint, { kind: "exact-position" }>,
): string | undefined {
	return constraint.targetId ?? constraint.target?.id;
}

function collectTargets(
	ids: readonly string[],
	boxes: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
): { id: string; box: Box }[] {
	const targets: { id: string; box: Box }[] = [];
	for (const id of ids) {
		const box = boxes.get(id);
		if (box === undefined) {
			missingReference(diagnostics, "target", id);
		} else {
			targets.push({ id, box });
		}
	}
	return targets;
}

function relativeBox(
	source: Box,
	reference: Box,
	constraint: RelativePositionConstraint,
): Box {
	const offset = constraint.offset ?? { x: 0, y: 0 };
	switch (constraint.relation) {
		case "above":
			return {
				...source,
				x: reference.x + offset.x,
				y: reference.y - source.height + offset.y,
			};
		case "right-of":
			return {
				...source,
				x: reference.x + reference.width + offset.x,
				y: reference.y + offset.y,
			};
		case "below":
			return {
				...source,
				x: reference.x + offset.x,
				y: reference.y + reference.height + offset.y,
			};
		case "left-of":
			return {
				...source,
				x: reference.x - source.width + offset.x,
				y: reference.y + offset.y,
			};
	}
}

function alignmentValue(box: Box, axis: AlignConstraint["axis"]): number {
	switch (axis) {
		case "x":
		case "left":
			return box.x;
		case "y":
		case "top":
			return box.y;
		case "center-x":
			return box.x + box.width / 2;
		case "center-y":
			return box.y + box.height / 2;
		case "right":
			return box.x + box.width;
		case "bottom":
			return box.y + box.height;
	}
}

function alignBox(box: Box, axis: AlignConstraint["axis"], value: number): Box {
	switch (axis) {
		case "x":
		case "left":
			return { ...box, x: value };
		case "y":
		case "top":
			return { ...box, y: value };
		case "center-x":
			return { ...box, x: value - box.width / 2 };
		case "center-y":
			return { ...box, y: value - box.height / 2 };
		case "right":
			return { ...box, x: value - box.width };
		case "bottom":
			return { ...box, y: value - box.height };
	}
}

function distributionStart(
	box: Box,
	axis: DistributeConstraint["axis"],
): number {
	return axis === "horizontal" ? box.x : box.y;
}

function contentBox(container: Box, padding: Insets | undefined): Box {
	const margin = padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
	return {
		x: container.x + margin.left,
		y: container.y + margin.top,
		width: Math.max(0, container.width - margin.left - margin.right),
		height: Math.max(0, container.height - margin.top - margin.bottom),
	};
}

type ReservedInterval = { start: number; end: number };

function applyDistributeContained(
	input: ConstraintSolverInput,
	boxes: Map<string, Box>,
	locks: Map<string, LayoutLock>,
	diagnostics: Diagnostic[],
): void {
	if (!input.distributeContainedChildren) {
		return;
	}

	const axis: "x" | "y" =
		input.direction === "LR" || input.direction === "RL" ? "x" : "y";
	const crossAxis = axis === "x" ? "y" : "x";
	const mainSize = axis === "x" ? "width" : "height";
	const crossSize = axis === "x" ? "height" : "width";
	// Default to a positive gap so distributed children are
	// visually separated even when minSiblingGap is not set.
	const minGap = input.minSiblingGap ?? 8;

	for (const constraint of input.constraints) {
		if (constraint.kind !== "containment") {
			continue;
		}
		const container = boxes.get(constraint.containerId);
		if (container === undefined) {
			continue;
		}

		const content = contentBox(container, constraint.padding);
		const unlocked: { id: string; box: Box }[] = [];
		const reserved: ReservedInterval[] = [];
		for (const childId of constraint.childIds) {
			const box = boxes.get(childId);
			if (box === undefined) {
				continue;
			}
			if (locks.has(childId)) {
				const lock = locks.get(childId);
				// When distribution is explicitly requested, a fixed-position
				// lock (from the node's `position` field) yields to the
				// distributor so the caller's distributeContainedChildren
				// option actually takes effect (#37). Explicit exact-position
				// constraints still win and are reserved.
				if (lock?.source === "fixed-position") {
					unlocked.push({ id: childId, box });
					continue;
				}
				diagnostics.push({
					severity: "warning",
					code: "constraints.locked-target-not-moved",
					message: `Locked child ${childId} skipped during containment distribution.`,
					path: ["constraints", constraint.id ?? constraint.containerId],
					detail: { nodeId: childId },
				});
				reserved.push(intervalForBox(box, axis, mainSize));
				continue;
			}
			unlocked.push({ id: childId, box });
		}
		if (unlocked.length < 2) {
			continue;
		}

		// Skip children that are already larger than the content area;
		// applyContainment already diagnoses these and moving them is futile.
		const oversized = unlocked.filter(
			(child) =>
				child.box[mainSize] > content[mainSize] ||
				child.box[crossSize] > content[crossSize],
		);
		if (oversized.length > 0) {
			diagnostics.push({
				severity: "warning",
				code: "constraints.containment.impossible",
				message: `Skipped ${oversized.length} oversized child(ren) during distribution in ${constraint.containerId}.`,
				path: ["constraints", constraint.id ?? constraint.containerId],
				detail: {
					containerId: constraint.containerId,
					oversized: oversized.map((c) => c.id),
				},
			});
		}
		for (const child of oversized) {
			reserved.push(intervalForBox(child.box, axis, mainSize));
		}
		reserved.sort((a, b) => a.start - b.start || a.end - b.end);
		const distributable = unlocked.filter(
			(child) =>
				child.box[mainSize] <= content[mainSize] &&
				child.box[crossSize] <= content[crossSize],
		);
		if (distributable.length < 2) {
			continue;
		}

		// Distribute along the main axis within the content box.
		// When spread mode is requested, distribute children across
		// the full content area instead of stacking at one end (#49).
		const spread = typeof input.distributeContainedChildren === "string";
		let effectiveGap = minGap;
		let pos = content[axis];
		if (spread) {
			let totalChildSpan = 0;
			for (const child of distributable) {
				totalChildSpan += child.box[mainSize];
			}
			// Subtract reserved intervals and their required gaps so
			// the spread gap is computed from actually usable space
			// (Codex P2: advancePastReserved needs minGap around reserved).
			let reservedSpan = 0;
			const contentEnd = content[axis] + content[mainSize];
			for (const r of reserved) {
				const rStart = Math.max(r.start, content[axis]);
				const rEnd = Math.min(r.end, contentEnd);
				if (rEnd > rStart) {
					reservedSpan += rEnd - rStart + minGap;
				}
			}
			const remaining =
				content[mainSize] -
				totalChildSpan -
				reservedSpan -
				minGap * (distributable.length - 1);
			if (remaining > 0) {
				effectiveGap = minGap + remaining / (distributable.length - 1);
			}
		}
		for (const child of distributable) {
			pos = advancePastReserved(pos, child.box[mainSize], reserved, minGap);
			const crossPos =
				content[crossAxis] +
				Math.max(0, (content[crossSize] - child.box[crossSize]) / 2);
			const next: Box = { ...child.box };
			next[axis] = pos;
			next[crossAxis] = crossPos;
			const clamped = moveInside(next, content);
			// Report when clamping squashed the requested spacing.
			if (clamped[axis] !== next[axis]) {
				diagnostics.push({
					severity: "warning",
					code: "intra_container_distributed_clamped",
					message: `Distribution gap clamped for ${child.id} in ${constraint.containerId}.`,
					path: ["constraints", constraint.id ?? constraint.containerId],
					detail: { nodeId: child.id, containerId: constraint.containerId },
				});
			}
			boxes.set(child.id, clamped);
			// Fixed-position locks only yield once distribution succeeds.
			locks.delete(child.id);
			pos = clamped[axis] + clamped[mainSize] + effectiveGap;
		}

		diagnostics.push({
			severity: "info",
			code: "intra_container_distributed",
			message: `Distributed ${distributable.length} children in ${constraint.containerId} along ${axis}.`,
			path: ["constraints", constraint.id ?? constraint.containerId],
			detail: {
				containerId: constraint.containerId,
				count: distributable.length,
				axis,
			},
		});
	}

	// Swimlane distribution (Issue #60): non-contract swimlanes are
	// NOT modeled as containment constraints, so distribute children
	// inside each lane's content box separately.
	if (
		input.swimlanes !== undefined &&
		input.swimlanes.length > 0 &&
		input.distributeSwimlaneChildren
	) {
		distributeSwimlaneChildren(input, boxes, locks, diagnostics);
	}
}

/**
 * Distribute children of non-contract swimlanes inside their lane
 * content box (Issue #60).  Similar to applyDistributeContained but
 * operates on swimlane lanes instead of containment constraints.
 */
function distributeSwimlaneChildren(
	input: ConstraintSolverInput,
	boxes: Map<string, Box>,
	locks: Map<string, LayoutLock>,
	diagnostics: Diagnostic[],
): void {
	const spread = input.distributeSwimlaneChildren === "spread";
	const minGap = input.minSiblingGap ?? 8;

	for (const swimlane of input.swimlanes!) {
		if (swimlane.layout === "contract") continue;
		const isVertical = swimlane.orientation !== "horizontal";
		const axis = isVertical ? ("x" as const) : ("y" as const);
		const mainSize = isVertical ? ("width" as const) : ("height" as const);

		for (const lane of swimlane.lanes) {
			if (lane.children.length < 2) continue;

			const unlocked: { id: string; box: Box }[] = [];
			const reserved: ReservedInterval[] = [];

			for (const childId of lane.children) {
				const box = boxes.get(childId);
				if (box === undefined) continue;
				if (locks.has(childId)) {
					const lock = locks.get(childId)!;
					if (lock.source === "fixed-position") {
						unlocked.push({ id: childId, box });
						continue;
					}
					reserved.push(intervalForBox(box, axis, mainSize));
					continue;
				}
				unlocked.push({ id: childId, box });
			}

			if (unlocked.length < 2) continue;

			const contentStart = isVertical
				? Math.min(...unlocked.map((c) => c.box.x))
				: Math.min(...unlocked.map((c) => c.box.y));
			const contentEnd = isVertical
				? Math.max(...unlocked.map((c) => c.box.x + c.box.width))
				: Math.max(...unlocked.map((c) => c.box.y + c.box.height));
			const contentSpan = contentEnd - contentStart;

			const totalChildSpan = unlocked.reduce((s, c) => s + c.box[mainSize], 0);
			const reservedSpan = reserved.reduce((s, r) => s + (r.end - r.start), 0);
			let effectiveGap = minGap;
			const remaining =
				contentSpan -
				totalChildSpan -
				reservedSpan -
				minGap * (unlocked.length - 1);
			if (spread && remaining > 0) {
				effectiveGap = minGap + remaining / (unlocked.length - 1);
			}

			unlocked.sort((a, b) => a.box[axis] - b.box[axis]);

			let pos = contentStart;
			for (const child of unlocked) {
				pos = advancePastReserved(pos, child.box[mainSize], reserved, minGap);
				const newBox = { ...child.box };
				if (axis === "x") {
					newBox.x = pos;
				} else {
					newBox.y = pos;
				}
				boxes.set(child.id, newBox);
				locks.delete(child.id);
				pos += child.box[mainSize] + effectiveGap;
			}

			diagnostics.push({
				severity: "info",
				code: "intra_container_distributed",
				message: `Distributed ${unlocked.length} children in swimlane ${lane.id} along ${axis}.`,
				detail: { containerId: lane.id, count: unlocked.length, axis },
			});
		}
	}
}

function intervalForBox(
	box: Box,
	axis: "x" | "y",
	mainSize: "width" | "height",
): ReservedInterval {
	return { start: box[axis], end: box[axis] + box[mainSize] };
}

function advancePastReserved(
	pos: number,
	size: number,
	reserved: readonly ReservedInterval[],
	minGap: number,
): number {
	let next = pos;
	for (const interval of reserved) {
		if (next + size + minGap <= interval.start) {
			break;
		}
		if (next >= interval.end + minGap) {
			continue;
		}
		next = interval.end + minGap;
	}
	return next;
}

function moveInside(child: Box, container: Box): Box {
	return {
		...child,
		x: Math.min(
			Math.max(child.x, container.x),
			container.x + container.width - child.width,
		),
		y: Math.min(
			Math.max(child.y, container.y),
			container.y + container.height - child.height,
		),
	};
}

function isInside(child: Box, container: Box): boolean {
	return (
		child.x >= container.x &&
		child.y >= container.y &&
		child.x + child.width <= container.x + container.width &&
		child.y + child.height <= container.y + container.height
	);
}

function movePastOverlap(
	moving: Box,
	fixed: Box,
	primaryAxis: "x" | "y",
	spacing: number,
): Box {
	if (primaryAxis === "x") {
		const movingCenter = moving.x + moving.width / 2;
		const fixedCenter = fixed.x + fixed.width / 2;
		const x =
			movingCenter >= fixedCenter
				? fixed.x + fixed.width + spacing
				: fixed.x - moving.width - spacing;
		return { ...moving, x };
	}

	const movingCenter = moving.y + moving.height / 2;
	const fixedCenter = fixed.y + fixed.height / 2;
	const y =
		movingCenter >= fixedCenter
			? fixed.y + fixed.height + spacing
			: fixed.y - moving.height - spacing;
	return { ...moving, y };
}

function samePosition(a: Box, b: Box): boolean {
	return a.x === b.x && a.y === b.y;
}

function isFiniteBox(box: Box): boolean {
	try {
		validateBox(box);
		return true;
	} catch {
		return false;
	}
}

function isFinitePoint(point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function missingReference(
	diagnostics: Diagnostic[],
	referenceKind: string,
	id: string | undefined,
): void {
	diagnostics.push({
		severity: "error",
		code: "constraints.reference.missing",
		message: `Missing ${referenceKind} reference${id === undefined ? "" : `: ${id}`}.`,
		path: ["constraints", referenceKind],
		detail: id === undefined ? {} : { id },
	});
}
