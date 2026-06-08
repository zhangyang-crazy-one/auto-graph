import { intersectsAabb, validateBox } from "../geometry/boxes.js";
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
	applyContainment(input.constraints, boxes, locks, diagnostics, false);
	applyRelative(input.constraints, boxes, locks, diagnostics);
	applyAlign(input.constraints, boxes, locks, diagnostics);
	applyDistribute(input.constraints, boxes, locks, diagnostics);
	repairOverlaps(input, boxes, locks, diagnostics);
	applyContainment(input.constraints, boxes, locks, diagnostics, true);
	reportOverlaps(boxes, diagnostics, containmentOverlapKeys(input.constraints));

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

			if (locks.has(childId)) {
				if (!reportOverflow) {
					diagnostics.push({
						severity: "warning",
						code: "constraints.locked-target-not-moved",
						message: `Locked child ${childId} was not moved into containment.`,
						path: ["constraints", constraint.id ?? constraint.containerId],
						detail: { nodeId: childId },
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
): void {
	const spacing = input.overlapSpacing ?? 40;
	const axis = input.direction === "LR" || input.direction === "RL" ? "x" : "y";
	const secondaryAxis = axis === "x" ? "y" : "x";
	const ids = [...boxes.keys()].sort();

	for (let pass = 0; pass < 2; pass += 1) {
		for (const firstId of ids) {
			for (const secondId of ids) {
				if (firstId >= secondId) {
					continue;
				}

				const first = boxes.get(firstId);
				const second = boxes.get(secondId);
				if (
					first === undefined ||
					second === undefined ||
					!intersectsAabb(first, second)
				) {
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
				const moved = movePastOverlap(moving, fixed, repairAxis, spacing);
				boxes.set(movingId, moved);
			}
		}
	}

	reportOverlaps(boxes, diagnostics);
}

function reportOverlaps(
	boxes: ReadonlyMap<string, Box>,
	diagnostics: Diagnostic[],
	ignoredPairs: ReadonlySet<string> = new Set(),
): void {
	const ids = [...boxes.keys()].sort();
	const reported = new Set(
		diagnostics
			.filter(
				(diagnostic) => diagnostic.code === "constraints.overlap.unresolved",
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

	for (const firstId of ids) {
		for (const secondId of ids) {
			if (firstId >= secondId) {
				continue;
			}
			const key = overlapKey(firstId, secondId);
			if (reported.has(key) || ignoredPairs.has(key)) {
				continue;
			}

			const first = boxes.get(firstId);
			const second = boxes.get(secondId);
			if (
				first !== undefined &&
				second !== undefined &&
				intersectsAabb(first, second)
			) {
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
		diagnostics.push({
			severity: "warning",
			code: "constraints.locked-target-not-moved",
			message: `Locked target ${id} was not moved by ${constraint.kind}.`,
			path: ["constraints", constraint.id ?? id],
			detail: { nodeId: id, constraintKind: constraint.kind },
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
		width: container.width - margin.left - margin.right,
		height: container.height - margin.top - margin.bottom,
	};
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
