import { z } from "zod";
import { createSchemaDiagnostic, sortDslDiagnostics } from "./diagnostics.js";
import type { DslDiagnostic } from "./types.js";

const directionSchema = z.enum(["TB", "LR", "BT", "RL"]);
const routeKindSchema = z.enum(["orthogonal", "straight"]);
const outputFormatSchema = z.enum(["svg", "excalidraw"]);
const edgeStrokeStyleSchema = z.enum(["solid", "dashed"]);
const edgeArrowheadSchema = z.enum(["triangle", "hollowTriangle"]);
const primaryReadingDirectionSchema = z.enum([
	"top_to_bottom",
	"top-to-bottom",
]);
const nodeShapeSchema = z.enum([
	"rectangle",
	"rounded-rectangle",
	"ellipse",
	"diamond",
	"parallelogram",
	"hexagon",
	"cylinder",
]);

const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.min(0);

const pointSchema = z.object({
	x: finiteNumberSchema,
	y: finiteNumberSchema,
});

const insetsSchema = z.object({
	top: finiteNumberSchema,
	right: finiteNumberSchema,
	bottom: finiteNumberSchema,
	left: finiteNumberSchema,
});

const labelSchema = z.union([
	z.string(),
	z.object({
		text: z.string(),
		maxWidth: finiteNumberSchema.optional(),
	}),
]);

const styleSchema = z.object({
	fill: z.string().optional(),
	stroke: z.string().optional(),
});

const blockCellSchema = z.union([
	z.string(),
	z.object({
		text: z.string(),
		fill: z.string().optional(),
		stroke: z.string().optional(),
		style: styleSchema.optional(),
	}),
]);

const portSideSchema = z.enum(["top", "right", "bottom", "left"]);
const portKindSchema = z.enum(["proxy", "flow"]);

const portSchema = z.object({
	label: labelSchema.optional(),
	side: portSideSchema,
	kind: portKindSchema.optional(),
	order: finiteNumberSchema.optional(),
	style: styleSchema.optional(),
});

const compartmentsSchema = z.object({
	stereotype: z.string().optional(),
	name: z.string().optional(),
	properties: z
		.array(z.record(z.string(), z.string()).or(z.string()))
		.optional(),
	constraints: z.array(z.string()).optional(),
});

const nodeSchema = z.object({
	label: labelSchema.optional(),
	shape: nodeShapeSchema.optional(),
	position: pointSchema.optional(),
	style: styleSchema.optional(),
	ports: z.record(z.string(), portSchema).optional(),
	compartments: compartmentsSchema.optional(),
});

const endpointSchema = z.union([
	z.string(),
	z.object({
		node: z.string(),
		port: z.string().optional(),
	}),
]);

const structuredEdgeSchema = z
	.object({
		id: z.string().optional(),
		source: endpointSchema.optional(),
		target: endpointSchema.optional(),
		sourceId: z.string().optional(),
		targetId: z.string().optional(),
		label: labelSchema.optional(),
		style: edgeStrokeStyleSchema.optional(),
		arrowhead: edgeArrowheadSchema.optional(),
	})
	.superRefine((edge, context) => {
		if (edge.source === undefined && edge.sourceId === undefined) {
			context.addIssue({
				code: "custom",
				message: "Edge requires source or sourceId.",
				path: ["source"],
			});
		}
		if (edge.target === undefined && edge.targetId === undefined) {
			context.addIssue({
				code: "custom",
				message: "Edge requires target or targetId.",
				path: ["target"],
			});
		}
	});

const edgeSchema = z.union([z.string(), structuredEdgeSchema]);

const groupSchema = z.object({
	label: labelSchema.optional(),
	nodes: z.array(z.string()).optional(),
	groups: z.array(z.string()).optional(),
	padding: insetsSchema.optional(),
	headerHeight: nonNegativeNumberSchema.optional(),
	labelPosition: z.enum(["top", "inside", "outside"]).optional(),
	direction: z.enum(["horizontal", "vertical"]).optional(),
});

const swimlaneSchema = z.object({
	label: labelSchema.optional(),
	orientation: z.enum(["vertical", "horizontal"]).optional(),
	layout: z.enum(["overlay", "contract"]).optional(),
	headerHeight: nonNegativeNumberSchema.optional(),
	padding: nonNegativeNumberSchema.optional(),
	lanes: z.record(
		z.string(),
		z.object({
			label: labelSchema.optional(),
			children: z.array(z.string()).optional(),
		}),
	),
});

const matrixSchema = z
	.object({
		id: z.string(),
		rows: z.array(z.string()),
		cols: z.array(z.string()),
		cells: z.array(z.array(blockCellSchema)),
		position: pointSchema.optional(),
		size: z
			.object({
				width: nonNegativeNumberSchema,
				height: nonNegativeNumberSchema,
			})
			.optional(),
		style: styleSchema.optional(),
	})
	.superRefine((matrix, context) => {
		checkDuplicateValues("matrix row", matrix.rows, context, (index) => [
			"rows",
			index,
		]);
		checkDuplicateValues("matrix column", matrix.cols, context, (index) => [
			"cols",
			index,
		]);
		if (matrix.cells.length !== matrix.rows.length) {
			context.addIssue({
				code: "custom",
				message: `Matrix cells must contain exactly ${matrix.rows.length} row(s).`,
				path: ["cells"],
			});
		}
		matrix.cells.forEach((row, rowIndex) => {
			if (row.length !== matrix.cols.length) {
				context.addIssue({
					code: "custom",
					message: `Matrix cell row must contain exactly ${matrix.cols.length} column(s).`,
					path: ["cells", rowIndex],
				});
			}
		});
	});

const tableColumnSchema = z.object({
	id: z.string(),
	label: labelSchema,
});

const tableRowSchema = z.object({
	id: z.string(),
	cells: z.record(z.string(), blockCellSchema),
});

const tableSchema = z
	.object({
		id: z.string(),
		columns: z.array(tableColumnSchema),
		rows: z.array(tableRowSchema),
		position: pointSchema.optional(),
		size: z
			.object({
				width: nonNegativeNumberSchema,
				height: nonNegativeNumberSchema,
			})
			.optional(),
		style: styleSchema.optional(),
	})
	.superRefine((table, context) => {
		checkDuplicateIds("column", table.columns, context, (index) => [
			"columns",
			index,
			"id",
		]);
		checkDuplicateIds("row", table.rows, context, (index) => [
			"rows",
			index,
			"id",
		]);
		const columnIds = new Set(table.columns.map((column) => column.id));
		table.rows.forEach((row, rowIndex) => {
			for (const columnId of Object.keys(row.cells)) {
				if (!columnIds.has(columnId)) {
					context.addIssue({
						code: "custom",
						message: `Table row cell references undeclared column "${columnId}".`,
						path: ["rows", rowIndex, "cells", columnId],
					});
				}
			}
		});
	});

const panelItemSchema = z.union([
	z.string(),
	z.object({
		id: z.string().optional(),
		label: labelSchema,
		detail: labelSchema.optional(),
		style: styleSchema.optional(),
	}),
]);

const evidencePanelSchema = z
	.object({
		id: z.string(),
		kind: z.enum(["legend", "rule", "note", "verification"]),
		items: z.array(panelItemSchema),
		position: pointSchema.optional(),
		size: z
			.object({
				width: nonNegativeNumberSchema,
				height: nonNegativeNumberSchema,
			})
			.optional(),
		style: styleSchema.optional(),
	})
	.superRefine((panel, context) => {
		const firstIndexByItemId = new Map<string, number>();
		panel.items.forEach((item, index) => {
			if (typeof item === "string" || item.id === undefined) {
				return;
			}
			const firstIndex = firstIndexByItemId.get(item.id);
			if (firstIndex === undefined) {
				firstIndexByItemId.set(item.id, index);
				return;
			}
			context.addIssue({
				code: "custom",
				message: `Duplicate evidence panel item id "${item.id}".`,
				path: ["items", index, "id"],
			});
		});
	});

const exactPositionConstraintSchema = z.object({
	kind: z.literal("exact-position"),
	target: z.string().optional(),
	targetId: z.string().optional(),
	position: pointSchema,
});

const relativePositionConstraintSchema = z.object({
	kind: z.literal("relative-position"),
	source: z.string().optional(),
	sourceId: z.string().optional(),
	reference: z.string().optional(),
	referenceId: z.string().optional(),
	relation: z.enum(["above", "right-of", "below", "left-of"]),
	offset: pointSchema.optional(),
});

const alignConstraintSchema = z.object({
	kind: z.literal("align"),
	axis: z.enum([
		"x",
		"y",
		"center-x",
		"center-y",
		"top",
		"right",
		"bottom",
		"left",
	]),
	targets: z.array(z.string()).optional(),
	targetIds: z.array(z.string()).optional(),
});

const distributeConstraintSchema = z.object({
	kind: z.literal("distribute"),
	axis: z.enum(["horizontal", "vertical"]),
	targets: z.array(z.string()).optional(),
	targetIds: z.array(z.string()).optional(),
	spacing: finiteNumberSchema.optional(),
});

const containmentConstraintSchema = z.object({
	kind: z.literal("containment"),
	container: z.string().optional(),
	containerId: z.string().optional(),
	children: z.array(z.string()).optional(),
	childIds: z.array(z.string()).optional(),
	padding: insetsSchema.optional(),
});

const constraintSchema = z.union([
	exactPositionConstraintSchema,
	relativePositionConstraintSchema,
	alignConstraintSchema,
	distributeConstraintSchema,
	containmentConstraintSchema,
]);

export const diagramDslSchema = z
	.object({
		id: z.string().optional(),
		title: z.string().optional(),
		direction: directionSchema.optional(),
		layout: z
			.object({
				direction: directionSchema.optional(),
				primaryReadingDirection: primaryReadingDirectionSchema.optional(),
			})
			.optional(),
		routing: z
			.object({
				kind: routeKindSchema.optional(),
				portShifting: z
					.object({
						enabled: z.boolean().optional(),
						spacing: finiteNumberSchema.optional(),
					})
					.optional(),
			})
			.optional(),
		nodes: z.record(z.string(), nodeSchema),
		edges: z.array(edgeSchema).optional(),
		groups: z.record(z.string(), groupSchema).optional(),
		swimlanes: z.record(z.string(), swimlaneSchema).optional(),
		matrices: z.array(matrixSchema).optional(),
		tables: z.array(tableSchema).optional(),
		evidencePanels: z.array(evidencePanelSchema).optional(),
		constraints: z.array(constraintSchema).optional(),
		frame: z
			.object({
				kind: z.string(),
				context: z.string().optional(),
				name: z.string().optional(),
				titleTab: z.string(),
				headerHeight: nonNegativeNumberSchema.optional(),
				padding: z.union([nonNegativeNumberSchema, insetsSchema]).optional(),
				labelPosition: z.enum(["top", "inside", "outside"]).optional(),
				direction: z.enum(["horizontal", "vertical"]).optional(),
				style: styleSchema.optional(),
			})
			.optional(),
		output: z
			.object({
				format: outputFormatSchema.optional(),
			})
			.optional(),
	})
	.superRefine((diagram, context) => {
		checkDuplicateEvidenceBlockIds("matrices", diagram.matrices, context);
		checkDuplicateEvidenceBlockIds("tables", diagram.tables, context);
		checkDuplicateEvidenceBlockIds(
			"evidencePanels",
			diagram.evidencePanels,
			context,
		);
		checkDuplicateEvidenceBlockIdsAcrossTypes(diagram, context);
	});

export type DiagramDsl = z.infer<typeof diagramDslSchema>;

export function validateDiagramDsl(value: unknown): {
	value?: DiagramDsl;
	diagnostics: DslDiagnostic[];
} {
	const result = diagramDslSchema.safeParse(value);

	if (result.success) {
		return { value: result.data, diagnostics: [] };
	}

	return {
		diagnostics: sortDslDiagnostics(
			result.error.issues.map((issue) =>
				createSchemaDiagnostic(toDiagnosticPath(issue.path), issue.message),
			),
		),
	};
}

function toDiagnosticPath(path: PropertyKey[]): Array<string | number> {
	return path.flatMap((segment) =>
		typeof segment === "string" || typeof segment === "number" ? [segment] : [],
	);
}

function checkDuplicateEvidenceBlockIds(
	collection: "matrices" | "tables" | "evidencePanels",
	blocks: readonly { id: string }[] | undefined,
	context: z.RefinementCtx,
): void {
	checkDuplicateIds(
		`evidence block id in ${collection}`,
		blocks ?? [],
		context,
		(index) => [collection, index, "id"],
	);
}

function checkDuplicateIds(
	label: string,
	items: readonly { id: string }[],
	context: z.RefinementCtx,
	pathForIndex: (index: number) => Array<string | number>,
): void {
	const firstIndexById = new Map<string, number>();
	items.forEach((item, index) => {
		const firstIndex = firstIndexById.get(item.id);
		if (firstIndex === undefined) {
			firstIndexById.set(item.id, index);
			return;
		}
		context.addIssue({
			code: "custom",
			message: `Duplicate ${label} "${item.id}".`,
			path: pathForIndex(index),
		});
	});
}

function checkDuplicateValues(
	label: string,
	values: readonly string[],
	context: z.RefinementCtx,
	pathForIndex: (index: number) => Array<string | number>,
): void {
	const firstIndexByValue = new Map<string, number>();
	values.forEach((value, index) => {
		const firstIndex = firstIndexByValue.get(value);
		if (firstIndex === undefined) {
			firstIndexByValue.set(value, index);
			return;
		}
		context.addIssue({
			code: "custom",
			message: `Duplicate ${label} "${value}".`,
			path: pathForIndex(index),
		});
	});
}

function checkDuplicateEvidenceBlockIdsAcrossTypes(
	diagram: {
		matrices?: readonly { id: string }[] | undefined;
		tables?: readonly { id: string }[] | undefined;
		evidencePanels?: readonly { id: string }[] | undefined;
	},
	context: z.RefinementCtx,
): void {
	const firstById = new Map<
		string,
		{ collection: "matrices" | "tables" | "evidencePanels"; index: number }
	>();
	for (const collection of ["matrices", "tables", "evidencePanels"] as const) {
		const blocks = diagram[collection] ?? [];
		blocks.forEach((block, index) => {
			const first = firstById.get(block.id);
			if (first === undefined) {
				firstById.set(block.id, { collection, index });
				return;
			}
			context.addIssue({
				code: "custom",
				message: `Duplicate evidence block id "${block.id}" across ${first.collection} and ${collection}.`,
				path: [collection, index, "id"],
			});
		});
	}
}
