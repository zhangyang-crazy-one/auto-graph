/** Extracted from solve.ts — behavior-preserving #77 split. */

import { expandBoxForQuery, intersectsAabb } from "../geometry/index.js";
import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	NormalizedDiagram,
	PagePolicy,
	PagePolicyOption,
	RoutingGutterAllocation,
} from "../ir/diagram.js";
import type {
	CoordinatedGroup,
	CoordinatedNode,
	NormalizedNode,
} from "../ir/elements.js";
import type { Box, Insets, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";

export const EDGE_LABEL_CLEARANCE = 8;
export const EXTERNAL_LABEL_SHELF_GAP = 48;
export const EXTERNAL_LABEL_SHELF_ROW_GAP = 8;
/** Soft-obstacle count allowed inside a proposed rail band before reject (0 = any soft obstacle rejects). */
export const RAIL_BAND_SOFT_OBSTACLE_MAX = 0;
/** Maximum accepted dependency rail lanes before capacity remediation. */
export const DEFAULT_RAIL_BUDGET = 24;
/** Hard cap on outer remediation apply iterations after route-label exhaustion. */
export const DEFAULT_MAX_REMEDIATION_ITERATIONS = 2;
/** Reserved side-gutter width for resource-flow / IBD page policies. */
export const DEFAULT_SIDE_GUTTER_WIDTH = 48;

export function cloneNormalizedNodeForSolver(
	node: NormalizedNode,
): NormalizedNode {
	return {
		...node,
		size: { ...node.size },
		padding: { ...node.padding },
		...(node.position === undefined ? {} : { position: { ...node.position } }),
		...(node.labelLayout === undefined
			? {}
			: {
					labelLayout: {
						...node.labelLayout,
						box: { ...node.labelLayout.box },
						contentBox: { ...node.labelLayout.contentBox },
						naturalSize: { ...node.labelLayout.naturalSize },
						fittedSize: { ...node.labelLayout.fittedSize },
						padding: { ...node.labelLayout.padding },
						overflow: { ...node.labelLayout.overflow },
						lines: node.labelLayout.lines.map((line) => ({
							...line,
							box: { ...line.box },
						})),
						diagnostics: node.labelLayout.diagnostics.map((diagnostic) => ({
							...diagnostic,
							...(diagnostic.path === undefined
								? {}
								: { path: [...diagnostic.path] }),
							...(diagnostic.detail === undefined
								? {}
								: { detail: { ...diagnostic.detail } }),
						})),
					},
				}),
	};
}

export function cloneBoxMap(boxes: ReadonlyMap<string, Box>): Map<string, Box> {
	return new Map(
		[...boxes.entries()].map(([id, box]) => [id, { ...box }] as const),
	);
}

export function policyUsesFanOutBundles(
	pagePolicy: PagePolicyOption | undefined,
): boolean {
	return pagePolicy === "resource-flow" || pagePolicy === "ibd-high-fan-in";
}

export function policyUsesSideGutters(
	pagePolicy: PagePolicyOption | undefined,
): boolean {
	return pagePolicy === "resource-flow" || pagePolicy === "ibd-high-fan-in";
}

export function reserveSideGutters(
	contentBounds: Box,
	direction: NormalizedDiagram["direction"],
	pagePolicy: PagePolicy,
): RoutingGutterAllocation[] {
	if (!policyUsesSideGutters(pagePolicy)) {
		return [];
	}
	const width = Math.max(
		8,
		Math.min(
			DEFAULT_SIDE_GUTTER_WIDTH,
			Math.floor(Math.min(contentBounds.width, contentBounds.height) * 0.2),
		),
	);
	if (width <= 0 || contentBounds.width <= 0 || contentBounds.height <= 0) {
		return [];
	}
	const horizontal = direction === "LR" || direction === "RL";
	if (horizontal) {
		return [
			{
				side: "left",
				box: {
					x: contentBounds.x - width,
					y: contentBounds.y,
					width,
					height: contentBounds.height,
				},
				railCount: 0,
			},
			{
				side: "right",
				box: {
					x: contentBounds.x + contentBounds.width,
					y: contentBounds.y,
					width,
					height: contentBounds.height,
				},
				railCount: 0,
			},
		];
	}
	return [
		{
			side: "top",
			box: {
				x: contentBounds.x,
				y: contentBounds.y - width,
				width: contentBounds.width,
				height: width,
			},
			railCount: 0,
		},
		{
			side: "bottom",
			box: {
				x: contentBounds.x,
				y: contentBounds.y + contentBounds.height,
				width: contentBounds.width,
				height: width,
			},
			railCount: 0,
		},
	];
}

/** Codes that justify entering the outer remediation pass after local routing. */
export const REMEDIATION_ENTRY_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
	"routing.text-clearance.unresolved",
	"routing.label-congestion.unresolved",
	"routing.label-externalization.required",
	"routing.route-label-loop.exhausted",
	"routing.rail-capacity.exceeded",
	"routing.anchor-capacity.requires-resize",
	"constraints.overlap.post-growth",
	"routing.obstacle.unavoidable",
	"routing.endpoint-interior.unavoidable",
	"routing.label-hard-obstacle.unavoidable",
	"routing.evidence.crossing_forbidden",
	"route_obstacle_fallback",
]);

export function flattenDiagnosticDetailStrings(
	diagnostics: readonly Diagnostic[],
	key: string,
): string[] {
	return diagnostics
		.map((diagnostic) => diagnostic.detail?.[key])
		.filter((value): value is string => typeof value === "string");
}

export function flattenDiagnosticDetailCsvStrings(
	diagnostics: readonly Diagnostic[],
	key: string,
): string[] {
	return flattenDiagnosticDetailStrings(diagnostics, key)
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

export function isValidInitialDimension(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

export function isFiniteInitialPoint(point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function reportPageOverflow(
	contentBounds: Box,
	pageBounds: { width: number; height: number } | undefined,
): Diagnostic[] {
	if (pageBounds === undefined) {
		return [];
	}
	const overflowRight = Math.max(
		0,
		contentBounds.x + contentBounds.width - pageBounds.width,
	);
	const overflowBottom = Math.max(
		0,
		contentBounds.y + contentBounds.height - pageBounds.height,
	);
	const overflowLeft = Math.max(0, -contentBounds.x);
	const overflowTop = Math.max(0, -contentBounds.y);
	if (
		overflowRight === 0 &&
		overflowBottom === 0 &&
		overflowLeft === 0 &&
		overflowTop === 0
	) {
		return [];
	}
	return [
		{
			severity: "warning",
			code: "page_overflow",
			message: `Content ${contentBounds.width}x${contentBounds.height} exceeds page ${pageBounds.width}x${pageBounds.height}.`,
			path: ["bounds"],
			detail: {
				page: { width: pageBounds.width, height: pageBounds.height },
				content: {
					width: contentBounds.width,
					height: contentBounds.height,
				},
				overflow: {
					right: overflowRight,
					bottom: overflowBottom,
					left: overflowLeft,
					top: overflowTop,
				},
			},
		},
	];
}

export function isTopToBottomReadingDirection(value: unknown): boolean {
	return value === "top_to_bottom" || value === "top-to-bottom";
}

// Minimum unlocked same-rank children that trigger cross-axis spread
// instead of vertical stacking (Issue #62).
export const CROSS_AXIS_SPREAD_THRESHOLD = 3;

export function removeResolvedOverlapDiagnostics(
	diagnostics: Diagnostic[],
	nodeBoxes: ReadonlyMap<string, Box>,
): void {
	for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
		const diagnostic = diagnostics[index];
		if (diagnostic?.code !== "constraints.overlap.unresolved") {
			continue;
		}
		const firstId = detailString(diagnostic, "firstId");
		const secondId = detailString(diagnostic, "secondId");
		const first = firstId === undefined ? undefined : nodeBoxes.get(firstId);
		const second = secondId === undefined ? undefined : nodeBoxes.get(secondId);
		if (
			first !== undefined &&
			second !== undefined &&
			!intersectsAabb(first, second)
		) {
			diagnostics.splice(index, 1);
		}
	}
}

export function movedConstraintNodeIds(
	constraint: Constraint,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	switch (constraint.kind) {
		case "exact-position":
			return [];
		case "containment":
			return movedContainmentViolations(constraint, nodeBoxes, movedChildIds);
		case "relative-position":
			return movedRelativeViolations(constraint, nodeBoxes, movedChildIds);
		case "align":
			return movedAlignViolations(constraint, nodeBoxes, movedChildIds);
		case "distribute":
			return movedDistributeViolations(constraint, nodeBoxes, movedChildIds);
	}
}

export function movedContainmentViolations(
	constraint: Extract<Constraint, { kind: "containment" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	const container = nodeBoxes.get(constraint.containerId);
	if (container === undefined) {
		return [];
	}
	const content = paddedContentBox(container, constraint.padding);
	return constraint.childIds.filter((childId) => {
		if (!movedChildIds.has(childId)) {
			return false;
		}
		const child = nodeBoxes.get(childId);
		return child !== undefined && !boxInside(child, content);
	});
}

export function movedRelativeViolations(
	constraint: Extract<Constraint, { kind: "relative-position" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	if (
		!movedChildIds.has(constraint.sourceId) &&
		!movedChildIds.has(constraint.referenceId)
	) {
		return [];
	}
	const source = nodeBoxes.get(constraint.sourceId);
	const reference = nodeBoxes.get(constraint.referenceId);
	if (source === undefined || reference === undefined) {
		return [];
	}
	return sameBoxPosition(
		source,
		expectedRelativeBox(source, reference, constraint),
	)
		? []
		: [constraint.sourceId];
}

export function movedAlignViolations(
	constraint: Extract<Constraint, { kind: "align" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	if (!constraint.targetIds.some((id) => movedChildIds.has(id))) {
		return [];
	}
	const targets = constraint.targetIds
		.map((id) => ({ id, box: nodeBoxes.get(id) }))
		.filter(
			(target): target is { id: string; box: Box } => target.box !== undefined,
		);
	const anchor = targets[0];
	if (anchor === undefined) {
		return [];
	}
	const expected = alignmentValue(anchor.box, constraint.axis);
	return targets
		.filter(
			(target) =>
				movedChildIds.has(target.id) &&
				!sameNumber(alignmentValue(target.box, constraint.axis), expected),
		)
		.map((target) => target.id);
}

export function movedDistributeViolations(
	constraint: Extract<Constraint, { kind: "distribute" }>,
	nodeBoxes: ReadonlyMap<string, Box>,
	movedChildIds: ReadonlySet<string>,
): string[] {
	if (!constraint.targetIds.some((id) => movedChildIds.has(id))) {
		return [];
	}
	const targets = constraint.targetIds
		.map((id) => ({ id, box: nodeBoxes.get(id) }))
		.filter(
			(target): target is { id: string; box: Box } => target.box !== undefined,
		)
		.sort((a, b) => {
			const delta =
				constraint.axis === "horizontal"
					? a.box.x - b.box.x
					: a.box.y - b.box.y;
			return delta === 0 ? a.id.localeCompare(b.id) : delta;
		});
	if (targets.length < 3) {
		return [];
	}
	const first = targets[0];
	const last = targets.at(-1);
	if (first === undefined || last === undefined) {
		return [];
	}
	const expectedSpacing =
		constraint.spacing ??
		(distributionStart(last.box, constraint.axis) -
			distributionStart(first.box, constraint.axis)) /
			(targets.length - 1);
	return targets
		.slice(1)
		.filter((target, index) => {
			const previous = targets[index];
			if (previous === undefined || !movedChildIds.has(target.id)) {
				return false;
			}
			return !sameNumber(
				distributionStart(target.box, constraint.axis) -
					distributionStart(previous.box, constraint.axis),
				expectedSpacing,
			);
		})
		.map((target) => target.id);
}

export function expectedRelativeBox(
	source: Box,
	reference: Box,
	constraint: Extract<Constraint, { kind: "relative-position" }>,
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

export function paddedContentBox(
	container: Box,
	padding: Insets | undefined,
): Box {
	const margin = padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
	return {
		x: container.x + margin.left,
		y: container.y + margin.top,
		width: container.width - margin.left - margin.right,
		height: container.height - margin.top - margin.bottom,
	};
}

export function boxInside(child: Box, container: Box): boolean {
	return (
		child.x >= container.x &&
		child.y >= container.y &&
		child.x + child.width <= container.x + container.width &&
		child.y + child.height <= container.y + container.height
	);
}

export function sameBoxPosition(first: Box, second: Box): boolean {
	return sameNumber(first.x, second.x) && sameNumber(first.y, second.y);
}

export function sameNumber(first: number, second: number): boolean {
	return Math.abs(first - second) < 0.001;
}

export function alignmentValue(
	box: Box,
	axis: Extract<Constraint, { kind: "align" }>["axis"],
): number {
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

export function distributionStart(
	box: Box,
	axis: Extract<Constraint, { kind: "distribute" }>["axis"],
): number {
	return axis === "horizontal" ? box.x : box.y;
}

export function detailString(
	diagnostic: Diagnostic,
	key: "firstId" | "secondId",
): string | undefined {
	const value = diagnostic.detail?.[key];
	return typeof value === "string" ? value : undefined;
}

export const PORT_BOX_SIZE = 10;
export const MIN_PORT_EDGE_GAP = 12;

export function boxCenter(box: Box): Point {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function containsBox(container: Box, child: Box): boolean {
	const epsilon = 0.001;
	return (
		child.x + epsilon >= container.x &&
		child.y + epsilon >= container.y &&
		child.x + child.width <= container.x + container.width + epsilon &&
		child.y + child.height <= container.y + container.height + epsilon
	);
}

export function expand(box: Box, padding: number, titleSize: number): Box {
	return {
		x: box.x - padding,
		y: box.y - padding - titleSize,
		width: box.width + padding * 2,
		height: box.height + padding * 2 + titleSize,
	};
}

export function edgeCorridorBox(source: Box, target: Box, margin: number): Box {
	const minX = Math.min(source.x, target.x);
	const minY = Math.min(source.y, target.y);
	const maxX = Math.max(source.x + source.width, target.x + target.width);
	const maxY = Math.max(source.y + source.height, target.y + target.height);
	return expandBoxForQuery(
		{ x: minX, y: minY, width: maxX - minX, height: maxY - minY },
		margin,
	);
}

export function sameBox(first: Box, second: Box): boolean {
	return (
		first.x === second.x &&
		first.y === second.y &&
		first.width === second.width &&
		first.height === second.height
	);
}

/**
 * Collect every group (including nested ancestors) that contains
 * the given node, by walking `group.nodeIds` and `group.groupIds`.
 */
export function ancestorGroupIds(
	groups: readonly CoordinatedGroup[],
	nodeId: string,
): Set<string> {
	const direct = new Set<string>();
	for (const group of groups) {
		if (group.nodeIds.includes(nodeId)) {
			direct.add(group.id);
		}
	}
	// Walk upward: if a group contains any of the direct parent groups,
	// it is an ancestor container that should also be skipped.
	let previousSize = -1;
	const ancestors = new Set(direct);
	while (ancestors.size !== previousSize) {
		previousSize = ancestors.size;
		for (const group of groups) {
			for (const candidate of ancestors) {
				if (group.groupIds.includes(candidate)) {
					ancestors.add(group.id);
					break;
				}
			}
		}
	}
	return ancestors;
}

export function boxJson(
	box: Box,
): NonNullable<SolvedTextAnnotation["placementDetail"]> {
	return {
		x: box.x,
		y: box.y,
		width: box.width,
		height: box.height,
	};
}

export function numberDetail(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function stableStrings(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function insetBox(box: Box, amount: number): Box {
	return {
		x: box.x + amount,
		y: box.y + amount,
		width: Math.max(0, box.width - amount * 2),
		height: Math.max(0, box.height - amount * 2),
	};
}

export function pointInsideBox(point: Point, box: Box): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

export function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return high > min && low < max;
}

export function compactDetail(
	detail: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(detail).filter(
			(entry): entry is [string, string | number | boolean] =>
				entry[1] !== undefined,
		),
	);
}

export function compartmentRows(node: CoordinatedNode): string[] {
	const compartments = node.compartments;
	if (compartments === undefined) {
		return [];
	}
	return [
		...(compartments.stereotype === undefined ? [] : [compartments.stereotype]),
		...(compartments.name === undefined
			? [node.label?.text ?? node.id]
			: [compartments.name]),
		...(compartments.properties ?? []),
		...(compartments.constraints ?? []),
	];
}

export function stableUniqueById<T extends { id: string }>(
	items: readonly T[],
	diagnostics: Diagnostic[],
	pathRoot: string,
	code: string,
): T[] {
	const firstById = new Map<string, T>();
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (item === undefined) {
			continue;
		}
		if (firstById.has(item.id)) {
			diagnostics.push({
				severity: "error",
				code,
				message: `Duplicate ${pathRoot.slice(0, -1)} id ${item.id} was ignored; first occurrence was kept.`,
				path: [pathRoot, index, "id"],
				detail: { id: item.id, duplicateIndex: index },
			});
			continue;
		}
		firstById.set(item.id, item);
	}
	return [...firstById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function stableByConstraintId<T extends { id?: string; kind: string }>(
	items: readonly T[],
): T[] {
	return [...items].sort((a, b) =>
		`${a.id ?? a.kind}`.localeCompare(`${b.id ?? b.kind}`),
	);
}

export function groupReferenceMissing(
	groupId: string,
	referenceKind: string,
	id: string | undefined,
): Diagnostic {
	return {
		severity: "error",
		code: "solver.group-reference.missing",
		message: `Group ${groupId} references a missing ${referenceKind}.`,
		path: ["groups", groupId],
		detail: id === undefined ? { groupId } : { groupId, id },
	};
}
