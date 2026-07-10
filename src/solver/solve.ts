import { applyLayoutConstraints } from "../constraints/index.js";
import {
	computeContainerGeometry,
	computeShapeGeometry,
	createBoxSpatialIndex,
	expandBox,
	intersectsAabb,
	queryBoxSpatialIndex,
	unionBoxes,
} from "../geometry/index.js";
import { getEdgePort } from "../geometry/shapes.js";
import {
	DELIVERABILITY_DIAGNOSTIC_CODES,
	type Diagnostic,
	type RouteConflictClass,
} from "../ir/diagnostics.js";
import type {
	CoordinatedDiagram,
	DeliverabilityReport,
	ExternalLabelCallout,
	NormalizedDiagram,
	PagePolicy,
	PageSplitPolicyMode,
	RemediationPlan,
	RemediationPlanDetail,
	RemediationPlanType,
	RemediationPolicy,
	RemediationPolicyMode,
	RoutingAllocationReport,
	RoutingGutterAllocation,
	RoutingRailAllocation,
} from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedEvidencePanel,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedMatrixBlock,
	CoordinatedNode,
	CoordinatedPort,
	CoordinatedTableBlock,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
} from "../ir/elements.js";
import type { AnchorName, Box, Insets, Point } from "../ir/geometry.js";
import type {
	LabelLayout,
	SolvedTextAnnotation,
	TextSurfaceKind,
} from "../ir/label-layout.js";
import { fitLabel } from "../labels/index.js";
import { runRecursiveContainerLayout } from "../layout/recursive.js";
import { computeFanOutPorts } from "../routing/bus-router.js";
import { type RouteHardObstacleMetadata, routeEdge } from "../routing/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import type { TextMeasurer, TextStyleOptions } from "../text/types.js";
import {
	type CjkTypography,
	createCjkTypographyOptions,
	enhanceEdgeCjkTypography,
	enhanceGroupCjkTypography,
	enhanceNodeCjkTypography,
	enhanceSwimlaneCjkTypography,
	typographyForLabel,
	typographyTextStyle,
} from "./cjk-typography.js";
import {
	coordinateEvidencePanels,
	coordinateMatrices,
	coordinateTables,
	measureEvidenceTextBlocks,
	placeEvidenceBlocks,
	refreshTableColumnXOffsets,
	reportEvidenceBlockOverlaps,
} from "./evidence.js";
import {
	ancestorGroupIds,
	boxCenter,
	boxJson,
	cloneBoxMap,
	cloneNormalizedNodeForSolver,
	compactDetail,
	compartmentRows,
	DEFAULT_MAX_REMEDIATION_ITERATIONS,
	DEFAULT_RAIL_BUDGET,
	EDGE_LABEL_CLEARANCE,
	EXTERNAL_LABEL_SHELF_GAP,
	EXTERNAL_LABEL_SHELF_ROW_GAP,
	edgeCorridorBox,
	flattenDiagnosticDetailCsvStrings,
	flattenDiagnosticDetailStrings,
	groupReferenceMissing,
	insetBox,
	isTopToBottomReadingDirection,
	MIN_PORT_EDGE_GAP,
	numberDetail,
	PORT_BOX_SIZE,
	pointInsideBox,
	policyUsesFanOutBundles,
	RAIL_BAND_SOFT_OBSTACLE_MAX,
	REMEDIATION_ENTRY_DIAGNOSTIC_CODES,
	rangesOverlap,
	removeResolvedOverlapDiagnostics,
	reportPageOverflow,
	reserveSideGutters,
	sameBox,
	stableByConstraintId,
	stableStrings,
	stableUniqueById,
} from "./helpers.js";
import {
	capacityFromDiagnostics,
	edgeBounds,
	framePadding,
	growthDeltasFromDiagnostics,
	isSameRankEdge,
	prefitNodeLabelSize,
	reportPostGrowthOverlaps,
	runInitialLayout,
	wrapHorizontalStackIfNeeded,
	wrapVerticalStackIfNeeded,
} from "./initial-layout.js";
import type { PortShiftingOptions, SolveDiagramOptions } from "./options.js";
import {
	classifyPagePolicyFromBoxes,
	isStrictDeliverability,
	metadataPagePolicy,
	PAGE_POLICY_SAME_RANK_DEPENDENCY_MIN,
	resolvePagePolicy,
	shouldAutoClassifyPagePolicy,
} from "./page-policy.js";
import { LayoutPipeline } from "./pipeline/pipeline.js";
import { scoreLayoutQuality } from "./pipeline/quality.js";
import type { LayoutState } from "./pipeline/types.js";
import type { SwimlaneContractLayout } from "./swimlane-contracts.js";
import {
	applySwimlaneLayoutContracts,
	coordinateSwimlanes,
	hasFixedSwimlaneGeometry,
	reserveLaneCorridors,
} from "./swimlane-contracts.js";

export type {
	InitialLayoutMode,
	PortShiftingOptions,
	SolveDiagramOptions,
} from "./options.js";
export { resolvePagePolicy } from "./page-policy.js";

interface BuiltExternalLabelCallout {
	callout: ExternalLabelCallout;
	source: SolvedTextAnnotation;
	keyAnnotation: SolvedTextAnnotation;
	calloutAnnotation: SolvedTextAnnotation;
}

export function solveDiagram(
	diagram: NormalizedDiagram,
	inputOptions: SolveDiagramOptions = {},
): CoordinatedDiagram {
	const explicitPagePolicy =
		inputOptions.pagePolicy ?? metadataPagePolicy(diagram.metadata);
	const deferAutoPagePolicy =
		explicitPagePolicy === "auto" ||
		(explicitPagePolicy === undefined &&
			shouldAutoClassifyPagePolicy(inputOptions));
	// Defer auto classification until node boxes exist (after layout). Explicit
	// concrete policies still resolve immediately.
	let resolvedPagePolicy: PagePolicy = deferAutoPagePolicy
		? "off"
		: resolvePagePolicy(diagram, inputOptions);
	let options: SolveDiagramOptions = {
		...inputOptions,
		pagePolicy: resolvedPagePolicy,
	};
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
	const styledNodesBase =
		options.prefitLabelSize === true
			? cjkStyledNodes.map((node) =>
					prefitNodeLabelSize(node, options, diagnostics),
				)
			: cjkStyledNodes;
	const styledNodes = styledNodesBase.map(cloneNormalizedNodeForSolver);
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
	const contractSwimlanes =
		options.fixedSwimlaneGeometry === true ||
		options.fixedSwimlaneGeometry === "diagnose-overflow"
			? styledSwimlanes.filter(
					(swimlane) => !hasFixedSwimlaneGeometry(swimlane),
				)
			: styledSwimlanes;
	const swimlaneContracts =
		contractSwimlanes.length === 0
			? {
					layouts: new Map<string, SwimlaneContractLayout>(),
					diagnostics: [] as Diagnostic[],
					movedChildIds: new Set<string>(),
				}
			: applySwimlaneLayoutContracts(
					contractSwimlanes,
					constraints,
					styledEdges,
					isTopToBottomReadingDirection(
						diagram.metadata?.primaryReadingDirection,
					),
					constrained.boxes,
					constrained.locks,
					options?.overlapSpacing ?? 40,
					Math.max(0, options?.minLaneGutter ?? 0),
					options.distributeContainedChildren ?? true,
				);
	// Distribution may resolve overlaps that were reported earlier
	// by repairOverlaps — clean those up before continuing.
	removeResolvedOverlapDiagnostics(diagnostics, constrained.boxes);
	diagnostics.push(...swimlaneContracts.diagnostics);
	const beforeAnchorGrowthBoxes = cloneBoxMap(constrained.boxes);
	expandNodeBoxesForAnchorCapacity(
		styledEdges,
		styledNodes,
		constrained.boxes,
		diagram.direction,
		options,
		diagnostics,
	);
	diagnostics.push(
		...reportPostGrowthOverlaps(beforeAnchorGrowthBoxes, constrained.boxes),
	);

	if (deferAutoPagePolicy) {
		resolvedPagePolicy = classifyPagePolicyFromBoxes(
			diagram,
			constrained.boxes,
		);
		options = {
			...options,
			pagePolicy: resolvedPagePolicy,
		};
	}

	let coordinatedNodes = coordinateNodes(
		styledNodes,
		constrained.boxes,
		options,
		diagnostics,
	);
	let nodeGeometryById = new Map(
		coordinatedNodes.map((node) => [
			node.id,
			computeShapeGeometry({
				shape: node.shape,
				box: node.box,
				obstacleMargin: options.obstacleMargin ?? 0,
			}),
		]),
	);
	let coordinatedGroups = coordinateGroups(
		styledGroups,
		constrained.boxes,
		options,
		diagnostics,
	);
	let coordinatedSwimlanes = coordinateSwimlanes(
		styledSwimlanes,
		constrained.boxes,
		swimlaneContracts.layouts,
		options,
		diagnostics,
	);
	const coordinatedMatrices = coordinateMatrices(diagram.matrices ?? []);
	const coordinatedTables = coordinateTables(diagram.tables ?? []);
	const coordinatedEvidencePanels = coordinateEvidencePanels(
		diagram.evidencePanels ?? [],
	);
	const groupBoxes = new Map(
		coordinatedGroups.map((group) => [group.id, group.box]),
	);
	let baseTextAnnotations = coordinateBaseTextAnnotations({
		nodes: coordinatedNodes,
		groups: coordinatedGroups,
		swimlanes: coordinatedSwimlanes,
		...(options.textMeasurer === undefined
			? {}
			: { textMeasurer: options.textMeasurer }),
	});
	let edgeLabelEstimates =
		edgeLabelExternalizationPolicy(options) === "force"
			? []
			: estimateEdgeLabelAnnotations(
					styledEdges,
					nodeGeometryById,
					options.textMeasurer,
					options.labelPlacement,
					options.labelOffset,
				);
	let layoutBoxes = [
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
	let contentBounds =
		allBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(allBoxes);
	let frame =
		diagram.frame === undefined
			? undefined
			: coordinateFrame(diagram.frame, contentBounds);
	let frameTextAnnotation =
		frame === undefined
			? []
			: [coordinateFrameTextAnnotation(frame, options.textMeasurer)];
	let routingTextObstacles = [
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
	let titleBarObstacles: Box[] = [];
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

	let reservedSideGutters = reserveSideGutters(
		contentBounds,
		diagram.direction,
		resolvedPagePolicy,
	);
	let laneReservations = reserveLaneCorridors(
		coordinatedSwimlanes,
		frame,
		resolvedPagePolicy,
		margin,
	);
	let policySoftObstacles = [
		...softObstacles,
		...(resolvedPagePolicy === "lane-behavior" ? [] : titleBarObstacles),
		...laneReservations.softCorridors,
	];
	const policyLabelHardObstacles = resourceFlowLabelHardObstacles(
		baseTextAnnotations,
		resolvedPagePolicy,
		options,
	);
	let policyHardObstacles = [
		...hardObstacles,
		...laneReservations.hardBands,
		...policyLabelHardObstacles,
	];
	let policyHardObstacleMetadata: RouteHardObstacleMetadata[] = [
		...hardObstacles.map(() => ({ kind: "evidence" as const })),
		...laneReservations.hardBands.map(() => ({ kind: "text" as const })),
		...policyLabelHardObstacles.map(() => ({ kind: "text" as const })),
	];

	let routeObstacleEntries = [...nodeGeometryById.entries()].map(
		([nodeId, geometry]) => ({
			id: nodeId,
			box:
				options.routingGutter === undefined
					? geometry.obstacleBox
					: expandBox(geometry.obstacleBox, options.routingGutter),
		}),
	);
	const edgeRoutingDiagnostics: Diagnostic[] = [];
	const acceptedRailAllocations = new Map<string, RoutingRailAllocation>();
	let coordinatedEdges = coordinateEdges(
		styledEdges,
		nodeGeometryById,
		coordinatedNodes,
		routeObstacleEntries,
		policySoftObstacles,
		routingTextObstacles,
		policyHardObstacles,
		diagram.direction,
		options,
		edgeRoutingDiagnostics,
		coordinatedGroups,
		contentBounds,
		styledEdges,
		frame !== undefined,
		policyHardObstacleMetadata,
		acceptedRailAllocations,
	);
	let edgeTextAnnotations = coordinateEdgeTextAnnotations(
		coordinatedEdges,
		[
			...coordinatedNodes.map((node) => node.box),
			...baseTextAnnotations.map((annotation) => annotation.box),
			...frameTextAnnotation.map((annotation) => annotation.box),
		],
		options,
	);
	const maxEdgeLabelReroutes = edgeLabelRerouteIterations(options);
	let routeLabelFeedbackState: RouteLabelFeedbackState = {
		edges: coordinatedEdges,
		edgeTextAnnotations,
		edgeRoutingDiagnostics,
		conflicts: routeLabelFeedbackConflicts(
			coordinatedEdges,
			routeLabelFeedbackTextAnnotations(
				baseTextAnnotations,
				frameTextAnnotation,
				edgeTextAnnotations,
			),
			options,
		),
		iteration: 0,
		changedEdgeIds: new Set<string>(),
		acceptedReroutes: 0,
		rejectedReroutes: 0,
	};
	for (let iteration = 0; iteration < maxEdgeLabelReroutes; iteration += 1) {
		const currentTextAnnotations = routeLabelFeedbackTextAnnotations(
			baseTextAnnotations,
			frameTextAnnotation,
			routeLabelFeedbackState.edgeTextAnnotations,
		);
		const currentConflicts = routeLabelFeedbackConflicts(
			routeLabelFeedbackState.edges,
			currentTextAnnotations,
			options,
		);
		if (currentConflicts.length === 0) {
			routeLabelFeedbackState = {
				...routeLabelFeedbackState,
				conflicts: currentConflicts,
				iteration,
			};
			break;
		}
		let iterationState: RouteLabelFeedbackState = {
			...routeLabelFeedbackState,
			conflicts: currentConflicts,
			iteration: iteration + 1,
		};
		let acceptedThisIteration = 0;
		for (const edgeId of edgeIdsFromRouteTextDiagnostics(currentConflicts)) {
			const styledEdge = styledEdges.find((edge) => edge.id === edgeId);
			if (styledEdge === undefined) {
				iterationState = {
					...iterationState,
					rejectedReroutes: iterationState.rejectedReroutes + 1,
				};
				continue;
			}
			const baselineTextAnnotations = routeLabelFeedbackTextAnnotations(
				baseTextAnnotations,
				frameTextAnnotation,
				iterationState.edgeTextAnnotations,
			);
			const baselineScore = scoreRouteLabelFeedbackCandidate(
				edgeId,
				iterationState.edges,
				baselineTextAnnotations,
				iterationState.edgeRoutingDiagnostics,
				options,
			);
			const rerouteDiagnostics: Diagnostic[] = [];
			const hardTextObstacleEntries = routeLabelFeedbackHardTextObstacles(
				styledEdge,
				baselineTextAnnotations,
				options,
			);
			const policyLabelHardObstacles = resourceFlowLabelHardObstacles(
				baselineTextAnnotations,
				resolvedPagePolicy,
				options,
			);
			const rerouteHardObstacles = [
				...hardObstacles,
				...hardTextObstacleEntries.map((entry) => entry.box),
				...laneReservations.hardBands,
				...policyLabelHardObstacles,
			];
			const rerouteHardObstacleMetadata: RouteHardObstacleMetadata[] = [
				...hardObstacles.map(() => ({ kind: "evidence" as const })),
				...hardTextObstacleEntries.map((entry) => entry.metadata),
				...laneReservations.hardBands.map(() => ({ kind: "text" as const })),
				...policyLabelHardObstacles.map(() => ({ kind: "text" as const })),
			];
			const candidateRailAllocations = new Map(acceptedRailAllocations);
			const reroutedEdge = coordinateEdges(
				[styledEdge],
				nodeGeometryById,
				coordinatedNodes,
				routeObstacleEntries,
				policySoftObstacles,
				baselineTextAnnotations,
				rerouteHardObstacles,
				diagram.direction,
				options,
				rerouteDiagnostics,
				coordinatedGroups,
				contentBounds,
				styledEdges,
				frame !== undefined,
				rerouteHardObstacleMetadata,
				candidateRailAllocations,
			).find((edge) => edge.id === edgeId);
			if (reroutedEdge === undefined) {
				iterationState = {
					...iterationState,
					rejectedReroutes: iterationState.rejectedReroutes + 1,
				};
				continue;
			}
			const candidateEdges = iterationState.edges.map((edge) =>
				edge.id === edgeId ? reroutedEdge : edge,
			);
			const candidateEdgeTextAnnotations = coordinateEdgeTextAnnotations(
				candidateEdges,
				[
					...coordinatedNodes.map((node) => node.box),
					...baseTextAnnotations.map((annotation) => annotation.box),
					...frameTextAnnotation.map((annotation) => annotation.box),
				],
				options,
			);
			const candidateTextAnnotations = routeLabelFeedbackTextAnnotations(
				baseTextAnnotations,
				frameTextAnnotation,
				candidateEdgeTextAnnotations,
			);
			const candidateRoutingDiagnostics = replaceRouteDiagnosticsForEdge(
				iterationState.edgeRoutingDiagnostics,
				edgeId,
				routeLabelFeedbackPublicRouteDiagnostics(rerouteDiagnostics),
			);
			const candidateScore = scoreRouteLabelFeedbackCandidate(
				edgeId,
				candidateEdges,
				candidateTextAnnotations,
				candidateRoutingDiagnostics,
				options,
			);
			if (compareRouteLabelFeedbackScore(candidateScore, baselineScore) >= 0) {
				iterationState = {
					...iterationState,
					rejectedReroutes: iterationState.rejectedReroutes + 1,
				};
				continue;
			}
			acceptedRailAllocations.clear();
			for (const [railEdgeId, allocation] of candidateRailAllocations) {
				acceptedRailAllocations.set(railEdgeId, allocation);
			}
			const changedEdgeIds = new Set(iterationState.changedEdgeIds);
			changedEdgeIds.add(edgeId);
			iterationState = {
				edges: candidateEdges,
				edgeTextAnnotations: candidateEdgeTextAnnotations,
				edgeRoutingDiagnostics: candidateRoutingDiagnostics,
				conflicts: routeLabelFeedbackConflicts(
					candidateEdges,
					candidateTextAnnotations,
					options,
				),
				iteration: iteration + 1,
				changedEdgeIds,
				acceptedReroutes: iterationState.acceptedReroutes + 1,
				rejectedReroutes: iterationState.rejectedReroutes,
			};
			acceptedThisIteration += 1;
		}
		routeLabelFeedbackState = {
			...iterationState,
			conflicts: routeLabelFeedbackConflicts(
				iterationState.edges,
				routeLabelFeedbackTextAnnotations(
					baseTextAnnotations,
					frameTextAnnotation,
					iterationState.edgeTextAnnotations,
				),
				options,
			),
		};
		if (
			acceptedThisIteration === 0 ||
			routeLabelFeedbackState.conflicts.length === 0
		) {
			break;
		}
	}
	coordinatedEdges = [...routeLabelFeedbackState.edges];
	edgeTextAnnotations = [...routeLabelFeedbackState.edgeTextAnnotations];
	edgeRoutingDiagnostics.splice(
		0,
		edgeRoutingDiagnostics.length,
		...routeLabelFeedbackState.edgeRoutingDiagnostics,
	);
	diagnostics.push(...edgeRoutingDiagnostics);

	const residualRouteTextDiagnostics = reportRouteTextClearance(
		coordinatedEdges,
		routeLabelFeedbackTextAnnotations(
			baseTextAnnotations,
			frameTextAnnotation,
			edgeTextAnnotations,
		),
		options,
	);
	const enterRemediation =
		residualRouteTextDiagnostics.length > 0 ||
		diagnostics.some((diagnostic) =>
			REMEDIATION_ENTRY_DIAGNOSTIC_CODES.has(diagnostic.code),
		);
	let appliedRemediationPlans: RemediationPlan[] = [];
	let appliedExternalLabelCallouts: ExternalLabelCallout[] = [];
	let remediationPassIterations = 0;
	if (enterRemediation) {
		if (maxEdgeLabelReroutes > 0 && residualRouteTextDiagnostics.length > 0) {
			diagnostics.push(
				routeLabelLoopExhaustedDiagnostic(
					residualRouteTextDiagnostics,
					routeLabelFeedbackState,
					maxEdgeLabelReroutes,
					{ remediationTransition: true },
				),
			);
		}
		const remediationState: RemediationPassState = {
			coordinatedNodes,
			nodeGeometryById,
			constrainedBoxes: constrained.boxes,
			coordinatedGroups,
			coordinatedSwimlanes,
			baseTextAnnotations,
			edgeLabelEstimates,
			layoutBoxes,
			contentBounds,
			frame,
			frameTextAnnotation,
			routingTextObstacles,
			titleBarObstacles,
			reservedSideGutters,
			laneReservations,
			policySoftObstacles,
			policyHardObstacles,
			policyHardObstacleMetadata,
			routeObstacleEntries,
			coordinatedEdges,
			edgeTextAnnotations,
			edgeRoutingDiagnostics,
			acceptedRailAllocations,
			diagnostics,
			appliedExternalLabelCallouts,
			appliedRemediationPlans,
			remediationPassIterations,
			preservedDiagnosticKeys: new Set(
				diagram.diagnostics.map(remediationDiagnosticKey),
			),
		};
		runRemediationPass(remediationState, {
			diagram,
			styledEdges,
			styledNodes,
			styledGroups,
			styledSwimlanes,
			swimlaneLayouts: swimlaneContracts.layouts,
			coordinatedMatrices,
			coordinatedTables,
			coordinatedEvidencePanels,
			softObstacles: [...softObstacles],
			hardObstacles: [...hardObstacles],
			evidenceBoxes: [...evidenceBoxes],
			resolvedPagePolicy,
			options,
			margin,
			maxIterations: DEFAULT_MAX_REMEDIATION_ITERATIONS,
		});
		coordinatedNodes = remediationState.coordinatedNodes;
		nodeGeometryById = remediationState.nodeGeometryById;
		coordinatedGroups = remediationState.coordinatedGroups;
		coordinatedSwimlanes = remediationState.coordinatedSwimlanes;
		baseTextAnnotations = remediationState.baseTextAnnotations;
		edgeLabelEstimates = remediationState.edgeLabelEstimates;
		layoutBoxes = remediationState.layoutBoxes;
		contentBounds = remediationState.contentBounds;
		frame = remediationState.frame;
		frameTextAnnotation = remediationState.frameTextAnnotation;
		routingTextObstacles = remediationState.routingTextObstacles;
		titleBarObstacles = remediationState.titleBarObstacles;
		reservedSideGutters = remediationState.reservedSideGutters;
		laneReservations = remediationState.laneReservations;
		policySoftObstacles = remediationState.policySoftObstacles;
		policyHardObstacles = remediationState.policyHardObstacles;
		policyHardObstacleMetadata = remediationState.policyHardObstacleMetadata;
		routeObstacleEntries = remediationState.routeObstacleEntries;
		coordinatedEdges = remediationState.coordinatedEdges;
		edgeTextAnnotations = remediationState.edgeTextAnnotations;
		appliedExternalLabelCallouts =
			remediationState.appliedExternalLabelCallouts;
		appliedRemediationPlans = remediationState.appliedRemediationPlans;
		remediationPassIterations = remediationState.remediationPassIterations;
	} else if (externalLabelExecutionMode(options) === "auto") {
		const edgePointBounds = edgeBounds(coordinatedEdges);
		const externalLabelCallouts = buildExternalLabelCallouts(
			edgeTextAnnotations,
			unionBoxes([contentBounds, ...edgePointBounds]),
			options,
		);
		if (externalLabelCallouts.length > 0) {
			edgeTextAnnotations = applyExternalLabelCallouts(
				edgeTextAnnotations,
				externalLabelCallouts,
			);
			appliedExternalLabelCallouts = externalLabelCallouts.map(
				(callout) => callout.callout,
			);
		}
	}

	const edgePointBounds = edgeBounds(coordinatedEdges);
	const boundsBase = [
		contentBounds,
		...edgePointBounds,
		...edgeTextAnnotations.map((annotation) => annotation.box),
	];
	if (diagram.frame !== undefined && frame !== undefined) {
		frame = coordinateFrame(diagram.frame, unionBoxes(boundsBase));
		frameTextAnnotation = [
			coordinateFrameTextAnnotation(frame, options.textMeasurer),
		];
	}
	const textAnnotations = [
		...baseTextAnnotations,
		...frameTextAnnotation,
		...edgeTextAnnotations,
	];
	diagnostics.push(...reportTextAnnotationCollisions(textAnnotations));
	diagnostics.push(
		...reportExternalizedLabelDiagnostics(
			edgeTextAnnotations,
			coordinatedEdges,
		),
	);
	const routeTextDiagnostics = reportRouteTextClearance(
		coordinatedEdges,
		textAnnotations,
		options,
	);
	diagnostics.push(...routeTextDiagnostics);
	if (
		maxEdgeLabelReroutes > 0 &&
		routeTextDiagnostics.length > 0 &&
		!diagnostics.some(
			(diagnostic) => diagnostic.code === "routing.route-label-loop.exhausted",
		)
	) {
		diagnostics.push(
			routeLabelLoopExhaustedDiagnostic(
				routeTextDiagnostics,
				routeLabelFeedbackState,
				maxEdgeLabelReroutes,
				enterRemediation ||
					remediationPassIterations > 0 ||
					appliedExternalLabelCallouts.length > 0
					? { remediationTransition: true }
					: undefined,
			),
		);
	}
	diagnostics.push(
		...reportLabelCongestionDiagnostics(routeTextDiagnostics, coordinatedEdges),
	);
	diagnostics.push(
		...reportPageOverflow(
			frame === undefined
				? unionBoxes(boundsBase)
				: unionBoxes([...boundsBase, frame.box, frame.titleBox]),
			options.pageBounds,
		),
	);

	let deliverability = buildDeliverabilityReport(
		diagnostics,
		options,
		appliedExternalLabelCallouts,
		appliedRemediationPlans,
	);
	if (deliverability.status === "unsatisfiable") {
		diagnostics.push(
			deliverabilityUnsatisfiableDiagnostic(
				diagram.id,
				deliverability,
				diagnostics,
			),
		);
		deliverability = buildDeliverabilityReport(
			diagnostics,
			options,
			appliedExternalLabelCallouts,
			appliedRemediationPlans,
		);
	}
	const degraded = deliverability.degraded;
	const resultDiagnostics = diagnostics.map((diagnostic) => {
		if (DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code)) {
			if (isStrictDeliverability(options)) {
				return { ...diagnostic, severity: "error" as const };
			}
		}
		return diagnostic;
	});
	const routingAllocations = buildRoutingAllocationReport(
		[...acceptedRailAllocations.values()],
		contentBounds,
		reservedSideGutters,
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
		diagnostics: resultDiagnostics,
		degraded,
		deliverability,
		...(routingAllocations === undefined
			? {}
			: { routing: routingAllocations }),
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

function buildRoutingAllocationReport(
	acceptedRails: readonly RoutingRailAllocation[],
	contentBounds: Box,
	reservedGutters: readonly RoutingGutterAllocation[] = [],
): RoutingAllocationReport | undefined {
	const rails = [...acceptedRails]
		.map((rail) => ({ ...rail, coordinate: Math.round(rail.coordinate) }))
		.sort(
			(left, right) =>
				left.index - right.index ||
				left.coordinate - right.coordinate ||
				left.edgeId.localeCompare(right.edgeId),
		);
	const gutters: RoutingAllocationReport["gutters"] = [
		...reservedGutters.map((gutter) => ({
			...gutter,
			box: { ...gutter.box },
		})),
	];
	const reservedSides = new Set(gutters.map((gutter) => gutter.side));
	const sides = stableStrings(rails.map((rail) => rail.side)) as Array<
		RoutingRailAllocation["side"]
	>;
	for (const side of sides) {
		if (reservedSides.has(side)) {
			continue;
		}
		const sideRails = rails.filter((rail) => rail.side === side);
		if (sideRails.length === 0) {
			continue;
		}
		const minCoordinate = Math.min(...sideRails.map((rail) => rail.coordinate));
		const maxCoordinate = Math.max(...sideRails.map((rail) => rail.coordinate));
		switch (side) {
			case "top":
				gutters.push({
					side,
					box: {
						x: contentBounds.x,
						y: minCoordinate,
						width: contentBounds.width,
						height: contentBounds.y - minCoordinate,
					},
					railCount: sideRails.length,
				});
				break;
			case "left":
				gutters.push({
					side,
					box: {
						x: minCoordinate,
						y: contentBounds.y,
						width: contentBounds.x - minCoordinate,
						height: contentBounds.height,
					},
					railCount: sideRails.length,
				});
				break;
			case "bottom":
				gutters.push({
					side,
					box: {
						x: contentBounds.x,
						y: contentBounds.y + contentBounds.height,
						width: contentBounds.width,
						height: maxCoordinate - (contentBounds.y + contentBounds.height),
					},
					railCount: sideRails.length,
				});
				break;
			case "right":
				gutters.push({
					side,
					box: {
						x: contentBounds.x + contentBounds.width,
						y: contentBounds.y,
						width: maxCoordinate - (contentBounds.x + contentBounds.width),
						height: contentBounds.height,
					},
					railCount: sideRails.length,
				});
				break;
		}
	}
	gutters.sort(
		(left, right) =>
			left.side.localeCompare(right.side) ||
			left.box.x - right.box.x ||
			left.box.y - right.box.y,
	);
	if (rails.length === 0 && gutters.length === 0) {
		return undefined;
	}
	return { rails, gutters };
}

function resourceFlowLabelHardObstacles(
	textAnnotations: readonly SolvedTextAnnotation[],
	pagePolicy: PagePolicy,
	options: SolveDiagramOptions,
): Box[] {
	if (pagePolicy !== "resource-flow" && pagePolicy !== "ibd-high-fan-in") {
		return [];
	}
	return textAnnotations
		.filter((annotation) => annotation.surfaceKind === "node-label")
		.filter((annotation) => {
			const text = annotation.text.trim().toLowerCase();
			return (
				text.includes("resource coordination") ||
				annotation.ownerId === "dense-label-cell"
			);
		})
		.map((annotation) => {
			// Shrink slightly so endpoint stubs on nearby nodes are not trapped
			// inside the hard band while the central cluster remains blocked.
			const box = textObstacleBox(annotation, options);
			const inset = Math.min(8, box.width / 6, box.height / 6);
			return {
				x: box.x + inset,
				y: box.y + inset,
				width: Math.max(0, box.width - inset * 2),
				height: Math.max(0, box.height - inset * 2),
			};
		})
		.filter((box) => box.width > 0 && box.height > 0);
}

function computePolicyFanOutAnchors(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): Map<string, DistributedAnchor> {
	const config =
		typeof options.anchorCapacity === "object" ? options.anchorCapacity : {};
	const spacing = Math.max(1, config.minSpacing ?? 8);
	const groups = new Map<
		string,
		{
			nodeId: string;
			side: AnchorSide;
			role: EndpointRole;
			edgeIds: string[];
		}
	>();

	for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
		const sourceBox = boxes.get(edge.source.nodeId)?.box;
		const targetBox = boxes.get(edge.target.nodeId)?.box;
		if (sourceBox === undefined || targetBox === undefined) {
			continue;
		}
		if (
			edge.source.portId === undefined &&
			distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			) !== undefined
		) {
			const side = distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			);
			if (side !== undefined) {
				const key = `${edge.source.nodeId}:${side}:source`;
				const group = groups.get(key) ?? {
					nodeId: edge.source.nodeId,
					side,
					role: "source" as EndpointRole,
					edgeIds: [],
				};
				group.edgeIds.push(edge.id);
				groups.set(key, group);
			}
		}
		if (
			edge.target.portId === undefined &&
			distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			) !== undefined
		) {
			const side = distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			);
			if (side !== undefined) {
				const key = `${edge.target.nodeId}:${side}:target`;
				const group = groups.get(key) ?? {
					nodeId: edge.target.nodeId,
					side,
					role: "target" as EndpointRole,
					edgeIds: [],
				};
				group.edgeIds.push(edge.id);
				groups.set(key, group);
			}
		}
	}

	const distributed = new Map<string, DistributedAnchor>();
	for (const group of [...groups.values()].sort((a, b) =>
		`${a.nodeId}:${a.side}:${a.role}`.localeCompare(
			`${b.nodeId}:${b.side}:${b.role}`,
		),
	)) {
		if (group.edgeIds.length <= 1) continue;
		const box = boxes.get(group.nodeId)?.box;
		if (box === undefined) continue;
		const edgeIds = [...group.edgeIds].sort((a, b) => a.localeCompare(b));
		const fanOut = computeFanOutPorts(edgeIds, box, group.side, spacing);
		for (const edgeId of edgeIds) {
			const port = fanOut.get(edgeId);
			if (port === undefined) continue;
			distributed.set(endpointDistributionKey(edgeId, group.role), {
				anchor: group.side,
				point: port.anchor,
			});
		}
	}
	return distributed;
}

function railAllocationForRoute(
	edgeId: string,
	points: readonly Point[],
	direction: NormalizedDiagram["direction"],
	railIndex: number,
	side: RoutingRailAllocation["side"],
): RoutingRailAllocation {
	const horizontal = direction === "LR" || direction === "RL";
	return {
		edgeId,
		axis: horizontal ? "y" : "x",
		side,
		coordinate: horizontal
			? side === "bottom"
				? Math.max(...points.map((point) => point.y))
				: Math.min(...points.map((point) => point.y))
			: side === "right"
				? Math.max(...points.map((point) => point.x))
				: Math.min(...points.map((point) => point.x)),
		index: railIndex,
	};
}

function buildDeliverabilityReport(
	diagnostics: readonly Diagnostic[],
	options: SolveDiagramOptions,
	appliedExternalLabelCallouts: readonly ExternalLabelCallout[] = [],
	appliedRemediationPlans: readonly RemediationPlan[] = [],
): DeliverabilityReport {
	const blocking = diagnostics.filter((diagnostic) =>
		DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code),
	);
	const degraded = blocking.length > 0;
	const strict = isStrictDeliverability(options);
	return {
		status: !degraded ? "clean" : strict ? "unsatisfiable" : "degraded",
		strict,
		degraded,
		diagnosticCodes: stableStrings(
			blocking.map((diagnostic) => diagnostic.code),
		),
		remediationTypes: stableStrings(blocking.map(remediationTypeForDiagnostic)),
		remediationPlans: buildRemediationPlans(
			blocking,
			options,
			appliedExternalLabelCallouts,
			appliedRemediationPlans,
		),
	};
}

function buildRemediationPlans(
	diagnostics: readonly Diagnostic[],
	options: SolveDiagramOptions,
	appliedExternalLabelCallouts: readonly ExternalLabelCallout[] = [],
	appliedRemediationPlans: readonly RemediationPlan[] = [],
): RemediationPlan[] {
	const policy = resolveRemediationPolicy(options.remediationPolicy);
	const appliedByType = new Map<RemediationPlanType, RemediationPlan>();
	for (const plan of appliedRemediationPlans) {
		appliedByType.set(plan.type, plan);
	}
	const buckets = new Map<RemediationPlanType, Diagnostic[]>();
	for (const diagnostic of diagnostics) {
		if (diagnostic.code === "routing.deliverability.unsatisfiable") {
			continue;
		}
		for (const type of remediationPlanTypesForDiagnostic(diagnostic)) {
			if (!remediationPlanEnabled(type, policy)) {
				continue;
			}
			const existing = buckets.get(type);
			if (existing === undefined) {
				buckets.set(type, [diagnostic]);
			} else {
				existing.push(diagnostic);
			}
		}
	}
	const planTypes: RemediationPlanType[] = [
		"external-label",
		"route-rail",
		"grow-fixed-geometry",
		"page-split",
	];
	return planTypes
		.flatMap((type) => {
			const applied = appliedByType.get(type);
			if (applied !== undefined) {
				return [omitRemediationPlanId(applied)];
			}
			const bucket = buckets.get(type);
			if (
				type === "external-label" &&
				appliedExternalLabelCallouts.length > 0
			) {
				return [
					buildAppliedExternalLabelRemediationPlan(
						bucket ?? [],
						policy,
						appliedExternalLabelCallouts,
					),
				];
			}
			return bucket === undefined || bucket.length === 0
				? []
				: [buildRemediationPlan(type, bucket, policy)];
		})
		.map((plan, index) => ({
			...plan,
			id: `remediation-${String(index + 1).padStart(2, "0")}-${plan.type}`,
		}));
}

function omitRemediationPlanId(
	plan: RemediationPlan,
): Omit<RemediationPlan, "id"> {
	const { id: _id, ...rest } = plan;
	return rest;
}

interface RemediationPassState {
	coordinatedNodes: CoordinatedNode[];
	nodeGeometryById: Map<string, ReturnType<typeof computeShapeGeometry>>;
	constrainedBoxes: Map<string, Box>;
	coordinatedGroups: CoordinatedGroup[];
	coordinatedSwimlanes: Swimlane[];
	baseTextAnnotations: SolvedTextAnnotation[];
	edgeLabelEstimates: SolvedTextAnnotation[];
	layoutBoxes: Box[];
	contentBounds: Box;
	frame: CoordinatedFrame | undefined;
	frameTextAnnotation: SolvedTextAnnotation[];
	routingTextObstacles: SolvedTextAnnotation[];
	titleBarObstacles: Box[];
	reservedSideGutters: RoutingGutterAllocation[];
	laneReservations: { hardBands: Box[]; softCorridors: Box[] };
	policySoftObstacles: Box[];
	policyHardObstacles: Box[];
	policyHardObstacleMetadata: RouteHardObstacleMetadata[];
	routeObstacleEntries: NodeObstacleEntry[];
	coordinatedEdges: CoordinatedEdge[];
	edgeTextAnnotations: SolvedTextAnnotation[];
	edgeRoutingDiagnostics: Diagnostic[];
	acceptedRailAllocations: Map<string, RoutingRailAllocation>;
	diagnostics: Diagnostic[];
	appliedExternalLabelCallouts: ExternalLabelCallout[];
	appliedRemediationPlans: RemediationPlan[];
	remediationPassIterations: number;
	/** Input-seeded diagnostics must survive regenerable routing refreshes. */
	preservedDiagnosticKeys: ReadonlySet<string>;
}

interface RemediationPassContext {
	diagram: NormalizedDiagram;
	styledEdges: NormalizedEdge[];
	styledNodes: NormalizedNode[];
	styledGroups: NormalizedGroup[];
	styledSwimlanes: Swimlane[];
	swimlaneLayouts: ReadonlyMap<string, SwimlaneContractLayout>;
	coordinatedMatrices: CoordinatedMatrixBlock[];
	coordinatedTables: CoordinatedTableBlock[];
	coordinatedEvidencePanels: CoordinatedEvidencePanel[];
	/** Mutable: refreshed after grow re-places evidence blocks. */
	softObstacles: Box[];
	hardObstacles: Box[];
	evidenceBoxes: Box[];
	resolvedPagePolicy: PagePolicy;
	options: SolveDiagramOptions;
	margin: number | Insets;
	maxIterations: number;
}

/**
 * Bounded outer remediation after local route-label exhaustion.
 * Apply order: grow → rails → external-label. Never materializes page-split.
 */
function runRemediationPass(
	state: RemediationPassState,
	context: RemediationPassContext,
): void {
	const policy = resolveRemediationPolicy(context.options.remediationPolicy);
	const hasAuto =
		policy.growFixedGeometry === "auto" ||
		policy.routeRails === "auto" ||
		policy.externalLabels === "auto";
	// Suggest/off still stage plans via buildDeliverabilityReport; only auto
	// policies mutate geometry and refresh regenerable routing diagnostics.
	if (!hasAuto) {
		return;
	}
	let previousFingerprint = remediationDiagnosticFingerprint(state.diagnostics);

	for (let iteration = 0; iteration < context.maxIterations; iteration += 1) {
		state.remediationPassIterations = iteration + 1;
		let appliedAny = false;

		const buildCandidates = (): RemediationPlan[] =>
			buildRemediationPlans(
				blockingRemediationDiagnostics(state.diagnostics),
				context.options,
				state.appliedExternalLabelCallouts,
				state.appliedRemediationPlans,
			);

		if (
			policy.growFixedGeometry === "auto" &&
			!hasTerminalRemediationPlan(state, "grow-fixed-geometry")
		) {
			const growCandidate = buildCandidates().find(
				(plan) => plan.type === "grow-fixed-geometry",
			);
			if (growCandidate !== undefined) {
				const growPlan = applyGrowFixedGeometryRemediation(
					growCandidate,
					state,
					context,
				);
				recordAppliedRemediationPlan(state, growPlan);
				if (growPlan.status === "applied") {
					appliedAny = true;
					rebuildRemediationGeometry(state, context);
					rerouteRemediationEdges(state, context, context.options);
					refreshRemediationDiagnostics(state, context);
				}
			}
		}

		if (
			policy.routeRails === "auto" &&
			!hasTerminalRemediationPlan(state, "route-rail") &&
			blockingRemediationDiagnostics(state.diagnostics).length > 0
		) {
			const railCandidate = buildCandidates().find(
				(plan) => plan.type === "route-rail",
			);
			if (railCandidate !== undefined) {
				const railPlan = applyRouteRailsRemediation(
					railCandidate,
					state,
					context,
				);
				recordAppliedRemediationPlan(state, railPlan);
				if (railPlan.status === "applied") {
					appliedAny = true;
					refreshRemediationDiagnostics(state, context);
				}
			}
		}

		if (
			policy.externalLabels === "auto" &&
			!hasTerminalRemediationPlan(state, "external-label") &&
			blockingRemediationDiagnostics(state.diagnostics).length > 0
		) {
			const externalPlan = applyExternalLabelRemediation(state, context);
			if (externalPlan !== undefined) {
				recordAppliedRemediationPlan(state, externalPlan);
				if (externalPlan.status === "applied") {
					appliedAny = true;
				}
			}
		}

		refreshRemediationDiagnostics(state, context);
		const fingerprint = remediationDiagnosticFingerprint(state.diagnostics);
		if (!appliedAny && fingerprint === previousFingerprint) {
			break;
		}
		previousFingerprint = fingerprint;
		if (blockingRemediationDiagnostics(state.diagnostics).length === 0) {
			break;
		}
	}
}

function hasTerminalRemediationPlan(
	state: RemediationPassState,
	type: RemediationPlanType,
): boolean {
	return state.appliedRemediationPlans.some(
		(plan) =>
			plan.type === type &&
			(plan.status === "applied" || plan.status === "blocked"),
	);
}

function recordAppliedRemediationPlan(
	state: RemediationPassState,
	plan: RemediationPlan,
): void {
	const existingIndex = state.appliedRemediationPlans.findIndex(
		(candidate) => candidate.type === plan.type,
	);
	if (existingIndex >= 0) {
		state.appliedRemediationPlans[existingIndex] = plan;
	} else {
		state.appliedRemediationPlans.push(plan);
	}
}

function blockingRemediationDiagnostics(
	diagnostics: readonly Diagnostic[],
): Diagnostic[] {
	return diagnostics.filter(
		(diagnostic) =>
			DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code) &&
			diagnostic.code !== "routing.deliverability.unsatisfiable",
	);
}

function remediationDiagnosticFingerprint(
	diagnostics: readonly Diagnostic[],
): string {
	return blockingRemediationDiagnostics(diagnostics)
		.map(
			(diagnostic) =>
				`${diagnostic.code}:${String(diagnostic.detail?.edgeId ?? "")}:${String(diagnostic.detail?.nodeId ?? "")}:${String(diagnostic.detail?.required ?? "")}:${String(diagnostic.detail?.available ?? "")}`,
		)
		.sort((left, right) => left.localeCompare(right))
		.join("|");
}

function applyGrowFixedGeometryRemediation(
	candidate: RemediationPlan,
	state: RemediationPassState,
	context: RemediationPassContext,
): RemediationPlan {
	const policy = resolveRemediationPolicy(context.options.remediationPolicy);
	const beforeBoxes = cloneBoxMap(state.constrainedBoxes);
	const growthDeltas =
		candidate.detail.strategy === "grow-or-relax-fixed-geometry" &&
		candidate.detail.growthDeltas !== undefined
			? candidate.detail.growthDeltas.map((delta) => ({ ...delta }))
			: growthDeltasFromDiagnostics(state.diagnostics);

	if (growthDeltas.length > 0) {
		const nodesById = new Map(
			context.styledNodes.map((node) => [node.id, node]),
		);
		for (const delta of growthDeltas) {
			const box = state.constrainedBoxes.get(delta.nodeId);
			if (box === undefined) continue;
			if (delta.deltaWidth > 0) {
				box.x -= delta.deltaWidth / 2;
				box.width += delta.deltaWidth;
			}
			if (delta.deltaHeight > 0) {
				box.y -= delta.deltaHeight / 2;
				box.height += delta.deltaHeight;
			}
			if (delta.deltaWidth > 0 || delta.deltaHeight > 0) {
				const node = nodesById.get(delta.nodeId);
				if (node !== undefined) {
					recenterNodeLabelLayout(node, box);
				}
			}
		}
	} else {
		const growOptions: SolveDiagramOptions = {
			...context.options,
			anchorCapacity: {
				...(typeof context.options.anchorCapacity === "object"
					? context.options.anchorCapacity
					: {}),
				grow: true,
			},
		};
		expandNodeBoxesForAnchorCapacity(
			context.styledEdges,
			context.styledNodes,
			state.constrainedBoxes,
			context.diagram.direction,
			growOptions,
			[],
		);
	}

	const changedNodeIds = [...state.constrainedBoxes.keys()]
		.filter((nodeId) => {
			const before = beforeBoxes.get(nodeId);
			const after = state.constrainedBoxes.get(nodeId);
			return (
				before !== undefined && after !== undefined && !sameBox(before, after)
			);
		})
		.sort((left, right) => left.localeCompare(right));
	const appliedDeltas = changedNodeIds.map((nodeId) => {
		const before = beforeBoxes.get(nodeId);
		const after = state.constrainedBoxes.get(nodeId);
		return {
			nodeId,
			deltaWidth: Math.max(0, (after?.width ?? 0) - (before?.width ?? 0)),
			deltaHeight: Math.max(0, (after?.height ?? 0) - (before?.height ?? 0)),
		};
	});

	if (changedNodeIds.length > 0) {
		state.diagnostics.push(
			...reportPostGrowthOverlaps(beforeBoxes, state.constrainedBoxes),
		);
		stripDiagnosticsByCodes(
			state.diagnostics,
			["routing.anchor-capacity.requires-resize"],
			state.preservedDiagnosticKeys,
		);
		return {
			...candidate,
			status: "applied",
			reason: `Grew ${changedNodeIds.length} node(s) to restore anchor capacity during remediation.`,
			nodeIds: stableStrings([...candidate.nodeIds, ...changedNodeIds]),
			detail: {
				strategy: "grow-or-relax-fixed-geometry",
				policy: policy.growFixedGeometry,
				affectedNodeCount: changedNodeIds.length,
				growthDeltas: appliedDeltas,
			},
		};
	}

	return {
		...candidate,
		status: "blocked",
		reason:
			"growFixedGeometry auto could not expand fixed geometry enough to clear residual conflicts.",
		detail: {
			strategy: "grow-or-relax-fixed-geometry",
			policy: policy.growFixedGeometry,
			affectedNodeCount: candidate.nodeIds.length,
			...(growthDeltas.length === 0
				? {}
				: {
						growthDeltas: growthDeltas.map((delta) => ({ ...delta })),
					}),
		},
	};
}

/**
 * Phase 16 pagePolicy rails are the geometry engine; this wires
 * remediationPolicy.routeRails auto to force/confirm that path after exhaustion.
 */
function applyRouteRailsRemediation(
	candidate: RemediationPlan,
	state: RemediationPassState,
	context: RemediationPassContext,
): RemediationPlan {
	const policy = resolveRemediationPolicy(context.options.remediationPolicy);
	const preSnapshot = railRemediationSnapshot(state);
	const forcedOptions: SolveDiagramOptions = {
		...context.options,
		railRouting: "dependency",
		pagePolicy:
			context.options.pagePolicy === "off" ||
			context.options.pagePolicy === undefined
				? "dependency"
				: context.options.pagePolicy,
	};
	rerouteRemediationEdges(state, context, forcedOptions);
	const postSnapshot = railRemediationSnapshot(state);
	const geometryChanged =
		preSnapshot.railSignature !== postSnapshot.railSignature;
	const diagnosticsImproved =
		postSnapshot.conflictCount < preSnapshot.conflictCount;
	const capacity = capacityFromDiagnostics(state.diagnostics) ?? {
		required:
			candidate.detail.strategy === "dependency-rails"
				? candidate.detail.required
				: Math.max(1, candidate.edgeIds.length),
		available:
			candidate.detail.strategy === "dependency-rails"
				? candidate.detail.available
				: 0,
	};

	if (geometryChanged || diagnosticsImproved) {
		return {
			...candidate,
			status: "applied",
			reason:
				"Forced dependency-rail routing during remediation and observed rail/diagnostic change.",
			detail: {
				strategy: "dependency-rails",
				policy: policy.routeRails,
				requiredRailCount: capacity.required,
				required: capacity.required,
				available: capacity.available,
				edgeIds: [...candidate.edgeIds],
			},
		};
	}

	return {
		...candidate,
		status: "blocked",
		reason:
			"routeRails auto forced dependency rails but residual conflicts remain without measurable rail/diagnostic improvement.",
		detail: {
			strategy: "dependency-rails",
			policy: policy.routeRails,
			requiredRailCount: capacity.required,
			required: capacity.required,
			available: capacity.available,
			edgeIds: [...candidate.edgeIds],
		},
	};
}

function applyExternalLabelRemediation(
	state: RemediationPassState,
	context: RemediationPassContext,
): RemediationPlan | undefined {
	const edgePointBounds = edgeBounds(state.coordinatedEdges);
	const externalLabelCallouts = buildExternalLabelCallouts(
		state.edgeTextAnnotations,
		unionBoxes([state.contentBounds, ...edgePointBounds]),
		context.options,
	);
	if (externalLabelCallouts.length === 0) {
		const candidate = buildRemediationPlans(
			blockingRemediationDiagnostics(state.diagnostics),
			context.options,
			state.appliedExternalLabelCallouts,
			state.appliedRemediationPlans,
		).find((plan) => plan.type === "external-label");
		if (candidate === undefined) {
			return undefined;
		}
		return {
			...candidate,
			status: "blocked",
			reason:
				"externalLabels auto found no external-callout-required labels to relocate.",
		};
	}
	state.edgeTextAnnotations = applyExternalLabelCallouts(
		state.edgeTextAnnotations,
		externalLabelCallouts,
	);
	state.appliedExternalLabelCallouts = externalLabelCallouts.map(
		(callout) => callout.callout,
	);
	const policy = resolveRemediationPolicy(context.options.remediationPolicy);
	return {
		id: "remediation-external-label",
		...buildAppliedExternalLabelRemediationPlan(
			blockingRemediationDiagnostics(state.diagnostics),
			policy,
			state.appliedExternalLabelCallouts,
		),
	};
}

function railRemediationSnapshot(state: RemediationPassState): {
	railSignature: string;
	conflictCount: number;
} {
	const rails = [...state.acceptedRailAllocations.values()]
		.map(
			(rail) =>
				`${rail.edgeId}:${rail.side}:${rail.index}:${Math.round(rail.coordinate)}`,
		)
		.sort((left, right) => left.localeCompare(right));
	const conflictCount = state.diagnostics.filter((diagnostic) =>
		[
			"routing.text-clearance.unresolved",
			"routing.obstacle.unavoidable",
			"routing.rail-capacity.exceeded",
			"routing.label-congestion.unresolved",
		].includes(diagnostic.code),
	).length;
	return {
		railSignature: rails.join("|"),
		conflictCount,
	};
}

function rebuildRemediationGeometry(
	state: RemediationPassState,
	context: RemediationPassContext,
): void {
	state.coordinatedNodes = coordinateNodes(
		context.styledNodes,
		state.constrainedBoxes,
		context.options,
		state.diagnostics,
	);
	state.nodeGeometryById = new Map(
		state.coordinatedNodes.map((node) => [
			node.id,
			computeShapeGeometry({
				shape: node.shape,
				box: node.box,
				obstacleMargin: context.options.obstacleMargin ?? 0,
			}),
		]),
	);
	state.coordinatedGroups = coordinateGroups(
		context.styledGroups,
		state.constrainedBoxes,
		context.options,
		state.diagnostics,
	);
	state.coordinatedSwimlanes = coordinateSwimlanes(
		context.styledSwimlanes,
		state.constrainedBoxes,
		context.swimlaneLayouts,
		context.options,
		state.diagnostics,
	);
	state.baseTextAnnotations = coordinateBaseTextAnnotations({
		nodes: state.coordinatedNodes,
		groups: state.coordinatedGroups,
		swimlanes: state.coordinatedSwimlanes,
		...(context.options.textMeasurer === undefined
			? {}
			: { textMeasurer: context.options.textMeasurer }),
	});
	state.edgeLabelEstimates =
		edgeLabelExternalizationPolicy(context.options) === "force"
			? []
			: estimateEdgeLabelAnnotations(
					context.styledEdges,
					state.nodeGeometryById,
					context.options.textMeasurer,
					context.options.labelPlacement,
					context.options.labelOffset,
				);
	const groupBoxes = new Map(
		state.coordinatedGroups.map((group) => [group.id, group.box]),
	);
	state.layoutBoxes = [
		...state.coordinatedNodes.map((node) => node.box),
		...state.coordinatedNodes.flatMap((node) =>
			(node.ports ?? []).flatMap((port) =>
				port.label === undefined ? [port.box] : [port.box, portLabelBox(port)],
			),
		),
		...groupBoxes.values(),
		...state.coordinatedSwimlanes.flatMap((swimlane) =>
			swimlane.box === undefined ? [] : [swimlane.box],
		),
		...state.baseTextAnnotations.map((annotation) => annotation.box),
	];
	const layoutContentBounds =
		state.layoutBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(state.layoutBoxes);
	placeEvidenceBlocks(
		context.options.obstacleMargin ?? 0,
		[
			...context.coordinatedMatrices,
			...context.coordinatedTables,
			...context.coordinatedEvidencePanels,
		],
		layoutContentBounds,
	);
	refreshTableColumnXOffsets(context.coordinatedTables);
	measureEvidenceTextBlocks(
		context.coordinatedMatrices,
		context.coordinatedTables,
		context.coordinatedEvidencePanels,
		context.options.textMeasurer,
	);
	context.evidenceBoxes.splice(
		0,
		context.evidenceBoxes.length,
		...context.coordinatedMatrices.map((matrix) => matrix.box),
		...context.coordinatedTables.map((table) => table.box),
		...context.coordinatedEvidencePanels.map((panel) => panel.box),
	);
	const evidenceMargin = context.options.obstacleMargin ?? 0;
	context.softObstacles.splice(
		0,
		context.softObstacles.length,
		...context.coordinatedTables.map((table) =>
			expandBox(table.box, evidenceMargin),
		),
		...context.coordinatedEvidencePanels.map((panel) =>
			expandBox(panel.box, evidenceMargin),
		),
	);
	context.hardObstacles.splice(
		0,
		context.hardObstacles.length,
		...context.coordinatedMatrices.map((matrix) =>
			expandBox(matrix.box, evidenceMargin),
		),
	);
	stripDiagnosticsByCodes(
		state.diagnostics,
		["constraints.overlap.unresolved"],
		state.preservedDiagnosticKeys,
	);
	state.diagnostics.push(
		...reportEvidenceBlockOverlaps(
			[
				...context.coordinatedMatrices.map((matrix) => ({
					id: matrix.id,
					kind: "matrix",
					...(matrix.position === undefined
						? {}
						: { position: matrix.position }),
					box: matrix.box,
				})),
				...context.coordinatedTables.map((table) => ({
					id: table.id,
					kind: "table",
					...(table.position === undefined ? {} : { position: table.position }),
					box: table.box,
				})),
				...context.coordinatedEvidencePanels.map((panel) => ({
					id: panel.id,
					kind: "evidence-panel",
					...(panel.position === undefined ? {} : { position: panel.position }),
					box: panel.box,
				})),
			],
			[
				...state.coordinatedNodes.map((node) => ({
					id: node.id,
					kind: "node",
					box: node.box,
				})),
				...state.coordinatedGroups.map((group) => ({
					id: group.id,
					kind: "group",
					box: group.box,
				})),
				...state.coordinatedSwimlanes.flatMap((swimlane) =>
					swimlane.box === undefined
						? []
						: [{ id: swimlane.id, kind: "swimlane", box: swimlane.box }],
				),
			],
		),
	);
	const allBoxes = [...state.layoutBoxes, ...context.evidenceBoxes];
	state.contentBounds =
		allBoxes.length === 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: unionBoxes(allBoxes);
	state.frame =
		context.diagram.frame === undefined
			? undefined
			: coordinateFrame(context.diagram.frame, state.contentBounds);
	state.frameTextAnnotation =
		state.frame === undefined
			? []
			: [
					coordinateFrameTextAnnotation(
						state.frame,
						context.options.textMeasurer,
					),
				];
	state.routingTextObstacles = [
		...state.baseTextAnnotations.filter(isPreRouteTextObstacle),
		...state.frameTextAnnotation.filter(isPreRouteTextObstacle),
		...state.edgeLabelEstimates,
	];
	state.titleBarObstacles = [];
	if (state.frame !== undefined) {
		state.titleBarObstacles.push(
			expandBox(state.frame.titleBox, context.margin),
		);
	}
	for (const swimlane of state.coordinatedSwimlanes) {
		for (const lane of swimlane.lanes) {
			if (
				lane.headerBox !== undefined &&
				lane.headerBox.width > 0 &&
				lane.headerBox.height > 0
			) {
				state.titleBarObstacles.push(expandBox(lane.headerBox, context.margin));
			}
		}
	}
	state.reservedSideGutters = reserveSideGutters(
		state.contentBounds,
		context.diagram.direction,
		context.resolvedPagePolicy,
	);
	state.laneReservations = reserveLaneCorridors(
		state.coordinatedSwimlanes,
		state.frame,
		context.resolvedPagePolicy,
		context.margin,
	);
	state.policySoftObstacles = [
		...context.softObstacles,
		...(context.resolvedPagePolicy === "lane-behavior"
			? []
			: state.titleBarObstacles),
		...state.laneReservations.softCorridors,
	];
	const policyLabelHardObstacles = resourceFlowLabelHardObstacles(
		state.baseTextAnnotations,
		context.resolvedPagePolicy,
		context.options,
	);
	state.policyHardObstacles = [
		...context.hardObstacles,
		...state.laneReservations.hardBands,
		...policyLabelHardObstacles,
	];
	state.policyHardObstacleMetadata = [
		...context.hardObstacles.map(() => ({ kind: "evidence" as const })),
		...state.laneReservations.hardBands.map(() => ({ kind: "text" as const })),
		...policyLabelHardObstacles.map(() => ({ kind: "text" as const })),
	];
	state.routeObstacleEntries = [...state.nodeGeometryById.entries()].map(
		([nodeId, geometry]) => ({
			id: nodeId,
			box:
				context.options.routingGutter === undefined
					? geometry.obstacleBox
					: expandBox(geometry.obstacleBox, context.options.routingGutter),
		}),
	);
}

function rerouteRemediationEdges(
	state: RemediationPassState,
	context: RemediationPassContext,
	options: SolveDiagramOptions,
): void {
	const edgeRoutingDiagnostics: Diagnostic[] = [];
	state.acceptedRailAllocations.clear();
	state.coordinatedEdges = coordinateEdges(
		context.styledEdges,
		state.nodeGeometryById,
		state.coordinatedNodes,
		state.routeObstacleEntries,
		state.policySoftObstacles,
		state.routingTextObstacles,
		state.policyHardObstacles,
		context.diagram.direction,
		options,
		edgeRoutingDiagnostics,
		state.coordinatedGroups,
		state.contentBounds,
		context.styledEdges,
		state.frame !== undefined,
		state.policyHardObstacleMetadata,
		state.acceptedRailAllocations,
	);
	state.edgeRoutingDiagnostics.splice(
		0,
		state.edgeRoutingDiagnostics.length,
		...edgeRoutingDiagnostics,
	);
	state.edgeTextAnnotations = coordinateEdgeTextAnnotations(
		state.coordinatedEdges,
		[
			...state.coordinatedNodes.map((node) => node.box),
			...state.baseTextAnnotations.map((annotation) => annotation.box),
			...state.frameTextAnnotation.map((annotation) => annotation.box),
		],
		options,
	);
}

function refreshRemediationDiagnostics(
	state: RemediationPassState,
	context: RemediationPassContext,
): void {
	stripDiagnosticsByCodes(
		state.diagnostics,
		[
			"routing.text-clearance.unresolved",
			"routing.label-congestion.unresolved",
			"routing.label-externalization.required",
			"routing.route-label-loop.exhausted",
			"routing.obstacle.unavoidable",
			"routing.rail-capacity.exceeded",
			"routing.endpoint-interior.unavoidable",
			"route_obstacle_fallback",
			"routing.label-hard-obstacle.unavoidable",
		],
		state.preservedDiagnosticKeys,
	);
	// Keep edge-routing diagnostics from the latest remediation reroute.
	const retained = state.diagnostics.filter(
		(diagnostic) =>
			state.preservedDiagnosticKeys.has(remediationDiagnosticKey(diagnostic)) ||
			!state.edgeRoutingDiagnostics.some(
				(edgeDiagnostic) =>
					edgeDiagnostic.code === diagnostic.code &&
					edgeDiagnostic.detail?.edgeId === diagnostic.detail?.edgeId,
			),
	);
	state.diagnostics.splice(
		0,
		state.diagnostics.length,
		...retained,
		...state.edgeRoutingDiagnostics,
	);
	const routeTextDiagnostics = reportRouteTextClearance(
		state.coordinatedEdges,
		routeLabelFeedbackTextAnnotations(
			state.baseTextAnnotations,
			state.frameTextAnnotation,
			state.edgeTextAnnotations,
		),
		context.options,
	);
	state.diagnostics.push(...routeTextDiagnostics);
	state.diagnostics.push(
		...reportLabelCongestionDiagnostics(
			routeTextDiagnostics,
			state.coordinatedEdges,
		),
	);
}

function stripDiagnosticsByCodes(
	diagnostics: Diagnostic[],
	codes: readonly string[],
	preservedKeys: ReadonlySet<string> = new Set(),
): void {
	const codeSet = new Set(codes);
	for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
		const diagnostic = diagnostics[index];
		if (
			diagnostic !== undefined &&
			codeSet.has(diagnostic.code) &&
			!preservedKeys.has(remediationDiagnosticKey(diagnostic))
		) {
			diagnostics.splice(index, 1);
		}
	}
}

function remediationDiagnosticKey(diagnostic: Diagnostic): string {
	return `${diagnostic.code}|${diagnostic.message}|${String(diagnostic.detail?.edgeId ?? "")}|${String(diagnostic.detail?.nodeId ?? "")}`;
}

function resolveRemediationPolicy(
	policy: RemediationPolicy | undefined,
): Required<RemediationPolicy> {
	return {
		externalLabels: policy?.externalLabels ?? "suggest",
		routeRails: policy?.routeRails ?? "suggest",
		growFixedGeometry: policy?.growFixedGeometry ?? "suggest",
		pageSplit: policy?.pageSplit ?? "suggest",
	};
}

function remediationPlanEnabled(
	type: RemediationPlanType,
	policy: Required<RemediationPolicy>,
): boolean {
	return remediationPlanPolicyMode(type, policy) !== "off";
}

function remediationPlanPolicyMode(
	type: RemediationPlanType,
	policy: Required<RemediationPolicy>,
): RemediationPolicyMode | PageSplitPolicyMode {
	switch (type) {
		case "external-label":
			return policy.externalLabels;
		case "route-rail":
			return policy.routeRails;
		case "grow-fixed-geometry":
			return policy.growFixedGeometry;
		case "page-split":
			return policy.pageSplit;
	}
}

function buildRemediationPlan(
	type: RemediationPlanType,
	diagnostics: readonly Diagnostic[],
	policy: Required<RemediationPolicy>,
): Omit<RemediationPlan, "id"> {
	const edgeIds = stableStrings([
		...flattenDiagnosticDetailStrings(diagnostics, "edgeId"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "edgeIds"),
	]);
	const nodeIds = stableStrings([
		...flattenDiagnosticDetailStrings(diagnostics, "nodeId"),
		...flattenDiagnosticDetailStrings(diagnostics, "childId"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "nodeIds"),
		...flattenDiagnosticDetailStrings(diagnostics, "sourceId"),
		...flattenDiagnosticDetailStrings(diagnostics, "targetId"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "ownerIds"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "conflictingObjectIds"),
	]).filter((id) => id.length > 0);
	const diagnosticCodes = stableStrings(
		diagnostics.map((diagnostic) => diagnostic.code),
	);
	const capacity = capacityFromDiagnostics(diagnostics);
	const growthDeltas = growthDeltasFromDiagnostics(diagnostics);
	const reason =
		type === "page-split" && capacity !== undefined
			? `Page capacity exceeded: required ${capacity.required} lanes but only ${capacity.available} available; split or grow the saturated page.`
			: remediationPlanReason(type, diagnostics.length);
	const policyMode = remediationPlanPolicyMode(type, policy);
	const status =
		type !== "page-split" && policyMode === "auto" ? "blocked" : "suggested";
	return {
		type,
		status,
		reason:
			status === "blocked"
				? `${reason} Auto remediation could not clear the residual conflicts.`
				: reason,
		diagnosticCodes,
		edgeIds,
		nodeIds,
		detail: remediationPlanDetail(
			type,
			policy,
			edgeIds,
			nodeIds,
			capacity,
			reason,
			growthDeltas,
		),
	};
}

function buildAppliedExternalLabelRemediationPlan(
	diagnostics: readonly Diagnostic[],
	policy: Required<RemediationPolicy>,
	callouts: readonly ExternalLabelCallout[],
): Omit<RemediationPlan, "id"> {
	const diagnosticEdgeIds = stableStrings([
		...flattenDiagnosticDetailStrings(diagnostics, "edgeId"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "edgeIds"),
	]);
	const edgeIds = stableStrings([
		...diagnosticEdgeIds,
		...callouts.map((callout) => callout.edgeId),
	]);
	const nodeIds = stableStrings([
		...flattenDiagnosticDetailStrings(diagnostics, "nodeId"),
		...flattenDiagnosticDetailStrings(diagnostics, "childId"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "nodeIds"),
		...flattenDiagnosticDetailStrings(diagnostics, "sourceId"),
		...flattenDiagnosticDetailStrings(diagnostics, "targetId"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "ownerIds"),
		...flattenDiagnosticDetailCsvStrings(diagnostics, "conflictingObjectIds"),
	]).filter((id) => id.length > 0);
	const diagnosticCodes = stableStrings([
		"routing.label-externalization.required",
		...diagnostics.map((diagnostic) => diagnostic.code),
	]);
	return {
		type: "external-label",
		status: "applied",
		reason: `Moved ${callouts.length} congested edge label${callouts.length === 1 ? "" : "s"} into deterministic keyed callouts.`,
		diagnosticCodes,
		edgeIds,
		nodeIds,
		detail: {
			strategy: "keyed-callouts",
			policy: policy.externalLabels,
			labelCount: callouts.length,
			callouts: callouts.map((callout) => ({ ...callout })),
		},
	};
}

function remediationPlanReason(
	type: RemediationPlanType,
	diagnosticCount: number,
): string {
	const suffix = `${diagnosticCount} deliverability diagnostic${diagnosticCount === 1 ? "" : "s"}`;
	switch (type) {
		case "external-label":
			return `Move congested edge labels into deterministic keyed callouts for ${suffix}.`;
		case "route-rail":
			return `Reserve route rails or gutters before per-edge routing for ${suffix}.`;
		case "grow-fixed-geometry":
			return `Grow or relax fixed geometry constraints for ${suffix}.`;
		case "page-split":
			return `Split or grow the saturated page for ${suffix}.`;
	}
}

function remediationPlanDetail(
	type: RemediationPlanType,
	policy: Required<RemediationPolicy>,
	edgeIds: readonly string[],
	nodeIds: readonly string[],
	capacity?: { required: number; available: number },
	pageSplitReason?: string,
	growthDeltas: ReadonlyArray<{
		nodeId: string;
		deltaWidth: number;
		deltaHeight: number;
	}> = [],
): RemediationPlanDetail {
	const required = capacity?.required ?? Math.max(1, edgeIds.length);
	const available = capacity?.available ?? 0;
	switch (type) {
		case "external-label":
			return {
				strategy: "keyed-callouts",
				policy: policy.externalLabels,
				labelCount: edgeIds.length,
			};
		case "route-rail":
			return {
				strategy: "dependency-rails",
				policy: policy.routeRails,
				requiredRailCount: required,
				required,
				available,
				edgeIds: [...edgeIds],
			};
		case "grow-fixed-geometry":
			return {
				strategy: "grow-or-relax-fixed-geometry",
				policy: policy.growFixedGeometry,
				affectedNodeCount: nodeIds.length,
				...(growthDeltas.length === 0
					? {}
					: {
							growthDeltas: growthDeltas.map((delta) => ({ ...delta })),
						}),
			};
		case "page-split":
			return {
				strategy: "split-over-capacity-page",
				policy: policy.pageSplit,
				edgeCount: edgeIds.length,
				nodeCount: nodeIds.length,
				required,
				available,
				reason:
					pageSplitReason ??
					`Split or grow the saturated page for ${edgeIds.length} edge(s).`,
			};
	}
}

function remediationPlanTypesForDiagnostic(
	diagnostic: Diagnostic,
): RemediationPlanType[] {
	const remediationType = remediationTypeForDiagnostic(diagnostic);
	switch (remediationType) {
		case "external-label":
			return ["external-label"];
		case "external-label-or-split":
			// Congestion/clearance residuals must still produce route-rail
			// candidates when remediationPolicy.routeRails is "auto".
			return ["external-label", "route-rail", "page-split"];
		case "route-rail-or-page-split":
		case "increase-rails-or-split":
		case "adjust-anchors-or-page-split":
			return ["route-rail", "page-split"];
		case "grow-node-anchor-capacity":
			return ["grow-fixed-geometry", "page-split"];
		case "post-growth-repair":
		case "relax-or-grow-fixed-geometry":
			return ["grow-fixed-geometry"];
		case "structured-remediation-required":
			return ["page-split"];
		default:
			return ["page-split"];
	}
}

function deliverabilityUnsatisfiableDiagnostic(
	pageId: string,
	report: DeliverabilityReport,
	diagnostics: readonly Diagnostic[],
): Diagnostic {
	const blocking = diagnostics.filter((diagnostic) =>
		DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code),
	);
	const edgeIds = stableStrings(
		flattenDiagnosticDetailStrings(blocking, "edgeId"),
	);
	const edgeIdLists = stableStrings(
		flattenDiagnosticDetailStrings(blocking, "edgeIds")
			.flatMap((value) => value.split(","))
			.map((value) => value.trim())
			.filter((value) => value.length > 0),
	);
	const textSurfaceKinds = stableStrings(
		flattenDiagnosticDetailStrings(blocking, "textSurfaceKind").concat(
			flattenDiagnosticDetailStrings(blocking, "textSurfaceKinds")
				.flatMap((value) => value.split(","))
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	);
	const conflictingObjectIds = stableStrings(
		flattenDiagnosticDetailStrings(blocking, "conflictingObjectId").concat(
			flattenDiagnosticDetailStrings(blocking, "ownerIds")
				.flatMap((value) => value.split(","))
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	);
	return {
		severity: "error",
		code: "routing.deliverability.unsatisfiable",
		message:
			"Strict deliverability could not be satisfied; structured remediation is required before this layout is deliverable.",
		path: ["diagnostics"],
		detail: compactDetail({
			pageId,
			status: report.status,
			strict: report.strict,
			blockingDiagnosticCount: blocking.length,
			diagnosticCodes: report.diagnosticCodes.join(","),
			remediationTypes: report.remediationTypes.join(","),
			edgeIds: stableStrings([...edgeIds, ...edgeIdLists]).join(","),
			textSurfaceKinds: textSurfaceKinds.join(","),
			conflictingObjectIds: conflictingObjectIds.join(","),
			suggestedRemedy:
				"Apply the listed remediation types, such as external labels, route rails, page growth, or page splitting, then solve again.",
		}),
	};
}

function remediationTypeForDiagnostic(diagnostic: Diagnostic): string {
	if (typeof diagnostic.detail?.remediationType === "string") {
		return diagnostic.detail.remediationType;
	}
	switch (diagnostic.code) {
		case "routing.text-clearance.unresolved":
		case "routing.label-hard-obstacle.unavoidable":
		case "routing.label-congestion.unresolved":
		case "routing.route-label-loop.exhausted":
			return "external-label-or-split";
		case "routing.label-externalization.required":
			return "external-label";
		case "routing.obstacle.unavoidable":
		case "routing.endpoint-interior.unavoidable":
		case "routing.evidence.crossing_forbidden":
		case "route_obstacle_fallback":
			return "route-rail-or-page-split";
		case "routing.rail-capacity.exceeded":
			return "increase-rails-or-split";
		case "routing.anchor-capacity.requires-resize":
			return "grow-node-anchor-capacity";
		case "constraints.overlap.locked-conflict":
		case "constraints.overlap.post-growth":
		case "constraints.locked-target-not-moved":
		case "layout.container-fixed-bounds-overflow":
		case "routing.container-fixed-bounds-overflow":
			return "relax-or-grow-fixed-geometry";
		case "routing.deliverability.unsatisfiable":
			return "structured-remediation-required";
		default:
			return "manual-remediation";
	}
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
		if (heightExpansion > 0 || widthExpansion > 0) {
			recenterNodeLabelLayout(node, box);
		}
	}
}

type AnchorSide = "top" | "right" | "bottom" | "left";
type EndpointRole = "source" | "target";

interface DistributedAnchor {
	anchor: AnchorSide;
	point: Point;
}

function expandNodeBoxesForAnchorCapacity(
	edges: readonly NormalizedEdge[],
	nodes: readonly NormalizedNode[],
	boxes: Map<string, Box>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
): void {
	const enabled =
		options.anchorCapacity !== false &&
		(options.anchorCapacity !== undefined ||
			(options.routeKind ?? "orthogonal") === "obstacle-avoiding");
	if (!enabled) return;
	const config =
		typeof options.anchorCapacity === "object" ? options.anchorCapacity : {};
	const minSpacing = Math.max(1, config.minSpacing ?? 16);
	const grow = config.grow ?? true;
	const counts = new Map<string, Map<AnchorSide, number>>();
	const nodesById = new Map(nodes.map((node) => [node.id, node] as const));

	for (const edge of edges) {
		const sourceBox = boxes.get(edge.source.nodeId);
		const targetBox = boxes.get(edge.target.nodeId);
		if (sourceBox === undefined || targetBox === undefined) {
			continue;
		}
		if (edge.source.portId === undefined) {
			const sourceSide = distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			);
			if (sourceSide !== undefined) {
				incrementAnchorCount(counts, edge.source.nodeId, sourceSide);
			}
		}
		if (edge.target.portId === undefined) {
			const targetSide = distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			);
			if (targetSide !== undefined) {
				incrementAnchorCount(counts, edge.target.nodeId, targetSide);
			}
		}
	}

	for (const [nodeId, sideCounts] of [...counts.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		const box = boxes.get(nodeId);
		if (box === undefined) continue;
		let widthExpansion = 0;
		let heightExpansion = 0;
		for (const [side, count] of [...sideCounts.entries()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		)) {
			if (count <= 1) continue;
			const vertical = side === "left" || side === "right";
			const availableSpan = vertical ? box.height : box.width;
			const requiredSpan = (count - 1) * minSpacing + PORT_BOX_SIZE;
			if (requiredSpan <= availableSpan) continue;
			const expansion = requiredSpan - availableSpan;
			if (grow) {
				if (vertical) {
					heightExpansion = Math.max(heightExpansion, expansion);
				} else {
					widthExpansion = Math.max(widthExpansion, expansion);
				}
			} else {
				const expansion = Math.ceil(requiredSpan - availableSpan);
				const deltaWidth = vertical ? 0 : expansion;
				const deltaHeight = vertical ? expansion : 0;
				diagnostics.push({
					severity: "warning",
					code: "routing.anchor-capacity.requires-resize",
					message: `Node ${nodeId} needs ${Math.ceil(requiredSpan)} px on ${side} side to fit ${count} edge anchor(s).`,
					path: ["nodes", nodeId],
					detail: {
						nodeId,
						side,
						edgeCount: count,
						availableSpan: Math.round(availableSpan),
						requiredSpan: Math.ceil(requiredSpan),
						required: Math.ceil(requiredSpan),
						available: Math.round(availableSpan),
						deltaWidth,
						deltaHeight,
						minSpacing,
						conflictClass: "fixed-geometry-block",
						remediationType: "grow-node-anchor-capacity",
						suggestedRemedy:
							"Increase node size, reduce same-side fanout, or enable anchorCapacity.grow.",
					},
				});
			}
		}
		if (widthExpansion > 0) {
			box.x -= widthExpansion / 2;
			box.width += widthExpansion;
		}
		if (heightExpansion > 0) {
			box.y -= heightExpansion / 2;
			box.height += heightExpansion;
		}
		if (heightExpansion > 0 || widthExpansion > 0) {
			const node = nodesById.get(nodeId);
			if (node !== undefined) {
				recenterNodeLabelLayout(node, box);
			}
		}
	}
}

function recenterNodeLabelLayout(node: NormalizedNode, box: Box): void {
	if (node.labelLayout === undefined) return;
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

function incrementAnchorCount(
	counts: Map<string, Map<AnchorSide, number>>,
	nodeId: string,
	side: AnchorSide,
): void {
	const sideCounts = counts.get(nodeId) ?? new Map<AnchorSide, number>();
	sideCounts.set(side, (sideCounts.get(side) ?? 0) + 1);
	counts.set(nodeId, sideCounts);
}

function anchorSideForEndpoint(
	anchor: NormalizedEdge["source"]["anchor"] | undefined,
	ownBox: Box,
	otherBox: Box,
	direction: NormalizedDiagram["direction"],
): AnchorSide {
	if (
		anchor === "top" ||
		anchor === "right" ||
		anchor === "bottom" ||
		anchor === "left"
	) {
		return anchor;
	}
	const ownCenter = boxCenter(ownBox);
	const otherCenter = boxCenter(otherBox);
	const dx = otherCenter.x - ownCenter.x;
	const dy = otherCenter.y - ownCenter.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		if (dx !== 0) {
			return dx > 0 ? "right" : "left";
		}
		return direction === "RL" ? "left" : "right";
	}
	if (dy !== 0) {
		return dy > 0 ? "bottom" : "top";
	}
	return direction === "BT" ? "top" : "bottom";
}

function distributedAnchorPointsByEndpoint(
	edges: readonly NormalizedEdge[],
	boxes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): Map<string, DistributedAnchor> {
	const enabled =
		options.anchorCapacity !== false &&
		(options.anchorCapacity !== undefined ||
			(options.routeKind ?? "orthogonal") === "obstacle-avoiding");
	if (!enabled) return new Map();

	const config =
		typeof options.anchorCapacity === "object" ? options.anchorCapacity : {};
	const minSpacing = Math.max(1, config.minSpacing ?? 16);
	const endpointsByNodeSide = new Map<
		string,
		{
			edgeId: string;
			role: EndpointRole;
			nodeId: string;
			side: AnchorSide;
		}[]
	>();

	for (const edge of edges) {
		const sourceBox = boxes.get(edge.source.nodeId)?.box;
		const targetBox = boxes.get(edge.target.nodeId)?.box;
		if (sourceBox === undefined || targetBox === undefined) {
			continue;
		}
		if (edge.source.portId === undefined) {
			const sourceSide = distributableAnchorSide(
				edge.source.anchor,
				sourceBox,
				targetBox,
				direction,
			);
			if (sourceSide !== undefined) {
				const key = `${edge.source.nodeId}:${sourceSide}`;
				const endpoints = endpointsByNodeSide.get(key) ?? [];
				endpoints.push({
					edgeId: edge.id,
					role: "source",
					nodeId: edge.source.nodeId,
					side: sourceSide,
				});
				endpointsByNodeSide.set(key, endpoints);
			}
		}
		if (edge.target.portId === undefined) {
			const targetSide = distributableAnchorSide(
				edge.target.anchor,
				targetBox,
				sourceBox,
				direction,
			);
			if (targetSide !== undefined) {
				const key = `${edge.target.nodeId}:${targetSide}`;
				const endpoints = endpointsByNodeSide.get(key) ?? [];
				endpoints.push({
					edgeId: edge.id,
					role: "target",
					nodeId: edge.target.nodeId,
					side: targetSide,
				});
				endpointsByNodeSide.set(key, endpoints);
			}
		}
	}

	const distributed = new Map<string, DistributedAnchor>();
	for (const endpoints of endpointsByNodeSide.values()) {
		if (endpoints.length <= 1) continue;
		const sorted = [...endpoints].sort((a, b) => {
			const byEdge = a.edgeId.localeCompare(b.edgeId);
			return byEdge === 0 ? a.role.localeCompare(b.role) : byEdge;
		});
		const first = sorted[0];
		if (first === undefined) continue;
		const box = boxes.get(first.nodeId)?.box;
		if (box === undefined) continue;
		for (let index = 0; index < sorted.length; index += 1) {
			const endpoint = sorted[index];
			if (endpoint === undefined) continue;
			distributed.set(endpointDistributionKey(endpoint.edgeId, endpoint.role), {
				anchor: endpoint.side,
				point: distributedAnchorPoint(
					box,
					endpoint.side,
					index,
					sorted.length,
					minSpacing,
				),
			});
		}
	}
	return distributed;
}

function distributableAnchorSide(
	anchor: NormalizedEdge["source"]["anchor"] | undefined,
	ownBox: Box,
	otherBox: Box,
	direction: NormalizedDiagram["direction"],
): AnchorSide | undefined {
	if (anchor === undefined) {
		return anchorSideForEndpoint(anchor, ownBox, otherBox, direction);
	}
	if (
		anchor === "top" ||
		anchor === "right" ||
		anchor === "bottom" ||
		anchor === "left"
	) {
		return anchor;
	}
	return undefined;
}

function distributedAnchorPoint(
	box: Box,
	side: AnchorSide,
	index: number,
	count: number,
	minSpacing: number,
): Point {
	const center = boxCenter(box);
	const vertical = side === "left" || side === "right";
	const span = vertical ? box.height : box.width;
	const usableSpan = Math.max(0, span - PORT_BOX_SIZE);
	const spacing =
		count <= 1 ? 0 : Math.min(minSpacing, usableSpan / Math.max(1, count - 1));
	const offset = (index - (count - 1) / 2) * spacing;
	switch (side) {
		case "left":
			return { x: box.x, y: center.y + offset };
		case "right":
			return { x: box.x + box.width, y: center.y + offset };
		case "top":
			return { x: center.x + offset, y: box.y };
		case "bottom":
			return { x: center.x + offset, y: box.y + box.height };
	}
}

function endpointDistributionKey(edgeId: string, role: EndpointRole): string {
	return `${edgeId}:${role}`;
}

function withDistributedAnchor(
	geometry: ReturnType<typeof computeShapeGeometry>,
	distributed: DistributedAnchor | undefined,
): ReturnType<typeof computeShapeGeometry> {
	if (distributed === undefined) return geometry;
	return {
		...geometry,
		anchors: geometry.anchors.map((anchor) =>
			anchor.name === distributed.anchor
				? { ...anchor, point: distributed.point }
				: anchor,
		),
	};
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

interface NodeObstacleEntry {
	id: string;
	box: Box;
}

function coordinateEdges(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	coordinatedNodes: readonly CoordinatedNode[],
	nodeObstacles: readonly NodeObstacleEntry[],
	softObstacles: readonly Box[],
	textObstacles: readonly SolvedTextAnnotation[],
	hardObstacles: readonly Box[],
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
	diagnostics: Diagnostic[],
	groups: readonly CoordinatedGroup[],
	contentBounds: Box,
	allocationEdges: readonly NormalizedEdge[] = edges,
	avoidFrameTitleRails = false,
	hardObstacleMetadata?: readonly RouteHardObstacleMetadata[],
	railAllocations?: Map<string, RoutingRailAllocation>,
): CoordinatedEdge[] {
	const coordinated: CoordinatedEdge[] = [];
	const coordinatedNodeById = new Map(
		coordinatedNodes.map((node) => [node.id, node]),
	);
	// Compute adaptive corridor margin for corner-graph prefilter (Issue #66).
	// "auto" uses 30% of the content diagonal (min 200 px) so the corridor
	// covers ~60% of the page on dense diagrams instead of the old fixed 32 px.
	const corridorMarginOption = options.corridorMargin ?? "auto";
	const corridorMargin: number =
		typeof corridorMarginOption === "number"
			? corridorMarginOption
			: Math.max(
					200,
					Math.hypot(contentBounds.width, contentBounds.height) * 0.3,
				);

	// Effective query gutter for node-obstacle prefilter. Only widen for
	// obstacle-avoiding routes that actually use the adaptive corridor —
	// other route kinds should respect the caller's routingGutter as-is to
	// avoid unnecessary detours from over-including nodes (Codex P2).
	const routingGutter = options.routingGutter ?? 160;
	const queryGutter =
		(options.routeKind ?? "orthogonal") === "obstacle-avoiding"
			? Math.max(routingGutter, corridorMargin)
			: routingGutter;
	const nodeObstacleIndex = createBoxSpatialIndex(
		nodeObstacles.map((entry) => ({ id: entry.id, box: entry.box })),
		queryGutter,
	);
	const railIndexByEdgeId = railRouteIndexByEdgeId(
		allocationEdges,
		nodes,
		direction,
		options,
	);
	const railOccupancy = createRailOccupancyState();
	// Policy fan-out (resource-flow / ibd-high-fan-in) replaces
	// distributedAnchorPointsByEndpoint for eligible endpoints so each
	// edge is mutated once. Explicit portId / corner anchors are skipped.
	const policyFanOutAnchors = policyUsesFanOutBundles(options.pagePolicy)
		? computePolicyFanOutAnchors(allocationEdges, nodes, direction, options)
		: new Map<string, DistributedAnchor>();
	const distributedAnchors = policyUsesFanOutBundles(options.pagePolicy)
		? new Map<string, DistributedAnchor>()
		: distributedAnchorPointsByEndpoint(
				allocationEdges,
				nodes,
				direction,
				options,
			);
	const routeHardObstacleMetadata =
		hardObstacleMetadata ??
		hardObstacles.map(() => ({ kind: "evidence" as const }));

	for (const edge of edges) {
		railAllocations?.delete(edge.id);
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
		const sourceDistributedAnchor =
			policyFanOutAnchors.get(endpointDistributionKey(edge.id, "source")) ??
			distributedAnchors.get(endpointDistributionKey(edge.id, "source"));
		const targetDistributedAnchor =
			policyFanOutAnchors.get(endpointDistributionKey(edge.id, "target")) ??
			distributedAnchors.get(endpointDistributionKey(edge.id, "target"));
		const sourceGeometry = withDistributedAnchor(
			portGeometry(source, sourcePort),
			sourceDistributedAnchor,
		);
		const targetGeometry = withDistributedAnchor(
			portGeometry(target, targetPort),
			targetDistributedAnchor,
		);
		const sourceAnchor = edge.source.anchor ?? sourceDistributedAnchor?.anchor;
		const targetAnchor = edge.target.anchor ?? targetDistributedAnchor?.anchor;
		const routeTextObstacles = textObstacles
			.filter(isLocalRouteClearanceText)
			.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
			.map((annotation) => textObstacleBox(annotation, options));
		const railTextObstacles = textObstacles
			.filter(isLocalRouteClearanceText)
			.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
			.map((annotation) => textObstacleBox(annotation, options));
		const corridor = edgeCorridorBox(source.box, target.box, queryGutter);
		const routeNodeObstacles = queryBoxSpatialIndex(nodeObstacleIndex, corridor)
			.filter(
				(entry) =>
					entry.id !== edge.source.nodeId && entry.id !== edge.target.nodeId,
			)
			.map((entry) => entry.box);
		const routeGroupObstacles = groupObstaclesForEdge(
			edge,
			groups,
			options.obstacleMargin ?? 0,
		);
		const railCandidate = railIndexByEdgeId.get(edge.id);
		if (railCandidate !== undefined) {
			const railNodeObstacles = nodeObstacles
				.filter(
					(obstacle) =>
						obstacle.id !== edge.source.nodeId &&
						obstacle.id !== edge.target.nodeId,
				)
				.map((obstacle) => obstacle.box);
			const railSoftObstacles = [
				...railNodeObstacles,
				...softObstacles,
				...routeGroupObstacles,
				...railTextObstacles,
			];
			const acceptedRail = tryAcceptDependencyRail({
				edgeId: edge.id,
				source: sourceGeometry,
				target: targetGeometry,
				sourceAnchor,
				targetAnchor,
				direction,
				contentBounds,
				candidateIndex: railCandidate.index,
				side: railCandidate.side,
				laneIndex: railCandidate.laneIndex,
				avoidFrameTitleRails,
				railSoftObstacles,
				railBandObstacles: railTextObstacles,
				hardObstacles,
				occupancy: railOccupancy,
			});
			if (acceptedRail !== undefined) {
				railAllocations?.set(edge.id, acceptedRail.allocation);
				if (acceptedRail.overBudget) {
					diagnostics.push(
						railCapacityDiagnostic(
							edge.id,
							acceptedRail.allocation.index,
							acceptedRail.required,
							acceptedRail.available,
							edge.source.nodeId,
							edge.target.nodeId,
						),
					);
				}
				coordinated.push({
					...edge,
					points: acceptedRail.points,
				});
				continue;
			}
		}

		const route = routeEdge({
			kind: options.routeKind ?? "orthogonal",
			direction,
			source: sourceGeometry,
			target: targetGeometry,
			...(sourceAnchor === undefined ? {} : { sourceAnchor }),
			...(targetAnchor === undefined ? {} : { targetAnchor }),
			obstacles: [
				...routeNodeObstacles,
				...softObstacles,
				...routeGroupObstacles,
				...routeTextObstacles,
			],
			hardObstacles,
			hardObstacleMetadata: routeHardObstacleMetadata,
			corridorMargin,
			...(options.maxCorners === undefined
				? {}
				: { maxCorners: options.maxCorners }),
			...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
			...(options.maxRoutingAttempts === undefined
				? {}
				: { maxRoutingAttempts: options.maxRoutingAttempts }),
			...(options.maxBacktrackingRatio === undefined
				? {}
				: { maxBacktrackingRatio: options.maxBacktrackingRatio }),
			...(options.textObstacleVertices === undefined
				? {}
				: { textObstacleVertices: options.textObstacleVertices }),
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

type RailOccupancyState = Map<RoutingRailAllocation["side"], Set<number>>;

interface RailRouteCandidate {
	index: number;
	side: RoutingRailAllocation["side"];
	laneIndex: number;
}

function createRailOccupancyState(): RailOccupancyState {
	return new Map();
}

function isRailLaneOccupied(
	occupancy: RailOccupancyState,
	side: RoutingRailAllocation["side"],
	laneIndex: number,
): boolean {
	return occupancy.get(side)?.has(laneIndex) === true;
}

function markRailLaneOccupied(
	occupancy: RailOccupancyState,
	side: RoutingRailAllocation["side"],
	laneIndex: number,
): void {
	const lanes = occupancy.get(side);
	if (lanes === undefined) {
		occupancy.set(side, new Set([laneIndex]));
		return;
	}
	lanes.add(laneIndex);
}

function scoreRailBandOccupancy(
	railPoints: readonly Point[],
	softObstacles: readonly Box[],
	side: RoutingRailAllocation["side"],
	direction: NormalizedDiagram["direction"],
): number {
	const band = railBandBox(railPoints, side, direction);
	if (band === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	let count = 0;
	for (const obstacle of softObstacles) {
		if (intersectsAabb(band, obstacle)) {
			count += 1;
		}
	}
	return count;
}

function railBandBox(
	railPoints: readonly Point[],
	side: RoutingRailAllocation["side"],
	direction: NormalizedDiagram["direction"],
): Box | undefined {
	const horizontal = direction === "LR" || direction === "RL";
	if (horizontal) {
		const railYs = railPoints
			.map((point) => point.y)
			.filter((y, index, values) => values.indexOf(y) === index);
		const railY =
			side === "bottom"
				? Math.max(...railPoints.map((point) => point.y))
				: Math.min(...railPoints.map((point) => point.y));
		if (!railYs.includes(railY)) {
			return undefined;
		}
		const xs = railPoints.map((point) => point.x);
		return {
			x: Math.min(...xs),
			y: railY - 4,
			width: Math.max(0, Math.max(...xs) - Math.min(...xs)),
			height: 8,
		};
	}
	const railX =
		side === "right"
			? Math.max(...railPoints.map((point) => point.x))
			: Math.min(...railPoints.map((point) => point.x));
	const ys = railPoints.map((point) => point.y);
	return {
		x: railX - 4,
		y: Math.min(...ys),
		width: 8,
		height: Math.max(0, Math.max(...ys) - Math.min(...ys)),
	};
}

function tryAcceptDependencyRail(input: {
	edgeId: string;
	source: ReturnType<typeof computeShapeGeometry>;
	target: ReturnType<typeof computeShapeGeometry>;
	sourceAnchor: AnchorName | undefined;
	targetAnchor: AnchorName | undefined;
	direction: NormalizedDiagram["direction"];
	contentBounds: Box;
	candidateIndex: number;
	side: RoutingRailAllocation["side"];
	laneIndex: number;
	avoidFrameTitleRails: boolean;
	railSoftObstacles: readonly Box[];
	railBandObstacles: readonly Box[];
	hardObstacles: readonly Box[];
	occupancy: RailOccupancyState;
}):
	| {
			points: Point[];
			allocation: RoutingRailAllocation;
			overBudget: boolean;
			required: number;
			available: number;
	  }
	| undefined {
	const { side, laneIndex } = input;
	if (isRailLaneOccupied(input.occupancy, side, laneIndex)) {
		return undefined;
	}
	const railPoints = railRoutePoints(
		input.source,
		input.target,
		input.sourceAnchor,
		input.targetAnchor,
		input.direction,
		input.contentBounds,
		laneIndex,
		side,
		input.avoidFrameTitleRails,
	);
	if (railPoints === undefined) {
		return undefined;
	}
	const softDensity = scoreRailBandOccupancy(
		railPoints,
		input.railBandObstacles,
		side,
		input.direction,
	);
	if (softDensity > RAIL_BAND_SOFT_OBSTACLE_MAX) {
		return undefined;
	}
	if (
		routeCrossesBoxes(railPoints, input.railSoftObstacles) ||
		routeCrossesBoxes(railPoints, input.hardObstacles)
	) {
		return undefined;
	}
	markRailLaneOccupied(input.occupancy, side, laneIndex);
	const required = input.candidateIndex + 1;
	const available = DEFAULT_RAIL_BUDGET;
	return {
		points: railPoints,
		allocation: railAllocationForRoute(
			input.edgeId,
			railPoints,
			input.direction,
			input.candidateIndex,
			side,
		),
		overBudget: required > available,
		required,
		available,
	};
}

function railCapacityDiagnostic(
	edgeId: string,
	railIndex: number,
	required: number,
	available: number,
	sourceId: string,
	targetId: string,
): Diagnostic {
	return {
		severity: "warning",
		code: "routing.rail-capacity.exceeded",
		message: `Rail routing for edge ${edgeId} exceeded the recommended ${available}-lane budget (required ${required}).`,
		path: ["edges", edgeId],
		detail: {
			edgeId,
			railIndex,
			required,
			available,
			sourceId,
			targetId,
			conflictClass: "rail-lane-overflow",
			remediationType: "increase-rails-or-split",
			suggestedRemedy:
				"Split the dependency group, increase page bounds, or use explicit constraints.",
		},
	};
}

function railRouteIndexByEdgeId(
	edges: readonly NormalizedEdge[],
	nodes: ReadonlyMap<string, ReturnType<typeof computeShapeGeometry>>,
	direction: NormalizedDiagram["direction"],
	options: SolveDiagramOptions,
): Map<string, RailRouteCandidate> {
	if (!dependencyRailsEnabled(options)) {
		return new Map();
	}
	const candidates = edges
		.filter((edge) => {
			const source = nodes.get(edge.source.nodeId);
			const target = nodes.get(edge.target.nodeId);
			if (source === undefined || target === undefined) return false;
			if (source.box === target.box) return false;
			return isSameRankEdge(source, target, direction);
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	if (
		options.railRouting === "auto" &&
		options.pagePolicy !== "dependency" &&
		candidates.length < PAGE_POLICY_SAME_RANK_DEPENDENCY_MIN
	) {
		return new Map();
	}
	const horizontal = direction === "LR" || direction === "RL";
	return new Map(
		candidates.map((edge, index) => {
			const useSecondary = index % 2 === 1;
			const side: RoutingRailAllocation["side"] = horizontal
				? useSecondary
					? "bottom"
					: "top"
				: useSecondary
					? "right"
					: "left";
			return [
				edge.id,
				{
					index,
					side,
					laneIndex: Math.floor(index / 2),
				} satisfies RailRouteCandidate,
			];
		}),
	);
}

function dependencyRailsEnabled(options: SolveDiagramOptions): boolean {
	// Explicit opt-out wins over pagePolicy so callers can disable rails on
	// dependency pages without changing the classified policy.
	if (options.railRouting === false) {
		return false;
	}
	if (options.pagePolicy === "dependency") {
		return true;
	}
	if (options.pagePolicy === "off") {
		return (
			options.railRouting === "dependency" || options.railRouting === "auto"
		);
	}
	if (options.railRouting === undefined) {
		return false;
	}
	if (
		options.railRouting === "auto" &&
		(options.routeKind ?? "orthogonal") !== "obstacle-avoiding"
	) {
		return false;
	}
	return options.railRouting === "dependency" || options.railRouting === "auto";
}

function railRoutePoints(
	source: ReturnType<typeof computeShapeGeometry>,
	target: ReturnType<typeof computeShapeGeometry>,
	sourceAnchor: AnchorName | undefined,
	targetAnchor: AnchorName | undefined,
	direction: NormalizedDiagram["direction"],
	contentBounds: Box,
	laneIndex: number,
	side: RoutingRailAllocation["side"],
	avoidFrameTitleRails: boolean,
): Point[] | undefined {
	const gap = 18;
	if (direction === "LR" || direction === "RL") {
		const sourceSide =
			sourceAnchor === undefined
				? direction === "RL"
					? "left"
					: "right"
				: anchorSideForEndpoint(
						sourceAnchor,
						source.box,
						target.box,
						direction,
					);
		const targetSide =
			targetAnchor === undefined
				? direction === "RL"
					? "right"
					: "left"
				: anchorSideForEndpoint(
						targetAnchor,
						target.box,
						source.box,
						direction,
					);
		if (
			!isHorizontalRailEndpointSide(sourceSide) ||
			!isHorizontalRailEndpointSide(targetSide)
		) {
			return undefined;
		}
		const start = getEdgePort(
			source,
			target.center,
			sourceAnchor ?? sourceSide,
		);
		const end = getEdgePort(target, source.center, targetAnchor ?? targetSide);
		const sourceOutward =
			side === "bottom"
				? sourceSide === "left"
					? contentBounds.x - 64
					: contentBounds.x + contentBounds.width + 64
				: sourceSide === "left"
					? start.x - gap
					: start.x + gap;
		const targetOutward =
			side === "bottom"
				? targetSide === "left"
					? contentBounds.x - 64
					: contentBounds.x + contentBounds.width + 64
				: targetSide === "left"
					? end.x - gap
					: end.x + gap;
		const sourceJogX = avoidFrameTitleJogX(
			sourceOutward,
			contentBounds,
			gap,
			avoidFrameTitleRails,
		);
		const targetJogX = avoidFrameTitleJogX(
			targetOutward,
			contentBounds,
			gap,
			avoidFrameTitleRails,
		);
		const railY =
			side === "bottom"
				? contentBounds.y + contentBounds.height + 64 + laneIndex * gap
				: contentBounds.y -
					64 -
					(avoidFrameTitleRails ? 48 : 0) -
					laneIndex * gap;
		return compactRoutePoints([
			start,
			{ x: sourceJogX, y: start.y },
			{ x: sourceJogX, y: railY },
			{ x: targetJogX, y: railY },
			{ x: targetJogX, y: end.y },
			end,
		]);
	}
	const sourceSide =
		sourceAnchor === undefined
			? direction === "BT"
				? "top"
				: "bottom"
			: anchorSideForEndpoint(sourceAnchor, source.box, target.box, direction);
	const targetSide =
		targetAnchor === undefined
			? direction === "BT"
				? "bottom"
				: "top"
			: anchorSideForEndpoint(targetAnchor, target.box, source.box, direction);
	if (
		!isVerticalRailEndpointSide(sourceSide) ||
		!isVerticalRailEndpointSide(targetSide)
	) {
		return undefined;
	}
	const start = getEdgePort(source, target.center, sourceAnchor ?? sourceSide);
	const end = getEdgePort(target, source.center, targetAnchor ?? targetSide);
	const sourceJogY =
		side === "right"
			? sourceSide === "top"
				? contentBounds.y - 64
				: contentBounds.y + contentBounds.height + 64
			: sourceSide === "top"
				? start.y - gap
				: start.y + gap;
	const targetJogY =
		side === "right"
			? targetSide === "top"
				? contentBounds.y - 64
				: contentBounds.y + contentBounds.height + 64
			: targetSide === "top"
				? end.y - gap
				: end.y + gap;
	const railX =
		side === "right"
			? contentBounds.x + contentBounds.width + 64 + laneIndex * gap
			: contentBounds.x - 64 - laneIndex * gap;
	return compactRoutePoints([
		start,
		{ x: start.x, y: sourceJogY },
		{ x: railX, y: sourceJogY },
		{ x: railX, y: targetJogY },
		{ x: end.x, y: targetJogY },
		end,
	]);
}

function isHorizontalRailEndpointSide(side: AnchorSide): boolean {
	return side === "left" || side === "right";
}

function isVerticalRailEndpointSide(side: AnchorSide): boolean {
	return side === "top" || side === "bottom";
}

function avoidFrameTitleJogX(
	jogX: number,
	contentBounds: Box,
	gap: number,
	enabled: boolean,
): number {
	if (!enabled) {
		return jogX;
	}
	const reservedTitleLeft = contentBounds.x - 64;
	const reservedTitleRight = contentBounds.x + 220;
	if (jogX >= reservedTitleLeft && jogX <= reservedTitleRight) {
		return reservedTitleRight + gap;
	}
	return jogX;
}

function compactRoutePoints(points: readonly Point[]): Point[] {
	const compacted: Point[] = [];
	for (const point of points) {
		const previous = compacted[compacted.length - 1];
		if (
			previous === undefined ||
			previous.x !== point.x ||
			previous.y !== point.y
		) {
			compacted.push(point);
		}
	}
	return compacted;
}

function routeCrossesBoxes(
	points: readonly Point[],
	obstacles: readonly Box[],
): boolean {
	for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
		const start = points[pointIndex];
		const end = points[pointIndex + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const segment = segmentBox(start, end);
		for (const obstacle of obstacles) {
			if (intersectsAabb(segment, obstacle)) {
				return true;
			}
		}
	}
	return false;
}

function segmentBox(start: Point, end: Point): Box {
	return {
		x: Math.min(start.x, end.x),
		y: Math.min(start.y, end.y),
		width: Math.abs(end.x - start.x),
		height: Math.abs(end.y - start.y),
	};
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
	options: SolveDiagramOptions = {},
): SolvedTextAnnotation[] {
	const labelBaseOffset =
		options.labelPlacement === "beside" ? (options.labelOffset ?? 16) : 10;

	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
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
		const anchor = edgeLabelAnchor(
			edge,
			layout,
			edges,
			obstacleBoxes,
			placedLabelBoxes,
			labelBaseOffset,
			options,
		);
		if (!anchor.externalized) {
			placedLabelBoxes.push({
				x: anchor.center.x - layout.box.width / 2,
				y: anchor.center.y - layout.box.height / 2,
				width: layout.box.width,
				height: layout.box.height,
			});
		}
		annotations.push(
			buildCenteredTextAnnotation({
				ownerId: edge.id,
				surfaceKind: "edge-label",
				layout,
				typography: typographyForLabel(edge.label),
				center: anchor.center,
				...(anchor.externalized
					? { placement: "external-callout-required" }
					: {}),
				placementDetail: {
					candidateCount: anchor.candidateCount,
					localConflictCount: anchor.localConflictCount,
					routeConflictCount: anchor.routeConflictCount,
					nodeOverlapCount: anchor.nodeOverlapCount,
					labelOverlapCount: anchor.labelOverlapCount,
				},
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
	labelPlacement?: "beside" | "on-path",
	labelOffset?: number,
): SolvedTextAnnotation[] {
	const measurer = textMeasurer ?? createDefaultTextMeasurer();
	const annotations: SolvedTextAnnotation[] = [];
	const labelBaseOffset =
		labelPlacement === "beside" ? (labelOffset ?? 16) : 10;

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
		const paths = edgeLabelEstimatePaths(sourceGeom.center, targetGeom.center);
		const seen = new Set<string>();
		let surfaceIndex = 0;
		for (const path of paths) {
			const placement = labelPlacementOnPolyline(path, labelBaseOffset);
			if (placement === undefined) {
				continue;
			}
			const candidates = edgeLabelAnchorCandidates(
				path,
				placement,
				layout,
				labelBaseOffset,
			);
			const candidate =
				candidates.find((candidate) => {
					const labelBox = {
						x: candidate.x - layout.box.width / 2,
						y: candidate.y - layout.box.height / 2,
						width: layout.box.width,
						height: layout.box.height,
					};
					return !routeIntersectsTextBox(path, labelBox);
				}) ?? candidates[0];
			if (candidate !== undefined) {
				const key = `${Math.round(candidate.x * 10) / 10},${
					Math.round(candidate.y * 10) / 10
				}`;
				if (!seen.has(key)) {
					seen.add(key);
					annotations.push(
						buildCenteredTextAnnotation({
							ownerId: edge.id,
							surfaceKind: "edge-label",
							surfaceIndex,
							layout,
							center: candidate,
						}),
					);
					surfaceIndex += 1;
				}
			}
		}
	}
	return annotations;
}

function edgeLabelEstimatePaths(source: Point, target: Point): Point[][] {
	return [
		[source, target],
		[source, { x: target.x, y: source.y }, target],
		[source, { x: source.x, y: target.y }, target],
	];
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
	placement?: SolvedTextAnnotation["placement"];
	placementDetail?: SolvedTextAnnotation["placementDetail"];
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
		...(input.placement === undefined ? {} : { placement: input.placement }),
		...(input.placementDetail === undefined
			? {}
			: { placementDetail: input.placementDetail }),
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

function buildExternalLabelCallouts(
	annotations: readonly SolvedTextAnnotation[],
	bounds: Box,
	options: SolveDiagramOptions,
): BuiltExternalLabelCallout[] {
	const sources = annotations
		.filter(
			(annotation) =>
				annotation.surfaceKind === "edge-label" &&
				annotation.placement === "external-callout-required",
		)
		.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
	if (sources.length === 0) {
		return [];
	}

	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
	let shelfY = bounds.y;
	return sources.map((source, index) => {
		const key = externalLabelKey(index);
		const shelfText = `${key}: ${source.text}`;
		const keyLayout = fitLabel(
			key,
			{
				font: {
					fontFamily: source.fontFamily,
					fontSize: Math.max(10, Math.min(source.fontSize, 12)),
					lineHeight: Math.max(12, Math.min(source.fontSize + 2, 14)),
				},
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				minSize: { width: 0, height: 0 },
				maxWidth: 48,
			},
			measurer,
		);
		const shelfLayout = fitLabel(
			shelfText,
			{
				font: {
					fontFamily: source.fontFamily,
					fontSize: source.fontSize,
					lineHeight: source.fontSize + 2,
				},
				padding: source.paddings,
				minSize: { width: 0, height: 0 },
				maxWidth: Math.max(source.box.width, 160),
			},
			measurer,
		);
		const sourceCenter = boxCenter(source.box);
		const keyBox = {
			x: sourceCenter.x - keyLayout.box.width / 2,
			y: sourceCenter.y - keyLayout.box.height / 2,
			width: keyLayout.box.width,
			height: keyLayout.box.height,
		};
		const calloutBox = {
			x: bounds.x + bounds.width + EXTERNAL_LABEL_SHELF_GAP,
			y: shelfY,
			width: Math.max(source.box.width, shelfLayout.box.width),
			height: Math.max(source.box.height, shelfLayout.box.height),
		};
		shelfY += Math.max(14, calloutBox.height) + EXTERNAL_LABEL_SHELF_ROW_GAP;
		const callout: ExternalLabelCallout = {
			edgeId: source.ownerId,
			key,
			text: source.text,
			shelfSide: "right",
			keyBox,
			calloutBox,
		};
		return {
			callout,
			source,
			keyAnnotation: buildExternalLabelKeyAnnotation(
				source,
				keyLayout,
				callout,
			),
			calloutAnnotation: buildExternalLabelCalloutAnnotation(
				source,
				callout,
				shelfLayout,
			),
		};
	});
}

function applyExternalLabelCallouts(
	annotations: readonly SolvedTextAnnotation[],
	callouts: readonly BuiltExternalLabelCallout[],
): SolvedTextAnnotation[] {
	if (callouts.length === 0) {
		return [...annotations];
	}
	const calloutByEdgeId = new Map(
		callouts.map((callout) => [callout.source.ownerId, callout]),
	);
	const rewritten: SolvedTextAnnotation[] = [];
	for (const annotation of annotations) {
		const callout = calloutByEdgeId.get(annotation.ownerId);
		if (
			annotation.surfaceKind !== "edge-label" ||
			annotation.placement !== "external-callout-required" ||
			callout === undefined
		) {
			rewritten.push(annotation);
			continue;
		}
		rewritten.push(callout.keyAnnotation, callout.calloutAnnotation);
	}
	return rewritten;
}

function externalLabelKey(index: number): string {
	return `E${index + 1}`;
}

function buildExternalLabelKeyAnnotation(
	source: SolvedTextAnnotation,
	keyLayout: LabelLayout,
	callout: ExternalLabelCallout,
): SolvedTextAnnotation {
	return {
		...source,
		text: callout.key,
		placement: "external-callout",
		placementDetail: externalLabelPlacementDetail(source, callout, "key"),
		box: callout.keyBox,
		paddings: keyLayout.padding,
		lines: keyLayout.lines,
		fontFamily: normalizeOutputFontFamily(keyLayout.font),
		fontSize: keyLayout.font.fontSize,
		textBackend: keyLayout.textBackend,
	};
}

function buildExternalLabelCalloutAnnotation(
	source: SolvedTextAnnotation,
	callout: ExternalLabelCallout,
	shelfLayout: LabelLayout,
): SolvedTextAnnotation {
	return {
		...source,
		text: shelfLayout.text,
		placement: "external-callout",
		placementDetail: externalLabelPlacementDetail(source, callout, "callout"),
		box: callout.calloutBox,
		paddings: shelfLayout.padding,
		lines: shelfLayout.lines,
		fontFamily: normalizeOutputFontFamily(shelfLayout.font),
		fontSize: shelfLayout.font.fontSize,
		textBackend: shelfLayout.textBackend,
	};
}

function externalLabelPlacementDetail(
	source: SolvedTextAnnotation,
	callout: ExternalLabelCallout,
	role: "key" | "callout",
): NonNullable<SolvedTextAnnotation["placementDetail"]> {
	return {
		...(source.placementDetail ?? {}),
		role,
		key: callout.key,
		originalText: callout.text,
		shelfSide: callout.shelfSide,
		keyBox: boxJson(callout.keyBox),
		calloutBox: boxJson(callout.calloutBox),
	};
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
	options: SolveDiagramOptions = {},
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const relevantAnnotations = annotations.filter(isLocalRouteClearanceText);
	const tolerance = options.textIntersectionTolerance ?? 2;

	for (const edge of edges) {
		for (const annotation of relevantAnnotations) {
			if (isEdgeConnectedTextAnnotation(edge, annotation)) {
				continue;
			}
			const obstacle = textObstacleBox(annotation, options);
			if (!routeIntersectsTextBox(edge.points, obstacle, tolerance)) {
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
					conflictClass: classifyRouteTextConflict(
						edge.points,
						annotation,
						obstacle,
						tolerance,
					),
				}),
			});
		}
	}

	return diagnostics;
}

function classifyRouteTextConflict(
	points: readonly Point[],
	annotation: SolvedTextAnnotation,
	obstacle: Box,
	tolerance: number,
): RouteConflictClass {
	// Caller already observed an intersection at `tolerance`. A graze is a
	// shallow bbox touch that disappears once the box is inset further.
	if (!routeIntersectsTextBox(points, obstacle, tolerance + 2)) {
		return "label-bbox-graze";
	}
	if (annotation.surfaceKind === "node-label") {
		return "node-label-strike";
	}
	if (annotation.surfaceKind === "edge-label") {
		return "edge-label-pileup";
	}
	return "label-bbox-graze";
}

function reportExternalizedLabelDiagnostics(
	annotations: readonly SolvedTextAnnotation[],
	edges: readonly CoordinatedEdge[],
): Diagnostic[] {
	const externalized = annotations.filter(
		(annotation) =>
			annotation.surfaceKind === "edge-label" &&
			annotation.placement === "external-callout-required",
	);
	if (externalized.length === 0) {
		return [];
	}
	const edgeIds = stableStrings(
		externalized.map((annotation) => annotation.ownerId),
	);
	const candidateCount = externalized.reduce(
		(total, annotation) =>
			total + numberDetail(annotation.placementDetail?.candidateCount),
		0,
	);
	const localConflictCount = externalized.reduce(
		(total, annotation) =>
			total + numberDetail(annotation.placementDetail?.localConflictCount),
		0,
	);
	const routeConflictCount = externalized.reduce(
		(total, annotation) =>
			total + numberDetail(annotation.placementDetail?.routeConflictCount),
		0,
	);
	const nodeOverlapCount = externalized.reduce(
		(total, annotation) =>
			total + numberDetail(annotation.placementDetail?.nodeOverlapCount),
		0,
	);
	const labelOverlapCount = externalized.reduce(
		(total, annotation) =>
			total + numberDetail(annotation.placementDetail?.labelOverlapCount),
		0,
	);
	const involvedEdges = edges.filter((edge) => edgeIds.includes(edge.id));
	const bounds =
		involvedEdges.length === 0
			? undefined
			: unionBoxes(involvedEdges.map((edge) => edgeRouteBounds(edge)));
	return [
		{
			severity: "warning",
			code: "routing.label-externalization.required",
			message: `${externalized.length} edge label(s) require external callouts because local candidates remain congested.`,
			path: ["textAnnotations", "edge-label"],
			detail: compactDetail({
				edgeIds: edgeIds.join(","),
				labelCount: externalized.length,
				candidateCount,
				localConflictCount,
				routeConflictCount,
				nodeOverlapCount,
				labelOverlapCount,
				remediationType: "external-label",
				occupiedCorridor:
					bounds === undefined
						? undefined
						: `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(
								bounds.width,
							)},${Math.round(bounds.height)}`,
				...(bounds === undefined
					? {}
					: {
							boundsX: Math.round(bounds.x),
							boundsY: Math.round(bounds.y),
							boundsWidth: Math.round(bounds.width),
							boundsHeight: Math.round(bounds.height),
						}),
				suggestedRemedy:
					"Render these edge labels as keyed external callouts, increase label rails, or split the dense view.",
			}),
		},
	];
}

function reportLabelCongestionDiagnostics(
	routeTextDiagnostics: readonly Diagnostic[],
	edges: readonly CoordinatedEdge[],
): Diagnostic[] {
	const congested = routeTextDiagnostics.filter(
		(diagnostic) =>
			diagnostic.code === "routing.text-clearance.unresolved" &&
			(diagnostic.detail?.textSurfaceKind === "edge-label" ||
				diagnostic.detail?.textSurfaceKind === "node-label"),
	);
	if (congested.length === 0) {
		return [];
	}
	const edgeIds = stableStrings(
		congested
			.map((diagnostic) => diagnostic.detail?.edgeId)
			.filter((value): value is string => typeof value === "string"),
	);
	const ownerIds = stableStrings(
		congested
			.map((diagnostic) => diagnostic.detail?.conflictingObjectId)
			.filter((value): value is string => typeof value === "string"),
	);
	const surfaceKinds = stableStrings(
		congested
			.map((diagnostic) => diagnostic.detail?.textSurfaceKind)
			.filter((value): value is string => typeof value === "string"),
	);
	const involvedEdges = edges.filter((edge) => edgeIds.includes(edge.id));
	const bounds =
		involvedEdges.length === 0
			? undefined
			: unionBoxes(involvedEdges.map((edge) => edgeRouteBounds(edge)));
	return [
		{
			severity: "warning",
			code: "routing.label-congestion.unresolved",
			message: `${congested.length} route/text clearance conflict(s) remain after dense label avoidance.`,
			path: ["edges"],
			detail: compactDetail({
				count: congested.length,
				edgeIds: edgeIds.join(","),
				ownerIds: ownerIds.join(","),
				textSurfaceKinds: surfaceKinds.join(","),
				...(bounds === undefined
					? {}
					: {
							boundsX: Math.round(bounds.x),
							boundsY: Math.round(bounds.y),
							boundsWidth: Math.round(bounds.width),
							boundsHeight: Math.round(bounds.height),
						}),
				suggestedRemedy:
					"Increase page rails/gutters, enable external labels, grow nodes, or split the dense view.",
			}),
		},
	];
}

interface RouteLabelFeedbackState {
	readonly edges: readonly CoordinatedEdge[];
	readonly edgeTextAnnotations: readonly SolvedTextAnnotation[];
	readonly edgeRoutingDiagnostics: readonly Diagnostic[];
	readonly conflicts: readonly Diagnostic[];
	readonly iteration: number;
	readonly changedEdgeIds: ReadonlySet<string>;
	readonly acceptedReroutes: number;
	readonly rejectedReroutes: number;
}

interface RouteLabelFeedbackScore {
	readonly routeTextConflicts: number;
	readonly otherRouteTextConflicts: number;
	readonly edgeRouteTextConflicts: number;
	readonly hardRouteDiagnostics: number;
	readonly softRouteDiagnostics: number;
	readonly backtrackingDiagnostics: number;
	readonly routeLength: number;
	readonly bendCount: number;
}

interface RouteLabelFeedbackHardTextObstacleEntry {
	readonly box: Box;
	readonly metadata: RouteHardObstacleMetadata;
}

function routeLabelFeedbackTextAnnotations(
	baseTextAnnotations: readonly SolvedTextAnnotation[],
	frameTextAnnotations: readonly SolvedTextAnnotation[],
	edgeTextAnnotations: readonly SolvedTextAnnotation[],
): SolvedTextAnnotation[] {
	return [
		...baseTextAnnotations,
		...frameTextAnnotations,
		...edgeTextAnnotations,
	];
}

function routeLabelFeedbackConflicts(
	edges: readonly CoordinatedEdge[],
	textAnnotations: readonly SolvedTextAnnotation[],
	options: SolveDiagramOptions,
): Diagnostic[] {
	return reportRouteTextClearance(edges, textAnnotations, options);
}

function routeLabelFeedbackHardTextObstacles(
	edge: NormalizedEdge,
	textAnnotations: readonly SolvedTextAnnotation[],
	options: SolveDiagramOptions,
): RouteLabelFeedbackHardTextObstacleEntry[] {
	return textAnnotations
		.filter(isLocalRouteClearanceText)
		.filter((annotation) => !isEdgeConnectedTextAnnotation(edge, annotation))
		.map((annotation) => ({
			box: textObstacleBox(annotation, options),
			metadata: {
				kind: "text",
				ownerId: annotation.ownerId,
				surfaceKind: annotation.surfaceKind,
				...(annotation.surfaceIndex === undefined
					? {}
					: { surfaceIndex: annotation.surfaceIndex }),
			},
		}));
}

function edgeIdsFromRouteTextDiagnostics(
	diagnostics: readonly Diagnostic[],
): string[] {
	return stableStrings(
		diagnostics
			.map((diagnostic) => diagnostic.detail?.edgeId)
			.filter((edgeId): edgeId is string => typeof edgeId === "string"),
	);
}

function scoreRouteLabelFeedbackCandidate(
	edgeId: string,
	edges: readonly CoordinatedEdge[],
	textAnnotations: readonly SolvedTextAnnotation[],
	edgeRoutingDiagnostics: readonly Diagnostic[],
	options: SolveDiagramOptions,
): RouteLabelFeedbackScore {
	const routeTextDiagnostics = routeLabelFeedbackConflicts(
		edges,
		textAnnotations,
		options,
	);
	const edgeRouteTextConflicts = routeTextDiagnostics.filter(
		(diagnostic) => diagnostic.detail?.edgeId === edgeId,
	).length;
	const routeDiagnostics = edgeRoutingDiagnostics.filter(
		(diagnostic) => diagnostic.detail?.edgeId === edgeId,
	);
	const edge = edges.find((candidate) => candidate.id === edgeId);
	return {
		routeTextConflicts: routeTextDiagnostics.length,
		otherRouteTextConflicts:
			routeTextDiagnostics.length - edgeRouteTextConflicts,
		edgeRouteTextConflicts,
		hardRouteDiagnostics: routeDiagnostics.filter(
			isRouteLabelFeedbackHardRouteDiagnostic,
		).length,
		softRouteDiagnostics: routeDiagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.obstacle.unavoidable",
		).length,
		backtrackingDiagnostics: routeDiagnostics.filter(
			(diagnostic) => diagnostic.code === "routing.backtracking_excessive",
		).length,
		routeLength: edge === undefined ? 0 : routePointLength(edge.points),
		bendCount: edge === undefined ? 0 : routeBendCount(edge.points),
	};
}

function compareRouteLabelFeedbackScore(
	left: RouteLabelFeedbackScore,
	right: RouteLabelFeedbackScore,
): number {
	return (
		left.hardRouteDiagnostics - right.hardRouteDiagnostics ||
		left.routeTextConflicts - right.routeTextConflicts ||
		left.otherRouteTextConflicts - right.otherRouteTextConflicts ||
		left.edgeRouteTextConflicts - right.edgeRouteTextConflicts ||
		left.softRouteDiagnostics - right.softRouteDiagnostics ||
		left.backtrackingDiagnostics - right.backtrackingDiagnostics ||
		left.routeLength - right.routeLength ||
		left.bendCount - right.bendCount
	);
}

function isRouteLabelFeedbackHardRouteDiagnostic(
	diagnostic: Diagnostic,
): boolean {
	return (
		diagnostic.code === "routing.evidence.crossing_forbidden" ||
		diagnostic.code === "routing.endpoint-interior.unavoidable" ||
		diagnostic.code === "routing.label-hard-obstacle.unavoidable" ||
		(diagnostic.code === "route_obstacle_fallback" &&
			diagnostic.severity === "error")
	);
}

function routeLabelFeedbackPublicRouteDiagnostics(
	diagnostics: readonly Diagnostic[],
): Diagnostic[] {
	return diagnostics.filter(
		(diagnostic) =>
			diagnostic.code !== "routing.label-hard-obstacle.unavoidable",
	);
}

function replaceRouteDiagnosticsForEdge(
	diagnostics: readonly Diagnostic[],
	edgeId: string,
	replacements: readonly Diagnostic[],
): Diagnostic[] {
	return [
		...diagnostics.filter((diagnostic) => diagnostic.detail?.edgeId !== edgeId),
		...replacements,
	];
}

function routeLabelLoopExhaustedDiagnostic(
	routeTextDiagnostics: readonly Diagnostic[],
	state: RouteLabelFeedbackState,
	maxIterations: number,
	options?: { remediationTransition?: boolean },
): Diagnostic {
	const edgeIds = edgeIdsFromRouteTextDiagnostics(routeTextDiagnostics);
	const ownerIds = stableStrings(
		routeTextDiagnostics
			.map((diagnostic) => diagnostic.detail?.conflictingObjectId)
			.filter((ownerId): ownerId is string => typeof ownerId === "string"),
	);
	const surfaceKinds = stableStrings(
		routeTextDiagnostics
			.map((diagnostic) => diagnostic.detail?.textSurfaceKind)
			.filter(
				(surfaceKind): surfaceKind is string => typeof surfaceKind === "string",
			),
	);
	return {
		severity: "warning",
		code: "routing.route-label-loop.exhausted",
		message: `Route/label feedback loop stopped with ${routeTextDiagnostics.length} route/text clearance conflict(s).`,
		path: ["edges"],
		detail: compactDetail({
			conflictCount: routeTextDiagnostics.length,
			iterations: state.iteration,
			maxIterations,
			acceptedReroutes: state.acceptedReroutes,
			rejectedReroutes: state.rejectedReroutes,
			changedEdgeIds: stableStrings([...state.changedEdgeIds]).join(","),
			edgeIds: edgeIds.join(","),
			ownerIds: ownerIds.join(","),
			textSurfaceKinds: surfaceKinds.join(","),
			suggestedRemedy:
				"Increase route clearance, grow label/node spacing, split the dense view, or reduce label area near routed edges.",
			...(options?.remediationTransition === true
				? {
						remediationTransition: true,
						phase: "remediation-planning",
					}
				: {}),
		}),
	};
}

function routePointLength(points: readonly Point[]): number {
	let length = 0;
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		length += Math.hypot(end.x - start.x, end.y - start.y);
	}
	return length;
}

function routeBendCount(points: readonly Point[]): number {
	let count = 0;
	let previousDirection: "horizontal" | "vertical" | "diagonal" | undefined;
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const direction =
			start.y === end.y
				? "horizontal"
				: start.x === end.x
					? "vertical"
					: "diagonal";
		if (previousDirection !== undefined && previousDirection !== direction) {
			count += 1;
		}
		previousDirection = direction;
	}
	return count;
}

function edgeRouteBounds(edge: CoordinatedEdge): Box {
	const xs = edge.points.map((point) => point.x);
	const ys = edge.points.map((point) => point.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	const maxX = Math.max(...xs);
	const maxY = Math.max(...ys);
	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function isPreRouteTextObstacle(annotation: SolvedTextAnnotation): boolean {
	return isLocalRouteClearanceText(annotation);
}

function isLocalRouteClearanceText(annotation: SolvedTextAnnotation): boolean {
	if (!isRouteClearanceText(annotation)) {
		return false;
	}
	if (annotation.placement === "external-callout-required") {
		return false;
	}
	// Shelf callout bodies live off-diagram; keyed markers stay on the route
	// and must remain clearance obstacles.
	if (
		annotation.placement === "external-callout" &&
		annotation.placementDetail?.role === "callout"
	) {
		return false;
	}
	return true;
}

function externalLabelExecutionMode(
	options: SolveDiagramOptions,
): RemediationPolicyMode {
	return resolveRemediationPolicy(options.remediationPolicy).externalLabels;
}

function edgeLabelRerouteIterations(options: SolveDiagramOptions): number {
	const setting = options.edgeLabelRerouting;
	if (setting === false) {
		return 0;
	}
	const routeKind = options.routeKind ?? "orthogonal";
	if (routeKind !== "orthogonal" && routeKind !== "obstacle-avoiding") {
		return 0;
	}
	if (typeof setting === "object") {
		return Math.max(0, Math.floor(setting.maxIterations ?? 4));
	}
	if (setting === true || routeKind === "obstacle-avoiding") {
		return 4;
	}
	return 0;
}

function textObstacleBox(
	annotation: SolvedTextAnnotation,
	options: SolveDiagramOptions,
): Box {
	if (!usesCompactTextObstacle(annotation, options)) {
		return annotation.box;
	}
	const horizontalInset = Math.min(
		Math.max(annotation.paddings.left, annotation.paddings.right, 2),
		annotation.box.width / 3,
	);
	const verticalInset = Math.min(
		Math.max(annotation.paddings.top, annotation.paddings.bottom, 2),
		annotation.box.height / 3,
	);
	return {
		x: annotation.box.x + horizontalInset,
		y: annotation.box.y + verticalInset,
		width: Math.max(0, annotation.box.width - horizontalInset * 2),
		height: Math.max(0, annotation.box.height - verticalInset * 2),
	};
}

function usesCompactTextObstacle(
	annotation: SolvedTextAnnotation,
	options: SolveDiagramOptions,
): boolean {
	if (options.compactTextObstacles === true) {
		return true;
	}
	if (options.compactTextObstacles === "labels-only") {
		return (
			annotation.surfaceKind === "node-label" ||
			annotation.surfaceKind === "edge-label" ||
			annotation.surfaceKind === "port-label" ||
			annotation.surfaceKind === "swimlane-label"
		);
	}
	return false;
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

function routeIntersectsTextBox(
	points: readonly Point[],
	box: Box,
	tolerance = 0,
): boolean {
	const testBox = insetBox(box, Math.max(0, tolerance));
	if (testBox.width <= 0 || testBox.height <= 0) {
		return false;
	}
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		if (segmentIntersectsBox(start, end, testBox)) {
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

interface EdgeLabelAnchorResult {
	center: Point;
	candidateCount: number;
	localConflictCount: number;
	routeConflictCount: number;
	nodeOverlapCount: number;
	labelOverlapCount: number;
	externalized: boolean;
}

function edgeLabelAnchor(
	edge: CoordinatedEdge,
	layout: LabelLayout,
	edges: readonly CoordinatedEdge[],
	obstacleBoxes: readonly Box[],
	placedLabelBoxes: readonly Box[],
	baseOffset = 10,
	options: SolveDiagramOptions = {},
): EdgeLabelAnchorResult {
	const placement = labelPlacementOnPolyline(edge.points, baseOffset);
	if (placement === undefined) {
		return {
			center: { x: 0, y: 0 },
			candidateCount: 0,
			localConflictCount: 0,
			routeConflictCount: 0,
			nodeOverlapCount: 0,
			labelOverlapCount: 0,
			externalized: false,
		};
	}

	let bestFallback:
		| {
				candidate: Point;
				score: number;
				routeConflictCount: number;
				nodeOverlapCount: number;
				labelOverlapCount: number;
		  }
		| undefined;
	const candidates = edgeLabelAnchorCandidates(
		edge.points,
		placement,
		layout,
		baseOffset,
	);
	for (const candidate of candidates) {
		const labelBox = {
			x: candidate.x - layout.box.width / 2,
			y: candidate.y - layout.box.height / 2,
			width: layout.box.width,
			height: layout.box.height,
		};
		const crossesOwnRoute = routeIntersectsTextBox(edge.points, labelBox);
		const otherRouteCrossings = edges.filter(
			(other) =>
				other.id !== edge.id && routeIntersectsTextBox(other.points, labelBox),
		).length;
		const nodeOverlaps = obstacleBoxes.filter((box) =>
			intersectsAabb(labelBox, box),
		).length;
		const placedLabelOverlaps = placedLabelBoxes.filter((box) =>
			intersectsAabb(labelBox, box),
		).length;
		if (
			!crossesOwnRoute &&
			otherRouteCrossings === 0 &&
			nodeOverlaps === 0 &&
			placedLabelOverlaps === 0
		) {
			const externalPolicy = edgeLabelExternalizationPolicy(options);
			return {
				center: candidate,
				candidateCount: candidates.length,
				localConflictCount: 0,
				routeConflictCount: 0,
				nodeOverlapCount: 0,
				labelOverlapCount: 0,
				externalized: externalPolicy === "force",
			};
		}
		const distanceFromDefault = Math.hypot(
			candidate.x - placement.x,
			candidate.y - placement.y,
		);
		const score =
			nodeOverlaps * 1_000_000 +
			placedLabelOverlaps * 500_000 +
			otherRouteCrossings * 100_000 +
			(crossesOwnRoute ? 10_000 : 0) +
			distanceFromDefault;
		if (bestFallback === undefined || score < bestFallback.score) {
			bestFallback = {
				candidate,
				score,
				routeConflictCount: (crossesOwnRoute ? 1 : 0) + otherRouteCrossings,
				nodeOverlapCount: nodeOverlaps,
				labelOverlapCount: placedLabelOverlaps,
			};
		}
	}

	const fallback = bestFallback ?? {
		candidate: placement,
		score: 0,
		routeConflictCount: 0,
		nodeOverlapCount: 0,
		labelOverlapCount: 0,
	};
	const localConflictCount =
		fallback.routeConflictCount +
		fallback.nodeOverlapCount +
		fallback.labelOverlapCount;
	const externalPolicy = edgeLabelExternalizationPolicy(options);
	return {
		center: fallback.candidate,
		candidateCount: candidates.length,
		localConflictCount,
		routeConflictCount: fallback.routeConflictCount,
		nodeOverlapCount: fallback.nodeOverlapCount,
		labelOverlapCount: fallback.labelOverlapCount,
		externalized:
			externalPolicy === "force" ||
			(localConflictCount > 0 && externalPolicy === "congested"),
	};
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
		for (const ratio of [0.2, 0.25, 0.35, 0.65, 0.75, 0.8]) {
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

function edgeLabelExternalizationPolicy(
	options: SolveDiagramOptions,
): "off" | "congested" | "force" {
	const setting = options.externalLabels;
	const remediationMode = externalLabelExecutionMode(options);
	if (
		setting === false ||
		(typeof setting === "object" && setting.edgeLabels === false)
	) {
		return "off";
	}
	if (setting === true) {
		return "force";
	}
	if (typeof setting === "object") {
		return "force";
	}
	if (remediationMode === "auto") {
		return "congested";
	}
	return isStrictDeliverability(options) ? "congested" : "off";
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
