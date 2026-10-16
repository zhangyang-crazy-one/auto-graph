import { z } from "zod";
import type { SolvedScene } from "../ir.js";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const geoPoint = z
	.object({
		lat: z.number().describe("WGS84 latitude, degrees."),
		lon: z.number().describe("WGS84 longitude, degrees."),
		alt: z.number().describe("Height above the WGS84 ellipsoid, metres."),
	})
	.strict();
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
			.describe(
				"Its rotation as a unit quaternion [x, y, z, w]: the turn about z, then any lean with the slope.",
			),
		up: vec3
			.optional()
			.describe(
				"The object's up axis in the world, when it leans with the slope (`align to slope`).",
			),
		size: vec3.describe("Width, depth and height before the turn."),
		front: z
			.enum(["+x", "-x", "+y", "-y"])
			.describe("The object's own front before the turn."),
		supportedBy: z.string().optional(),
		aabb: z.object({ min: vec3, max: vec3 }).strict(),
		label: z.string().optional(),
		asset: z.string().optional(),
		group: z.string().optional(),
		geo: geoPoint
			.optional()
			.describe("Where `position` is on the Earth (scenes with a frame)."),
	})
	.strict();

const pathSchema = z
	.object({
		id: z.string(),
		agent: z.string(),
		from: z.string(),
		to: z.string(),
		points: z
			.array(vec3)
			.describe(
				"Corners from start to end, [x, y, z] on the floor (or the ground).",
			),
		length: z.number(),
		width: z.number().describe("The agent's width."),
		clearance: z
			.number()
			.describe("Least distance from the agent's edge to anything."),
		start: z.number().describe("When the agent sets off, seconds."),
		times: z
			.array(z.number())
			.describe(
				"When the agent reaches each point, seconds (it starts and stops at rest, slows at corners).",
			),
		duration: z.number().describe("Seconds from setting off to arriving."),
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
		openings: z.array(
			z
				.object({
					id: z.string(),
					wall: z.enum(["north", "south", "east", "west"]),
					at: z
						.number()
						.describe("Center along the wall from its west (or south) end."),
					width: z.number(),
				})
				.strict(),
		),
		agents: z.array(
			z
				.object({
					id: z.string(),
					radius: z.number(),
					height: z.number(),
					speed: z.number().describe("Top speed, m/s."),
					accel: z.number().describe("Acceleration and braking, m/s²."),
				})
				.strict(),
		),
		paths: z.array(pathSchema),
		geo: z
			.object({
				origin: geoPoint,
				datum: z
					.enum(["WGS84", "GCJ02", "BD09"])
					.describe(
						"The datum the document was written in; every output coordinate is WGS84.",
					),
				anchor: z
					.tuple([z.number(), z.number()])
					.describe("The scene point at the origin, metres."),
				heading: z
					.number()
					.describe(
						"True bearing of the scene's +y axis, degrees clockwise from north.",
					),
				projection: z
					.discriminatedUnion("kind", [
						z.object({ kind: z.literal("enu") }).strict(),
						z
							.object({
								kind: z.literal("utm"),
								zone: z.number(),
								hemisphere: z.enum(["N", "S"]),
								epsg: z.number(),
							})
							.strict(),
						z
							.object({
								kind: z.literal("web-mercator"),
								epsg: z.literal(3857),
							})
							.strict(),
					])
					.describe(
						"How scene metres map to the Earth: a local east-north-up frame, or a map projection's grid (scene metres are its metres from the origin).",
					),
			})
			.strict()
			.optional()
			.describe(
				"Where the scene sits on the Earth: scene metres are a local east-north-up frame at `origin`, turned by `heading`.",
			),
		landmarks: z
			.array(
				z
					.object({
						id: z.string(),
						position: z
							.tuple([z.number(), z.number()])
							.describe("In the scene frame, metres."),
						geo: geoPoint,
					})
					.strict(),
			)
			.optional(),
		terrain: z
			.object({
				origin: z
					.tuple([z.number(), z.number()])
					.describe("Scene x, y of the south-west sample, metres."),
				spacing: z
					.tuple([z.number(), z.number()])
					.describe("Distance between samples along x and y, metres."),
				base: z.number().describe("Elevation at scene z = 0, metres."),
				heights: z
					.array(z.array(z.number()))
					.describe(
						"Elevations, rows south to north, each west to east; the ground between samples is bilinear, and scene z = elevation - base.",
					),
			})
			.strict()
			.optional()
			.describe("The ground (scenes with terrain)."),
		unplaced: z
			.array(z.string())
			.describe(
				"Objects left out of `objects`: no finite position (see the diagnostics).",
			),
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
		openings: scene.openings,
		agents: scene.agents,
		paths: scene.paths,
		...(scene.geo === undefined ? {} : { geo: scene.geo }),
		...(scene.landmarks === undefined ? {} : { landmarks: scene.landmarks }),
		...(scene.terrain === undefined ? {} : { terrain: scene.terrain }),
		unplaced: scene.unplaced,
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
