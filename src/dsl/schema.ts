import { z } from "zod";
import { createSchemaDiagnostic, sortDslDiagnostics } from "./diagnostics.js";
import type { DslDiagnostic } from "./types.js";

const directionSchema = z.enum(["TB", "LR", "BT", "RL"]);
const routeKindSchema = z.enum(["orthogonal", "straight"]);
const outputFormatSchema = z.enum(["svg", "excalidraw"]);
const edgeStrokeStyleSchema = z.enum(["solid", "dashed"]);
const edgeArrowheadSchema = z.enum(["triangle", "hollowTriangle"]);
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
});

const swimlaneSchema = z.object({
	label: labelSchema.optional(),
	orientation: z.enum(["vertical", "horizontal"]).optional(),
	layout: z.enum(["overlay", "contract"]).optional(),
	headerHeight: finiteNumberSchema.optional(),
	padding: finiteNumberSchema.optional(),
	lanes: z.record(
		z.string(),
		z.object({
			label: labelSchema.optional(),
			children: z.array(z.string()).optional(),
		}),
	),
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

export const diagramDslSchema = z.object({
	id: z.string().optional(),
	title: z.string().optional(),
	direction: directionSchema.optional(),
	layout: z
		.object({
			direction: directionSchema.optional(),
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
	constraints: z.array(constraintSchema).optional(),
	frame: z
		.object({
			kind: z.string(),
			context: z.string().optional(),
			name: z.string().optional(),
			titleTab: z.string(),
			style: styleSchema.optional(),
		})
		.optional(),
	output: z
		.object({
			format: outputFormatSchema.optional(),
		})
		.optional(),
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
