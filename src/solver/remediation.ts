/** Extracted from solve.ts — behavior-preserving #77 split. */

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
	CoordinatedTableBlock,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
} from "../ir/elements.js";
import type { Box, Insets } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import type { RouteHardObstacleMetadata } from "../routing/index.js";
import {
	coordinateFrame,
	coordinateGroups,
	coordinateNodes,
} from "./coordinate.js";
import {
	measureEvidenceTextBlocks,
	placeEvidenceBlocks,
	refreshTableColumnXOffsets,
	reportEvidenceBlockOverlaps,
} from "./evidence.js";
import {
	cloneBoxMap,
	compactDetail,
	flattenDiagnosticDetailCsvStrings,
	flattenDiagnosticDetailStrings,
	recenterNodeLabelLayout,
	reserveSideGutters,
	sameBox,
	stableStrings,
} from "./helpers.js";
import {
	capacityFromDiagnostics,
	edgeBounds,
	growthDeltasFromDiagnostics,
	reportPostGrowthOverlaps,
} from "./initial-layout.js";
import {
	applyExternalLabelCallouts,
	buildExternalLabelCallouts,
	coordinateBaseTextAnnotations,
	coordinateEdgeTextAnnotations,
	coordinateFrameTextAnnotation,
	edgeLabelExternalizationPolicy,
	estimateEdgeLabelAnnotations,
	reportLabelCongestionDiagnostics,
	routeLabelFeedbackTextAnnotations,
} from "./labels.js";
import {
	resolveRemediationPolicy,
	type SolveDiagramOptions,
} from "./options.js";
import { isStrictDeliverability } from "./page-policy.js";
import { expandNodeBoxesForAnchorCapacity, portLabelBox } from "./ports.js";
import type { NodeObstacleEntry } from "./route-edges.js";
import {
	coordinateEdges,
	isPreRouteTextObstacle,
	reportRouteTextClearance,
	resourceFlowLabelHardObstacles,
} from "./route-edges.js";
import type { SwimlaneContractLayout } from "./swimlane-contracts.js";
import {
	coordinateSwimlanes,
	reserveLaneCorridors,
} from "./swimlane-contracts.js";

export { resolveRemediationPolicy } from "./options.js";

export function buildDeliverabilityReport(
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

export function buildRemediationPlans(
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

export function omitRemediationPlanId(
	plan: RemediationPlan,
): Omit<RemediationPlan, "id"> {
	const { id: _id, ...rest } = plan;
	return rest;
}

export interface RemediationPassState {
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

export interface RemediationPassContext {
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
export function runRemediationPass(
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

export function hasTerminalRemediationPlan(
	state: RemediationPassState,
	type: RemediationPlanType,
): boolean {
	return state.appliedRemediationPlans.some(
		(plan) =>
			plan.type === type &&
			(plan.status === "applied" || plan.status === "blocked"),
	);
}

export function recordAppliedRemediationPlan(
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

export function blockingRemediationDiagnostics(
	diagnostics: readonly Diagnostic[],
): Diagnostic[] {
	return diagnostics.filter(
		(diagnostic) =>
			DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code) &&
			diagnostic.code !== "routing.deliverability.unsatisfiable",
	);
}

export function remediationDiagnosticFingerprint(
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

export function applyGrowFixedGeometryRemediation(
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
export function applyRouteRailsRemediation(
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
		preSnapshot.railSignature !== postSnapshot.railSignature ||
		preSnapshot.routeSignature !== postSnapshot.routeSignature;
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

export function applyExternalLabelRemediation(
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

export function railRemediationSnapshot(state: RemediationPassState): {
	railSignature: string;
	routeSignature: string;
	conflictCount: number;
} {
	const rails = [...state.acceptedRailAllocations.values()]
		.map(
			(rail) =>
				`${rail.edgeId}:${rail.side}:${rail.index}:${Math.round(rail.coordinate)}`,
		)
		.sort((left, right) => left.localeCompare(right));
	const routes = state.coordinatedEdges
		.map((edge) => {
			const points = (edge.points ?? [])
				.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`)
				.join(">");
			return `${edge.id}:${points}`;
		})
		.sort((left, right) => left.localeCompare(right));
	const conflictCount = state.diagnostics.filter((diagnostic) =>
		[
			"routing.text-clearance.unresolved",
			"routing.obstacle.unavoidable",
			"routing.rail-capacity.exceeded",
			"routing.label-congestion.unresolved",
			"route_obstacle_fallback",
			"routing.endpoint-interior.unavoidable",
			"routing.evidence.crossing_forbidden",
		].includes(diagnostic.code),
	).length;
	return {
		railSignature: rails.join("|"),
		routeSignature: routes.join("|"),
		conflictCount,
	};
}

export function rebuildRemediationGeometry(
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

export function rerouteRemediationEdges(
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

export function refreshRemediationDiagnostics(
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

export function stripDiagnosticsByCodes(
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

export function remediationDiagnosticKey(diagnostic: Diagnostic): string {
	return `${diagnostic.code}|${diagnostic.message}|${String(diagnostic.detail?.edgeId ?? "")}|${String(diagnostic.detail?.nodeId ?? "")}`;
}

export function remediationPlanEnabled(
	type: RemediationPlanType,
	policy: Required<RemediationPolicy>,
): boolean {
	return remediationPlanPolicyMode(type, policy) !== "off";
}

export function remediationPlanPolicyMode(
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

export function buildRemediationPlan(
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

export function buildAppliedExternalLabelRemediationPlan(
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

export function remediationPlanReason(
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

export function remediationPlanDetail(
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

export function remediationPlanTypesForDiagnostic(
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

export function deliverabilityUnsatisfiableDiagnostic(
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

export function remediationTypeForDiagnostic(diagnostic: Diagnostic): string {
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
