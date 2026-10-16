import { Buffer } from "node:buffer";
import { z } from "zod";
import {
	createParseDiagnostic,
	createSchemaDiagnostic,
	sortDslDiagnostics,
} from "../dsl/diagnostics.js";
import { DEFAULT_DSL_MAX_BYTES, parseDslSource } from "../dsl/parse.js";
import type { DslDiagnostic, ParseDiagramDslOptions } from "../dsl/types.js";
import { closest } from "../views/common.js";
import {
	bd09ToWgs84,
	GEO_REACH,
	type Geodetic,
	gcj02ToWgs84,
	geodesicDirect,
	SceneGeoFrame,
} from "./geo/index.js";
import type {
	CornerSide,
	GeoPoint,
	SceneAgent,
	SceneFrame,
	SceneLandmark,
	SceneObject,
	SceneOpening,
	ScenePath,
	ScenePathSpec,
	SceneRelation,
	SceneSide,
	SceneSpec,
	SceneTerrain,
	SceneUnits,
	SupportSpot,
	WallSide,
} from "./ir.js";

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().min(0);

/** Words a relation reads specially; no object may be called one. */
const RESERVED_IDS = new Set([
	"room",
	"north",
	"south",
	"east",
	"west",
	"terrain",
]);

const geoPointSchema = z
	.object({
		lat: z.number().finite().min(-90).max(90),
		lon: z.number().finite().min(-180).max(180),
		alt: z.number().finite().optional(),
	})
	.strict();

const sceneObjectSchema = z
	.object({
		size: z.tuple([positive, positive, positive]),
		front: z.enum(["+x", "-x", "+y", "-y"]).optional(),
		count: z.number().int().min(1).max(1000).optional(),
		label: z.string().optional(),
		asset: z.string().min(1).optional(),
		/** Pinned footprint center [x, y]. */
		position: z.tuple([z.number().finite(), z.number().finite()]).optional(),
		/** Pinned turn in degrees, counter-clockwise seen from above. */
		yaw: z.number().finite().optional(),
		/** Pinned footprint center by latitude and longitude (needs a frame). */
		geo: geoPointSchema.omit({ alt: true }).optional(),
	})
	.strict();

const idSchema = z
	.string()
	.regex(
		/^[A-Za-z_][\w-]*$/,
		"Ids start with a letter or _ and use letters, digits, _ and -.",
	);

/** The agent every scene has unless it declares its own `person`. */
const DEFAULT_PERSON = { radius: 0.25, height: 1.8, speed: 1.2, accel: 1 };
/** Walking pace (m/s) and how quickly it is reached (m/s²) by default. */
const DEFAULT_SPEED = 1;
const DEFAULT_ACCEL = 1;
/** Room a path keeps beyond its clearance when it can (walks mid-aisle). */
const DEFAULT_COMFORT = 0.15;

export const sceneDslSchema = z
	.object({
		scene: z.string().min(1),
		units: z.enum(["m", "cm", "mm"]).optional(),
		bounds: z
			.object({
				width: positive,
				depth: positive,
				height: positive.optional(),
			})
			.strict(),
		minGap: nonNegative.optional(),
		makeWay: z.boolean().optional(),
		objects: z.record(idSchema, sceneObjectSchema),
		relations: z.array(z.string().min(1)).optional(),
		openings: z
			.record(
				idSchema,
				z
					.object({
						wall: z.enum(["north", "south", "east", "west"]),
						at: nonNegative,
						width: positive,
					})
					.strict(),
			)
			.optional(),
		agents: z
			.record(
				idSchema,
				z
					.object({
						radius: positive,
						height: positive,
						speed: positive.optional(),
						accel: positive.optional(),
					})
					.strict(),
			)
			.optional(),
		paths: z.array(z.string().min(1)).optional(),
		frame: z
			.object({
				origin: geoPointSchema,
				datum: z.enum(["WGS84", "GCJ02", "BD09"]).optional(),
				/** The scene point at the origin (default the south-west corner). */
				anchor: z.tuple([z.number().finite(), z.number().finite()]).optional(),
				/** True bearing of the scene's +y axis, degrees (default 0). */
				heading: z.number().finite().optional(),
			})
			.strict()
			.optional(),
		landmarks: z.record(idSchema, geoPointSchema).optional(),
		/** The ground, as a grid of elevations (see `GridTerrain`). */
		terrain: z
			.object({
				grid: z
					.object({
						/** Scene x, y of the south-west sample (default [0, 0]). */
						origin: z
							.tuple([z.number().finite(), z.number().finite()])
							.optional(),
						/** Distance between samples: one number, or [x, y]. */
						spacing: z.union([positive, z.tuple([positive, positive])]),
						/** Elevations, rows south to north, each west to east. */
						heights: z.array(z.array(z.number().finite())),
					})
					.strict(),
				/** Elevation at scene z = 0 (default 0; the frame origin's height in a scene with a frame). */
				base: z.number().finite().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type SceneDsl = z.infer<typeof sceneDslSchema>;

export interface NormalizeSceneDslResult {
	scene?: SceneSpec;
	diagnostics: DslDiagnostic[];
}

/** A document is a scene when it has a top-level `scene` key. */
export function isSceneDocument(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"scene" in value
	);
}

/** Parse YAML/JSON scene source and normalize it (see {@link normalizeSceneDsl}). */
export function parseSceneDsl(
	source: string,
	options: ParseDiagramDslOptions = {},
): NormalizeSceneDslResult {
	const maxBytes = options.maxBytes ?? DEFAULT_DSL_MAX_BYTES;
	if (Buffer.byteLength(source, "utf8") > maxBytes) {
		return {
			diagnostics: [
				createParseDiagnostic(
					"parse.input.too-large",
					`Input exceeds the ${maxBytes} byte limit.`,
					"Split the scene into smaller inputs or raise maxBytes for trusted sources.",
				),
			],
		};
	}
	const parsed = parseDslSource(source, options);
	if (parsed.value === undefined || hasErrors(parsed.diagnostics)) {
		return { diagnostics: sortDslDiagnostics(parsed.diagnostics) };
	}
	const normalized = normalizeSceneDsl(parsed.value);
	return {
		...(normalized.scene === undefined ? {} : { scene: normalized.scene }),
		diagnostics: sortDslDiagnostics([
			...parsed.diagnostics,
			...normalized.diagnostics,
		]),
	};
}

/**
 * Validate a scene document and turn it into the scene IR: lengths in
 * meters, `count` groups expanded (`seat` with `count: 4` becomes `seat1`
 * … `seat4`; a group id ending in a digit gets `-1` … instead), and every
 * relation string parsed. Diagnostics point back at the document path.
 */
export function normalizeSceneDsl(value: unknown): NormalizeSceneDslResult {
	// The schema would drop an object called __proto__ without a word.
	const raw = (value as { objects?: unknown } | null)?.objects;
	if (
		raw !== null &&
		typeof raw === "object" &&
		Object.hasOwn(raw, "__proto__")
	) {
		return {
			diagnostics: [
				error(
					["objects", "__proto__"],
					"validate.scene.reserved-id",
					'"__proto__" is a reserved word and cannot name an object.',
					"Rename it.",
				),
			],
		};
	}
	const result = sceneDslSchema.safeParse(value);
	if (!result.success) {
		return {
			diagnostics: sortDslDiagnostics(
				result.error.issues.map((issue) =>
					createSchemaDiagnostic(
						issue.path.flatMap((segment) =>
							typeof segment === "string" || typeof segment === "number"
								? [segment]
								: [],
						),
						issue.message,
					),
				),
			),
		};
	}
	const dsl = result.data;
	const units: SceneUnits = dsl.units ?? "m";
	const perMeter = PER_METER[units];
	const diagnostics: DslDiagnostic[] = [];

	// Where the scene sits on the Earth: every latitude and longitude in
	// the document is in the frame's datum and is stored as WGS84.
	const datum = dsl.frame?.datum ?? "WGS84";
	// A point given without a height is on the ground: at the origin's.
	const ground = dsl.frame?.origin.alt ?? 0;
	const toWgs84 = (point: Geodetic): GeoPoint => {
		const wgs =
			datum === "GCJ02"
				? gcj02ToWgs84(point)
				: datum === "BD09"
					? bd09ToWgs84(point)
					: point;
		return { lat: wgs.lat, lon: wgs.lon, alt: point.alt ?? ground };
	};
	const frame: SceneFrame | undefined =
		dsl.frame === undefined
			? undefined
			: {
					origin: toWgs84(dsl.frame.origin),
					datum,
					anchor: {
						x: (dsl.frame.anchor?.[0] ?? 0) / perMeter,
						y: (dsl.frame.anchor?.[1] ?? 0) / perMeter,
					},
					heading: dsl.frame.heading ?? 0,
					path: ["frame"],
				};
	const geoFrame = frame === undefined ? undefined : new SceneGeoFrame(frame);
	// A point too far from the origin has no faithful place in the local
	// frame (one on the far side of the Earth would fold back next to the
	// origin), so it is refused before it is projected.
	const tooFar = (point: Geodetic, path: ScenePath): boolean => {
		const reach = (geoFrame as SceneGeoFrame).reach(toWgs84(point));
		if (reach <= GEO_REACH) return false;
		diagnostics.push(geoExtent(path, reach));
		return true;
	};
	const sceneAt = (point: Geodetic): [number, number] => {
		const at = (geoFrame as SceneGeoFrame).toScene(toWgs84(point));
		return [at.x, at.y];
	};

	const objects: SceneObject[] = [];
	const groups = new Map<string, string[]>();
	const declared = new Set(Object.keys(dsl.objects));
	const taken = new Map<string, ScenePath>();
	for (const [id, entry] of Object.entries(dsl.objects)) {
		const path: ScenePath = ["objects", id];
		if (RESERVED_IDS.has(id)) {
			diagnostics.push(
				error(
					path,
					"validate.scene.reserved-id",
					`"${id}" is a reserved word and cannot name an object.`,
					`Rename it; relations read ${[...RESERVED_IDS].join(", ")} specially.`,
				),
			);
			continue;
		}
		const base = {
			size: entry.size.map((length) => length / perMeter) as [
				number,
				number,
				number,
			],
			front: entry.front ?? "-y",
			...(entry.label === undefined ? {} : { label: entry.label }),
			...(entry.asset === undefined ? {} : { asset: entry.asset }),
			...(entry.count !== undefined && entry.yaw !== undefined
				? { yaw: entry.yaw }
				: {}),
		};
		if (entry.geo !== undefined && geoFrame === undefined) {
			diagnostics.push(
				error(
					[...path, "geo"],
					"validate.scene.geo-without-frame",
					`"${id}" is placed by latitude and longitude, but the scene has no \`frame\`.`,
					"Add `frame: { origin: { lat, lon } }` to place the scene on the Earth.",
				),
			);
		}
		if (entry.geo !== undefined && entry.position !== undefined) {
			diagnostics.push(
				error(
					[...path, "geo"],
					"validate.scene.relation-conflict",
					`"${id}" is pinned twice, by \`position\` and by \`geo\`.`,
					"Keep one of them.",
				),
			);
		}
		const pinned =
			entry.position !== undefined
				? (entry.position.map((v) => v / perMeter) as [number, number])
				: entry.geo !== undefined &&
						geoFrame !== undefined &&
						!tooFar(entry.geo, [...path, "geo"])
					? sceneAt(entry.geo)
					: undefined;
		if (entry.count === undefined) {
			taken.set(id, path);
			objects.push({
				id,
				...base,
				...(pinned === undefined ? {} : { position: pinned }),
				...(entry.yaw === undefined ? {} : { yaw: entry.yaw }),
				path,
			});
			continue;
		}
		if (entry.position !== undefined || entry.geo !== undefined) {
			diagnostics.push(
				error(
					[...path, entry.position !== undefined ? "position" : "geo"],
					"validate.scene.group-position",
					`"${id}" makes ${entry.count} objects; one position cannot pin them all.`,
					"Place the group with a relation (around, grid, distribute) or declare the objects one by one.",
				),
			);
		}
		const members: string[] = [];
		const separator = /\d$/.test(id) ? "-" : "";
		for (let index = 1; index <= entry.count; index += 1) {
			const member = `${id}${separator}${index}`;
			if (declared.has(member) || taken.has(member)) {
				diagnostics.push(
					error(
						path,
						"validate.scene.count-id-conflict",
						`"${id}" with count ${entry.count} makes "${member}", which is already an object.`,
						"Rename the group or the other object.",
					),
				);
				continue;
			}
			taken.set(member, path);
			members.push(member);
			objects.push({ id: member, ...base, group: id, path });
		}
		groups.set(id, members);
	}

	const landmarks: SceneLandmark[] = [];
	for (const [id, point] of Object.entries(dsl.landmarks ?? {})) {
		const path: ScenePath = ["landmarks", id];
		if (geoFrame === undefined) {
			diagnostics.push(
				error(
					path,
					"validate.scene.geo-without-frame",
					`Landmark "${id}" is given by latitude and longitude, but the scene has no \`frame\`.`,
					"Add `frame: { origin: { lat, lon } }` to place the scene on the Earth.",
				),
			);
			continue;
		}
		if (
			RESERVED_IDS.has(id) ||
			taken.has(id) ||
			groups.has(id) ||
			dsl.openings?.[id] !== undefined
		) {
			diagnostics.push(
				error(
					path,
					"validate.scene.duplicate-id",
					`"${id}" names both a landmark and an object or opening (or is a reserved word).`,
					"Give the landmark its own id.",
				),
			);
			continue;
		}
		if (tooFar(point, path)) continue;
		const [x, y] = sceneAt(point);
		landmarks.push({ id, geo: toWgs84(point), position: { x, y }, path });
	}

	const terrain = readTerrain(dsl.terrain, perMeter, frame, diagnostics);

	const parser = new RelationParser(
		new Set(objects.map((object) => object.id)),
		groups,
		units,
		diagnostics,
		new Map(landmarks.map((landmark) => [landmark.id, landmark])),
		geoFrame,
		dsl.terrain !== undefined,
	);
	const relations: SceneRelation[] = [];
	(dsl.relations ?? []).forEach((text, index) => {
		relations.push(...parser.parse(text, ["relations", index]));
	});

	const width = dsl.bounds.width / perMeter;
	const depth = dsl.bounds.depth / perMeter;
	const objectIds = new Set(objects.map((object) => object.id));
	const openings: SceneOpening[] = [];
	for (const [id, entry] of Object.entries(dsl.openings ?? {})) {
		const path: ScenePath = ["openings", id];
		const opening = {
			id,
			wall: entry.wall,
			at: entry.at / perMeter,
			width: entry.width / perMeter,
			path,
		};
		const along =
			entry.wall === "north" || entry.wall === "south" ? width : depth;
		if (objectIds.has(id) || groups.has(id)) {
			diagnostics.push(
				error(
					path,
					"validate.scene.duplicate-id",
					`"${id}" names both an object and an opening.`,
					"Give the opening its own id.",
				),
			);
		} else if (
			opening.at - opening.width / 2 < -1e-9 ||
			opening.at + opening.width / 2 > along + 1e-9
		) {
			diagnostics.push(
				error(
					path,
					"validate.scene.opening-outside",
					`Opening "${id}" (${opening.width} m wide at ${opening.at} m) does not fit in the ${entry.wall} wall (${along} m).`,
					"Move it along the wall or make it narrower.",
				),
			);
		} else if (
			openings.some(
				(other) =>
					other.wall === opening.wall &&
					Math.abs(other.at - opening.at) <
						(other.width + opening.width) / 2 - 1e-9,
			)
		) {
			const other = openings.find(
				(item) =>
					item.wall === opening.wall &&
					Math.abs(item.at - opening.at) <
						(item.width + opening.width) / 2 - 1e-9,
			) as SceneOpening;
			diagnostics.push(
				error(
					path,
					"validate.scene.opening-overlap",
					`Openings "${other.id}" and "${id}" overlap on the ${entry.wall} wall.`,
					"Move one along the wall or make them narrower; a wide gap is one opening.",
				),
			);
		} else {
			openings.push(opening);
		}
	}
	const agents: SceneAgent[] = Object.entries({
		person: DEFAULT_PERSON,
		...(dsl.agents ?? {}),
	}).map(([id, entry]) => {
		const scale = dsl.agents?.[id] === undefined ? 1 : perMeter;
		// A declared person keeps the built-in walking pace unless it says
		// otherwise; other agents default to 1 m/s and 1 m/s².
		const pace =
			id === "person"
				? DEFAULT_PERSON
				: { speed: DEFAULT_SPEED, accel: DEFAULT_ACCEL };
		return {
			id,
			radius: entry.radius / scale,
			height: entry.height / scale,
			speed: entry.speed === undefined ? pace.speed : entry.speed / scale,
			accel: entry.accel === undefined ? pace.accel : entry.accel / scale,
			path: ["agents", id],
		};
	});
	const paths = parsePaths(
		dsl.paths ?? [],
		{
			objects: objectIds,
			groups,
			openings: new Set(openings.map((opening) => opening.id)),
			agents: new Set(agents.map((agent) => agent.id)),
		},
		units,
		diagnostics,
	);

	if (hasErrors(diagnostics)) {
		return { diagnostics: sortDslDiagnostics(diagnostics) };
	}
	const height = dsl.bounds.height;
	return {
		scene: {
			name: dsl.scene,
			units,
			bounds: {
				width,
				depth,
				...(height === undefined ? {} : { height: height / perMeter }),
			},
			minGap: (dsl.minGap ?? 0) / perMeter,
			makeWay: dsl.makeWay ?? true,
			objects,
			relations,
			groups: Object.fromEntries(groups),
			openings,
			agents,
			paths,
			...(frame === undefined ? {} : { frame, landmarks }),
			...(terrain === undefined ? {} : { terrain }),
		},
		diagnostics: sortDslDiagnostics(diagnostics),
	};
}

/**
 * The ground grid in metres. Elevations are relative to `base`, which is
 * the frame origin's height in a scene on the Earth (so `geo` heights and
 * terrain agree) and 0 otherwise.
 */
function readTerrain(
	input: SceneDsl["terrain"],
	perMeter: number,
	frame: SceneFrame | undefined,
	diagnostics: DslDiagnostic[],
): SceneTerrain | undefined {
	if (input === undefined) return undefined;
	const path: ScenePath = ["terrain"];
	const { heights } = input.grid;
	const columns = heights[0]?.length ?? 0;
	if (heights.length < 2 || columns < 2) {
		diagnostics.push(
			error(
				[...path, "grid", "heights"],
				"validate.scene.terrain-grid",
				`The terrain grid has ${heights.length} row(s) of ${columns} sample(s); it needs at least 2 × 2.`,
				"Give rows south to north, each with the same number of elevations west to east.",
			),
		);
		return undefined;
	}
	const ragged = heights.findIndex((row) => row.length !== columns);
	if (ragged >= 0) {
		diagnostics.push(
			error(
				[...path, "grid", "heights", ragged],
				"validate.scene.terrain-grid",
				`Terrain row ${ragged} has ${heights[ragged]?.length} samples; the first row has ${columns}.`,
				"Give every row the same number of elevations.",
			),
		);
		return undefined;
	}
	if (input.base !== undefined && frame !== undefined) {
		diagnostics.push(
			error(
				[...path, "base"],
				"validate.scene.terrain-base",
				"A scene with a `frame` takes its floor's elevation from the frame origin's height; `terrain.base` would contradict it.",
				"Remove `terrain.base`, or set the frame origin's `alt`.",
			),
		);
		return undefined;
	}
	const spacing = input.grid.spacing;
	const [sx, sy] = typeof spacing === "number" ? [spacing, spacing] : spacing;
	return {
		origin: {
			x: (input.grid.origin?.[0] ?? 0) / perMeter,
			y: (input.grid.origin?.[1] ?? 0) / perMeter,
		},
		spacing: { x: sx / perMeter, y: sy / perMeter },
		heights: heights.map((row) => row.map((value) => value / perMeter)),
		base: frame?.origin.alt ?? (input.base ?? 0) / perMeter,
		path,
	};
}

/** Units per meter: dividing (not multiplying by 0.01) keeps 280 cm at 2.8. */
const PER_METER: Record<SceneUnits, number> = { m: 1, cm: 100, mm: 1000 };

// Maps, not object literals: a word like "constructor" must not find
// Object.prototype members.
const SIDE_VERBS = new Map<string, SceneSide>([
	["in-front-of", "front"],
	["behind", "back"],
	["left-of", "left"],
	["right-of", "right"],
]);

const WALLS = new Map<string, WallSide>([
	["north", "north"],
	["n", "north"],
	["south", "south"],
	["s", "south"],
	["east", "east"],
	["e", "east"],
	["west", "west"],
	["w", "west"],
]);

const CORNERS = new Set<CornerSide>(["ne", "nw", "se", "sw"]);

/** Modifier clauses each relation accepts (besides `facing` and `rotate`). */
const MODIFIERS = new Map<string, readonly string[]>([
	["beside", ["gap", "distance"]],
	["against-wall", ["gap"]],
	["corner", ["gap"]],
	["center-of", []],
	["on", ["at"]],
	["facing", []],
	["rotate", []],
	["align", []],
	["distribute", ["gap", "evenly"]],
	["grid", ["gap"]],
	["around", ["radius", "evenly", "start"]],
	["symmetric", ["axis"]],
	["keep-clear", []],
	["at", []],
	["distance", []],
	["ground", ["align"]],
	["slope-limit", []],
	["elevation-range", []],
]);

/** True bearings of the compass words in `<length> north-of <place>`. */
const BEARINGS = new Map<string, number>([
	["north", 0],
	["north-east", 45],
	["northeast", 45],
	["ne", 45],
	["east", 90],
	["south-east", 135],
	["southeast", 135],
	["se", 135],
	["south", 180],
	["south-west", 225],
	["southwest", 225],
	["sw", 225],
	["west", 270],
	["north-west", 315],
	["northwest", 315],
	["nw", 315],
]);

const VERBS =
	"in-front-of, behind, left-of, right-of, against wall, corner, center-of, on, facing, rotate, align, distribute, grid, around, symmetric, keep clear, at <landmark>, <length> bearing <degrees> from <place>, <length> north-of <place>, on terrain, align to slope, slope below <degrees>, elevation between <a> and <b>";

type Head =
	| { kind: "beside"; side: SceneSide; reference: string }
	| { kind: "against-wall"; wall: WallSide }
	| { kind: "corner"; corner: CornerSide }
	| { kind: "center-of"; reference: string }
	| { kind: "on"; support: string }
	| { kind: "facing"; target: string }
	| { kind: "rotate"; degrees: number }
	| { kind: "align"; axis: "x" | "y"; reference: string }
	| { kind: "distribute"; along: "x" | "y" | WallSide }
	| { kind: "grid"; rows: number; columns: number }
	| { kind: "around"; center: string }
	| { kind: "symmetric"; about: string }
	| { kind: "at"; landmark: string }
	| { kind: "distance"; length: number; bearing: number; reference: string }
	| { kind: "ground"; align: boolean }
	| { kind: "slope-limit"; max: number }
	| { kind: "elevation-range"; min?: number; max?: number };

interface Modifiers {
	gap?: number;
	distance?: number;
	at?: SupportSpot;
	radius?: number;
	start?: number;
	axis?: "x" | "y";
	evenly?: boolean;
	facing?: string;
	rotate?: number;
	/** `align to slope` after `on terrain`. */
	align?: boolean;
}

class RelationFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly hint: string,
	) {
		super(message);
	}
}

function fail(code: string, message: string, hint: string): never {
	throw new RelationFailure(code, message, hint);
}

class RelationParser {
	constructor(
		private readonly ids: ReadonlySet<string>,
		private readonly groups: ReadonlyMap<string, string[]>,
		private readonly units: SceneUnits,
		private readonly diagnostics: DslDiagnostic[],
		private readonly landmarks: ReadonlyMap<string, SceneLandmark> = new Map(),
		private readonly geoFrame?: SceneGeoFrame,
		private readonly terrain = false,
	) {}

	parse(text: string, path: ScenePath): SceneRelation[] {
		try {
			return this.relation(text, path);
		} catch (failure) {
			if (!(failure instanceof RelationFailure)) throw failure;
			this.diagnostics.push(
				error(path, failure.code, failure.message, failure.hint, text),
			);
			return [];
		}
	}

	private relation(text: string, path: ScenePath): SceneRelation[] {
		const clauses = text
			.split(",")
			.map((clause) => clause.trim().split(/\s+/).filter(Boolean));
		if (clauses.some((clause) => clause.length === 0)) {
			fail(
				"validate.scene.relation-syntax",
				`Relation "${text}" has an empty clause.`,
				"Separate clauses with single commas.",
			);
		}
		const [first = [], ...rest] = clauses;

		if (first[0] === "keep" && first[1] === "clear") {
			// keep clear <length> between <a> and <b>
			const [, , length, between, a, and, b, ...extra] = first;
			if (between !== "between" || and !== "and" || b === undefined) {
				fail(
					"validate.scene.relation-syntax",
					`Cannot read "${first.join(" ")}".`,
					"Write `keep clear <length> between <a> and <b>`.",
				);
			}
			this.noExtra(extra);
			if (rest.length > 0) this.modifierNotAllowed("keep-clear", rest[0]);
			const pair: [string, string] = [
				this.reference(a as string),
				this.reference(b),
			];
			if (pair[0] === pair[1]) this.selfReference(pair[0]);
			return [
				{
					kind: "keep-clear",
					between: pair,
					clearance: this.length(length, "keep clear"),
					path,
				},
			];
		}

		const verbAt = first.findIndex((token, index) =>
			index % 2 === 1 ? token !== "and" : false,
		);
		if (verbAt < 0) {
			fail(
				"validate.scene.relation-syntax",
				`Relation "${text}" has no verb.`,
				`Write \`<object> <verb> …\`; verbs: ${VERBS}.`,
			);
		}
		const subjects = this.subjects(first.slice(0, verbAt));
		const head = this.head(first.slice(verbAt));
		const modifiers = this.modifiers(head.kind, rest);
		return this.build(subjects, head, modifiers, path);
	}

	private subjects(tokens: string[]): string[] {
		const out: string[] = [];
		for (const token of tokens.filter((_, index) => index % 2 === 0)) {
			for (const id of this.subject(token)) {
				if (out.includes(id)) {
					fail(
						"validate.scene.relation-syntax",
						`"${id}" is named twice in the subject.`,
						"Name each object once.",
					);
				}
				out.push(id);
			}
		}
		return out;
	}

	private head(tokens: string[]): Head {
		const [verb, ...args] = tokens;
		const words = (count: number, usage: string): string[] => {
			if (args.length !== count) {
				fail(
					"validate.scene.relation-syntax",
					`Cannot read "${tokens.join(" ")}".`,
					`Write \`${usage}\`.`,
				);
			}
			return args;
		};
		// <length> bearing <degrees> from <place> | <length> north-of <place>
		if (/^(\d+(?:\.\d+)?|\.\d+)(m|cm|mm|km)?$/.test(verb ?? "")) {
			const length = this.distance(verb);
			if (args[0] === "bearing") {
				const [, degrees, from, reference] = words(
					4,
					"<object> <length> bearing <degrees> from <place>",
				);
				if (from !== "from") {
					fail(
						"validate.scene.relation-syntax",
						`Cannot read "${tokens.join(" ")}".`,
						"Write `<object> <length> bearing <degrees> from <place>`.",
					);
				}
				return {
					kind: "distance",
					length,
					bearing: this.bearing(degrees),
					reference: reference as string,
				};
			}
			const [direction, reference] = words(
				2,
				"<object> <length> north-of <place>",
			);
			const bearing = BEARINGS.get((direction ?? "").replace(/-of$/, ""));
			if (bearing === undefined || !(direction ?? "").endsWith("-of")) {
				fail(
					"validate.scene.relation-value",
					`Cannot read direction "${direction}".`,
					"Write `<length> bearing <degrees> from <place>`, or a compass word such as north-of, north-east-of, sw-of.",
				);
			}
			return {
				kind: "distance",
				length,
				bearing,
				reference: reference as string,
			};
		}
		const side = SIDE_VERBS.get(verb ?? "");
		if (side !== undefined) {
			const [reference] = words(1, `<object> ${verb} <reference>`);
			return { kind: "beside", side, reference: reference as string };
		}
		switch (verb) {
			case "against": {
				// against wall north | against north wall
				const [a, b] = words(
					2,
					"<object> against wall <north|south|east|west>",
				);
				const name = a === "wall" ? b : b === "wall" ? a : undefined;
				return { kind: "against-wall", wall: this.wall(name) };
			}
			case "corner": {
				const [name] = words(1, "<object> corner <ne|nw|se|sw>");
				if (!CORNERS.has(name as CornerSide)) {
					fail(
						"validate.scene.relation-value",
						`Unknown corner "${name}".`,
						"Use ne, nw, se or sw.",
					);
				}
				return { kind: "corner", corner: name as CornerSide };
			}
			case "center-of": {
				const [reference] = words(1, "<object> center-of <room|object>");
				return { kind: "center-of", reference: reference as string };
			}
			case "on": {
				const [support] = words(1, "<object> on <support|terrain>");
				if (support === "terrain") {
					this.needTerrain("on terrain");
					return { kind: "ground", align: false };
				}
				return { kind: "on", support: support as string };
			}
			case "slope": {
				// slope below 15 | slope < 15° | slope <= 15
				const [op, degrees] = words(2, "<object> slope below <degrees>");
				if (!["below", "under", "<", "<=", "≤", "max"].includes(op ?? "")) {
					fail(
						"validate.scene.relation-syntax",
						`Cannot read "${tokens.join(" ")}".`,
						"Write `<object> slope below <degrees>`.",
					);
				}
				this.needTerrain("slope");
				const max = this.angle(degrees, "slope");
				if (!(max >= 0 && max < 90)) {
					fail(
						"validate.scene.relation-value",
						`A slope limit of ${max}° is not between 0° and 90°.`,
						"Give the steepest slope allowed, in degrees from level.",
					);
				}
				return { kind: "slope-limit", max };
			}
			case "elevation": {
				// elevation between <a> and <b> | elevation above <a> | elevation below <b>
				const usage =
					"<object> elevation between <a> and <b> (or above <a>, below <b>)";
				const [op, a, and, b] = args;
				this.needTerrain("elevation");
				if (op === "between" && and === "and" && args.length === 4) {
					const min = this.elevation(a);
					const max = this.elevation(b);
					if (min > max) {
						fail(
							"validate.scene.relation-value",
							`Elevation between ${a} and ${b}: the first is higher than the second.`,
							"Give the lower elevation first.",
						);
					}
					return { kind: "elevation-range", min, max };
				}
				if (args.length === 2 && ["above", ">", ">=", "≥"].includes(op ?? "")) {
					return { kind: "elevation-range", min: this.elevation(a) };
				}
				if (args.length === 2 && ["below", "<", "<=", "≤"].includes(op ?? "")) {
					return { kind: "elevation-range", max: this.elevation(a) };
				}
				return fail(
					"validate.scene.relation-syntax",
					`Cannot read "${tokens.join(" ")}".`,
					`Write \`${usage}\`.`,
				);
			}
			case "facing": {
				const [target] = words(
					1,
					"<object> facing <object|north|south|east|west>",
				);
				return { kind: "facing", target: target as string };
			}
			case "rotate": {
				const [degrees] = words(1, "<object> rotate <degrees>");
				return { kind: "rotate", degrees: this.angle(degrees, "rotate") };
			}
			case "align": {
				if (args[0] === "to" && args[1] === "slope" && args.length === 2) {
					this.needTerrain("align to slope");
					return { kind: "ground", align: true };
				}
				const [axis, with_, reference] = words(
					3,
					"<objects> align <x|y> with <reference>",
				);
				if (with_ !== "with") {
					fail(
						"validate.scene.relation-syntax",
						`Cannot read "${tokens.join(" ")}".`,
						"Write `<objects> align <x|y> with <reference>`.",
					);
				}
				return {
					kind: "align",
					axis: this.axis(axis),
					reference: reference as string,
				};
			}
			case "distribute": {
				// distribute [evenly] along <x|y|wall side>
				const rest = args[0] === "evenly" ? args.slice(1) : args;
				const usage = "<group> distribute evenly along <x|y|wall north|…>";
				if (rest[0] !== "along" || rest.length < 2 || rest.length > 3) {
					fail(
						"validate.scene.relation-syntax",
						`Cannot read "${tokens.join(" ")}".`,
						`Write \`${usage}\`.`,
					);
				}
				const target = rest.slice(1);
				if (target.length === 1 && (target[0] === "x" || target[0] === "y")) {
					return { kind: "distribute", along: target[0] };
				}
				const name =
					target.length === 1
						? target[0]
						: target[0] === "wall"
							? target[1]
							: target[1] === "wall"
								? target[0]
								: undefined;
				return { kind: "distribute", along: this.wall(name) };
			}
			case "grid": {
				const [shape] = words(1, "<group> grid <rows>x<columns>");
				const match = /^(\d+)x(\d+)$/.exec(shape as string);
				const rows = Number(match?.[1]);
				const columns = Number(match?.[2]);
				if (
					!(rows >= 1 && columns >= 1) ||
					!Number.isSafeInteger(rows * columns)
				) {
					fail(
						"validate.scene.relation-value",
						`Cannot read grid size "${shape}".`,
						"Write rows x columns as one word, e.g. `grid 2x3`.",
					);
				}
				return { kind: "grid", rows, columns };
			}
			case "around": {
				const [center] = words(
					1,
					"<group> around <object|landmark>, radius <length>",
				);
				return { kind: "around", center: center as string };
			}
			case "at": {
				const [landmark] = words(1, "<object> at <landmark>");
				return { kind: "at", landmark: landmark as string };
			}
			case "symmetric": {
				const [about, reference] = words(
					2,
					"<a> and <b> symmetric about <object|room>",
				);
				if (about !== "about") {
					fail(
						"validate.scene.relation-syntax",
						`Cannot read "${tokens.join(" ")}".`,
						"Write `<a> and <b> symmetric about <object|room>`.",
					);
				}
				return { kind: "symmetric", about: reference as string };
			}
			default: {
				const near = closest(verb ?? "", VERBS.split(", "));
				fail(
					"validate.scene.unknown-verb",
					`Unknown relation verb "${verb}".`,
					near.length > 0
						? `Did you mean "${near[0]}"? Verbs: ${VERBS}.`
						: `Verbs: ${VERBS}.`,
				);
			}
		}
	}

	private modifiers(kind: Head["kind"], clauses: string[][]): Modifiers {
		const allowed = MODIFIERS.get(kind) ?? [];
		const out: Modifiers = {};
		for (const clause of clauses) {
			const [name, ...args] = clause;
			if (
				name !== "facing" &&
				name !== "rotate" &&
				!allowed.includes(name ?? "")
			) {
				this.modifierNotAllowed(kind, clause);
			}
			if ((out as Record<string, unknown>)[name as string] !== undefined) {
				fail(
					"validate.scene.relation-syntax",
					`"${name}" is given twice.`,
					"Give each modifier once.",
				);
			}
			if (name === "evenly") {
				this.noExtra(args);
				out.evenly = true;
				continue;
			}
			if (name === "align") {
				if (args[0] !== "to" || args[1] !== "slope" || args.length !== 2) {
					fail(
						"validate.scene.relation-syntax",
						`Cannot read "${clause.join(" ")}".`,
						"Write `align to slope`.",
					);
				}
				out.align = true;
				continue;
			}
			if (args.length !== 1) {
				fail(
					"validate.scene.relation-syntax",
					`Cannot read "${clause.join(" ")}".`,
					`Write \`${name} <value>\`.`,
				);
			}
			const arg = args[0] as string;
			switch (name) {
				case "gap":
				case "distance":
				case "radius":
					out[name] = this.length(arg, name);
					break;
				case "start":
				case "rotate":
					out[name] = this.angle(arg, name);
					break;
				case "at":
					out.at = spot(arg);
					break;
				case "axis":
					out.axis = this.axis(arg);
					break;
				case "facing":
					out.facing = arg;
					break;
			}
		}
		if (out.facing !== undefined && out.rotate !== undefined) {
			fail(
				"validate.scene.relation-conflict",
				"`facing` and `rotate` both set the same turn.",
				"Keep one of them.",
			);
		}
		if (out.gap !== undefined && out.distance !== undefined) {
			fail(
				"validate.scene.relation-conflict",
				"`gap` (between sides) and `distance` (between centers) both set the same spacing.",
				"Keep one of them.",
			);
		}
		return out;
	}

	private build(
		subjects: string[],
		head: Head,
		modifiers: Modifiers,
		path: ScenePath,
	): SceneRelation[] {
		const out: SceneRelation[] = [];
		const turn = (subject: string) => {
			if (modifiers.facing !== undefined) {
				out.push({
					kind: "facing",
					subject,
					target: this.facingTarget(modifiers.facing, subject),
					path,
				});
			}
			if (modifiers.rotate !== undefined) {
				out.push({ kind: "rotate", subject, degrees: modifiers.rotate, path });
			}
		};
		const each = (make: (subject: string) => SceneRelation) => {
			for (const subject of subjects) {
				out.push(make(subject));
				turn(subject);
			}
			return out;
		};
		const gap = modifiers.gap ?? 0;
		switch (head.kind) {
			case "beside": {
				const reference = this.reference(head.reference);
				return each((subject) => {
					this.notSelf(subject, reference);
					return {
						kind: "beside",
						subject,
						side: head.side,
						reference,
						...(modifiers.gap === undefined ? {} : { gap: modifiers.gap }),
						...(modifiers.distance === undefined
							? {}
							: { distance: modifiers.distance }),
						path,
					};
				});
			}
			case "against-wall":
				return each((subject) => ({
					kind: "against-wall",
					subject,
					wall: head.wall,
					gap,
					path,
				}));
			case "corner":
				return each((subject) => ({
					kind: "corner",
					subject,
					corner: head.corner,
					gap,
					path,
				}));
			case "center-of": {
				const reference =
					head.reference === "room" ? "room" : this.reference(head.reference);
				return each((subject) => {
					this.notSelf(subject, reference);
					return { kind: "center-of", subject, reference, path };
				});
			}
			case "on": {
				const support = this.reference(head.support);
				return each((subject) => {
					this.notSelf(subject, support);
					return {
						kind: "on",
						subject,
						support,
						at: modifiers.at ?? "center",
						path,
					};
				});
			}
			case "facing":
				if (modifiers.facing !== undefined || modifiers.rotate !== undefined) {
					this.modifierNotAllowed("facing", [
						modifiers.facing === undefined ? "rotate" : "facing",
					]);
				}
				return each((subject) => ({
					kind: "facing",
					subject,
					target: this.facingTarget(head.target, subject),
					path,
				}));
			case "rotate":
				if (modifiers.facing !== undefined || modifiers.rotate !== undefined) {
					this.modifierNotAllowed("rotate", [
						modifiers.facing === undefined ? "rotate" : "facing",
					]);
				}
				return each((subject) => ({
					kind: "rotate",
					subject,
					degrees: head.degrees,
					path,
				}));
			case "align": {
				const reference = this.reference(head.reference);
				for (const subject of subjects) this.notSelf(subject, reference);
				out.push({
					kind: "align",
					subjects,
					axis: head.axis,
					reference,
					path,
				});
				break;
			}
			case "distribute":
				this.atLeast(subjects, 2, "distribute");
				out.push({
					kind: "distribute",
					subjects,
					along: head.along,
					...(modifiers.gap === undefined ? {} : { gap: modifiers.gap }),
					path,
				});
				break;
			case "grid":
				if (subjects.length > head.rows * head.columns) {
					fail(
						"validate.scene.relation-value",
						`A ${head.rows}x${head.columns} grid has ${head.rows * head.columns} cells for ${subjects.length} objects.`,
						"Make the grid larger or place fewer objects in it.",
					);
				}
				out.push({
					kind: "grid",
					subjects,
					rows: head.rows,
					columns: head.columns,
					gap,
					path,
				});
				break;
			case "around": {
				const landmark = this.landmarks.get(head.center);
				const center = landmark?.id ?? this.reference(head.center);
				for (const subject of subjects) this.notSelf(subject, center);
				if (modifiers.radius === undefined) {
					fail(
						"validate.scene.relation-syntax",
						"`around` needs a radius.",
						"Add `, radius <length>` (center to center).",
					);
				}
				out.push({
					kind: "around",
					subjects,
					center,
					...(landmark === undefined
						? {}
						: { point: { ...landmark.position } }),
					radius: modifiers.radius,
					start: modifiers.start ?? 270,
					faceCenter:
						modifiers.facing === undefined && modifiers.rotate === undefined,
					path,
				});
				break;
			}
			case "at": {
				const landmark = this.landmark(head.landmark);
				return each((subject) => ({
					kind: "at-point",
					subject,
					point: { ...landmark.position },
					from: landmark.id,
					path,
				}));
			}
			case "distance": {
				// From a landmark: along the ellipsoid's geodesic. From an object:
				// on the local plane (true bearings, turned into the scene frame).
				const landmark = this.landmarks.get(head.reference);
				if (landmark !== undefined) {
					const frame = this.geoFrame as SceneGeoFrame;
					const at = geodesicDirect(landmark.geo, head.bearing, head.length);
					const reach = frame.reach(at);
					if (reach > GEO_REACH) {
						fail(
							"validate.scene.geo-extent",
							geoExtentMessage(reach),
							GEO_EXTENT_HINT,
						);
					}
					const point = frame.along(landmark.geo, head.bearing, head.length);
					return each((subject) => ({
						kind: "at-point",
						subject,
						point,
						from: `${round(head.length)} m at ${round(head.bearing)}° from "${landmark.id}"`,
						path,
					}));
				}
				const reference = this.reference(head.reference);
				const offset = this.geoFrame?.offset(head.bearing, head.length) ?? {
					x: head.length * Math.sin((head.bearing * Math.PI) / 180),
					y: head.length * Math.cos((head.bearing * Math.PI) / 180),
				};
				return each((subject) => {
					this.notSelf(subject, reference);
					return {
						kind: "offset",
						subject,
						reference,
						dx: offset.x,
						dy: offset.y,
						path,
					};
				});
			}
			case "ground":
				return each((subject) => ({
					kind: "ground",
					subject,
					align: head.align || modifiers.align === true,
					path,
				}));
			case "slope-limit":
				return each((subject) => ({
					kind: "slope-limit",
					subject,
					max: head.max,
					path,
				}));
			case "elevation-range":
				return each((subject) => ({
					kind: "elevation-range",
					subject,
					...(head.min === undefined ? {} : { min: head.min }),
					...(head.max === undefined ? {} : { max: head.max }),
					path,
				}));
			case "symmetric": {
				const about =
					head.about === "room" ? "room" : this.reference(head.about);
				if (subjects.length !== 2) {
					fail(
						"validate.scene.relation-value",
						`\`symmetric\` pairs two objects; got ${subjects.length}.`,
						"Name exactly two objects: `<a> and <b> symmetric about <object|room>`.",
					);
				}
				for (const subject of subjects) this.notSelf(subject, about);
				out.push({
					kind: "symmetric",
					subjects: subjects as [string, string],
					about,
					...(modifiers.axis === undefined ? {} : { axis: modifiers.axis }),
					path,
				});
				break;
			}
		}
		for (const subject of subjects) turn(subject);
		return out;
	}

	/** An object or a `count` group (all its members). */
	private subject(token: string): string[] {
		const members = this.groups.get(token);
		if (members !== undefined) return members;
		if (this.ids.has(token)) return [token];
		return this.unknown(token);
	}

	/** One object: a group is not a reference. */
	private reference(token: string): string {
		if (this.ids.has(token)) return token;
		const members = this.groups.get(token);
		if (members !== undefined) {
			fail(
				"validate.scene.group-reference",
				`"${token}" is a group of ${members.length} objects, not one object.`,
				`Name one of them (${members.slice(0, 3).join(", ")}${members.length > 3 ? ", …" : ""}).`,
			);
		}
		return this.unknown(token);
	}

	private unknown(token: string): never {
		const near = closest(token, [...this.ids, ...this.groups.keys()]);
		fail(
			"validate.scene.unknown-object",
			`Unknown object "${token}".`,
			near.length > 0
				? `Did you mean ${near.map((id) => `"${id}"`).join(" or ")}? Declare every object under \`objects\`.`
				: "Declare every object under `objects`.",
		);
	}

	private facingTarget(
		token: string,
		subject: string,
	):
		| { object: string }
		| { direction: WallSide }
		| { landmark: string; point: { x: number; y: number } } {
		const direction = WALLS.get(token);
		if (direction !== undefined && token.length > 1) return { direction };
		const landmark = this.landmarks.get(token);
		if (landmark !== undefined) {
			return { landmark: landmark.id, point: { ...landmark.position } };
		}
		const object = this.reference(token);
		this.notSelf(subject, object);
		return { object };
	}

	private wall(name: string | undefined): WallSide {
		const wall = WALLS.get(name ?? "");
		if (wall === undefined) {
			fail(
				"validate.scene.relation-value",
				`Unknown wall "${name ?? ""}".`,
				"Use north, south, east or west (n, s, e, w).",
			);
		}
		return wall;
	}

	private axis(name: string | undefined): "x" | "y" {
		if (name !== "x" && name !== "y") {
			fail(
				"validate.scene.relation-value",
				`Unknown axis "${name ?? ""}".`,
				"Use x (east-west) or y (north-south).",
			);
		}
		return name;
	}

	/** A length in the document's units, or with an m/cm/mm suffix. */
	private length(token: string | undefined, what: string): number {
		const match = /^(\d+(?:\.\d+)?|\.\d+)(m|cm|mm)?$/.exec(token ?? "");
		if (match === null) {
			fail(
				"validate.scene.relation-value",
				`\`${what}\` needs a length; got "${token ?? ""}".`,
				`Write a non-negative number, in ${this.units} or with an m, cm or mm suffix.`,
			);
		}
		const unit = (match[2] as SceneUnits | undefined) ?? this.units;
		const value = Number(match[1]) / PER_METER[unit];
		if (!Number.isFinite(value)) this.tooLarge(token, what);
		return value;
	}

	/** An elevation: a signed length (the ground may lie below sea level). */
	private elevation(token: string | undefined): number {
		const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(m|cm|mm)?$/.exec(token ?? "");
		if (match === null) {
			fail(
				"validate.scene.relation-value",
				`\`elevation\` needs a height; got "${token ?? ""}".`,
				`Write a number, in ${this.units} or with an m, cm or mm suffix.`,
			);
		}
		const unit = (match[2] as SceneUnits | undefined) ?? this.units;
		const value = Number(match[1]) / PER_METER[unit];
		if (!Number.isFinite(value)) this.tooLarge(token, "elevation");
		return value;
	}

	private needTerrain(what: string): void {
		if (this.terrain) return;
		fail(
			"validate.scene.terrain-missing",
			`\`${what}\` needs ground to stand on, but the scene has no \`terrain\`.`,
			"Add `terrain: { grid: { spacing, heights } }`.",
		);
	}

	private landmark(token: string): SceneLandmark {
		const landmark = this.landmarks.get(token);
		if (landmark !== undefined) return landmark;
		const near = closest(token, [...this.landmarks.keys()]);
		fail(
			"validate.scene.unknown-landmark",
			`Unknown landmark "${token}".`,
			near.length > 0
				? `Did you mean "${near[0]}"? Declare landmarks under \`landmarks\`.`
				: "Declare landmarks (with latitude and longitude) under `landmarks`, in a scene with a `frame`.",
		);
	}

	/** A length that may also be in km (for distances on a site). */
	private distance(token: string | undefined): number {
		const match = /^(\d+(?:\.\d+)?|\.\d+)km$/.exec(token ?? "");
		if (match !== null) {
			const value = Number(match[1]) * 1000;
			if (!Number.isFinite(value)) this.tooLarge(token, "distance");
			return value;
		}
		return this.length(token, "distance");
	}

	/** A true bearing in degrees clockwise from north; `deg` or `°` may follow. */
	private bearing(token: string | undefined): number {
		const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(?:deg|°)?$/.exec(token ?? "");
		if (match === null) {
			fail(
				"validate.scene.relation-value",
				`\`bearing\` needs degrees; got "${token ?? ""}".`,
				"Write degrees clockwise from north, e.g. `bearing 30`.",
			);
		}
		const value = Number(match[1]);
		if (!Number.isFinite(value)) this.tooLarge(token, "bearing");
		return ((value % 360) + 360) % 360;
	}

	/** Degrees, counter-clockwise; `deg` or `°` may follow. */
	private angle(token: string | undefined, what: string): number {
		const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(?:deg|°)?$/.exec(token ?? "");
		if (match === null) {
			fail(
				"validate.scene.relation-value",
				`\`${what}\` needs an angle in degrees; got "${token ?? ""}".`,
				"Write a number of degrees, counter-clockwise seen from above.",
			);
		}
		const value = Number(match[1]);
		if (!Number.isFinite(value)) this.tooLarge(token, what);
		return value;
	}

	private tooLarge(token: string | undefined, what: string): never {
		fail(
			"validate.scene.relation-value",
			`\`${what}\` value "${(token ?? "").slice(0, 24)}${(token ?? "").length > 24 ? "…" : ""}" is too large.`,
			"Write a number of reasonable size.",
		);
	}

	private notSelf(subject: string, reference: string): void {
		if (subject === reference) this.selfReference(subject);
	}

	private selfReference(id: string): never {
		fail(
			"validate.scene.self-reference",
			`"${id}" cannot be placed relative to itself.`,
			"Use a different reference object.",
		);
	}

	private atLeast(subjects: string[], count: number, verb: string): void {
		if (subjects.length < count) {
			fail(
				"validate.scene.relation-value",
				`\`${verb}\` needs at least ${count} objects; got ${subjects.length}.`,
				"Name a `count` group or several objects joined with `and`.",
			);
		}
	}

	private noExtra(tokens: string[]): void {
		if (tokens.length > 0) {
			fail(
				"validate.scene.relation-syntax",
				`Unexpected "${tokens.join(" ")}".`,
				"Separate further clauses with commas.",
			);
		}
	}

	private modifierNotAllowed(
		kind: string,
		clause: string[] | undefined,
	): never {
		const allowed = [...(MODIFIERS.get(kind) ?? [])];
		if (kind !== "keep-clear" && kind !== "facing" && kind !== "rotate") {
			allowed.push("facing", "rotate");
		}
		fail(
			"validate.scene.relation-modifier",
			`\`${kind}\` does not take "${(clause ?? []).join(" ")}".`,
			allowed.length > 0
				? `It takes: ${allowed.join(", ")}.`
				: "It takes no further clauses.",
		);
	}
}

const SPOT_ROWS = new Set(["front", "back"]);
const SPOT_COLUMNS = new Set(["left", "right"]);

/** `center`, a side, or a corner in either order (`right-back`). */
function spot(token: string): SupportSpot {
	if (token === "center") return "center";
	const parts = token.split("-");
	const row = parts.find((part) => SPOT_ROWS.has(part));
	const column = parts.find((part) => SPOT_COLUMNS.has(part));
	const known = (row === undefined ? 0 : 1) + (column === undefined ? 0 : 1);
	if (known === 0 || known !== parts.length) {
		fail(
			"validate.scene.relation-value",
			`Unknown spot "${token}".`,
			"Use center, front, back, left, right, or a corner such as back-right.",
		);
	}
	return [row, column].filter(Boolean).join("-") as SupportSpot;
}

interface PathNames {
	objects: ReadonlySet<string>;
	groups: ReadonlyMap<string, string[]>;
	openings: ReadonlySet<string>;
	agents: ReadonlySet<string>;
}

/**
 * `<agent> from <place> to <place>[, via <place> and <place>][, clearance
 * <length>][, comfort <length>][, start <seconds>][, orthogonal]`, where a
 * place is an object or an opening.
 */
function parsePaths(
	lines: readonly string[],
	names: PathNames,
	units: SceneUnits,
	diagnostics: DslDiagnostic[],
): ScenePathSpec[] {
	const out: ScenePathSpec[] = [];
	const ids = new Map<string, number>();
	const place = (token: string | undefined): string => {
		if (
			token !== undefined &&
			(names.objects.has(token) || names.openings.has(token))
		) {
			return token;
		}
		const members = token === undefined ? undefined : names.groups.get(token);
		if (members !== undefined) {
			fail(
				"validate.scene.group-reference",
				`"${token}" is a group of ${members.length} objects, not one place.`,
				`Name one of them (${members.slice(0, 3).join(", ")}${members.length > 3 ? ", …" : ""}).`,
			);
		}
		const near = closest(token ?? "", [...names.objects, ...names.openings]);
		fail(
			"validate.scene.unknown-place",
			`Unknown place "${token ?? ""}".`,
			near.length > 0
				? `Did you mean ${near.map((id) => `"${id}"`).join(" or ")}? A path goes between objects and openings.`
				: "A path goes between objects and openings (declare openings under `openings`).",
		);
	};
	lines.forEach((text, index) => {
		const path: ScenePath = ["paths", index];
		try {
			const clauses = text
				.split(",")
				.map((clause) => clause.trim().split(/\s+/).filter(Boolean));
			const [head = [], ...rest] = clauses;
			const [agent, fromWord, from, toWord, to, ...extra] = head;
			if (
				fromWord !== "from" ||
				toWord !== "to" ||
				to === undefined ||
				extra.length > 0
			) {
				fail(
					"validate.scene.path-syntax",
					`Cannot read "${head.join(" ")}".`,
					"Write `<agent> from <place> to <place>`, then clauses after commas.",
				);
			}
			if (!names.agents.has(agent as string)) {
				const near = closest(agent as string, [...names.agents]);
				fail(
					"validate.scene.unknown-agent",
					`Unknown agent "${agent}".`,
					near.length > 0
						? `Did you mean "${near[0]}"? Declare agents under \`agents\` (person is built in).`
						: "Declare agents under `agents` (person is built in).",
				);
			}
			const spec: Omit<ScenePathSpec, "id"> = {
				agent: agent as string,
				from: place(from),
				to: place(to),
				via: [],
				clearance: 0,
				orthogonal: false,
				comfort: DEFAULT_COMFORT,
				path,
			};
			if (spec.from === spec.to) {
				fail(
					"validate.scene.path-syntax",
					`The path starts and ends at "${spec.from}".`,
					"Give two different places.",
				);
			}
			const seen = new Set<string>();
			for (const clause of rest) {
				const [name, ...args] = clause;
				if (name === undefined || seen.has(name)) {
					fail(
						"validate.scene.path-syntax",
						name === undefined
							? "An empty clause."
							: `"${name}" is given twice.`,
						"Separate clauses with single commas; give each once.",
					);
				}
				seen.add(name);
				if (name === "orthogonal" && args.length === 0) {
					spec.orthogonal = true;
				} else if (name === "clearance" && args.length === 1) {
					spec.clearance = pathLength(args[0] as string, units, name);
				} else if (name === "comfort" && args.length === 1) {
					spec.comfort = pathLength(args[0] as string, units, name);
				} else if (name === "start" && args.length === 1) {
					spec.start = seconds(args[0] as string);
				} else if (name === "via" && args.length % 2 === 1) {
					spec.via = args.filter((_, k) => k % 2 === 0).map(place);
					if (args.some((word, k) => k % 2 === 1 && word !== "and")) {
						fail(
							"validate.scene.path-syntax",
							`Cannot read "${clause.join(" ")}".`,
							"Write `via <place> and <place>`.",
						);
					}
				} else {
					fail(
						"validate.scene.path-syntax",
						`Unknown clause "${clause.join(" ")}".`,
						"Paths take: via <place> [and <place>], clearance <length>, comfort <length>, start <seconds>, orthogonal.",
					);
				}
			}
			const base = `${spec.agent}:${spec.from}->${spec.to}`;
			const count = (ids.get(base) ?? 0) + 1;
			ids.set(base, count);
			out.push({ id: count === 1 ? base : `${base}#${count}`, ...spec });
		} catch (failure) {
			if (!(failure instanceof RelationFailure)) throw failure;
			diagnostics.push(
				error(path, failure.code, failure.message, failure.hint, text),
			);
		}
	});
	return out;
}

/**
 * Latest `start`, seconds. Times are kept to 0.1 ms; well below this
 * bound that precision holds.
 */
const MAX_START = 1_000_000;

/** A time in seconds: `2`, `2.5s`. */
function seconds(token: string): number {
	const match = /^(\d+(?:\.\d+)?|\.\d+)s?$/.exec(token);
	const value = match === null ? Number.NaN : Number(match[1]);
	if (!Number.isFinite(value)) {
		fail(
			"validate.scene.relation-value",
			`\`start\` needs a time; got "${token.slice(0, 24)}".`,
			"Write a non-negative number of seconds, e.g. `start 2` or `start 2.5s`.",
		);
	}
	if (value > MAX_START) {
		fail(
			"validate.scene.relation-value",
			`\`start ${token.slice(0, 24)}\` is later than ${MAX_START} s (about 11.6 days), the latest start supported.`,
			"Count time from the start of the schedule.",
		);
	}
	return value;
}

function pathLength(token: string, units: SceneUnits, clause: string): number {
	const match = /^(\d+(?:\.\d+)?|\.\d+)(m|cm|mm)?$/.exec(token);
	const value =
		match === null
			? Number.NaN
			: Number(match[1]) /
				PER_METER[(match[2] as SceneUnits | undefined) ?? units];
	if (!Number.isFinite(value)) {
		fail(
			"validate.scene.relation-value",
			`\`${clause}\` needs a length; got "${token.slice(0, 24)}".`,
			`Write a non-negative number, in ${units} or with an m, cm or mm suffix.`,
		);
	}
	return value;
}

function error(
	path: ScenePath,
	code: string,
	message: string,
	hint: string,
	relation?: string,
): DslDiagnostic {
	return {
		severity: "error",
		layer: "validate",
		code,
		message,
		path,
		hint,
		...(relation === undefined ? {} : { detail: { relation } }),
	};
}

const GEO_EXTENT_HINT =
	"Check the coordinates (and the datum), or give a far site a scene with its own origin.";

function geoExtentMessage(reach: number): string {
	return `This point is ${round(reach / 1000)} km from the frame origin; one local frame places points within ${GEO_REACH / 1000} km.`;
}

function geoExtent(path: ScenePath, reach: number): DslDiagnostic {
	return {
		...error(
			path,
			"validate.scene.geo-extent",
			geoExtentMessage(reach),
			GEO_EXTENT_HINT,
		),
		detail: { reach: Math.round(reach) },
	};
}

function hasErrors(diagnostics: readonly DslDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function round(value: number): number {
	return Math.round(value * 1e4) / 1e4;
}
