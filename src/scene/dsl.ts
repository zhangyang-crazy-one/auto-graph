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
import type {
	CornerSide,
	SceneAgent,
	SceneObject,
	SceneOpening,
	ScenePath,
	ScenePathSpec,
	SceneRelation,
	SceneSide,
	SceneSpec,
	SceneUnits,
	SupportSpot,
	WallSide,
} from "./ir.js";

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().min(0);

/** Words a relation reads specially; no object may be called one. */
const RESERVED_IDS = new Set(["room", "north", "south", "east", "west"]);

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
		if (entry.count === undefined) {
			taken.set(id, path);
			objects.push({
				id,
				...base,
				...(entry.position === undefined
					? {}
					: {
							position: entry.position.map((v) => v / perMeter) as [
								number,
								number,
							],
						}),
				...(entry.yaw === undefined ? {} : { yaw: entry.yaw }),
				path,
			});
			continue;
		}
		if (entry.position !== undefined) {
			diagnostics.push(
				error(
					[...path, "position"],
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

	const parser = new RelationParser(
		new Set(objects.map((object) => object.id)),
		groups,
		units,
		diagnostics,
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
		} else {
			openings.push(opening);
		}
	}
	const agents: SceneAgent[] = Object.entries({
		person: DEFAULT_PERSON,
		...(dsl.agents ?? {}),
	}).map(([id, entry]) => {
		const scale = dsl.agents?.[id] === undefined ? 1 : perMeter;
		return {
			id,
			radius: entry.radius / scale,
			height: entry.height / scale,
			speed: (entry.speed ?? DEFAULT_SPEED * scale) / scale,
			accel: (entry.accel ?? DEFAULT_ACCEL * scale) / scale,
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
		},
		diagnostics: sortDslDiagnostics(diagnostics),
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
]);

const VERBS =
	"in-front-of, behind, left-of, right-of, against wall, corner, center-of, on, facing, rotate, align, distribute, grid, around, symmetric, keep clear";

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
	| { kind: "symmetric"; about: string };

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
				const [support] = words(1, "<object> on <support>");
				return { kind: "on", support: support as string };
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
				const [center] = words(1, "<group> around <object>, radius <length>");
				return { kind: "around", center: center as string };
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
				const center = this.reference(head.center);
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
					radius: modifiers.radius,
					start: modifiers.start ?? 270,
					faceCenter:
						modifiers.facing === undefined && modifiers.rotate === undefined,
					path,
				});
				break;
			}
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
	): { object: string } | { direction: WallSide } {
		const direction = WALLS.get(token);
		if (direction !== undefined && token.length > 1) return { direction };
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

function hasErrors(diagnostics: readonly DslDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
