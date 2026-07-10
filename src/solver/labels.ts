/** Extracted from solve.ts — behavior-preserving #77 split. */

import {
	type computeShapeGeometry,
	intersectsAabb,
	unionBoxes,
} from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	ExternalLabelCallout,
	RemediationPolicyMode,
} from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedNode,
	NormalizedEdge,
	Swimlane,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type {
	LabelLayout,
	SolvedTextAnnotation,
	TextSurfaceKind,
} from "../ir/label-layout.js";
import { fitLabel } from "../labels/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import type { TextMeasurer } from "../text/types.js";
import {
	type CjkTypography,
	typographyForLabel,
	typographyTextStyle,
} from "./cjk-typography.js";
import {
	boxCenter,
	boxJson,
	compactDetail,
	compartmentRows,
	EDGE_LABEL_CLEARANCE,
	EXTERNAL_LABEL_SHELF_GAP,
	EXTERNAL_LABEL_SHELF_ROW_GAP,
	isEdgeConnectedTextAnnotation,
	labelOffset,
	numberDetail,
	stableStrings,
} from "./helpers.js";
import {
	resolveRemediationPolicy,
	type SolveDiagramOptions,
} from "./options.js";
import { isStrictDeliverability } from "./page-policy.js";
import {
	buildAnchorCenteredTextAnnotation,
	buildCenteredTextAnnotation,
	normalizeOutputFontFamily,
	portLabelBox,
} from "./ports.js";
import type {
	RouteLabelFeedbackHardTextObstacleEntry,
	RouteLabelFeedbackState,
} from "./route-edges.js";
import {
	edgeIdsFromRouteTextDiagnostics,
	edgeRouteBounds,
	isLocalRouteClearanceText,
	labelPlacementOnPolyline,
	labelSegmentOnPolyline,
	reportRouteTextClearance,
	routeIntersectsTextBox,
	textObstacleBox,
} from "./route-edges.js";

export {
	isEdgeConnectedTextAnnotation,
	labelOffset,
	recenterNodeLabelLayout,
} from "./helpers.js";
export {
	buildCenteredTextAnnotation,
	normalizeOutputFontFamily,
} from "./ports.js";

export interface BuiltExternalLabelCallout {
	callout: ExternalLabelCallout;
	source: SolvedTextAnnotation;
	keyAnnotation: SolvedTextAnnotation;
	calloutAnnotation: SolvedTextAnnotation;
}

export function coordinateBaseTextAnnotations(input: {
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

export function coordinateEdgeTextAnnotations(
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
export function estimateEdgeLabelAnnotations(
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

export function edgeLabelEstimatePaths(
	source: Point,
	target: Point,
): Point[][] {
	return [
		[source, target],
		[source, { x: target.x, y: source.y }, target],
		[source, { x: source.x, y: target.y }, target],
	];
}

export function coordinateFrameTextAnnotation(
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

export function buildTextAnnotation(input: {
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

export function buildExternalLabelCallouts(
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

export function applyExternalLabelCallouts(
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

export function externalLabelKey(index: number): string {
	return `E${index + 1}`;
}

export function buildExternalLabelKeyAnnotation(
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

export function buildExternalLabelCalloutAnnotation(
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

export function externalLabelPlacementDetail(
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

export function reportTextAnnotationCollisions(
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

export function reportExternalizedLabelDiagnostics(
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

export function reportLabelCongestionDiagnostics(
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

export function routeLabelFeedbackTextAnnotations(
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

export function routeLabelFeedbackConflicts(
	edges: readonly CoordinatedEdge[],
	textAnnotations: readonly SolvedTextAnnotation[],
	options: SolveDiagramOptions,
): Diagnostic[] {
	return reportRouteTextClearance(edges, textAnnotations, options);
}

export function routeLabelFeedbackHardTextObstacles(
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

export function routeLabelFeedbackPublicRouteDiagnostics(
	diagnostics: readonly Diagnostic[],
): Diagnostic[] {
	return diagnostics.filter(
		(diagnostic) =>
			diagnostic.code !== "routing.label-hard-obstacle.unavoidable",
	);
}

export function routeLabelLoopExhaustedDiagnostic(
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

export function externalLabelExecutionMode(
	options: SolveDiagramOptions,
): RemediationPolicyMode {
	return resolveRemediationPolicy(options.remediationPolicy).externalLabels;
}

export function isExternallyPlacedText(surfaceKind: TextSurfaceKind): boolean {
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

export function fallbackLabelLayout(text: string): LabelLayout {
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

export interface EdgeLabelAnchorResult {
	center: Point;
	candidateCount: number;
	localConflictCount: number;
	routeConflictCount: number;
	nodeOverlapCount: number;
	labelOverlapCount: number;
	externalized: boolean;
}

export function edgeLabelAnchor(
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

export function edgeLabelAnchorCandidates(
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

export function edgeLabelExternalizationPolicy(
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

export function labelPlacementAtRatio(
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
