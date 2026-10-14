import { z } from "zod";
import type { SolvedScene } from "../ir.js";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const path = z.array(z.union([z.string(), z.number()]));

const sceneObjectSchema = z
	.object({
		id: z.string(),
		position: vec3.describe(
			"Footprint center on the floor plan and bottom height [x, y, z], meters.",
		),
		yaw: z
			.number()
			.describe("Turn about z, degrees counter-clockwise seen from above."),
		quaternion: z
			.tuple([z.number(), z.number(), z.number(), z.number()])
			.describe("The same turn as a unit quaternion [x, y, z, w]."),
		size: vec3.describe("Width, depth and height before the turn."),
		front: z
			.enum(["+x", "-x", "+y", "-y"])
			.describe("The object's own front before the turn."),
		supportedBy: z.string().optional(),
		aabb: z.object({ min: vec3, max: vec3 }).strict(),
		label: z.string().optional(),
		asset: z.string().optional(),
		group: z.string().optional(),
	})
	.strict();

const diagnosticSchema = z
	.object({
		severity: z.enum(["info", "warning", "error"]),
		code: z.string(),
		message: z.string(),
		objects: z.array(z.string()).optional(),
		path: path.optional(),
		hint: z.string().optional(),
		detail: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
	})
	.strict();

/** The `dge-scene` v1 document: a solved scene, renderer-agnostic. */
export const sceneDocumentSchema = z
	.object({
		format: z.literal("dge-scene"),
		version: z.literal(1),
		units: z.literal("m"),
		frame: z
			.object({
				x: z.literal("east"),
				y: z.literal("north"),
				z: z.literal("up"),
				origin: z.literal("south-west floor corner"),
			})
			.strict(),
		name: z.string(),
		bounds: z
			.object({
				width: z.number(),
				depth: z.number(),
				height: z.number().optional(),
			})
			.strict(),
		valid: z
			.boolean()
			.describe(
				"No interpenetration, nothing past the walls or ceiling, nothing off its support, every relation held.",
			),
		objects: z.array(sceneObjectSchema),
		diagnostics: z.array(diagnosticSchema),
	})
	.strict();

export type SceneDocument = z.infer<typeof sceneDocumentSchema>;

export function sceneJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(sceneDocumentSchema) as Record<string, unknown>;
}

/** The solved scene as a `dge-scene` v1 document (stable key order). */
export function sceneToDocument(scene: SolvedScene): SceneDocument {
	return {
		format: "dge-scene",
		version: 1,
		units: "m",
		frame: {
			x: "east",
			y: "north",
			z: "up",
			origin: "south-west floor corner",
		},
		name: scene.name,
		bounds: scene.bounds,
		valid: scene.valid,
		objects: scene.objects,
		diagnostics: scene.diagnostics,
	};
}

/** Two-space JSON with number arrays (positions, sizes) on one line. */
export function sceneToJson(scene: SolvedScene): string {
	const text = JSON.stringify(sceneToDocument(scene), null, 2).replace(
		/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g,
		(_, inner: string) => `[${inner.replace(/,\s+/g, ", ")}]`,
	);
	return `${text}\n`;
}
