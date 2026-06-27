import { applyLayoutConstraints } from "../constraints/index.js";
import {
	DEFAULT_FONT,
	DEFAULT_LABEL_MAX_WIDTH,
	DEFAULT_NODE_MIN_SIZE,
	DEFAULT_NODE_PADDING,
} from "../dsl/normalize.js";
import { computeArrowhead } from "../exporters/arrow.js";
import {
	computeContainerGeometry,
	computeShapeGeometry,
	createBoxSpatialIndex,
	expandBox,
	expandBoxForQuery,
	intersectsAabb,
	normalizeInsets,
	queryBoxSpatialIndex,
	unionBoxes,
} from "../geometry/index.js";
import type { Constraint } from "../ir/constraints.js";
import {
	DELIVERABILITY_DIAGNOSTIC_CODES,
	type Diagnostic,
} from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedEvidencePanel,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedMatrixBlock,
	CoordinatedNode,
	CoordinatedPort,
	CoordinatedTableBlock,
	EvidencePanel,
	EvidenceTextLayout,
	MatrixBlock,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
	SwimlaneLane,
	TableBlock,
	VisualStyle,
} from "../ir/elements.js";
import type { Box, Insets, Point, Size } from "../ir/geometry.js";
import type {
	LabelLayout,
	SolvedTextAnnotation,
	TextSurfaceKind,
} from "../ir/label-layout.js";
import { fitLabel } from "../labels/index.js";
import {
	type InitialLayoutResult,
	runComponentAwareDagreInitialLayout,
	runDagreInitialLayout,
} from "../layout/index.js";
import { runRecursiveContainerLayout } from "../layout/recursive.js";
import { type RouteKind, routeEdge } from "../routing/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import type { TextMeasurer, TextStyleOptions } from "../text/types.js";
import { LayoutPipeline } from "./pipeline/pipeline.js";
import { scoreLayoutQuality } from "./pipeline/quality.js";
import type { LayoutState } from "./pipeline/types.js";

export type InitialLayoutMode = "dagre" | "positions";

export interface SolveDiagramOptions {
	/** Selects the seed coordinates before constraints, routing, and export. */
	initialLayout?: InitialLayoutMode;
	/** When true, use recursive bottom-up layout for container groups (Issue #54, 方案 A). */
	recursiveLayout?: boolean;
	routeKind?: RouteKind;
	obstacleMargin?: number | Insets;
	/** When true, compute quality score after solving (Issue #54, 方案 E). */
	qualityScore?: boolean;
	/** Extra horizontal/vertical clearance reserved around nodes for edge corridors. */
	routingGutter?: number;
	overlapSpacing?: number;
	minLaneGutter?: number;
	prefitLabelSize?: boolean;
	minSiblingGap?: number;
	distributeContainedChildren?: boolean | "spread";
	/** When "spread", distribute children within non-contract swimlane
	 * lanes (Issue #60). Opt-in: no redistribution occurs unless explicitly set. */
	distributeSwimlaneChildren?: boolean | "spread";
	pageBounds?: { width: number; height: number };
	maxStackDepth?: number;
	preferredAspectRatio?: number;
	/** Target aspect ratio (width/height). When bounds exceed
	 * target*3, nodes are rewrapped (Issue #60). */
	targetAspectRatio?: number;
	/** Max nodes per row for TB/BT horizontal-rewrap (Issue #60). */
	maxRowDepth?: number;
	portShifting?: PortShiftingOptions;
	cjkFontFamily?: string | false;
	minCjkFontSize?: number | false;
	textMeasurer?: TextMeasurer;
	/** When true, promote deliverability-breaking diagnostics to errors. */
	strict?: boolean;
	/** Maximum greedy rerouting iterations per edge (default 5). */
	maxRoutingAttempts?: number;
	/** Edge label placement mode: "beside" offsets away from the edge, "on-path" (default) places at the midpoint. */
	labelPlacement?: "beside" | "on-path";
	/** Pixels to offset edge labels from the edge path when labelPlacement is "beside". */
	labelOffset?: number;
}

export interface PortShiftingOptions {
	enabled?: boolean;
	spacing?: number;
}

const DEFAULT_MATRIX_CELL_SIZE: Size = { width: 120, height: 36 };
const DEFAULT_TABLE_CELL_SIZE: Size = { width: 128, height: 34 };
const DEFAULT_PANEL_WIDTH = 320;
const DEFAULT_PANEL_ITEM_HEIGHT = 28;
const DEFAULT_EVIDENCE_BLOCK_GAP = 24;
const EDGE_LABEL_CLEARANCE = 8;
const DEFAULT_CJK_FONT_FAMILY = "YaHei,SimSun,sans-serif";
const DEFAULT_MIN_CJK_FONT_SIZE = 14;
// Reuse DSL defaults — these are the same values as DEFAULT_FONT,
// DEFAULT_NODE_PADDING, DEFAULT_NODE_MIN_SIZE, DEFAULT_LABEL_MAX_WIDTH
// imported from normalize.ts above.
function prefitLabelFont(
	node: NormalizedNode,
	_options: SolveDiagramOptions,
): TextStyleOptions {
	const cjk = labelCjkTypography(node.label?.metadata);
	const fontFamily = cjk.fontFamily ?? DEFAULT_FONT.fontFamily;
	const fontSize = cjk.fontSize ?? DEFAULT_FONT.fontSize;
	const lineHeight =
		fontSize !== DEFAULT_FONT.fontSize
			? Math.max(DEFAULT_FONT.lineHeight ?? 18, fontSize * 1.2)
			: (DEFAULT_FONT.lineHeight ?? 18);
	return { fontFamily, fontSize, lineHeight };
}

const EVIDENCE_TEXT_FONT = {
	fontFamily: "Arial, sans-serif",
	fontSize: 10,
	lineHeight: 12,
} as const;

interface SwimlaneContractLayout {
	box: Box;
	slotWidth: number;
	slotHeight: number;
	laneStep: number;
}

interface SwimlaneContractResult {
	layouts: Map<string, SwimlaneContractLayout>;
	diagnostics: Diagnostic[];
	movedChildIds: Set<string>;
}

interface LayoutLockLike {
	nodeId: string;
	source: string;
}

interface CjkTypographyOptions {
	fontFamily?: string;
	minFontSize?: number;
}

interface CjkTypography {
	fontFamily?: string;
	fontSize?: number;
}

export function solveDiagram(
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions = {},
): CoordinatedDiagram {
	const diagnostics: Diagnostic[] = [...diagram.diagnostics];
	const nodes = stableUniqueById(
		diagram.nodes,
		diagnostics,
		"nodes",
		"duplicate_node_id",
	);
	const edges = stableUniqueById(
		diagram.edges,
		diagnostics,
		"edges",
		"duplicate_edge_id",
	);
	const groups = stableUniqueById(
		diagram.groups,
		diagnostics,
		"groups",
		"duplicate_group_id",
	);
	const cjkTypography = createCjkTypographyOptions(options);
	const cjkStyledNodes = nodes.map((node) =>
		enhanceNodeCjkTypography(node, cjkTypography, diagnostics),
	);
	const styledNodes =
		options.prefitLabelSize === true
			? cjkStyledNodes.map((node) =>
					prefitNodeLabelSize(node, options, diagnostics),
				)
			: cjkStyledNodes;
	const styledEdges = edges.map((edge) =>
		enhanceEdgeCjkTypography(edge, cjkTypography, diagnostics),
	);
	const styledGroups = groups.map((group) =>
		enhanceGroupCjkTypography(group, cjkTypography, diagnostics),
	);
	const styledSwimlanes = (diagram.swimlanes ?? []).map((swimlane) =>
		enhanceSwimlaneCjkTypography(swimlane, cjkTypography, diagnostics),
	);
	const constraints = stableByConstraintId(diagram.constraints);
	const initialLayoutMode = options.initialLayout ?? "dagre";
	const useRecursive = options.recursiveLayout === true;
	if (useRecursive && initialLayoutMode === "positions") {
		diagnostics.push({
			severity: "warning",
			code: "layout.recursive-ignores-positions",
			message:
				'recursiveLayout overrides initialLayout "positions" — seed positions are ignored for bottom-up container layout.',
		});
	}
	const layout = useRecursive
		? runRecursiveContainerLayout({
				direction: diagram.direction,
				nodes: styledNodes,
				groups: styledGroups,
				edges: styledEdges,
				constraints,
			})
		: runInitialLayout({
				mode: initialLayoutMode,
				componentAware: options.maxStackDepth === undefined,
				direction: diagram.direction,
				nodes: styledNodes,
				edges: styledEdges,
			});

	diagnostics.push(...layout.diagnostics);
	const initialNodeBoxes =
		initialLayoutMode === "positions" ||
		(diagram.direction !== "LR" && diagram.direction !== "RL")
			? layout.boxes
			: wrapVerticalStackIfNeeded(
					layout.boxes,
					styledNodes,
					styledEdges,
					diagram.direction,
					options,
					diagnostics,
				);

	// Horizontal rewrap for TB/BT layouts (Issue #60).
	if (
		(diagram.direction === "TB" || diagram.direction === "BT") &&
		(options.maxRowDepth !== undefined ||
			options.targetAspectRatio !== undefined)
	) {
		const diagCountBefore = diagnostics.length;
		const rewrapped = wrapHorizontalStackIfNeeded(
			initialNodeBoxes,
			styledNodes,
			diagram.direction,
			options,
			diagnostics,
		);
		for (const [id, box] of rewrapped) {
			initialNodeBoxes.set(id, box);
		}
		// Only clear position fields when the rewrap actually executed
		// (horizontal_runaway diagnostic was emitted).
		if (diagnostics.length > diagCountBefore) {
			for (const node of styledNodes) {
				if (node.position !== undefined && rewrapped.has(node.id)) {
					const rwBox = rewrapped.get(node.id)!;
					// Clone node before setting position to avoid mutating
					// caller diagram.nodes (Issue #61 codex P2).
					const idx = styledNodes.indexOf(node);
					if (idx !== -1) {
						styledNodes[idx] = {
							...node,
							position: { x: rwBox.x, y: rwBox.y },
						};
					}
				}
			}
		}
	}
	// When using recursive layout, pre-populate group boxes from
	// bottom-up layout so downstream coordinateGroups does not
	// recompute them from scratch.
	if (useRecursive && "groupBoxes" in layout) {
		const recursiveLayout =
			layout as import("../layout/recursive.js").RecursiveLayoutResult;
		for (const [groupId, groupBox] of recursiveLayout.groupBoxes) {
			initialNodeBoxes.set(groupId, groupBox);
		}
	}

	// Expand node boxes for port capacity before constraint solving
	// so containment, overlap repair, and swimlane contracts see the
	// final sizes (Codex P2: avoid post-hoc expansion issues).
	expandNodeBoxesForPorts(styledNodes, initialNodeBoxes, options, diagnostics);

	const constrained = applyLayoutConstraints({
		direction: diagram.direction,
		overlapSpacing: options?.overlapSpacing ?? 40,
		...(options.minSiblingGap === undefined
			? {}
			: { minSiblingGap: options.minSiblingGap }),
		distributeContainedChildren: options.distributeContainedChildren ?? true,
		...(options.distributeSwimlaneChildren !== undefined
			? { distributeSwimlaneChildren: options.distributeSwimlaneChildren }
			: {}),
		swimlanes: styledSwimlanes,
		boxes: initialNodeBoxes,
		nodes: styledNodes,
		groups: styledGroups,
		constraints,
	});

	diagnostics.push(...constrained.diagnostics);
	const swimlaneContracts = applySwimlaneLayoutContracts(
		styledSwimlanes,
		constraints,
		styledEdges,
		isTopToBottomReadingDirection(diagram.metadata?.primaryReadingDirection),
		constrained.boxes,
		constrained.locks,
		options?.overlapSpacing ?? 40,
		Math.max(0, options?.minLaneGutter ?? 0),
	);
	// Distribution may resolve overlaps that were reported earlier
	// by repairOverlaps — clean those up before continuing.
	removeResolvedOverlapDiagnostics(diagnostics, constrained.boxes);
	diagnostics.push(...swimlaneContracts.diagnostics);

	const coordinatedNodes = coordinateNodes(
		styledNodes,
		constrained.boxes,
		options,
		diagnostics,
	);
	const nodeGeometryById = new Map(
		coordinatedNodes.map((node) => [
			node.id,
			computeShapeGeometry({
				shape: node.shape,
				box: node.box,
				obstacleMargin: options.obstacleMargin ?? 0,
			}),
		]),
	);
	const coordinatedGroups = coordinateGroups(
		styledGroups,
		constrained.boxes,
		options,
		diagnostics,
	);
	const coordinatedSwimlanes = coordinateSwimlanes(
		styledSwimlanes,
		constrained.boxes,
		swimlaneContracts.layouts,
	);
	const coordinatedMatrices = coordinateMatrices(diagram.matrices ?? []);
	const coordinatedTables = coordinateTables(diagram.tables ?? []);
	const coordinatedEvidencePanels = coordinateEvidencePanels(
		diagram.evidencePanels ?? [],
	);
	const groupBoxes = new Map(
		coordinatedGroups.map((group) => [group.id, group.box]),
	);
	const baseTextAnnotations = coordinateBaseTextAnnotations({
		nodes: coordinatedNodes,
		groups: coordinatedGroups,
		swimlanes: coordinatedSwimlanes,
		...(options.textMeasurer === undefined
			? {}
			: { textMeasurer: options.textMeasurer }),
	});
	const edgeLabelEstimates = estimateEdgeLabelAnnotations(
		styledEdges,
		nodeGeometryById,
		options.textMeasurer,
	);
	const layoutBoxes = [
		...coordinatedNodes.map((node) => node.box),
		...coordinatedNodes.flatMap((node) =>
			(node.ports ?? []).flatMap((port) =>
				port.label === undefined ? [port.box] : [port.box, portLabelBox(port)],
			),
		),
		...groupBoxes.values(),
		...coordinatedSwimlanes.flatMap((swimlane) =>
			swimlane.box === undefined ? [] : [swimlane.box],
		),
		...baseTextAnnotations.map((annotation) => annotation.box),
	];
	const initialContentBounds =
		layoutBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(layoutBoxes);
	placeEvidenceBlocks(
		options.obstacleMargin ?? 0,
		[
			...coordinatedMatrices,
			...coordinatedTables,
			...coordinatedEvidencePanels,
		],
		initialContentBounds,
	);
	refreshTableColumnXOffsets(coordinatedTables);
	measureEvidenceTextBlocks(
		coordinatedMatrices,
		coordinatedTables,
		coordinatedEvidencePanels,
		options.textMeasurer,
	);
	const evidenceBoxes = [
		...coordinatedMatrices.map((matrix) => matrix.box),
		...coordinatedTables.map((table) => table.box),
		...coordinatedEvidencePanels.map((panel) => panel.box),
	];
	diagnostics.push(
		...reportEvidenceBlockOverlaps(
			[
				...coordinatedMatrices.map((matrix) => ({
					id: matrix.id,
					kind: "matrix",
					...(matrix.position === undefined
						? {}
						: { position: matrix.position }),
					box: matrix.box,
				})),
				...coordinatedTables.map((table) => ({
					id: table.id,
					kind: "table",
					...(table.position === undefined ? {} : { position: table.position }),
					box: table.box,
				})),
				...coordinatedEvidencePanels.map((panel) => ({
					id: panel.id,
					kind: "evidence-panel",
					...(panel.position === undefined ? {} : { position: panel.position }),
					box: panel.box,
				})),
			],
			[
				...coordinatedNodes.map((node) => ({
					id: node.id,
					kind: "node",
					box: node.box,
				})),
				...coordinatedGroups.map((group) => ({
					id: group.id,
					kind: "group",
					box: group.box,
				})),
				...coordinatedSwimlanes.flatMap((swimlane) =>
					swimlane.box === undefined
						? []
						: [{ id: swimlane.id, kind: "swimlane", box: swimlane.box }],
				),
			],
		),
	);
	const allBoxes = [...layoutBoxes, ...evidenceBoxes];
	const contentBounds =
		allBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(allBoxes);
	const frame =
		diagram.frame === undefined
			? undefined
			: coordinateFrame(diagram.frame, contentBounds);
	const frameTextAnnotation =
		frame === undefined
			? []
			: [coordinateFrameTextAnnotation(frame, options.textMeasurer)];
	const routingTextObstacles = [
		...baseTextAnnotations.filter(isPreRouteTextObstacle),
		...frameTextAnnotation.filter(isPreRouteTextObstacle),
		// Dry-run edge-label estimates so edges route around
		// each other's label areas (Issue #41).
		...edgeLabelEstimates,
	];
	// Expand evidence-block boxes by obstacleMargin so edges route
	// around them with the same clearance as node/group boxes.
	const margin = options.obstacleMargin ?? 0;
	const softObstacles = [
		...coordinatedTables.map((table) => expandBox(table.box, margin)),
		...coordinatedEvidencePanels.map((panel) => expandBox(panel.box, margin)),
	];
	const hardObstacles = coordinatedMatrices.map((matrix) =>
		expandBox(matrix.box, margin),
	);

	// Include frame title box and swimlane lane header boxes so edges
	// do not route through title bars (issue #29).
	const titleBarObstacles: Box[] = [];
	if (frame !== undefined) {
		titleBarObstacles.push(expandBox(frame.titleBox, margin));
	}
	for (const swimlane of coordinatedSwimlanes) {
		for (const lane of swimlane.lanes) {
			if (
				lane.headerBox !== undefined &&
				lane.headerBox.width > 0 &&
				lane.headerBox.height > 0
			) {
				titleBarObstacles.push(expandBox(lane.headerBox, margin));
			}
		}
	}

	const coordinatedEdges = coordinateEdges(
		styledEdges,
		nodeGeometryById,
		coordinatedNodes,
		[...nodeGeometryById.values()].map((geometry) =>
			options.routingGutter === undefined
				? geometry.obstacleBox
				: expandBox(geometry.obstacleBox, options.routingGutter),
		),
		[...softObstacles, ...titleBarObstacles],
		routingTextObstacles,
		hardObstacles,
		diagram.direction,
		options,
		diagnostics,
		coordinatedGroups,
	);
	const edgeTextAnnotations = coordinateEdgeTextAnnotations(
		coordinatedEdges,
		[
			...coordinatedNodes.map((node) => node.box),
			...baseTextAnnotations.map((annotation) => annotation.box),
			...frameTextAnnotation.map((annotation) => annotation.box),
		],
		options.textMeasurer,
		options.labelPlacement,
		options.labelOffset,
	);
	const textAnnotations = [
		...baseTextAnnotations,
		...frameTextAnnotation,
		...edgeTextAnnotations,
	];
	diagnostics.push(...reportTextAnnotationCollisions(textAnnotations));
	diagnostics.push(
		...reportRouteTextClearance(coordinatedEdges, textAnnotations),
	);
	const edgePointBounds = edgeBounds(coordinatedEdges);
	const boundsBase = [
		contentBounds,
		...edgePointBounds,
		...edgeTextAnnotations.map((annotation) => annotation.box),
	];
	diagnostics.push(
		...reportPageOverflow(
			frame === undefined
				? unionBoxes(boundsBase)
				: unionBoxes([...boundsBase, frame.box, frame.titleBox]),
			options.pageBounds,
		),
	);

	let degraded = false;
	const resultDiagnostics = diagnostics.map((diagnostic) => {
		if (DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code)) {
			degraded = true;
			if (options.strict) {
				return { ...diagnostic, severity: "error" as const };
			}
		}
		return diagnostic;
	});

	return {
		id: diagram.id,
		...(diagram.title === undefined ? {} : { title: diagram.title }),
		direction: diagram.direction,
		nodes: coordinatedNodes,
		edges: coordinatedEdges,
		groups: coordinatedGroups,
		...(coordinatedSwimlanes.length === 0
			? {}
			: { swimlanes: coordinatedSwimlanes }),
		...(coordinatedMatrices.length === 0
			? {}
			: { matrices: coordinatedMatrices }),
		...(coordinatedTables.length === 0 ? {} : { tables: coordinatedTables }),
		...(coordinatedEvidencePanels.length === 0
			? {}
			: { evidencePanels: coordinatedEvidencePanels }),
		diagnostics: resultDiagnostics,
		degraded,
		bounds:
			frame === undefined
				? unionBoxes(boundsBase)
				: unionBoxes([...boundsBase, frame.box, frame.titleBox]),
		...(frame === undefined ? {} : { frame }),
		...(textAnnotations.length === 0 ? {} : { textAnnotations }),
		...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
	};
}

/**
 * Convenience wrapper around {@link solveDiagram} that enables
 * {@link SolveDiagramOptions.prefitLabelSize} by default so node sizes are
 * expanded to fit their label text.  Direct callers of `solveDiagram` who
 * pass hard-coded `NormalizedNode.size` values without a `labelLayout`
 * often see truncated labels; this wrapper avoids that trap.
 *
 * @see SolveDiagramOptions.prefitLabelSize
 */
export function solveDiagramSafe(
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions = {},
): CoordinatedDiagram {
	return solveDiagram(diagram, { ...options, prefitLabelSize: true });
}

function runInitialLayout(input: {
	mode: InitialLayoutMode;
	componentAware: boolean;
	direction: NormalizedDiagram["direction"];
	nodes: readonly NormalizedNode[];
	edges: readonly NormalizedEdge[];
}): InitialLayoutResult {
	if (input.mode === "positions") {
		return runPositionSeededInitialLayout(input);
	}

	const runAutoLayout = input.componentAware
		? runComponentAwareDagreInitialLayout
		: runDagreInitialLayout;
	return runAutoLayout({
		direction: input.direction,
		nodes: input.nodes.map((node) => ({ id: node.id, size: node.size })),
		edges: input.edges.map((edge) => ({
			id: edge.id,
			sourceId: edge.source.nodeId,
			targetId: edge.target.nodeId,
		})),
	});
}

function runPositionSeededInitialLayout(input: {
	direction: NormalizedDiagram["direction"];
	nodes: readonly NormalizedNode[];
	edges: readonly NormalizedEdge[];
}): InitialLayoutResult {
	const diagnostics: Diagnostic[] = [];
	const boxes = new Map<string, Box>();
	const autoNodes: NormalizedNode[] = [];

	for (const node of input.nodes) {
		if (
			!isValidInitialDimension(node.size.width) ||
			!isValidInitialDimension(node.size.height)
		) {
			diagnostics.push({
				severity: "error",
				code: "layout.node-size.invalid",
				message: `Node ${node.id} has invalid layout dimensions.`,
				path: ["nodes", node.id, "size"],
				detail: { nodeId: node.id },
			});
			continue;
		}

		if (node.position === undefined) {
			autoNodes.push(node);
			continue;
		}

		if (!isFiniteInitialPoint(node.position)) {
			diagnostics.push({
				severity: "error",
				code: "layout.node-position.invalid",
				message: `Node ${node.id} has an invalid seeded position.`,
				path: ["nodes", node.id, "position"],
				detail: { nodeId: node.id },
			});
			continue;
		}

		boxes.set(node.id, {
			x: node.position.x,
			y: node.position.y,
			width: node.size.width,
			height: node.size.height,
		});
	}

	if (autoNodes.length === 0) {
		return { boxes, diagnostics };
	}

	const autoNodeIds = new Set(autoNodes.map((node) => node.id));
	const autoLayout = runComponentAwareDagreInitialLayout({
		direction: input.direction,
		nodes: autoNodes.map((node) => ({ id: node.id, size: node.size })),
		edges: input.edges
			.filter(
				(edge) =>
					autoNodeIds.has(edge.source.nodeId) &&
					autoNodeIds.has(edge.target.nodeId),
			)
			.map((edge) => ({
				id: edge.id,
				sourceId: edge.source.nodeId,
				targetId: edge.target.nodeId,
			})),
	});
	diagnostics.push(...autoLayout.diagnostics);
	for (const [id, box] of autoLayout.boxes) {
		boxes.set(id, box);
	}

	return { boxes, diagnostics };
}

function isValidInitialDimension(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function isFiniteInitialPoint(point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function prefitNodeLabelSize(
	node: NormalizedNode,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): NormalizedNode {
	if (node.label === undefined) {
		return node;
	}
	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
	const layout = fitLabel(
		node.label.text,
		{
			font: prefitLabelFont(node, options),
			padding: DEFAULT_NODE_PADDING,
			minSize: DEFAULT_NODE_MIN_SIZE,
			maxWidth:
				node.label.maxWidth ??
				Math.max(node.size.width, DEFAULT_LABEL_MAX_WIDTH),
		},
		measurer,
	);
	const width = Math.max(node.size.width, layout.fittedSize.width);
	const height = Math.max(node.size.height, layout.fittedSize.height);
	const resized = width !== node.size.width || height !== node.size.height;
	if (resized) {
		diagnostics.push({
			severity: "info",
			code: "prefit_label_resized",
			message: `Node ${node.id} size expanded to fit its label.`,
			path: ["nodes", node.id],
			detail: {
				nodeId: node.id,
				from: { width: node.size.width, height: node.size.height },
				to: { width, height },
			},
		});
	}
	// Center the label layout within the node dimensions so the
	// annotation is visually centered even when the node is larger
	// than what the label text requires (codex P2).
	const centeredLayout = expandLabelLayoutToNode(layout, { width, height });
	return { ...node, size: { width, height }, labelLayout: centeredLayout };
}
function expandLabelLayoutToNode(
	layout: LabelLayout,
	nodeSize: Size,
): LabelLayout {
	if (
		layout.box.width >= nodeSize.width &&
		layout.box.height >= nodeSize.height
	) {
		return layout;
	}
	const offsetX = Math.max(0, (nodeSize.width - layout.box.width) / 2);
	const offsetY = Math.max(0, (nodeSize.height - layout.box.height) / 2);
	if (offsetX === 0 && offsetY === 0) {
		return layout;
	}
	return {
		...layout,
		box: {
			x: layout.box.x + offsetX,
			y: layout.box.y + offsetY,
			width: layout.box.width,
			height: layout.box.height,
		},
	};
}

function reportPageOverflow(
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

function createCjkTypographyOptions(
	options: SolveDiagramOptions,
): CjkTypographyOptions {
	const fontFamily =
		options.cjkFontFamily === false
			? undefined
			: (options.cjkFontFamily ?? DEFAULT_CJK_FONT_FAMILY);
	const minFontSize =
		options.minCjkFontSize === false
			? undefined
			: (options.minCjkFontSize ?? DEFAULT_MIN_CJK_FONT_SIZE);
	return {
		...(fontFamily === undefined ? {} : { fontFamily }),
		...(minFontSize === undefined ? {} : { minFontSize }),
	};
}

function enhanceNodeCjkTypography(
	node: NormalizedNode,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): NormalizedNode {
	const nodeWithStyle = enhanceStyledLabelOwner(
		node,
		["nodes", node.id],
		options,
		diagnostics,
	);
	const ports =
		nodeWithStyle.ports === undefined
			? undefined
			: nodeWithStyle.ports.map((port) =>
					enhanceStyledLabelOwner(
						port,
						["nodes", node.id, "ports", port.id],
						options,
						diagnostics,
					),
				);
	return ports === undefined ? nodeWithStyle : { ...nodeWithStyle, ports };
}

function enhanceEdgeCjkTypography(
	edge: NormalizedEdge,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): NormalizedEdge {
	return enhanceStyledLabelOwner(
		edge,
		["edges", edge.id],
		options,
		diagnostics,
	);
}

function enhanceGroupCjkTypography(
	group: NormalizedGroup,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): NormalizedGroup {
	return enhanceStyledLabelOwner(
		group,
		["groups", group.id],
		options,
		diagnostics,
	);
}

function enhanceSwimlaneCjkTypography(
	swimlane: Swimlane,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): Swimlane {
	const root = enhanceStyledLabelOwner(
		swimlane,
		["swimlanes", swimlane.id],
		options,
		diagnostics,
	);
	const lanes = root.lanes.map((lane) =>
		enhanceSwimlaneLaneCjkTypography(swimlane.id, lane, options, diagnostics),
	);
	return { ...root, lanes };
}

function enhanceSwimlaneLaneCjkTypography(
	swimlaneId: string,
	lane: SwimlaneLane,
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): SwimlaneLane {
	return enhanceStyledLabelOwner(
		lane,
		["swimlanes", swimlaneId, "lanes", lane.id],
		options,
		diagnostics,
	);
}

function enhanceStyledLabelOwner<
	T extends { id: string; label?: { text: string; metadata?: unknown } },
>(
	owner: T,
	path: readonly (string | number)[],
	options: CjkTypographyOptions,
	diagnostics: Diagnostic[],
): T {
	const text = owner.label?.text;
	if (text === undefined || !containsCjk(text)) {
		return owner;
	}
	const typography = cjkTypographyForOwner(owner, options);
	if (
		typography.fontFamily === undefined &&
		typography.fontSize === undefined
	) {
		return owner;
	}
	const label = owner.label;
	if (label === undefined) {
		return owner;
	}
	const nextLabel = {
		...label,
		metadata: {
			...metadataObject(label.metadata),
			cjkTypography: typography,
		},
	};
	const nextOwner = { ...owner, label: nextLabel };
	const maybeStyled = nextOwner as T & { style?: VisualStyle };
	const nextStyle = enhanceCjkStyle(maybeStyled.style, typography);
	reportCjkTypographyDiagnostics(
		path,
		typography,
		maybeStyled.style,
		diagnostics,
	);
	return nextStyle === maybeStyled.style
		? nextOwner
		: { ...nextOwner, style: nextStyle };
}

function cjkTypographyForOwner(
	owner: {
		label?: { metadata?: unknown } | undefined;
		style?: VisualStyle | undefined;
	},
	options: CjkTypographyOptions,
): CjkTypography {
	const metadataTypography = labelCjkTypography(owner.label?.metadata);
	const fontFamily =
		metadataTypography.fontFamily ??
		owner.style?.fontFamily ??
		options.fontFamily;
	const fontSize = boostedCjkFontSize(
		metadataTypography.fontSize ?? owner.style?.fontSize,
		options.minFontSize,
	);
	return {
		...(fontFamily === undefined ? {} : { fontFamily }),
		...(fontSize === undefined ? {} : { fontSize }),
	};
}

function labelCjkTypography(metadata: unknown): CjkTypography {
	const metadataRecord = metadataObject(metadata);
	if (metadataRecord === undefined) {
		return {};
	}
	const value = metadataRecord.cjkTypography;
	if (value === undefined || value === null || typeof value !== "object") {
		return {};
	}
	const typography = value as Record<string, unknown>;
	const fontFamily =
		typeof typography.fontFamily === "string"
			? typography.fontFamily
			: undefined;
	const fontSize =
		typeof typography.fontSize === "number" &&
		Number.isFinite(typography.fontSize) &&
		typography.fontSize > 0
			? typography.fontSize
			: undefined;
	return {
		...(fontFamily === undefined ? {} : { fontFamily }),
		...(fontSize === undefined ? {} : { fontSize }),
	};
}

function metadataObject(
	metadata: unknown,
): Record<string, unknown> | undefined {
	if (
		metadata === undefined ||
		metadata === null ||
		typeof metadata !== "object" ||
		Array.isArray(metadata)
	) {
		return undefined;
	}
	return metadata as Record<string, unknown>;
}

function typographyForLabel(
	label: { metadata?: unknown } | undefined,
): CjkTypography {
	return labelCjkTypography(label?.metadata);
}

function typographyTextStyle(
	label: { metadata?: unknown } | undefined,
	base: TextStyleOptions,
): TextStyleOptions {
	const typography = typographyForLabel(label);
	return {
		...base,
		...(typography.fontFamily === undefined
			? {}
			: { fontFamily: typography.fontFamily }),
		...(typography.fontSize === undefined
			? {}
			: {
					fontSize: typography.fontSize,
					lineHeight: Math.max(base.lineHeight ?? 0, typography.fontSize * 1.2),
				}),
	};
}

function boostedCjkFontSize(
	current: number | undefined,
	minFontSize: number | undefined,
): number | undefined {
	if (minFontSize === undefined) {
		return current;
	}
	if (current === undefined || current < minFontSize) {
		return minFontSize;
	}
	return current;
}

function enhanceCjkStyle(
	style: VisualStyle | undefined,
	typography: CjkTypography,
): VisualStyle | undefined {
	let next = style;
	if (typography.fontFamily !== undefined && next?.fontFamily === undefined) {
		next = { ...next, fontFamily: typography.fontFamily };
	}
	if (
		typography.fontSize !== undefined &&
		(next?.fontSize === undefined || next.fontSize < typography.fontSize)
	) {
		next = { ...next, fontSize: typography.fontSize };
	}
	return next;
}

function reportCjkTypographyDiagnostics(
	path: readonly (string | number)[],
	typography: CjkTypography,
	previousStyle: VisualStyle | undefined,
	diagnostics: Diagnostic[],
): void {
	if (
		typography.fontFamily !== undefined &&
		previousStyle?.fontFamily === undefined
	) {
		diagnostics.push({
			severity: "info",
			code: "cjk_font_family_applied",
			message: `Applied CJK font family ${typography.fontFamily}.`,
			path: [...path, "label", "metadata", "cjkTypography", "fontFamily"],
			detail: { fontFamily: typography.fontFamily },
		});
	}
	if (
		typography.fontSize !== undefined &&
		(previousStyle?.fontSize === undefined ||
			previousStyle.fontSize < typography.fontSize)
	) {
		diagnostics.push({
			severity: "info",
			code: "cjk_font_size_boosted",
			message: `Raised CJK font size to ${typography.fontSize}.`,
			path: [...path, "label", "metadata", "cjkTypography", "fontSize"],
			detail: {
				minFontSize: typography.fontSize,
				...(previousStyle?.fontSize === undefined
					? {}
					: { previousFontSize: previousStyle.fontSize }),
			},
		});
	}
}

function containsCjk(value: string): boolean {
	return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(value);
}

function applySwimlaneLayoutContracts(
	swimlanes: readonly Swimlane[],
	constraints: readonly Constraint[],
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	overlapSpacing: number,
	laneGutter: number,
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

function wrapVerticalStackIfNeeded(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	edges: readonly NormalizedEdge[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): Map<string, Box> {
	const wrapped = new Map([...boxes].map(([id, box]) => [id, { ...box }]));
	const maxStackDepth = options.maxStackDepth;
	if (
		maxStackDepth === undefined ||
		maxStackDepth <= 0 ||
		nodes.length <= maxStackDepth
	) {
		reportVerticalRunaway(
			wrapped,
			nodes,
			edges,
			direction,
			options,
			diagnostics,
		);
		return wrapped;
	}
	if (edges.length > 0 || !isStackRunaway(wrapped, nodes, direction, options)) {
		reportVerticalRunaway(
			wrapped,
			nodes,
			edges,
			direction,
			options,
			diagnostics,
		);
		return wrapped;
	}

	const ordered = nodes
		.map((node) => ({ node, box: wrapped.get(node.id) }))
		.filter(
			(item): item is { node: NormalizedNode; box: Box } =>
				item.box !== undefined,
		)
		.sort((a, b) => {
			const delta = a.box.y - b.box.y;
			return delta === 0 ? a.node.id.localeCompare(b.node.id) : delta;
		});
	const columns = Math.ceil(ordered.length / maxStackDepth);
	const horizontalGap = options.overlapSpacing ?? 40;
	const verticalGap = Math.max(24, horizontalGap / 2);
	const columnWidths = Array.from({ length: columns }, (_, column) =>
		Math.max(
			0,
			...ordered
				.slice(column * maxStackDepth, (column + 1) * maxStackDepth)
				.map((item) => item.box.width),
		),
	);
	const startX = Math.min(...ordered.map((item) => item.box.x));
	const startY = Math.min(...ordered.map((item) => item.box.y));
	let columnX = startX;
	for (let column = 0; column < columns; column += 1) {
		let y = startY;
		const items = ordered.slice(
			column * maxStackDepth,
			(column + 1) * maxStackDepth,
		);
		for (const item of items) {
			wrapped.set(item.node.id, { ...item.box, x: columnX, y });
			y += item.box.height + verticalGap;
		}
		columnX += (columnWidths[column] ?? 0) + horizontalGap;
	}
	diagnostics.push({
		severity: "warning",
		code: "vertical_runaway",
		message: `Single-column layout exceeded maxStackDepth ${maxStackDepth}; wrapped into ${columns} columns.`,
		path: ["nodes"],
		detail: { nodeCount: ordered.length, maxStackDepth, columns },
	});
	return wrapped;
}

/**
 * Wrap a TB/BT single horizontal row into multiple rows when
 * the layout exceeds maxRowDepth or targetAspectRatio (Issue #60).
 * Mirror of wrapVerticalStackIfNeeded for vertical layouts.
 */
function wrapHorizontalStackIfNeeded(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): Map<string, Box> {
	if (!isStackRunaway(boxes, nodes, direction, options)) {
		return new Map(boxes);
	}
	let maxRowDepth = options.maxRowDepth;
	if (
		maxRowDepth === undefined ||
		maxRowDepth <= 0 ||
		nodes.length <= maxRowDepth
	) {
		// When called with only targetAspectRatio (no maxRowDepth),
		// derive a row depth so the rewrap is not silently skipped
		// (Issue #61 codex P2).
		if (maxRowDepth === undefined && options.targetAspectRatio !== undefined) {
			maxRowDepth = Math.ceil(Math.sqrt(nodes.length));
			if (nodes.length <= maxRowDepth) return new Map(boxes);
		} else {
			return new Map(boxes);
		}
	}
	const ordered = [...nodes].sort((a, b) => {
		const ba = boxes.get(a.id);
		const bb = boxes.get(b.id);
		if (ba === undefined || bb === undefined) return 0;
		const dx = ba.x - bb.x;
		return dx !== 0 ? dx : ba.y - bb.y;
	});
	const rows = Math.ceil(ordered.length / maxRowDepth);
	const wrapped = new Map(boxes);
	const rowSpacing = options.overlapSpacing ?? 40;
	let minX = Infinity;
	let minY = Infinity;
	let maxH = 0;
	for (const n of ordered) {
		const b = boxes.get(n.id);
		if (b !== undefined) {
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxH = Math.max(maxH, b.height);
		}
	}
	for (let ri = 0; ri < rows; ri++) {
		const rowNodes = ordered.slice(ri * maxRowDepth, (ri + 1) * maxRowDepth);
		let x = minX;
		const y = minY + ri * (maxH + rowSpacing);
		for (const node of rowNodes) {
			const box = boxes.get(node.id);
			if (box === undefined) continue;
			wrapped.set(node.id, { ...box, x, y });
			x += box.width + rowSpacing;
		}
	}
	diagnostics.push({
		severity: "warning",
		code: "horizontal_runaway",
		message: `Single-row layout exceeded maxRowDepth ${maxRowDepth}; wrapped into ${rows} rows.`,
		path: ["nodes"],
		detail: { nodeCount: ordered.length, maxRowDepth, rows },
	});
	return wrapped;
}

function reportVerticalRunaway(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	edges: readonly NormalizedEdge[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	if (!isStackRunaway(boxes, nodes, direction, options)) {
		return;
	}
	diagnostics.push({
		severity: "warning",
		code: "vertical_runaway",
		message:
			"Layout produced a tall vertical stack beyond the preferred aspect ratio.",
		path: ["nodes"],
		detail: {
			nodeCount: nodes.length,
			edgeCount: edges.length,
			...(options.preferredAspectRatio === undefined
				? {}
				: { preferredAspectRatio: options.preferredAspectRatio }),
			...(options.maxStackDepth === undefined
				? {}
				: { maxStackDepth: options.maxStackDepth }),
		},
	});
}

/**
 * Detect stack runaway in either direction.
 * For LR/RL: height/width > preferred (vertical runaway).
 * For TB/BT: width/height > preferred (horizontal runaway, Issue #60).
 */
function isStackRunaway(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): boolean {
	if (
		options.maxStackDepth === undefined &&
		options.preferredAspectRatio === undefined &&
		options.targetAspectRatio === undefined &&
		options.maxRowDepth === undefined
	) {
		return false;
	}
	if (nodes.length < 2) {
		return false;
	}
	const nodeBoxes = nodes
		.map((node) => boxes.get(node.id))
		.filter((box): box is Box => box !== undefined);
	if (nodeBoxes.length < 2) {
		return false;
	}
	const bounds = unionBoxes(nodeBoxes);

	const isHorizontal = direction === "TB" || direction === "BT";
	const aspectRatio = isHorizontal
		? bounds.height <= 0
			? Number.POSITIVE_INFINITY
			: bounds.width / bounds.height
		: bounds.width <= 0
			? Number.POSITIVE_INFINITY
			: bounds.height / bounds.width;
	const preferred = isHorizontal
		? (options.targetAspectRatio ?? options.preferredAspectRatio ?? 3)
		: (options.preferredAspectRatio ?? 3);
	if (
		(options.preferredAspectRatio !== undefined ||
			options.targetAspectRatio !== undefined) &&
		aspectRatio < preferred
	) {
		return false;
	}

	if (isHorizontal) {
		// TB/BT: check y-spread vs maxHeight (single row runaway).
		const yCenters = nodeBoxes.map((box) => box.y + box.height / 2);
		const ySpread = Math.max(...yCenters) - Math.min(...yCenters);
		const maxHeight = Math.max(...nodeBoxes.map((box) => box.height));
		return ySpread <= Math.max(maxHeight, options.overlapSpacing ?? 40);
	}

	// LR/RL: check x-spread vs maxWidth (single column runaway).
	const xCenters = nodeBoxes.map((box) => box.x + box.width / 2);
	const xSpread = Math.max(...xCenters) - Math.min(...xCenters);
	const maxWidth = Math.max(...nodeBoxes.map((box) => box.width));
	return xSpread <= Math.max(maxWidth, options.overlapSpacing ?? 40);
}

function applySingleSwimlaneContract(
	swimlane: Swimlane,
	edges: readonly NormalizedEdge[],
	topToBottomFlow: boolean,
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	laneGutter: number,
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

function applyVerticalSwimlaneContract(
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
): SwimlaneContractLayout {
	const populatedBounds = laneBounds.filter(
		(box): box is Box => box !== undefined,
	);
	const top = Math.min(...populatedBounds.map((box) => box.y));
	const left = Math.min(...populatedBounds.map((box) => box.x));
	const maxChildHeight = Math.max(...populatedBounds.map((box) => box.height));
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
	const slotWidth =
		Math.max(...populatedBounds.map((box) => box.width)) + padding * 2;
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
			slotWidth,
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

function isTopToBottomReadingDirection(value: unknown): boolean {
	return value === "top_to_bottom" || value === "top-to-bottom";
}

function rankVerticalSwimlaneChildren(
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

function rankCyclicSwimlaneChildren(
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

function maxVerticalRankStackHeight(
	swimlane: Swimlane,
	nodeBoxes: ReadonlyMap<string, Box>,
	flowRanks: ReadonlyMap<string, number>,
	gap: number,
): number {
	let maxHeight = 0;
	for (const lane of swimlane.lanes) {
		for (const stack of rankStacks(
			lane.children,
			nodeBoxes,
			flowRanks,
		).values()) {
			const height = stack.reduce(
				(total, item, index) =>
					total + item.box.height + (index === 0 ? 0 : gap),
				0,
			);
			maxHeight = Math.max(maxHeight, height);
		}
	}
	return maxHeight;
}

function moveRankedVerticalLaneChildren(
	childIds: readonly string[],
	nodeBoxes: Map<string, Box>,
	locks: ReadonlyMap<string, LayoutLockLike>,
	diagnostics: Diagnostic[],
	movedChildIds: Set<string>,
	flowRanks: ReadonlyMap<string, number>,
	rankSpacing: number,
	rankStackGap: number,
	target: Point,
	slotWidth: number,
): void {
	for (const [rank, stack] of rankStacks(childIds, nodeBoxes, flowRanks)) {
		// Filter out locked children for layout purposes.
		// fixed-position locks are overridden by contract placement
		// (the contract swimlane is authoritative, Issue #62).
		const unlocked: Array<{ childId: string; box: Box }> = [];
		for (const item of stack) {
			const lock = locks.get(item.childId);
			if (lock !== undefined && lock.source !== "fixed-position") {
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
			// Single child: center within slot.
			const { childId, box } = unlocked[0]!;
			const next = {
				...box,
				x: target.x + (slotWidth - box.width) / 2,
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
			const shouldSpread = unlocked.length >= 3;

			if (!shouldSpread) {
				// Normal vertical stacking (2 children fit within rank).
				let yOffset = 0;
				for (const { childId, box } of unlocked) {
					const next = {
						...box,
						x: target.x + (slotWidth - box.width) / 2,
						y: target.y + rank * rankSpacing + yOffset,
					};
					if (next.x !== box.x || next.y !== box.y) {
						movedChildIds.add(childId);
					}
					nodeBoxes.set(childId, next);
					yOffset += box.height + rankStackGap;
				}
			} else {
				// Cross-axis (horizontal) distribution: vertical stack would
				// overflow rankSpacing, so spread children across the slot
				// width (Issue #62). All children share the same y (same rank).
				const requiredWidth = unlocked.reduce(
					(sum, item, i) => sum + item.box.width + (i === 0 ? 0 : rankStackGap),
					0,
				);
				const effectiveSlotWidth = Math.max(slotWidth, requiredWidth);
				const subSlotWidth = effectiveSlotWidth / unlocked.length;
				for (let i = 0; i < unlocked.length; i++) {
					const { childId, box } = unlocked[i]!;
					const subSlotX = target.x + subSlotWidth * i;
					const next = {
						...box,
						x: subSlotX + (subSlotWidth - box.width) / 2,
						y: target.y + rank * rankSpacing,
					};
					if (next.x !== box.x || next.y !== box.y) {
						movedChildIds.add(childId);
					}
					nodeBoxes.set(childId, next);
				}
				diagnostics.push({
					severity: "info",
					code: "swimlane_contract.cross_axis_distributed",
					message: `Spread ${unlocked.length} same-rank children horizontally in contract lane (rank ${rank}).`,
					path: ["swimlanes"],
					detail: {
						rank,
						childCount: unlocked.length,
						slotWidth: effectiveSlotWidth,
					},
				});
			}
		}
	}
}

function rankStacks(
	childIds: readonly string[],
	nodeBoxes: ReadonlyMap<string, Box>,
	flowRanks: ReadonlyMap<string, number>,
): Map<number, Array<{ childId: string; box: Box }>> {
	const stacks = new Map<number, Array<{ childId: string; box: Box }>>();
	for (const childId of childIds) {
		const box = nodeBoxes.get(childId);
		if (box === undefined) {
			continue;
		}
		const rank = flowRanks.get(childId) ?? 0;
		const stack = stacks.get(rank) ?? [];
		stack.push({ childId, box });
		stacks.set(rank, stack);
	}
	for (const stack of stacks.values()) {
		stack.sort((a, b) => {
			const deltaY = a.box.y - b.box.y;
			return deltaY === 0 ? a.childId.localeCompare(b.childId) : deltaY;
		});
	}
	return stacks;
}

function applyHorizontalSwimlaneContract(
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

function moveLaneChildren(
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

function removeResolvedOverlapDiagnostics(
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

function reportSwimlaneConstraintInvalidations(
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

function movedConstraintNodeIds(
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

function movedContainmentViolations(
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

function movedRelativeViolations(
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

function movedAlignViolations(
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

function movedDistributeViolations(
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

function expectedRelativeBox(
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

function paddedContentBox(container: Box, padding: Insets | undefined): Box {
	const margin = padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
	return {
		x: container.x + margin.left,
		y: container.y + margin.top,
		width: container.width - margin.left - margin.right,
		height: container.height - margin.top - margin.bottom,
	};
}

function boxInside(child: Box, container: Box): boolean {
	return (
		child.x >= container.x &&
		child.y >= container.y &&
		child.x + child.width <= container.x + container.width &&
		child.y + child.height <= container.y + container.height
	);
}

function sameBoxPosition(first: Box, second: Box): boolean {
	return sameNumber(first.x, second.x) && sameNumber(first.y, second.y);
}

function sameNumber(first: number, second: number): boolean {
	return Math.abs(first - second) < 0.001;
}

function alignmentValue(
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

function distributionStart(
	box: Box,
	axis: Extract<Constraint, { kind: "distribute" }>["axis"],
): number {
	return axis === "horizontal" ? box.x : box.y;
}

function detailString(
	diagnostic: Diagnostic,
	key: "firstId" | "secondId",
): string | undefined {
	const value = diagnostic.detail?.[key];
	return typeof value === "string" ? value : undefined;
}

function reportSwimlaneOverlaps(
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

function coordinateNodes(
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

const PORT_BOX_SIZE = 10;
const MIN_PORT_EDGE_GAP = 12;

/**
 * Pre-expand node boxes whose sides cannot accommodate all ports
 * at the minimum spacing.  Runs before constraint solving so
 * containment, overlap repair, and swimlane contracts see the
 * expanded sizes (Codex P2: #42).
 */
function expandNodeBoxesForPorts(
	nodes: readonly NormalizedNode[],
	boxes: Map<string, Box>,
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	const shiftingEnabled = options.portShifting?.enabled ?? true;
	if (!shiftingEnabled) return;
	const requestedSpacing = options.portShifting?.spacing ?? 24;
	const minSpacing = Math.max(
		requestedSpacing,
		PORT_BOX_SIZE + MIN_PORT_EDGE_GAP,
	);

	for (const node of nodes) {
		if (node.ports === undefined || node.ports.length === 0) continue;
		const box = boxes.get(node.id);
		if (box === undefined) continue;

		// Aggregate required expansion per axis so all sides
		// are handled atomically (Codex P2: avoid stale anchors).
		let heightExpansion = 0;
		let widthExpansion = 0;

		const portsBySide = new Map<string, NormalizedNode["ports"]>();
		for (const port of node.ports) {
			const list = portsBySide.get(port.side) ?? [];
			list.push(port);
			portsBySide.set(port.side, list);
		}

		for (const [side, ports] of portsBySide) {
			const count = (ports ?? []).length;
			if (count <= 1) continue;
			const isVertical = side === "left" || side === "right";
			const availableSpan = isVertical ? box.height : box.width;
			const requiredSpan = (count - 1) * minSpacing + PORT_BOX_SIZE;
			if (requiredSpan > availableSpan) {
				const expansion = requiredSpan - availableSpan;
				if (isVertical) {
					heightExpansion = Math.max(heightExpansion, expansion);
				} else {
					widthExpansion = Math.max(widthExpansion, expansion);
				}
				diagnostics.push({
					severity: "info",
					code: "port_capacity_overflow",
					message: `Expanded node ${node.id} ${isVertical ? "height" : "width"} by ${Math.ceil(expansion)} px to fit ${count} port(s) on ${side} side.`,
					path: ["nodes", node.id, "ports"],
					detail: {
						nodeId: node.id,
						side,
						portCount: count,
						expansion: Math.ceil(expansion),
					},
				});
			}
		}

		if (heightExpansion > 0) {
			box.y -= heightExpansion / 2;
			box.height += heightExpansion;
		}
		if (widthExpansion > 0) {
			box.x -= widthExpansion / 2;
			box.width += widthExpansion;
		}
		// Recenter the label layout to match the expanded box.
		// Only shift layout.box — lines and contentBox stay
		// relative to the label area so the SVG renderer's
		// annotation.box + line.box addition is not doubled
		// (Codex P2: multiline labels on port-expanded nodes).
		if (
			(heightExpansion > 0 || widthExpansion > 0) &&
			node.labelLayout !== undefined
		) {
			const layout = node.labelLayout;
			const newOffsetX = Math.max(0, (box.width - layout.box.width) / 2);
			const newOffsetY = Math.max(0, (box.height - layout.box.height) / 2);
			(node as NormalizedNode).labelLayout = {
				...layout,
				box: {
					...layout.box,
					x: newOffsetX,
					y: newOffsetY,
				},
			};
		}
	}
}

function coordinatePorts(
	node: NormalizedNode,
	nodeBox: Box,
	portShifting: PortShiftingOptions | undefined,
): CoordinatedPort[] {
	const portsBySide = new Map<string, NormalizedNode["ports"]>();
	for (const port of node.ports ?? []) {
		const ports = portsBySide.get(port.side) ?? [];
		ports.push(port);
		portsBySide.set(port.side, ports);
	}

	const coordinated: CoordinatedPort[] = [];
	for (const [side, ports] of portsBySide) {
		const sorted = [...(ports ?? [])].sort((a, b) => {
			const order = (a.order ?? 0) - (b.order ?? 0);
			return order === 0 ? a.id.localeCompare(b.id) : order;
		});
		for (let index = 0; index < sorted.length; index += 1) {
			const port = sorted[index];
			if (port === undefined) {
				continue;
			}
			const anchor = portAnchor(
				nodeBox,
				side as CoordinatedPort["side"],
				index,
				sorted.length,
				portShifting,
			);
			const box = portBox(anchor);
			coordinated.push({ ...port, box, anchor });
		}
	}

	return coordinated.sort((a, b) => a.id.localeCompare(b.id));
}

function portAnchor(
	nodeBox: Box,
	side: CoordinatedPort["side"],
	index: number,
	count: number,
	portShifting: PortShiftingOptions | undefined,
): Point {
	const shiftingEnabled = portShifting?.enabled ?? true;
	const requestedSpacing = portShifting?.spacing ?? 24;
	const maxOffset =
		side === "left" || side === "right"
			? nodeBox.height / 2
			: nodeBox.width / 2;
	// When (count - 1) * spacing would overflow the node edge, compress the
	// spacing so every port still gets a distinct anchor evenly distributed
	// within the available extent, instead of clamping several ports onto the
	// same endpoint.
	const availableSpan = 2 * maxOffset;
	const minSpacing = PORT_BOX_SIZE + MIN_PORT_EDGE_GAP;
	const spacing =
		shiftingEnabled && count > 1
			? Math.max(
					Math.min(requestedSpacing, availableSpan / (count - 1)),
					minSpacing,
				)
			: requestedSpacing;
	const centeredOffset = shiftingEnabled
		? (index - (count - 1) / 2) * spacing
		: 0;
	switch (side) {
		case "left":
			return {
				x: nodeBox.x,
				y: nodeBox.y + nodeBox.height / 2 + centeredOffset,
			};
		case "right":
			return {
				x: nodeBox.x + nodeBox.width,
				y: nodeBox.y + nodeBox.height / 2 + centeredOffset,
			};
		case "top":
			return {
				x: nodeBox.x + nodeBox.width / 2 + centeredOffset,
				y: nodeBox.y,
			};
		case "bottom":
			return {
				x: nodeBox.x + nodeBox.width / 2 + centeredOffset,
				y: nodeBox.y + nodeBox.height,
			};
	}
}

function portBox(anchor: Point): Box {
	const size = PORT_BOX_SIZE;
	return {
		x: anchor.x - size / 2,
		y: anchor.y - size / 2,
		width: size,
		height: size,
	};
}

function portLabelBox(port: CoordinatedPort): Box {
	const textWidth = Math.max(0, (port.label?.text.length ?? 0) * 6);
	const height = 12;
	const gap = 8;
	const x =
		port.side === "left"
			? port.anchor.x - gap - textWidth
			: port.anchor.x + gap;
	return {
		x,
		y: port.anchor.y - 8 - height,
		width: textWidth,
		height,
	};
}

function coordinateSwimlanes(
	swimlanes: readonly Swimlane[],
	nodeBoxes: ReadonlyMap<string, Box>,
	layouts: ReadonlyMap<string, SwimlaneContractLayout>,
): Swimlane[] {
	return swimlanes.map((swimlane) => {
		const layout = swimlane.layout ?? "overlay";
		const headerHeight = swimlane.headerHeight ?? 28;
		const padding = swimlane.padding ?? 16;
		const contractLayout = layouts.get(swimlane.id);
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

function coordinateFrame(
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

function framePadding(
	value: NonNullable<NormalizedDiagram["frame"]>["padding"],
): Insets {
	return normalizeInsets(value ?? 32);
}

function expand(box: Box, padding: number, titleSize: number): Box {
	return {
		x: box.x - padding,
		y: box.y - padding - titleSize,
		width: box.width + padding * 2,
		height: box.height + padding * 2 + titleSize,
	};
}

function coordinateGroups(
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

function coordinateMatrices(
	matrices: readonly MatrixBlock[],
): CoordinatedMatrixBlock[] {
	return matrices.map((block) => ({
		...block,
		box: blockBox(block, {
			width:
				defaultMatrixRowHeaderWidth(block) +
				Math.max(1, block.cols.length) * DEFAULT_MATRIX_CELL_SIZE.width,
			height:
				Math.max(1, block.rows.length + 1) * DEFAULT_MATRIX_CELL_SIZE.height,
		}),
	}));
}

function defaultMatrixRowHeaderWidth(block: MatrixBlock): number {
	return block.rows.length === 0
		? 0
		: Math.min(96, DEFAULT_MATRIX_CELL_SIZE.width);
}

function coordinateTables(
	tables: readonly TableBlock[],
): CoordinatedTableBlock[] {
	return tables.map((table) => {
		const box = blockBox(table, {
			width: Math.max(1, table.columns.length) * DEFAULT_TABLE_CELL_SIZE.width,
			height:
				Math.max(1, table.rows.length + 1) * DEFAULT_TABLE_CELL_SIZE.height,
		});
		return {
			...table,
			box,
			columnXOffsets: columnXOffsets(table, box),
		};
	});
}

function coordinateEvidencePanels(
	panels: readonly EvidencePanel[],
): CoordinatedEvidencePanel[] {
	return panels.map((block) => ({
		...block,
		box: blockBox(block, {
			width: DEFAULT_PANEL_WIDTH,
			height: Math.max(1, block.items.length) * DEFAULT_PANEL_ITEM_HEIGHT,
		}),
	}));
}

function edgeBounds(edges: readonly CoordinatedEdge[]): Box[] {
	return edges.flatMap((edge) => {
		if (edge.points.length === 0) {
			return [];
		}
		// Include the rendered arrowhead polygon (tip/left/right) so page
		// overflow accounts for geometry that extends past the route points.
		const extraPoints: Point[] = [];
		if (edge.points.length >= 2) {
			const arrowhead = computeArrowhead(edge.points);
			extraPoints.push(arrowhead.tip, arrowhead.left, arrowhead.right);
		}
		const allPoints = [...edge.points, ...extraPoints];
		const minX = Math.min(...allPoints.map((point) => point.x));
		const minY = Math.min(...allPoints.map((point) => point.y));
		const maxX = Math.max(...allPoints.map((point) => point.x));
		const maxY = Math.max(...allPoints.map((point) => point.y));
		return [
			{
				x: minX,
				y: minY,
				width: maxX - minX,
				height: maxY - minY,
			},
		];
	});
}

function blockBox(
	block: { position?: Point; size?: Size },
	defaultSize: Size,
): Box {
	return {
		x: block.position?.x ?? 0,
		y: block.position?.y ?? 0,
		width: block.size?.width ?? defaultSize.width,
		height: block.size?.height ?? defaultSize.height,
	};
}

function placeEvidenceBlocks(
	obstacleMargin: number | Insets,
	blocks: Array<{ position?: Point; box: Box }>,
	contentBounds: Box,
): void {
	const margin = normalizeInsets(obstacleMargin);
	const horizontalGap = Math.max(
		DEFAULT_EVIDENCE_BLOCK_GAP,
		margin.right + margin.left,
	);
	const verticalGap = Math.max(
		DEFAULT_EVIDENCE_BLOCK_GAP,
		margin.bottom + margin.top,
	);
	let nextY = contentBounds.y;
	const x = contentBounds.x + contentBounds.width + horizontalGap;
	for (const block of blocks) {
		if (block.position !== undefined) {
			continue;
		}
		block.box.x = x;
		block.box.y = nextY;
		nextY += block.box.height + verticalGap;
	}
}

function columnXOffsets(table: TableBlock, box: Box): number[] {
	if (table.columns.length === 0) {
		return [];
	}
	const columnWidth = box.width / table.columns.length;
	return table.columns.map((_, index) => box.x + index * columnWidth);
}

function tableCellBox(
	table: CoordinatedTableBlock,
	columnIndex: number,
	rowIndex: number,
	rowHeight: number,
	columnCount: number,
): Box {
	const x =
		table.columnXOffsets[columnIndex] ??
		table.box.x + (table.box.width / columnCount) * columnIndex;
	const nextX =
		table.columnXOffsets[columnIndex + 1] ?? table.box.x + table.box.width;
	return {
		x,
		y: table.box.y + rowIndex * rowHeight,
		width: nextX - x,
		height: rowHeight,
	};
}

function refreshTableColumnXOffsets(tables: CoordinatedTableBlock[]): void {
	for (const table of tables) {
		table.columnXOffsets = columnXOffsets(table, table.box);
	}
}

function measureEvidenceTextBlocks(
	matrices: CoordinatedMatrixBlock[],
	tables: CoordinatedTableBlock[],
	panels: CoordinatedEvidencePanel[],
	textMeasurer?: TextMeasurer,
): void {
	const measurer = textMeasurer ?? createDefaultTextMeasurer();
	for (const matrix of matrices) {
		const geometry = matrixGeometry(matrix);
		matrix.columnLabelLayouts = matrix.cols.map((column) =>
			measureEvidenceTextLayout(column, geometry.columnHeaderBox, measurer),
		);
		matrix.rowLabelLayouts = matrix.rows.map((row, index) =>
			measureEvidenceTextLayout(row, geometry.rowHeaderBox(index), measurer),
		);
		matrix.cellLabelLayouts = matrix.rows.map((_, rowIndex) =>
			matrix.cols.map((_, columnIndex) => {
				const cell = matrix.cells[rowIndex]?.[columnIndex] ?? { text: "" };
				return measureEvidenceTextLayout(
					cell.text,
					geometry.cellBox(rowIndex, columnIndex),
					measurer,
				);
			}),
		);
	}
	for (const table of tables) {
		const rowHeight = table.box.height / Math.max(1, table.rows.length + 1);
		const columnCount = Math.max(1, table.columns.length);
		table.columnLabelLayouts = table.columns.map((column, columnIndex) =>
			measureEvidenceTextLayout(
				column.label.text,
				tableCellBox(table, columnIndex, 0, rowHeight, columnCount),
				measurer,
			),
		);
		table.cellLabelLayouts = table.rows.map((row, rowIndex) =>
			table.columns.map((column, columnIndex) => {
				const cell = row.cells[column.id] ?? { text: "" };
				return measureEvidenceTextLayout(
					cell.text,
					tableCellBox(
						table,
						columnIndex,
						rowIndex + 1,
						rowHeight,
						columnCount,
					),
					measurer,
				);
			}),
		);
	}
	for (const panel of panels) {
		const geometry = panelGeometry(panel);
		panel.titleLayout = measureEvidenceTextLayout(
			`${panel.kind}: ${panel.id}`,
			geometry.titleBox,
			measurer,
		);
		panel.itemLayouts = panel.items.map((item, index) =>
			measureEvidenceTextLayout(
				panelItemText(item.label.text, item.detail?.text),
				geometry.itemRowBox(index),
				measurer,
			),
		);
	}
}

function measureEvidenceTextLayout(
	text: string,
	box: Box,
	textMeasurer: TextMeasurer,
): EvidenceTextLayout {
	const lineHeight = EVIDENCE_TEXT_FONT.lineHeight;
	return {
		lines: wrapEvidenceText(text, {
			maxWidth: Math.max(0, box.width - 8),
			maxLines: Math.max(1, Math.floor((box.height - 4) / lineHeight)),
			textMeasurer,
		}),
	};
}

function wrapEvidenceText(
	text: string,
	options: { maxWidth: number; maxLines: number; textMeasurer: TextMeasurer },
): string[] {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		return [""];
	}

	const lines: string[] = [];
	let current = "";
	let overflow = false;
	for (const word of normalized.split(" ")) {
		const chunks = chunkEvidenceWord(
			word,
			options.maxWidth,
			options.textMeasurer,
		);
		for (const chunk of chunks) {
			const candidate = current.length === 0 ? chunk : `${current} ${chunk}`;
			if (
				measureEvidenceText(candidate, options.textMeasurer) <= options.maxWidth
			) {
				current = candidate;
				continue;
			}
			if (current.length > 0) {
				lines.push(current);
				current = chunk;
			} else {
				lines.push(chunk);
				current = "";
			}
			if (lines.length >= options.maxLines) {
				overflow = true;
				break;
			}
		}
		if (overflow) {
			break;
		}
	}
	if (!overflow && current.length > 0) {
		lines.push(current);
	}
	if (lines.length > options.maxLines) {
		overflow = true;
		lines.length = options.maxLines;
	}
	if (overflow || lines.length === options.maxLines) {
		const rendered = lines.join(" ");
		if (rendered.length < normalized.length) {
			lines[lines.length - 1] = ellipsizeMeasuredEvidenceLine(
				lines[lines.length - 1] ?? "",
				options.maxWidth,
				options.textMeasurer,
			);
		}
	}

	return lines.length === 0 ? [""] : lines;
}

function chunkEvidenceWord(
	word: string,
	maxWidth: number,
	textMeasurer: TextMeasurer,
): string[] {
	if (measureEvidenceText(word, textMeasurer) <= maxWidth) {
		return [word];
	}
	const chunks: string[] = [];
	let current = "";
	for (const char of Array.from(word)) {
		const candidate = `${current}${char}`;
		if (
			current.length > 0 &&
			measureEvidenceText(candidate, textMeasurer) > maxWidth
		) {
			chunks.push(current);
			current = char;
			continue;
		}
		current = candidate;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks.length === 0 ? [word] : chunks;
}

function ellipsizeMeasuredEvidenceLine(
	line: string,
	maxWidth: number,
	textMeasurer: TextMeasurer,
): string {
	const ellipsis = "...";
	if (measureEvidenceText(ellipsis, textMeasurer) > maxWidth) {
		return "";
	}
	let candidate = line.trimEnd();
	while (
		candidate.length > 0 &&
		measureEvidenceText(`${candidate}${ellipsis}`, textMeasurer) > maxWidth
	) {
		candidate = Array.from(candidate).slice(0, -1).join("").trimEnd();
	}
	return `${candidate}${ellipsis}`;
}

function measureEvidenceText(text: string, textMeasurer: TextMeasurer): number {
	return textMeasurer.naturalWidth(
		textMeasurer.prepare(text, EVIDENCE_TEXT_FONT),
	);
}

function matrixGeometry(matrix: CoordinatedMatrixBlock): {
	rowHeaderWidth: number;
	cellWidth: number;
	rowHeight: number;
	columnHeaderBox: Box;
	rowHeaderBox: (rowIndex: number) => Box;
	cellBox: (rowIndex: number, columnIndex: number) => Box;
} {
	const columnCount = Math.max(1, matrix.cols.length);
	const rowCount = matrix.rows.length;
	const rowHeaderWidth =
		rowCount > 0 ? Math.min(96, matrix.box.width * 0.28) : 0;
	const dataWidth = Math.max(0, matrix.box.width - rowHeaderWidth);
	const cellWidth = dataWidth / columnCount;
	const rowHeight = matrix.box.height / Math.max(1, rowCount + 1);
	return {
		rowHeaderWidth,
		cellWidth,
		rowHeight,
		columnHeaderBox: {
			x: matrix.box.x + rowHeaderWidth,
			y: matrix.box.y,
			width: cellWidth,
			height: rowHeight,
		},
		rowHeaderBox: (rowIndex) => ({
			x: matrix.box.x,
			y: matrix.box.y + (rowIndex + 1) * rowHeight,
			width: rowHeaderWidth,
			height: rowHeight,
		}),
		cellBox: (rowIndex, columnIndex) => ({
			x: matrix.box.x + rowHeaderWidth + columnIndex * cellWidth,
			y: matrix.box.y + (rowIndex + 1) * rowHeight,
			width: cellWidth,
			height: rowHeight,
		}),
	};
}

function panelGeometry(panel: CoordinatedEvidencePanel): {
	titleBox: Box;
	itemRowBox: (index: number) => Box;
} {
	const titleWidth = Math.min(panel.box.width * 0.36, 140);
	const itemBox = {
		x: panel.box.x + titleWidth,
		y: panel.box.y,
		width: panel.box.width - titleWidth,
		height: panel.box.height,
	};
	const itemHeight = panel.box.height / Math.max(1, panel.items.length);
	return {
		titleBox: {
			x: panel.box.x,
			y: panel.box.y,
			width: titleWidth,
			height: panel.box.height,
		},
		itemRowBox: (index) => ({
			x: itemBox.x,
			y: itemBox.y + index * itemHeight,
			width: itemBox.width,
			height: itemHeight,
		}),
	};
}

function panelItemText(label: string, detail: string | undefined): string {
	return detail === undefined ? label : `${label}: ${detail}`;
}

function reportEvidenceBlockOverlaps(
	evidenceBlocks: Array<{
		id: string;
		kind: string;
		position?: Point;
		box: Box;
	}>,
	contentBlocks: Array<{ id: string; kind: string; box: Box }>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (let index = 0; index < evidenceBlocks.length; index += 1) {
		const block = evidenceBlocks[index];
		if (block === undefined || block.position === undefined) {
			continue;
		}
		for (const content of contentBlocks) {
			if (intersectsAabb(block.box, content.box)) {
				diagnostics.push(evidenceOverlapDiagnostic(block, content));
			}
		}
		for (
			let otherIndex = 0;
			otherIndex < evidenceBlocks.length;
			otherIndex += 1
		) {
			if (otherIndex === index) {
				continue;
			}
			const other = evidenceBlocks[otherIndex];
			if (
				other === undefined ||
				(other.position !== undefined && otherIndex < index) ||
				!intersectsAabb(block.box, other.box)
			) {
				continue;
			}
			diagnostics.push(evidenceOverlapDiagnostic(block, other));
		}
	}
	return diagnostics;
}

function evidenceOverlapDiagnostic(
	block: { id: string; kind: string },
	conflict: { id: string; kind: string },
): Diagnostic {
	return {
		severity: "warning",
		code: "constraints.overlap.unresolved",
		message: `Evidence block ${block.id} overlaps ${conflict.kind} ${conflict.id}.`,
		path: ["evidence", block.id],
		detail: {
			evidenceBlockId: block.id,
			evidenceBlockKind: block.kind,
			conflictingObjectId: conflict.id,
			conflictingObjectKind: conflict.kind,
		},
	};
}

function coordinateEdges(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	coordinatedNodes: readonly CoordinatedNode[],
	obstacles: readonly Box[],
	softObstacles: readonly Box[],
	textObstacles: readonly SolvedTextAnnotation[],
	hardObstacles: readonly Box[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
	groups: readonly CoordinatedGroup[],
): CoordinatedEdge[] {
	const coordinated: CoordinatedEdge[] = [];
	const coordinatedNodeById = new Map(
		coordinatedNodes.map((node) => [node.id, node]),
	);
	const nodeObstacleIndex = createBoxSpatialIndex(
		obstacles.map((box, index) => ({ id: `node-obstacle:${index}`, box })),
		options.routingGutter ?? 160,
	);

	for (const edge of edges) {
		const source = nodes.get(edge.source.nodeId);
		const target = nodes.get(edge.target.nodeId);
		if (source === undefined || target === undefined) {
			diagnostics.push({
				severity: "error",
				code: "solver.edge-reference.missing",
				message: `Edge ${edge.id} references a missing coordinated node.`,
				path: ["edges", edge.id],
				detail: {
					edgeId: edge.id,
					sourceId: edge.source.nodeId,
					targetId: edge.target.nodeId,
				},
			});
			continue;
		}
		const sourcePort = coordinatedNodeById
			.get(edge.source.nodeId)
			?.ports?.find((port) => port.id === edge.source.portId);
		const targetPort = coordinatedNodeById
			.get(edge.target.nodeId)
			?.ports?.find((port) => port.id === edge.target.portId);
		const routeTextObstacles = textObstacles
			.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
			.map((annotation) => annotation.box);
		const corridor = edgeCorridorBox(
			source.box,
			target.box,
			options.routingGutter ?? 160,
		);
		const routeNodeObstacles = queryBoxSpatialIndex(nodeObstacleIndex, corridor)
			.map((entry) => entry.box)
			.filter(
				(obstacle) =>
					!sameBox(obstacle, source.obstacleBox) &&
					!sameBox(obstacle, target.obstacleBox),
			);

		const route = routeEdge({
			kind: options.routeKind ?? "orthogonal",
			direction,
			source: portGeometry(source, sourcePort),
			target: portGeometry(target, targetPort),
			...(edge.source.anchor === undefined
				? {}
				: { sourceAnchor: edge.source.anchor }),
			...(edge.target.anchor === undefined
				? {}
				: { targetAnchor: edge.target.anchor }),
			obstacles: [
				...routeNodeObstacles,
				...softObstacles,
				...groupObstaclesForEdge(edge, groups, options.obstacleMargin ?? 0),
				...routeTextObstacles,
			],
			hardObstacles,
			...(options.maxRoutingAttempts === undefined
				? {}
				: { maxRoutingAttempts: options.maxRoutingAttempts }),
		});
		diagnostics.push(
			...route.diagnostics.map((diagnostic) => ({
				...diagnostic,
				detail: { ...diagnostic.detail, edgeId: edge.id },
			})),
		);
		coordinated.push({
			...edge,
			points: route.points,
		});
	}

	return coordinated;
}

function edgeCorridorBox(source: Box, target: Box, margin: number): Box {
	const minX = Math.min(source.x, target.x);
	const minY = Math.min(source.y, target.y);
	const maxX = Math.max(source.x + source.width, target.x + target.width);
	const maxY = Math.max(source.y + source.height, target.y + target.height);
	return expandBoxForQuery(
		{ x: minX, y: minY, width: maxX - minX, height: maxY - minY },
		margin,
	);
}

function sameBox(first: Box, second: Box): boolean {
	return (
		first.x === second.x &&
		first.y === second.y &&
		first.width === second.width &&
		first.height === second.height
	);
}

function isEdgeConnectedTextAnnotation(
	edge: NormalizedEdge | CoordinatedEdge,
	annotation: SolvedTextAnnotation,
): boolean {
	switch (annotation.surfaceKind) {
		case "edge-label":
			return annotation.ownerId === edge.id;
		case "node-label":
		case "compartment-row":
			return (
				annotation.ownerId === edge.source.nodeId ||
				annotation.ownerId === edge.target.nodeId
			);
		case "port-label":
			return (
				(edge.source.portId !== undefined &&
					annotation.ownerId ===
						`${edge.source.nodeId}.${edge.source.portId}`) ||
				(edge.target.portId !== undefined &&
					annotation.ownerId === `${edge.target.nodeId}.${edge.target.portId}`)
			);
		case "group-label":
		case "swimlane-label":
		case "frame-title":
			return false;
	}
}

/**
 * Collect every group (including nested ancestors) that contains
 * the given node, by walking `group.nodeIds` and `group.groupIds`.
 */
function ancestorGroupIds(
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

/**
 * Return group boxes that should act as soft routing obstacles for a
 * given edge.  Groups that contain both endpoints (or are ancestors
 * of such groups) are skipped — an edge entirely inside a container
 * is free to route within that container (Issue #41).
 */
function groupObstaclesForEdge(
	edge: NormalizedEdge,
	groups: readonly CoordinatedGroup[],
	margin: number | Insets,
): Box[] {
	const sourceAncestors = ancestorGroupIds(groups, edge.source.nodeId);
	const targetAncestors = ancestorGroupIds(groups, edge.target.nodeId);
	// Edges that touch a group (at least one endpoint inside)
	// are allowed to cross its boundary; only fully external
	// edges must detour around the group box.
	return groups
		.filter((group) => {
			if (sourceAncestors.has(group.id) || targetAncestors.has(group.id)) {
				return false;
			}
			return true;
		})
		.map((group) => (margin === 0 ? group.box : expandBox(group.box, margin)));
}

function coordinateBaseTextAnnotations(input: {
	nodes: readonly CoordinatedNode[];
	groups: readonly CoordinatedGroup[];
	swimlanes: readonly Swimlane[];
	textMeasurer?: TextMeasurer;
	/** When true, promote deliverability-breaking diagnostics to errors. */
	strict?: boolean;
}): SolvedTextAnnotation[] {
	const measurer = input.textMeasurer ?? createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];

	for (const node of input.nodes) {
		if (node.compartments !== undefined) {
			continue;
		}
		if (node.labelLayout === undefined && node.label === undefined) {
			continue;
		}
		const layout =
			node.labelLayout ?? fallbackLabelLayout(node.label?.text ?? "");
		const buildAnnotation =
			node.labelLayout === undefined
				? buildAnchorCenteredTextAnnotation
				: buildTextAnnotation;
		annotations.push(
			buildAnnotation({
				ownerId: node.id,
				surfaceKind: "node-label",
				layout,
				typography: typographyForLabel(node.label),
				anchor: node.box,
			}),
		);
	}

	for (const group of input.groups) {
		if (group.labelLayout === undefined && group.label === undefined) {
			continue;
		}
		const layout =
			group.labelLayout ?? fallbackLabelLayout(group.label?.text ?? "");
		const buildAnnotation =
			group.labelLayout === undefined
				? buildAnchorCenteredTextAnnotation
				: buildTextAnnotation;
		annotations.push(
			buildAnnotation({
				ownerId: group.id,
				surfaceKind: "group-label",
				layout,
				typography: typographyForLabel(group.label),
				anchor: group.box,
			}),
		);
	}

	for (const node of input.nodes) {
		for (const port of node.ports ?? []) {
			if (port.label?.text === undefined) {
				continue;
			}
			const layout = fitLabel(
				port.label.text,
				{
					font: typographyTextStyle(port.label, {
						fontFamily: "Arial",
						fontSize: 10,
						lineHeight: 12,
					}),
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					minSize: { width: 0, height: 0 },
					maxWidth: 160,
				},
				measurer,
			);
			annotations.push(
				buildTextAnnotation({
					ownerId: `${node.id}.${port.id}`,
					surfaceKind: "port-label",
					layout,
					typography: typographyForLabel(port.label),
					anchor: portLabelBox(port),
				}),
			);
		}
	}

	for (const node of input.nodes) {
		if (node.compartments === undefined) {
			continue;
		}
		const rows = compartmentRows(node);
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (row === undefined) {
				continue;
			}
			const layout = fitLabel(
				row,
				{
					font: { fontFamily: "Arial", fontSize: 11, lineHeight: 13 },
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					minSize: { width: 0, height: 0 },
					maxWidth: node.box.width,
				},
				measurer,
			);
			annotations.push(
				buildAnchorCenteredTextAnnotation({
					ownerId: node.id,
					surfaceKind: "compartment-row",
					surfaceIndex: index,
					layout,
					anchor: {
						x: node.box.x,
						y: node.box.y + 18 + index * 16,
						width: node.box.width,
						height: 16,
					},
				}),
			);
		}
	}

	for (const swimlane of input.swimlanes) {
		for (const lane of swimlane.lanes) {
			if (lane.label?.text === undefined || lane.box === undefined) {
				continue;
			}
			const labelBox = lane.headerBox ?? lane.box;
			const layout = fitLabel(
				lane.label.text,
				{
					font: typographyTextStyle(lane.label, {
						fontFamily: "Arial",
						fontSize: 12,
						lineHeight: 14,
					}),
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					minSize: { width: 0, height: 0 },
					maxWidth:
						swimlane.orientation === "horizontal"
							? labelBox.height
							: labelBox.width,
				},
				measurer,
			);
			annotations.push(
				buildAnchorCenteredTextAnnotation({
					ownerId: `${swimlane.id}.${lane.id}`,
					surfaceKind: "swimlane-label",
					layout,
					typography: typographyForLabel(lane.label),
					anchor: labelBox,
				}),
			);
		}
	}

	return annotations;
}

function coordinateEdgeTextAnnotations(
	edges: readonly CoordinatedEdge[],
	obstacleBoxes: readonly Box[],
	textMeasurer?: TextMeasurer,
	labelPlacement?: "beside" | "on-path",
	labelOffset?: number,
): SolvedTextAnnotation[] {
	const labelBaseOffset =
		labelPlacement === "beside" ? (labelOffset ?? 16) : 10;

	const measurer = textMeasurer ?? createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];
	const placedLabelBoxes: Box[] = [];

	for (const edge of edges) {
		if (edge.label?.text === undefined) {
			continue;
		}
		const layout = fitLabel(
			edge.label.text,
			{
				font: typographyTextStyle(edge.label, {
					fontFamily: "Arial",
					fontSize: 12,
					lineHeight: 14,
				}),
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				minSize: { width: 0, height: 0 },
				maxWidth: 200,
			},
			measurer,
		);
		const center = edgeLabelAnchor(
			edge,
			layout,
			edges,
			obstacleBoxes,
			placedLabelBoxes,
			labelBaseOffset,
		);
		placedLabelBoxes.push({
			x: center.x - layout.box.width / 2,
			y: center.y - layout.box.height / 2,
			width: layout.box.width,
			height: layout.box.height,
		});
		annotations.push(
			buildCenteredTextAnnotation({
				ownerId: edge.id,
				surfaceKind: "edge-label",
				layout,
				typography: typographyForLabel(edge.label),
				center,
			}),
		);
	}

	return annotations;
}

/**
 * Produce a rough edge-label box estimate using the straight-line
 * midpoint between source and target node centers.  The estimate is
 * used as a pre-route text obstacle so edges can avoid each other's
 * label areas before the real label placement runs (Issue #41).
 */
function estimateEdgeLabelAnnotations(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	textMeasurer: TextMeasurer | undefined,
): SolvedTextAnnotation[] {
	const measurer = textMeasurer ?? createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];

	for (const edge of edges) {
		if (edge.label?.text === undefined) {
			continue;
		}
		const sourceGeom = nodes.get(edge.source.nodeId);
		const targetGeom = nodes.get(edge.target.nodeId);
		if (sourceGeom === undefined || targetGeom === undefined) {
			continue;
		}
		const layout = fitLabel(
			edge.label.text,
			{
				font: typographyTextStyle(edge.label, {
					fontFamily: "Arial",
					fontSize: 12,
					lineHeight: 14,
				}),
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				minSize: { width: 0, height: 0 },
				maxWidth: 200,
			},
			measurer,
		);
		// Straight-line midpoint between node centers.
		const cx = (sourceGeom.center.x + targetGeom.center.x) / 2;
		const cy = (sourceGeom.center.y + targetGeom.center.y) / 2;
		const box: Box = {
			x: cx - layout.box.width / 2,
			y: cy - layout.box.height / 2,
			width: layout.box.width,
			height: layout.box.height,
		};
		annotations.push({
			text: layout.text,
			ownerId: edge.id,
			surfaceKind: "edge-label",
			box,
			anchor: { x: cx, y: cy },
			paddings: layout.padding,
			lines: layout.lines,
			fontFamily: normalizeOutputFontFamily(layout.font),
			fontSize: layout.font.fontSize,
			textBackend: layout.textBackend,
		});
	}
	return annotations;
}

function coordinateFrameTextAnnotation(
	frame: CoordinatedFrame,
	textMeasurer?: TextMeasurer,
): SolvedTextAnnotation {
	const layout = fitLabel(
		frame.titleTab,
		{
			font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			minSize: { width: 0, height: 0 },
			maxWidth: frame.titleBox.width,
		},
		textMeasurer ?? createDefaultTextMeasurer(),
	);
	return buildAnchorCenteredTextAnnotation({
		ownerId: frame.kind,
		surfaceKind: "frame-title",
		layout,
		anchor: frame.titleBox,
	});
}

function buildTextAnnotation(input: {
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	layout: LabelLayout;
	typography?: CjkTypography;
	anchor: Box;
}): SolvedTextAnnotation {
	return {
		text: input.layout.text,
		ownerId: input.ownerId,
		surfaceKind: input.surfaceKind,
		...(input.surfaceIndex === undefined
			? {}
			: { surfaceIndex: input.surfaceIndex }),
		box: {
			x: input.anchor.x + input.layout.box.x,
			y: input.anchor.y + input.layout.box.y,
			width: input.layout.box.width,
			height: input.layout.box.height,
		},
		anchor: input.anchor,
		paddings: input.layout.padding,
		lines: input.layout.lines,
		fontFamily:
			input.typography?.fontFamily ??
			normalizeOutputFontFamily(input.layout.font),
		fontSize: input.typography?.fontSize ?? input.layout.font.fontSize,
		textBackend: input.layout.textBackend,
	};
}

function buildAnchorCenteredTextAnnotation(input: {
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	layout: LabelLayout;
	typography?: CjkTypography;
	anchor: Box;
}): SolvedTextAnnotation {
	return buildCenteredTextAnnotation({
		ownerId: input.ownerId,
		surfaceKind: input.surfaceKind,
		...(input.surfaceIndex === undefined
			? {}
			: { surfaceIndex: input.surfaceIndex }),
		layout: input.layout,
		...(input.typography === undefined ? {} : { typography: input.typography }),
		center: {
			x: input.anchor.x + input.anchor.width / 2,
			y: input.anchor.y + input.anchor.height / 2,
		},
		anchor: input.anchor,
	});
}

function buildCenteredTextAnnotation(input: {
	ownerId: string;
	surfaceKind: TextSurfaceKind;
	surfaceIndex?: number;
	layout: LabelLayout;
	typography?: CjkTypography;
	center: Point;
	anchor?: Box | Point;
}): SolvedTextAnnotation {
	return {
		text: input.layout.text,
		ownerId: input.ownerId,
		surfaceKind: input.surfaceKind,
		...(input.surfaceIndex === undefined
			? {}
			: { surfaceIndex: input.surfaceIndex }),
		box: {
			x: input.center.x - input.layout.box.width / 2,
			y: input.center.y - input.layout.box.height / 2,
			width: input.layout.box.width,
			height: input.layout.box.height,
		},
		anchor: input.anchor ?? input.center,
		paddings: input.layout.padding,
		lines: input.layout.lines,
		fontFamily:
			input.typography?.fontFamily ??
			normalizeOutputFontFamily(input.layout.font),
		fontSize: input.typography?.fontSize ?? input.layout.font.fontSize,
		textBackend: input.layout.textBackend,
	};
}

function normalizeOutputFontFamily(font: TextStyleOptions): string {
	return font.fontFamily === "Arial" ? "Arial, sans-serif" : font.fontFamily;
}

function reportTextAnnotationCollisions(
	annotations: readonly SolvedTextAnnotation[],
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	const relevantAnnotations = annotations.filter((annotation) =>
		isExternallyPlacedText(annotation.surfaceKind),
	);

	for (
		let annotationIndex = 0;
		annotationIndex < relevantAnnotations.length;
		annotationIndex += 1
	) {
		const annotation = relevantAnnotations[annotationIndex];
		if (annotation === undefined) {
			continue;
		}

		for (
			let otherIndex = annotationIndex + 1;
			otherIndex < relevantAnnotations.length;
			otherIndex += 1
		) {
			const other = relevantAnnotations[otherIndex];
			if (other === undefined) {
				continue;
			}
			if (!intersectsAabb(annotation.box, other.box)) {
				continue;
			}
			if (
				annotation.ownerId === other.ownerId &&
				annotation.surfaceKind === other.surfaceKind
			) {
				continue;
			}

			diagnostics.push({
				severity: "warning",
				code: "constraints.overlap.unresolved",
				message: `Text surface ${annotation.surfaceKind} for ${annotation.ownerId} overlaps text surface ${other.surfaceKind} for ${other.ownerId}.`,
				path: ["textAnnotations", annotation.surfaceKind, annotation.ownerId],
				detail: compactDetail({
					textSurfaceKind: annotation.surfaceKind,
					ownerId: annotation.ownerId,
					conflictingObjectId: other.ownerId,
					conflictingObjectKind: other.surfaceKind,
					surfaceIndex: annotation.surfaceIndex,
					otherSurfaceKind: other.surfaceKind,
					otherSurfaceIndex: other.surfaceIndex,
					textBackend: annotation.textBackend,
				}),
			});
		}
	}

	return diagnostics;
}

function reportRouteTextClearance(
	edges: readonly CoordinatedEdge[],
	annotations: readonly SolvedTextAnnotation[],
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const relevantAnnotations = annotations.filter(isRouteClearanceText);

	for (const edge of edges) {
		for (const annotation of relevantAnnotations) {
			if (isEdgeConnectedTextAnnotation(edge, annotation)) {
				continue;
			}
			if (!routeIntersectsTextBox(edge.points, annotation.box)) {
				continue;
			}
			diagnostics.push({
				severity: "warning",
				code: "routing.text-clearance.unresolved",
				message: `Edge ${edge.id} intersects solved text surface ${annotation.surfaceKind} for ${annotation.ownerId}.`,
				path: ["edges", edge.id],
				detail: compactDetail({
					edgeId: edge.id,
					textSurfaceKind: annotation.surfaceKind,
					conflictingObjectId: annotation.ownerId,
					surfaceIndex: annotation.surfaceIndex,
					textBackend: annotation.textBackend,
				}),
			});
		}
	}

	return diagnostics;
}

function isPreRouteTextObstacle(annotation: SolvedTextAnnotation): boolean {
	return isRouteClearanceText(annotation);
}

function isRouteClearanceText(annotation: SolvedTextAnnotation): boolean {
	switch (annotation.surfaceKind) {
		case "port-label":
		case "edge-label":
		case "swimlane-label":
		case "frame-title":
			return true;
		case "node-label":
		case "compartment-row":
			return true;
		case "group-label":
			return textExtendsOutsideAnchor(annotation);
	}
}

function textExtendsOutsideAnchor(annotation: SolvedTextAnnotation): boolean {
	if (!("width" in annotation.anchor)) {
		return true;
	}
	const epsilon = 0.001;
	return (
		annotation.box.x < annotation.anchor.x - epsilon ||
		annotation.box.y < annotation.anchor.y - epsilon ||
		annotation.box.x + annotation.box.width >
			annotation.anchor.x + annotation.anchor.width + epsilon ||
		annotation.box.y + annotation.box.height >
			annotation.anchor.y + annotation.anchor.height + epsilon
	);
}

function routeIntersectsTextBox(points: readonly Point[], box: Box): boolean {
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		if (segmentIntersectsBox(start, end, box)) {
			return true;
		}
	}
	return false;
}

function segmentIntersectsBox(start: Point, end: Point, box: Box): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	if (pointInsideBox(start, box) || pointInsideBox(end, box)) {
		return true;
	}
	if (start.x === end.x) {
		return (
			start.x > left &&
			start.x < right &&
			rangesOverlap(start.y, end.y, top, bottom)
		);
	}
	if (start.y === end.y) {
		return (
			start.y > top &&
			start.y < bottom &&
			rangesOverlap(start.x, end.x, left, right)
		);
	}
	return (
		segmentIntersectsBoxEdge(start, end, left, top, right, top) ||
		segmentIntersectsBoxEdge(start, end, right, top, right, bottom) ||
		segmentIntersectsBoxEdge(start, end, right, bottom, left, bottom) ||
		segmentIntersectsBoxEdge(start, end, left, bottom, left, top)
	);
}

function pointInsideBox(point: Point, box: Box): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return high > min && low < max;
}

function segmentIntersectsBoxEdge(
	start: Point,
	end: Point,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): boolean {
	const denominator =
		(end.x - start.x) * (y2 - y1) - (end.y - start.y) * (x2 - x1);
	if (denominator === 0) {
		return false;
	}
	const t =
		((x1 - start.x) * (y2 - y1) - (y1 - start.y) * (x2 - x1)) / denominator;
	const u =
		((x1 - start.x) * (end.y - start.y) - (y1 - start.y) * (end.x - start.x)) /
		denominator;
	return t > 0 && t < 1 && u > 0 && u < 1;
}

function compactDetail(
	detail: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(detail).filter(
			(entry): entry is [string, string | number | boolean] =>
				entry[1] !== undefined,
		),
	);
}

function isExternallyPlacedText(surfaceKind: TextSurfaceKind): boolean {
	switch (surfaceKind) {
		case "port-label":
			return true;
		case "edge-label":
			return false;
		case "swimlane-label":
			return true;
		case "frame-title":
			return true;
		case "node-label":
		case "group-label":
		case "compartment-row":
			return false;
	}
}

function fallbackLabelLayout(text: string): LabelLayout {
	const width = Math.max(0, text.length * 7);
	return {
		text,
		box: { x: 0, y: 0, width, height: 14 },
		contentBox: { x: 0, y: 0, width, height: 14 },
		naturalSize: { width, height: 14 },
		fittedSize: { width, height: 14 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		font: { fontFamily: "Arial", fontSize: 12, lineHeight: 14 },
		lineHeight: 14,
		lines: [
			{
				text,
				box: { x: 0, y: 0, width, height: 14 },
				baselineY: 11.2,
				width,
				lineIndex: 0,
			},
		],
		overflow: { horizontal: false, vertical: false, truncated: false },
		diagnostics: [],
	};
}

function edgeLabelAnchor(
	edge: CoordinatedEdge,
	layout: LabelLayout,
	edges: readonly CoordinatedEdge[],
	obstacleBoxes: readonly Box[],
	placedLabelBoxes: readonly Box[],
	baseOffset = 10,
): Point {
	const placement = labelPlacementOnPolyline(edge.points, baseOffset);
	if (placement === undefined) {
		return { x: 0, y: 0 };
	}

	for (const candidate of edgeLabelAnchorCandidates(
		edge.points,
		placement,
		layout,
		baseOffset,
	)) {
		const labelBox = {
			x: candidate.x - layout.box.width / 2,
			y: candidate.y - layout.box.height / 2,
			width: layout.box.width,
			height: layout.box.height,
		};
		if (routeIntersectsTextBox(edge.points, labelBox)) {
			continue;
		}
		const crossesOtherRoute = edges.some(
			(other) =>
				other.id !== edge.id && routeIntersectsTextBox(other.points, labelBox),
		);
		if (crossesOtherRoute) {
			continue;
		}
		const overlapsNode = obstacleBoxes.some((box) =>
			intersectsAabb(labelBox, box),
		);
		if (overlapsNode) {
			continue;
		}
		const overlapsPlacedLabel = placedLabelBoxes.some((box) =>
			intersectsAabb(labelBox, box),
		);
		if (!overlapsPlacedLabel) {
			return candidate;
		}
	}

	return placement;
}

function edgeLabelAnchorCandidates(
	points: readonly Point[],
	placement: Point,
	layout: LabelLayout,
	baseOffset = 10,
): Point[] {
	const segment = labelSegmentOnPolyline(points, baseOffset);
	if (segment === undefined) {
		return [placement];
	}

	const candidates: Point[] = [placement];
	// Expand the offset progressively. The number of steps is derived from the
	// label's own size so wide/tall labels can move far enough to clear their
	// own route segment (a fixed step count fails for labels wider than the
	// search range).
	if (segment.start.y === segment.end.y) {
		// Horizontal segment: label moves vertically; must clear half its height.
		const needed = layout.box.height / 2 + EDGE_LABEL_CLEARANCE;
		const maxSteps = Math.max(12, Math.ceil(needed / EDGE_LABEL_CLEARANCE));
		for (let step = 1; step <= maxSteps; step += 1) {
			const offset = EDGE_LABEL_CLEARANCE * step;
			candidates.push(
				{ x: placement.x, y: placement.y - offset },
				{ x: placement.x, y: placement.y + offset },
			);
		}
	} else if (segment.start.x === segment.end.x) {
		// Vertical segment: label moves horizontally; must clear half its width.
		const needed = layout.box.width / 2 + EDGE_LABEL_CLEARANCE;
		const maxSteps = Math.max(12, Math.ceil(needed / EDGE_LABEL_CLEARANCE));
		for (let step = 1; step <= maxSteps; step += 1) {
			const offset = EDGE_LABEL_CLEARANCE * step;
			candidates.push(
				{ x: placement.x + offset, y: placement.y },
				{ x: placement.x - offset, y: placement.y },
			);
		}
	} else {
		// Diagonal segment: expand in both perpendicular directions.
		const dx = segment.end.x - segment.start.x;
		const dy = segment.end.y - segment.start.y;
		const segLen = Math.hypot(dx, dy);
		if (segLen > 0) {
			const nx = -dy / segLen;
			const ny = dx / segLen;
			const needed =
				(Math.abs(nx) * layout.box.width + Math.abs(ny) * layout.box.height) /
					2 +
				EDGE_LABEL_CLEARANCE;
			const maxSteps = Math.max(12, Math.ceil(needed / EDGE_LABEL_CLEARANCE));
			for (let step = 1; step <= maxSteps; step += 1) {
				const offset = EDGE_LABEL_CLEARANCE * step;
				candidates.push(
					{ x: placement.x + nx * offset, y: placement.y + ny * offset },
					{ x: placement.x - nx * offset, y: placement.y - ny * offset },
				);
			}
		}
	}

	// For long edges, also try quartile positions along the polyline.
	const totalLen = points.reduce((sum, p, idx) => {
		if (idx === 0) return 0;
		const prev = points[idx - 1];
		return (
			sum +
			Math.hypot((p?.x ?? 0) - (prev?.x ?? 0), (p?.y ?? 0) - (prev?.y ?? 0))
		);
	}, 0);
	if (totalLen > 200) {
		for (const ratio of [0.25, 0.75]) {
			const qp = labelPlacementAtRatio(points, ratio, totalLen, baseOffset);
			if (qp !== undefined) {
				candidates.push(qp);
				// Find the segment that contains the quartile point
				// (labelSegmentOnPolyline gives the midpoint segment, not the quartile one)
				const qTargetDist = totalLen * ratio;
				let qTravelled = 0;
				let seg: { start: Point; end: Point; length: number } | undefined;
				for (let si = 1; si < points.length; si++) {
					const sp = points[si - 1];
					const sc = points[si];
					if (sp === undefined || sc === undefined) continue;
					const sl = Math.hypot(sc.x - sp.x, sc.y - sp.y);
					if (sl <= 0) continue;
					if (qTravelled + sl >= qTargetDist) {
						seg = { start: sp, end: sc, length: sl };
						break;
					}
					qTravelled += sl;
				}
				if (seg !== undefined) {
					const segLen = Math.hypot(
						seg.end.x - seg.start.x,
						seg.end.y - seg.start.y,
					);
					const qpNeeded =
						seg.start.y === seg.end.y
							? layout.box.height / 2 + EDGE_LABEL_CLEARANCE
							: seg.start.x === seg.end.x
								? layout.box.width / 2 + EDGE_LABEL_CLEARANCE
								: (Math.abs(seg.start.y - seg.end.y) * layout.box.width +
										Math.abs(seg.end.x - seg.start.x) * layout.box.height) /
										(2 * segLen) +
									EDGE_LABEL_CLEARANCE;
					const qpMaxSteps = Math.max(
						12,
						Math.ceil(qpNeeded / EDGE_LABEL_CLEARANCE),
					);
					for (let step = 1; step <= qpMaxSteps; step += 1) {
						const offset = EDGE_LABEL_CLEARANCE * step;
						if (seg.start.y === seg.end.y) {
							candidates.push(
								{ x: qp.x, y: qp.y - offset },
								{ x: qp.x, y: qp.y + offset },
							);
						} else if (seg.start.x === seg.end.x) {
							candidates.push(
								{ x: qp.x - offset, y: qp.y },
								{ x: qp.x + offset, y: qp.y },
							);
						} else {
							const nx = -(seg.end.y - seg.start.y) / segLen;
							const ny = (seg.end.x - seg.start.x) / segLen;
							candidates.push(
								{ x: qp.x + nx * offset, y: qp.y + ny * offset },
								{ x: qp.x - nx * offset, y: qp.y - ny * offset },
							);
						}
					}
				}
			}
		}
	}

	return candidates;
}

function labelPlacementOnPolyline(
	points: readonly Point[],
	baseOffset = 10,
): Point | undefined {
	return labelSegmentOnPolyline(points, baseOffset)?.placement;
}

function labelSegmentOnPolyline(
	points: readonly Point[],
	baseOffset = 10,
): { start: Point; end: Point; placement: Point } | undefined {
	const segments = nonZeroSegments(points);
	const totalLength = segments.reduce(
		(sum, segment) => sum + segment.length,
		0,
	);
	if (totalLength <= 0) {
		return undefined;
	}

	let remaining = totalLength / 2;
	for (const segment of segments) {
		if (remaining <= segment.length) {
			const ratio = remaining / segment.length;
			const x = segment.start.x + (segment.end.x - segment.start.x) * ratio;
			const y = segment.start.y + (segment.end.y - segment.start.y) * ratio;
			const offset = labelOffset(segment, baseOffset);
			return {
				start: segment.start,
				end: segment.end,
				placement: { x: x + offset.x, y: y + offset.y },
			};
		}
		remaining -= segment.length;
	}

	const last = segments.at(-1);
	if (last === undefined) {
		return undefined;
	}
	const offset = labelOffset(last, baseOffset);
	return {
		start: last.start,
		end: last.end,
		placement: { x: last.end.x + offset.x, y: last.end.y + offset.y },
	};
}

function nonZeroSegments(points: readonly Point[]): Array<{
	start: Point;
	end: Point;
	length: number;
}> {
	const segments: Array<{ start: Point; end: Point; length: number }> = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		if (length > 0) {
			segments.push({ start, end, length });
		}
	}
	return segments;
}

function labelPlacementAtRatio(
	points: readonly Point[],
	ratio: number,
	totalLength: number,
	baseOffset = 10,
): Point | undefined {
	if (points.length < 2 || ratio < 0 || ratio > 1) {
		return undefined;
	}
	const targetDist = totalLength * ratio;
	let travelled = 0;
	for (let idx = 1; idx < points.length; idx++) {
		const prev = points[idx - 1];
		const curr = points[idx];
		if (prev === undefined || curr === undefined) {
			continue;
		}
		const segLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
		if (segLen <= 0) {
			continue;
		}
		if (travelled + segLen >= targetDist) {
			const t = (targetDist - travelled) / segLen;
			const offset = labelOffset(
				{ start: prev, end: curr, length: segLen },
				baseOffset,
			);
			return {
				x: prev.x + (curr.x - prev.x) * t + offset.x,
				y: prev.y + (curr.y - prev.y) * t + offset.y,
			};
		}
		travelled += segLen;
	}
	return undefined;
}

function labelOffset(
	segment: { start: Point; end: Point; length: number },
	baseOffset = 10,
): Point {
	const offset = baseOffset;
	const dx = segment.end.x - segment.start.x;
	const dy = segment.end.y - segment.start.y;
	return {
		x: (-dy / segment.length) * offset,
		y: (dx / segment.length) * offset,
	};
}

function compartmentRows(node: CoordinatedNode): string[] {
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

function portGeometry(
	nodeGeometry: ReturnType<typeof computeShapeGeometry>,
	port: CoordinatedPort | undefined,
): ReturnType<typeof computeShapeGeometry> {
	if (port === undefined) {
		return nodeGeometry;
	}
	return {
		...nodeGeometry,
		box: port.box,
		center: port.anchor,
		anchors: nodeGeometry.anchors.map((anchor) => ({
			name: anchor.name,
			point: port.anchor,
		})),
		obstacleBox: port.box,
	};
}

function stableUniqueById<T extends { id: string }>(
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

function stableByConstraintId<T extends { id?: string; kind: string }>(
	items: readonly T[],
): T[] {
	return [...items].sort((a, b) =>
		`${a.id ?? a.kind}`.localeCompare(`${b.id ?? b.kind}`),
	);
}

function groupReferenceMissing(
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

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pipeline factory (Issue #54, 方案 D)
// ---------------------------------------------------------------------------

/**
 * Build the default layout pipeline. Currently wraps `solveDiagram` in
 * a single mega-phase so custom callers can replace individual phases
 * (e.g. "initial-layout", "route-edges") without touching the rest.
 *
 * Individual phases will be extracted from the mega-phase in follow-up
 * PRs for 方案 A (recursive layout) and 方案 B (corner-graph A*).
 */
export function createDefaultPipeline(): LayoutPipeline {
	return new LayoutPipeline()
		.addPhase({
			name: "solve-diagram",
			run(state: LayoutState): void {
				const result = solveDiagram(state.diagram, state.options);
				// Mirror the result back into the state so downstream
				// consumers can inspect it after the pipeline runs.
				state.diagnostics.push(...result.diagnostics);
				state.bounds = result.bounds;
				state.degraded = result.degraded ?? false;
				state.coordinatedNodes = result.nodes;
				state.coordinatedEdges = result.edges;
			},
		})
		.addPhase({
			name: "quality-score",
			run(state: LayoutState): void {
				if (!state.options.qualityScore) return;
				const report = scoreLayoutQuality(
					state.coordinatedNodes,
					state.coordinatedEdges,
				);
				state.qualityReport = report;
				state.diagnostics.push(...report.diagnostics);
			},
		});
}
