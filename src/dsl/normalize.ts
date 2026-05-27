import type { Constraint } from "../ir/constraints.js";
import type { NormalizedDiagram } from "../ir/diagram.js";
import type {
	Label,
	NodeCompartments,
	NodePort,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
	Swimlane,
	VisualStyle,
} from "../ir/elements.js";
import type { Insets, Point, Size } from "../ir/geometry.js";
import { fitLabel } from "../labels/index.js";
import { createDefaultTextMeasurer, type TextMeasurer } from "../text/index.js";
import { sortDslDiagnostics } from "./diagnostics.js";
import type { DiagramDsl } from "./schema.js";
import type { DslDiagnostic, NormalizeDiagramDslResult } from "./types.js";

const DEFAULT_NODE_PADDING: Insets = {
	top: 12,
	right: 16,
	bottom: 12,
	left: 16,
};
const DEFAULT_NODE_MIN_SIZE: Size = { width: 80, height: 40 };
const DEFAULT_GROUP_PADDING: Insets = {
	top: 16,
	right: 16,
	bottom: 16,
	left: 16,
};
const DEFAULT_LABEL_MAX_WIDTH = 160;
const DEFAULT_FONT = { fontFamily: "Arial", fontSize: 14, lineHeight: 18 };

export interface NormalizeDiagramDslOptions {
	id?: string;
	textMeasurer?: TextMeasurer;
}

export function normalizeDiagramDsl(
	dslValue: unknown,
	options: NormalizeDiagramDslOptions = {},
): NormalizeDiagramDslResult {
	const dsl = dslValue as DiagramDsl;
	const diagnostics = validateReferences(dsl);
	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return {
			diagnostics: sortDslDiagnostics(diagnostics),
			...outputResult(dsl),
		};
	}

	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
	const routeKind = dsl.routing?.kind ?? "orthogonal";
	const portShifting = normalizePortShifting(dsl.routing?.portShifting);
	const diagram: NormalizedDiagram = {
		id: options.id ?? dsl.id ?? "diagram",
		...(dsl.title === undefined ? {} : { title: dsl.title }),
		direction: dsl.layout?.direction ?? dsl.direction ?? "TB",
		nodes: normalizeNodes(dsl, measurer),
		edges: normalizeEdges(dsl),
		groups: normalizeGroups(dsl, measurer),
		swimlanes: normalizeSwimlanes(dsl),
		constraints: normalizeConstraints(dsl),
		diagnostics: [],
		...(dsl.frame === undefined ? {} : { frame: normalizeFrame(dsl.frame) }),
		metadata: {
			routeKind,
			...(portShifting === undefined ? {} : { portShifting }),
		},
	};

	return {
		diagram,
		diagnostics: [],
		...outputResult(dsl),
	};
}

function normalizePortShifting(
	portShifting: NonNullable<DiagramDsl["routing"]>["portShifting"] | undefined,
):
	| {
			enabled?: boolean;
			spacing?: number;
	  }
	| undefined {
	if (portShifting === undefined) {
		return undefined;
	}
	return {
		...(portShifting.enabled === undefined
			? {}
			: { enabled: portShifting.enabled }),
		...(portShifting.spacing === undefined
			? {}
			: { spacing: portShifting.spacing }),
	};
}

function outputResult(
	dsl: DiagramDsl,
): Pick<NormalizeDiagramDslResult, "output"> {
	return dsl.output?.format === undefined
		? {}
		: { output: { format: dsl.output.format } };
}

function normalizeNodes(
	dsl: DiagramDsl,
	measurer: TextMeasurer,
): NormalizedNode[] {
	return Object.keys(dsl.nodes)
		.sort()
		.map((id) => {
			const node = dsl.nodes[id];
			const label = toLabel(node?.label);
			const labelLayout =
				label === undefined ? undefined : fitDslLabel(label, measurer);
			const fittedSize = labelLayout?.fittedSize;
			const nodeCompartments =
				node?.compartments === undefined
					? undefined
					: compartments(node.compartments);
			const compartmentWidth =
				nodeCompartments === undefined
					? 0
					: compartmentNaturalWidth(id, label, nodeCompartments, measurer);

			return {
				id,
				...(label === undefined ? {} : { label }),
				shape: node?.shape ?? "rectangle",
				...(node?.position === undefined
					? {}
					: { position: point(node.position) }),
				...(node?.style === undefined ? {} : { style: style(node.style) }),
				...(node?.ports === undefined
					? {}
					: { ports: normalizePorts(node.ports) }),
				...(nodeCompartments === undefined
					? {}
					: { compartments: nodeCompartments }),
				size: {
					width: Math.max(
						DEFAULT_NODE_MIN_SIZE.width,
						fittedSize?.width ?? 0,
						compartmentWidth,
					),
					height: Math.max(
						nodeCompartments === undefined
							? DEFAULT_NODE_MIN_SIZE.height
							: compartmentHeight(nodeCompartments),
						fittedSize?.height ?? 0,
					),
				},
				padding: { ...DEFAULT_NODE_PADDING },
				...(labelLayout === undefined ? {} : { labelLayout }),
			};
		});
}

function compartmentHeight(value: NodeCompartments): number {
	const rowCount =
		(value.stereotype === undefined ? 0 : 1) +
		1 +
		(value.properties?.length ?? 0) +
		(value.constraints?.length ?? 0);
	const rowHeight = 16;
	const verticalPadding = 20;
	return Math.max(
		DEFAULT_NODE_MIN_SIZE.height,
		rowCount * rowHeight + verticalPadding,
	);
}

function compartmentNaturalWidth(
	id: string,
	label: Label | undefined,
	value: NodeCompartments,
	measurer: TextMeasurer,
): number {
	const rows = compartmentRows(id, label, value);
	const maxRowWidth = rows.reduce((width, row) => {
		const prepared = measurer.prepare(row, DEFAULT_FONT);
		return Math.max(width, measurer.naturalWidth(prepared));
	}, 0);
	return Math.ceil(
		maxRowWidth + DEFAULT_NODE_PADDING.left + DEFAULT_NODE_PADDING.right,
	);
}

function compartmentRows(
	id: string,
	label: Label | undefined,
	value: NodeCompartments,
): string[] {
	return [
		...(value.stereotype === undefined ? [] : [value.stereotype]),
		value.name ?? label?.text ?? id,
		...(value.properties ?? []),
		...(value.constraints ?? []),
	];
}

function normalizeEdges(dsl: DiagramDsl): NormalizedEdge[] {
	const counts = new Map<string, number>();

	return (dsl.edges ?? []).map((edge) => {
		const source = typeof edge === "string" ? undefined : edge.source;
		const target = typeof edge === "string" ? undefined : edge.target;
		const sourceId =
			typeof edge === "string"
				? ""
				: (edge.sourceId ?? endpointNodeId(source) ?? "");
		const targetId =
			typeof edge === "string"
				? ""
				: (edge.targetId ?? endpointNodeId(target) ?? "");
		const sourceEndpoint =
			typeof edge === "string"
				? { nodeId: sourceId }
				: endpoint(source, edge.sourceId);
		const targetEndpoint =
			typeof edge === "string"
				? { nodeId: targetId }
				: endpoint(target, edge.targetId);
		const baseId = `${sourceId}-${targetId}`;
		const count = counts.get(baseId) ?? 0;
		counts.set(baseId, count + 1);
		const id =
			typeof edge === "string"
				? baseId
				: (edge.id ?? (count === 0 ? baseId : `${baseId}-${count + 1}`));
		const label = typeof edge === "string" ? undefined : toLabel(edge.label);

		return {
			id,
			source: sourceEndpoint,
			target: targetEndpoint,
			...(label === undefined ? {} : { label }),
			...(typeof edge === "string" || edge.style === undefined
				? {}
				: { style: edge.style }),
			...(typeof edge === "string" || edge.arrowhead === undefined
				? {}
				: { arrowhead: edge.arrowhead }),
		};
	});
}

function normalizePorts(
	ports: NonNullable<DiagramDsl["nodes"][string]>["ports"],
): NodePort[] {
	return Object.keys(ports ?? {})
		.sort()
		.map((id) => {
			const port = ports?.[id];
			const label = toLabel(port?.label);
			return {
				id,
				...(label === undefined ? {} : { label }),
				side: port?.side ?? "right",
				kind: port?.kind ?? "proxy",
				...(port?.order === undefined ? {} : { order: port.order }),
				...(port?.style === undefined ? {} : { style: style(port.style) }),
			};
		});
}

function endpoint(
	value: string | { node: string; port?: string | undefined } | undefined,
	nodeIdOverride?: string | undefined,
): NormalizedEdge["source"] {
	if (nodeIdOverride !== undefined) {
		return {
			nodeId: nodeIdOverride,
			...(typeof value === "object" &&
			value.node === nodeIdOverride &&
			value.port !== undefined
				? { portId: value.port }
				: {}),
		};
	}
	if (value === undefined) {
		return { nodeId: "" };
	}
	if (typeof value === "string") {
		return { nodeId: value };
	}
	return {
		nodeId: value.node,
		...(value.port === undefined ? {} : { portId: value.port }),
	};
}

function style(value: {
	fill?: string | undefined;
	stroke?: string | undefined;
}): VisualStyle {
	return {
		...(value.fill === undefined ? {} : { fill: value.fill }),
		...(value.stroke === undefined ? {} : { stroke: value.stroke }),
	};
}

function compartments(value: {
	stereotype?: string | undefined;
	name?: string | undefined;
	properties?: Array<Record<string, string> | string> | undefined;
	constraints?: string[] | undefined;
}): NodeCompartments {
	return {
		...(value.stereotype === undefined ? {} : { stereotype: value.stereotype }),
		...(value.name === undefined ? {} : { name: value.name }),
		...(value.properties === undefined
			? {}
			: { properties: value.properties.map(formatCompartmentEntry) }),
		...(value.constraints === undefined
			? {}
			: { constraints: [...value.constraints] }),
	};
}

function normalizeFrame(frame: NonNullable<DiagramDsl["frame"]>) {
	return {
		kind: frame.kind,
		...(frame.context === undefined ? {} : { context: frame.context }),
		...(frame.name === undefined ? {} : { name: frame.name }),
		titleTab: frame.titleTab,
		...(frame.style === undefined ? {} : { style: style(frame.style) }),
	};
}

function formatCompartmentEntry(
	value: Record<string, string> | string,
): string {
	if (typeof value === "string") {
		return value;
	}
	const [entry] = Object.entries(value);
	if (entry === undefined) {
		return "";
	}
	return `${entry[0]}: ${entry[1]}`;
}

function normalizeSwimlanes(dsl: DiagramDsl): Swimlane[] {
	return Object.keys(dsl.swimlanes ?? {}).map((id) => {
		const swimlane = dsl.swimlanes?.[id];
		const label = toLabel(swimlane?.label);
		return {
			id,
			...(label === undefined ? {} : { label }),
			orientation: swimlane?.orientation ?? "vertical",
			layout: swimlane?.layout ?? "overlay",
			...(swimlane?.headerHeight === undefined
				? {}
				: { headerHeight: swimlane.headerHeight }),
			...(swimlane?.padding === undefined ? {} : { padding: swimlane.padding }),
			lanes: Object.keys(swimlane?.lanes ?? {}).map((laneId) => {
				const lane = swimlane?.lanes[laneId];
				const laneLabel = toLabel(lane?.label);
				return {
					id: laneId,
					...(laneLabel === undefined ? {} : { label: laneLabel }),
					children: [...(lane?.children ?? [])],
				};
			}),
		};
	});
}

function normalizeGroups(
	dsl: DiagramDsl,
	measurer: TextMeasurer,
): NormalizedGroup[] {
	return Object.keys(dsl.groups ?? {})
		.sort()
		.map((id) => {
			const group = dsl.groups?.[id];
			const label = toLabel(group?.label);
			const labelLayout =
				label === undefined ? undefined : fitDslLabel(label, measurer);

			return {
				id,
				...(label === undefined ? {} : { label }),
				nodeIds: [...(group?.nodes ?? [])],
				groupIds: [...(group?.groups ?? [])],
				padding: group?.padding ?? { ...DEFAULT_GROUP_PADDING },
				...(labelLayout === undefined ? {} : { labelLayout }),
			};
		});
}

function normalizeConstraints(dsl: DiagramDsl): Constraint[] {
	const constraints: Constraint[] = [];

	for (const constraint of dsl.constraints ?? []) {
		switch (constraint.kind) {
			case "exact-position":
				constraints.push({
					kind: "exact-position",
					targetId: constraint.targetId ?? constraint.target ?? "",
					position: point(constraint.position),
				});
				break;
			case "relative-position":
				constraints.push({
					kind: "relative-position",
					sourceId: constraint.sourceId ?? constraint.source ?? "",
					referenceId: constraint.referenceId ?? constraint.reference ?? "",
					relation: constraint.relation,
					...(constraint.offset === undefined
						? {}
						: { offset: point(constraint.offset) }),
				});
				break;
			case "align":
				constraints.push({
					kind: "align",
					axis: constraint.axis,
					targetIds: [...(constraint.targetIds ?? constraint.targets ?? [])],
				});
				break;
			case "distribute":
				constraints.push({
					kind: "distribute",
					axis: constraint.axis,
					targetIds: [...(constraint.targetIds ?? constraint.targets ?? [])],
					...(constraint.spacing === undefined
						? {}
						: { spacing: constraint.spacing }),
				});
				break;
			case "containment":
				constraints.push({
					kind: "containment",
					containerId: constraint.containerId ?? constraint.container ?? "",
					childIds: [...(constraint.childIds ?? constraint.children ?? [])],
					...(constraint.padding === undefined
						? {}
						: { padding: constraint.padding }),
				});
				break;
		}
	}

	return constraints;
}

function validateReferences(dsl: DiagramDsl): DslDiagnostic[] {
	const diagnostics: DslDiagnostic[] = [];
	const nodeIds = new Set(Object.keys(dsl.nodes));
	const groupIds = new Set(Object.keys(dsl.groups ?? {}));

	(dsl.edges ?? []).forEach((edge, index) => {
		if (typeof edge === "string") {
			return;
		}
		const sourceId = edge.sourceId ?? endpointNodeId(edge.source);
		const targetId = edge.targetId ?? endpointNodeId(edge.target);
		const sourceEndpoint = endpoint(edge.source, edge.sourceId);
		const targetEndpoint = endpoint(edge.target, edge.targetId);
		if (sourceId !== undefined && !nodeIds.has(sourceId)) {
			diagnostics.push(referenceMissing(["edges", index, "source"], sourceId));
		}
		if (targetId !== undefined && !nodeIds.has(targetId)) {
			diagnostics.push(referenceMissing(["edges", index, "target"], targetId));
		}
		validateEndpointPort(
			dsl,
			sourceEndpoint,
			["edges", index, "source"],
			diagnostics,
		);
		validateEndpointPort(
			dsl,
			targetEndpoint,
			["edges", index, "target"],
			diagnostics,
		);
	});

	for (const [groupId, group] of Object.entries(dsl.groups ?? {})) {
		(group.nodes ?? []).forEach((nodeId, index) => {
			if (!nodeIds.has(nodeId)) {
				diagnostics.push(
					referenceMissing(["groups", groupId, "nodes", index], nodeId),
				);
			}
		});
		(group.groups ?? []).forEach((childGroupId, index) => {
			if (!groupIds.has(childGroupId)) {
				diagnostics.push(
					referenceMissing(["groups", groupId, "groups", index], childGroupId),
				);
			}
		});
	}

	for (const [swimlaneId, swimlane] of Object.entries(dsl.swimlanes ?? {})) {
		for (const [laneId, lane] of Object.entries(swimlane.lanes)) {
			(lane.children ?? []).forEach((child, childIndex) => {
				if (!nodeIds.has(child)) {
					diagnostics.push(
						referenceMissing(
							[
								"swimlanes",
								swimlaneId,
								"lanes",
								laneId,
								"children",
								childIndex,
							],
							child,
						),
					);
				}
			});
		}
	}

	(dsl.constraints ?? []).forEach((constraint, index) => {
		switch (constraint.kind) {
			case "exact-position": {
				const target = constraint.targetId ?? constraint.target;
				if (
					target !== undefined &&
					!hasNodeOrGroup(target, nodeIds, groupIds)
				) {
					diagnostics.push(
						referenceMissing(["constraints", index, "target"], target),
					);
				}
				break;
			}
			case "relative-position": {
				const source = constraint.sourceId ?? constraint.source;
				const reference = constraint.referenceId ?? constraint.reference;
				if (
					source !== undefined &&
					!hasNodeOrGroup(source, nodeIds, groupIds)
				) {
					diagnostics.push(
						referenceMissing(["constraints", index, "source"], source),
					);
				}
				if (
					reference !== undefined &&
					!hasNodeOrGroup(reference, nodeIds, groupIds)
				) {
					diagnostics.push(
						referenceMissing(["constraints", index, "reference"], reference),
					);
				}
				break;
			}
			case "align":
			case "distribute":
				(constraint.targetIds ?? constraint.targets ?? []).forEach(
					(target, targetIndex) => {
						if (!hasNodeOrGroup(target, nodeIds, groupIds)) {
							diagnostics.push(
								referenceMissing(
									["constraints", index, "targets", targetIndex],
									target,
								),
							);
						}
					},
				);
				break;
			case "containment": {
				const container = constraint.containerId ?? constraint.container;
				if (container !== undefined) {
					if (!nodeIds.has(container)) {
						diagnostics.push(
							referenceMissing(["constraints", index, "container"], container),
						);
					}
				}
				(constraint.childIds ?? constraint.children ?? []).forEach(
					(child, childIndex) => {
						if (!hasNodeOrGroup(child, nodeIds, groupIds)) {
							diagnostics.push(
								referenceMissing(
									["constraints", index, "children", childIndex],
									child,
								),
							);
						}
					},
				);
				break;
			}
		}
	});

	return sortDslDiagnostics(diagnostics);
}

function referenceMissing(
	path: Array<string | number>,
	id: string,
): DslDiagnostic {
	return {
		severity: "error",
		layer: "validate",
		code: "validate.reference.missing",
		message: `Reference "${id}" does not exist.`,
		path,
		hint: "Define the referenced node or group id, or update this reference.",
	};
}

function hasNodeOrGroup(
	id: string,
	nodeIds: ReadonlySet<string>,
	groupIds: ReadonlySet<string>,
	swimlaneLaneIds: ReadonlySet<string> = new Set(),
): boolean {
	return nodeIds.has(id) || groupIds.has(id) || swimlaneLaneIds.has(id);
}

function endpointNodeId(
	endpointValue:
		| string
		| { node: string; port?: string | undefined }
		| undefined,
): string | undefined {
	if (typeof endpointValue === "string" || endpointValue === undefined) {
		return endpointValue;
	}
	return endpointValue.node;
}

function validateEndpointPort(
	dsl: DiagramDsl,
	endpointValue: NormalizedEdge["source"],
	path: Array<string | number>,
	diagnostics: DslDiagnostic[],
): void {
	if (endpointValue.portId === undefined) {
		return;
	}

	const node = dsl.nodes[endpointValue.nodeId];
	if (node !== undefined && node.ports?.[endpointValue.portId] === undefined) {
		diagnostics.push(referenceMissing([...path, "port"], endpointValue.portId));
	}
}

function toLabel(
	value: DiagramDsl["nodes"][string]["label"],
): Label | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value === "string") {
		return { text: value };
	}

	return value.maxWidth === undefined
		? { text: value.text }
		: { text: value.text, maxWidth: value.maxWidth };
}

function fitDslLabel(label: Label, measurer: TextMeasurer) {
	return fitLabel(
		label.text,
		{
			font: DEFAULT_FONT,
			padding: DEFAULT_NODE_PADDING,
			minSize: DEFAULT_NODE_MIN_SIZE,
			maxWidth: label.maxWidth ?? DEFAULT_LABEL_MAX_WIDTH,
		},
		measurer,
	);
}

function point(value: Point): Point {
	return { x: value.x, y: value.y };
}
