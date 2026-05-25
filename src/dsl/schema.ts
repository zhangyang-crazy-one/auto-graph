import { z } from "zod";
import { createSchemaDiagnostic, sortDslDiagnostics } from "./diagnostics.js";
import type { DslDiagnostic } from "./types.js";

const directionSchema = z.enum(["TB", "LR", "BT", "RL"]);
const routeKindSchema = z.enum(["orthogonal", "straight"]);
const outputFormatSchema = z.enum(["svg", "excalidraw"]);
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

const nodeSchema = z.object({
	label: labelSchema.optional(),
	shape: nodeShapeSchema.optional(),
	position: pointSchema.optional(),
});

const structuredEdgeSchema = z.object({
	id: z.string().optional(),
	source: z.string(),
	target: z.string(),
	label: labelSchema.optional(),
});

const edgeSchema = z.union([z.string(), structuredEdgeSchema]);

const groupSchema = z.object({
	label: labelSchema.optional(),
	nodes: z.array(z.string()).optional(),
	groups: z.array(z.string()).optional(),
	padding: insetsSchema.optional(),
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
		})
		.optional(),
	nodes: z.record(z.string(), nodeSchema),
	edges: z.array(edgeSchema).optional(),
	groups: z.record(z.string(), groupSchema).optional(),
	constraints: z.array(constraintSchema).optional(),
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
