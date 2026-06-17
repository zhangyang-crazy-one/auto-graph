import { applyLayoutConstraints } from "../constraints/index.js";
import { computeArrowhead } from "../exporters/arrow.js";
import {
	computeContainerGeometry,
	computeShapeGeometry,
	intersectsAabb,
	normalizeInsets,
	unionBoxes,
} from "../geometry/index.js";
import type { Constraint } from "../ir/constraints.js";
import type { Diagnostic } from "../ir/diagnostics.js";
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
import { runDagreInitialLayout } from "../layout/index.js";
import { type RouteKind, routeEdge } from "../routing/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import type { TextMeasurer, TextStyleOptions } from "../text/types.js";

export interface SolveDiagramOptions {
	routeKind?: RouteKind;
	obstacleMargin?: number | Insets;
	overlapSpacing?: number;
	minSiblingGap?: number;
	pageBounds?: { width: number; height: number };
	maxStackDepth?: number;
	preferredAspectRatio?: number;
	portShifting?: PortShiftingOptions;
	cjkFontFamily?: string | false;
	minCjkFontSize?: number | false;
	textMeasurer?: TextMeasurer;
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
const EVIDENCE_TEXT_FONT = {
	fontFamily: "Arial, sans-serif",
	fontSize: 10,
	lineHeight: 12,
} as const;

interface SwimlaneContractLayout {
	box: Box;
	slotWidth: number;
	slotHeight: number;
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
	const styledNodes = nodes.map((node) =>
		enhanceNodeCjkTypography(node, cjkTypography, diagnostics),
	);
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
	const layout = runDagreInitialLayout({
		direction: diagram.direction,
		nodes: styledNodes.map((node) => ({ id: node.id, size: node.size })),
		edges: styledEdges.map((edge) => ({
			id: edge.id,
			sourceId: edge.source.nodeId,
			targetId: edge.target.nodeId,
		})),
	});

	diagnostics.push(...layout.diagnostics);
	const initialNodeBoxes = wrapVerticalStackIfNeeded(
		layout.boxes,
		styledNodes,
		styledEdges,
		diagram.direction,
		options,
		diagnostics,
	);

	const constrained = applyLayoutConstraints({
		direction: diagram.direction,
		overlapSpacing: options?.overlapSpacing ?? 40,
		...(options.minSiblingGap === undefined
			? {}
			: { minSiblingGap: options.minSiblingGap }),
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
	);
	if (swimlaneContracts.layouts.size > 0) {
		removeResolvedOverlapDiagnostics(diagnostics, constrained.boxes);
	}
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
	];
	const coordinatedEdges = coordinateEdges(
		styledEdges,
		nodeGeometryById,
		coordinatedNodes,
		[...nodeGeometryById.values()].map((geometry) => geometry.obstacleBox),
		[
			...coordinatedTables.map((table) => table.box),
			...coordinatedEvidencePanels.map((panel) => panel.box),
		],
		routingTextObstacles,
		coordinatedMatrices.map((matrix) => matrix.box),
		diagram.direction,
		options,
		diagnostics,
	);
	const edgeTextAnnotations = coordinateEdgeTextAnnotations(
		coordinatedEdges,
		options.textMeasurer,
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
		...reportPageOverflow(unionBoxes(boundsBase), options.pageBounds),
	);

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
		diagnostics,
		bounds:
			frame === undefined
				? unionBoxes(boundsBase)
				: unionBoxes([...boundsBase, frame.box, frame.titleBox]),
		...(frame === undefined ? {} : { frame }),
		...(textAnnotations.length === 0 ? {} : { textAnnotations }),
		...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
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
	if (
		edges.length > 0 ||
		!isVerticalRunaway(wrapped, nodes, direction, options)
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

function reportVerticalRunaway(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	edges: readonly NormalizedEdge[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	if (!isVerticalRunaway(boxes, nodes, direction, options)) {
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

function isVerticalRunaway(
	boxes: ReadonlyMap<string, Box>,
	nodes: readonly NormalizedNode[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): boolean {
	if (
		options.maxStackDepth === undefined &&
		options.preferredAspectRatio === undefined
	) {
		return false;
	}
	if (nodes.length < 2 || (direction !== "LR" && direction !== "RL")) {
		return false;
	}
	const nodeBoxes = nodes
		.map((node) => boxes.get(node.id))
		.filter((box): box is Box => box !== undefined);
	if (nodeBoxes.length < 2) {
		return false;
	}
	const bounds = unionBoxes(nodeBoxes);
	const aspectRatio =
		bounds.width <= 0 ? Number.POSITIVE_INFINITY : bounds.height / bounds.width;
	const preferred = options.preferredAspectRatio ?? 3;
	if (aspectRatio < preferred) {
		return false;
	}
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
	const laneContentTop = top + headerHeight + padding;

	for (let index = 0; index < swimlane.lanes.length; index += 1) {
		const lane = swimlane.lanes[index];
		const bounds = laneBounds[index];
		if (lane === undefined || bounds === undefined) {
			continue;
		}
		const target = {
			x: left + slotWidth * index + padding,
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
			{
				x: target.x - bounds.x,
				y: laneContentTop,
			},
		);
	}

	return {
		box: {
			x: left,
			y: top,
			width: slotWidth * swimlane.lanes.length,
			height: contentHeight + padding * 2 + headerHeight,
		},
		slotWidth,
		slotHeight: contentHeight + padding * 2 + headerHeight,
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
): void {
	for (const [rank, stack] of rankStacks(childIds, nodeBoxes, flowRanks)) {
		let yOffset = 0;
		for (const item of stack) {
			const { childId, box } = item;
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
			const next = {
				...box,
				x: box.x + target.x,
				y: target.y + rank * rankSpacing + yOffset,
			};
			if (next.x !== box.x || next.y !== box.y) {
				movedChildIds.add(childId);
			}
			nodeBoxes.set(childId, next);
			yOffset += box.height + rankStackGap;
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

	for (let index = 0; index < swimlane.lanes.length; index += 1) {
		const lane = swimlane.lanes[index];
		const bounds = laneBounds[index];
		if (lane === undefined || bounds === undefined) {
			continue;
		}
		const target = {
			x: left + headerHeight + padding,
			y: top + slotHeight * index + padding,
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
			height: slotHeight * swimlane.lanes.length,
		},
		slotWidth,
		slotHeight,
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

		const geometry = computeShapeGeometry({
			shape: node.shape,
			box,
			obstacleMargin: options.obstacleMargin ?? 0,
		});

		coordinated.push({
			id: node.id,
			...(node.label === undefined ? {} : { label: node.label }),
			...(node.style === undefined ? {} : { style: node.style }),
			...(node.ports === undefined
				? {}
				: { ports: coordinatePorts(node, box, options.portShifting) }),
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
	const spacing = portShifting?.spacing ?? 24;
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
	const size = 10;
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
								x: contractLayout.box.x + contractLayout.slotWidth * index,
								y: contractLayout.box.y,
								width: contractLayout.slotWidth,
								height: contractLayout.box.height,
							}
						: {
								x: contractLayout.box.x,
								y: contractLayout.box.y + contractLayout.slotHeight * index,
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
	blocks: Array<{ position?: Point; box: Box }>,
	contentBounds: Box,
): void {
	let nextY = contentBounds.y;
	const x = contentBounds.x + contentBounds.width + DEFAULT_EVIDENCE_BLOCK_GAP;
	for (const block of blocks) {
		if (block.position !== undefined) {
			continue;
		}
		block.box.x = x;
		block.box.y = nextY;
		nextY += block.box.height + DEFAULT_EVIDENCE_BLOCK_GAP;
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
): CoordinatedEdge[] {
	const coordinated: CoordinatedEdge[] = [];
	const coordinatedNodeById = new Map(
		coordinatedNodes.map((node) => [node.id, node]),
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
		const connectedTextOwners = edgeConnectedTextOwnerIds(edge);
		const routeTextObstacles = textObstacles
			.filter((annotation) => !connectedTextOwners.has(annotation.ownerId))
			.map((annotation) => annotation.box);

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
				...obstacles.filter(
					(obstacle) =>
						obstacle !== source.obstacleBox && obstacle !== target.obstacleBox,
				),
				...softObstacles,
				...routeTextObstacles,
			],
			hardObstacles,
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

function edgeConnectedTextOwnerIds(
	edge: NormalizedEdge | CoordinatedEdge,
): Set<string> {
	const owners = new Set<string>();
	if (edge.source.portId !== undefined) {
		owners.add(`${edge.source.nodeId}.${edge.source.portId}`);
	}
	if (edge.target.portId !== undefined) {
		owners.add(`${edge.target.nodeId}.${edge.target.portId}`);
	}
	return owners;
}

function coordinateBaseTextAnnotations(input: {
	nodes: readonly CoordinatedNode[];
	groups: readonly CoordinatedGroup[];
	swimlanes: readonly Swimlane[];
	textMeasurer?: TextMeasurer;
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
	textMeasurer?: TextMeasurer,
): SolvedTextAnnotation[] {
	const measurer = textMeasurer ?? createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];

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
		annotations.push(
			buildCenteredTextAnnotation({
				ownerId: edge.id,
				surfaceKind: "edge-label",
				layout,
				typography: typographyForLabel(edge.label),
				center: edgeLabelAnchor(edge, layout, edges),
			}),
		);
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
		const connectedTextOwners = edgeConnectedTextOwnerIds(edge);
		for (const annotation of relevantAnnotations) {
			if (
				annotation.ownerId === edge.id ||
				connectedTextOwners.has(annotation.ownerId)
			) {
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
	if (annotation.surfaceKind === "edge-label") {
		return false;
	}
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
		case "group-label":
		case "compartment-row":
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
): Point {
	const placement = labelPlacementOnPolyline(edge.points);
	if (placement === undefined) {
		return { x: 0, y: 0 };
	}

	for (const candidate of edgeLabelAnchorCandidates(edge.points, placement)) {
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
		if (!crossesOtherRoute) {
			return candidate;
		}
	}

	return placement;
}

function edgeLabelAnchorCandidates(
	points: readonly Point[],
	placement: Point,
): Point[] {
	const segment = labelSegmentOnPolyline(points);
	if (segment === undefined) {
		return [placement];
	}

	if (segment.start.y === segment.end.y) {
		return [
			placement,
			{ x: placement.x, y: placement.y - EDGE_LABEL_CLEARANCE },
			{ x: placement.x, y: placement.y + EDGE_LABEL_CLEARANCE },
			{ x: placement.x, y: placement.y - EDGE_LABEL_CLEARANCE * 2 },
			{ x: placement.x, y: placement.y + EDGE_LABEL_CLEARANCE * 2 },
		];
	}

	if (segment.start.x === segment.end.x) {
		return [
			placement,
			{ x: placement.x + EDGE_LABEL_CLEARANCE, y: placement.y },
			{ x: placement.x - EDGE_LABEL_CLEARANCE, y: placement.y },
			{ x: placement.x + EDGE_LABEL_CLEARANCE * 2, y: placement.y },
			{ x: placement.x - EDGE_LABEL_CLEARANCE * 2, y: placement.y },
		];
	}

	return [placement];
}

function labelPlacementOnPolyline(points: readonly Point[]): Point | undefined {
	return labelSegmentOnPolyline(points)?.placement;
}

function labelSegmentOnPolyline(
	points: readonly Point[],
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
			const offset = labelOffset(segment);
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
	const offset = labelOffset(last);
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

function labelOffset(segment: {
	start: Point;
	end: Point;
	length: number;
}): Point {
	const offset = 10;
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
