/**
 * Solver orchestrator. Domain logic lives in sibling modules (#77).
 */
import { applyLayoutConstraints } from "../constraints/index.js";
import {
	computeShapeGeometry,
	expandBox,
	unionBoxes,
} from "../geometry/index.js";
import {
	DELIVERABILITY_DIAGNOSTIC_CODES,
	type Diagnostic,
} from "../ir/diagnostics.js";
import type {
	CoordinatedDiagram,
	ExternalLabelCallout,
	NormalizedDiagram,
	PagePolicy,
	RemediationPlan,
	RoutingRailAllocation,
} from "../ir/diagram.js";
import type { Box } from "../ir/geometry.js";
import { runRecursiveContainerLayout } from "../layout/recursive.js";
import type { RouteHardObstacleMetadata } from "../routing/index.js";
import {
	createCjkTypographyOptions,
	enhanceEdgeCjkTypography,
	enhanceGroupCjkTypography,
	enhanceNodeCjkTypography,
	enhanceSwimlaneCjkTypography,
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
import type { SolveDiagramOptions } from "./options.js";
import {
	classifyPagePolicyFromBoxes,
	isStrictDeliverability,
	metadataPagePolicy,
	resolvePagePolicy,
	shouldAutoClassifyPagePolicy,
} from "./page-policy.js";
import { LayoutPipeline } from "./pipeline/pipeline.js";
import { scoreLayoutQuality } from "./pipeline/quality.js";
import type { LayoutState } from "./pipeline/types.js";

export type {
	InitialLayoutMode,
	PortShiftingOptions,
	SolveDiagramOptions,
} from "./options.js";
export { resolvePagePolicy } from "./page-policy.js";

import {
	coordinateFrame,
	coordinateGroups,
	coordinateNodes,
} from "./coordinate.js";
import {
	cloneBoxMap,
	cloneNormalizedNodeForSolver,
	DEFAULT_MAX_REMEDIATION_ITERATIONS,
	isTopToBottomReadingDirection,
	REMEDIATION_ENTRY_DIAGNOSTIC_CODES,
	removeResolvedOverlapDiagnostics,
	reportPageOverflow,
	reserveSideGutters,
	stableByConstraintId,
	stableUniqueById,
} from "./helpers.js";
import {
	edgeBounds,
	prefitNodeLabelSize,
	reportPostGrowthOverlaps,
	runInitialLayout,
	wrapHorizontalStackIfNeeded,
	wrapVerticalStackIfNeeded,
} from "./initial-layout.js";
import {
	applyExternalLabelCallouts,
	buildExternalLabelCallouts,
	coordinateBaseTextAnnotations,
	coordinateEdgeTextAnnotations,
	coordinateFrameTextAnnotation,
	edgeLabelExternalizationPolicy,
	estimateEdgeLabelAnnotations,
	externalLabelExecutionMode,
	reportExternalizedLabelDiagnostics,
	reportLabelCongestionDiagnostics,
	reportTextAnnotationCollisions,
	routeLabelFeedbackConflicts,
	routeLabelFeedbackHardTextObstacles,
	routeLabelFeedbackPublicRouteDiagnostics,
	routeLabelFeedbackTextAnnotations,
	routeLabelLoopExhaustedDiagnostic,
} from "./labels.js";
import {
	buildRoutingAllocationReport,
	expandNodeBoxesForAnchorCapacity,
	expandNodeBoxesForPorts,
	portLabelBox,
} from "./ports.js";
import type { RemediationPassState } from "./remediation.js";
import {
	buildDeliverabilityReport,
	deliverabilityUnsatisfiableDiagnostic,
	remediationDiagnosticKey,
	runRemediationPass,
} from "./remediation.js";
import type { RouteLabelFeedbackState } from "./route-edges.js";
import {
	compareRouteLabelFeedbackScore,
	coordinateEdges,
	edgeIdsFromRouteTextDiagnostics,
	edgeLabelRerouteIterations,
	isPreRouteTextObstacle,
	replaceRouteDiagnosticsForEdge,
	reportRouteTextClearance,
	resourceFlowLabelHardObstacles,
	scoreRouteLabelFeedbackCandidate,
} from "./route-edges.js";
import type { SwimlaneContractLayout } from "./swimlane-contracts.js";
import {
	applySwimlaneLayoutContracts,
	coordinateSwimlanes,
	hasFixedSwimlaneGeometry,
	reserveLaneCorridors,
} from "./swimlane-contracts.js";

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
