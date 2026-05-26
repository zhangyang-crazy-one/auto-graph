import type { Constraint } from "../ir/constraints.js";
import type { NormalizedDiagram } from "../ir/diagram.js";
import type {
	Label,
	NormalizedEdge,
	NormalizedGroup,
	NormalizedNode,
} from "../ir/elements.js";
import type { Insets, Point, Size } from "../ir/geometry.js";
import { fitLabel } from "../labels/index.js";
import { DeterministicTextMeasurer, type TextMeasurer } from "../text/index.js";
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

	const measurer = options.textMeasurer ?? new DeterministicTextMeasurer();
	const routeKind = dsl.routing?.kind ?? "orthogonal";
	const diagram: NormalizedDiagram = {
		id: options.id ?? dsl.id ?? "diagram",
		...(dsl.title === undefined ? {} : { title: dsl.title }),
		direction: dsl.layout?.direction ?? dsl.direction ?? "TB",
		nodes: normalizeNodes(dsl, measurer),
		edges: normalizeEdges(dsl),
		groups: normalizeGroups(dsl, measurer),
		constraints: normalizeConstraints(dsl),
		diagnostics: [],
		metadata: { routeKind },
	};

	return {
		diagram,
		diagnostics: [],
		...outputResult(dsl),
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

			return {
				id,
				...(label === undefined ? {} : { label }),
				shape: node?.shape ?? "rectangle",
				...(node?.position === undefined
					? {}
					: { position: point(node.position) }),
				size: {
					width: Math.max(DEFAULT_NODE_MIN_SIZE.width, fittedSize?.width ?? 0),
					height: Math.max(
						DEFAULT_NODE_MIN_SIZE.height,
						fittedSize?.height ?? 0,
					),
				},
				padding: { ...DEFAULT_NODE_PADDING },
				...(labelLayout === undefined ? {} : { labelLayout }),
			};
		});
}

function normalizeEdges(dsl: DiagramDsl): NormalizedEdge[] {
	const counts = new Map<string, number>();

	return (dsl.edges ?? []).map((edge) => {
		const sourceId =
			typeof edge === "string" ? "" : (edge.sourceId ?? edge.source ?? "");
		const targetId =
			typeof edge === "string" ? "" : (edge.targetId ?? edge.target ?? "");
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
			source: { nodeId: sourceId },
			target: { nodeId: targetId },
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
		const sourceId = edge.sourceId ?? edge.source;
		const targetId = edge.targetId ?? edge.target;
		if (sourceId !== undefined && !nodeIds.has(sourceId)) {
			diagnostics.push(referenceMissing(["edges", index, "source"], sourceId));
		}
		if (targetId !== undefined && !nodeIds.has(targetId)) {
			diagnostics.push(referenceMissing(["edges", index, "target"], targetId));
		}
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
				if (
					container !== undefined &&
					!hasNodeOrGroup(container, nodeIds, groupIds)
				) {
					diagnostics.push(
						referenceMissing(["constraints", index, "container"], container),
					);
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
): boolean {
	return nodeIds.has(id) || groupIds.has(id);
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
