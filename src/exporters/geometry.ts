import { z } from "zod";
import {
	EDGE_CROSSING_END_CUTOFF,
	hopGlyphs,
} from "../geometry/edge-crossings.js";
import {
	actorFigure,
	fragmentTagPoints,
	noteOutlinePoints,
} from "../geometry/sequence-shapes.js";
import { cylinderCapRadius, shapeSkew } from "../geometry/shapes.js";
import type { Box, Point, PreviousLayout } from "../ir/geometry.js";
import {
	type CoordinatedDiagram,
	type CoordinatedEdge,
	type CoordinatedNode,
	type CoordinatedSequence,
	type EdgeCrossing,
	SEQUENCE_DESTRUCTION_HALF_SIZE,
	SEQUENCE_NOTE_FOLD,
	SEQUENCE_TAG_CUT,
	type SolvedTextAnnotation,
} from "../ir/index.js";
import { previousLayoutOf } from "../layout/global/previous.js";
import { measureLayoutQuality } from "../quality/layout-metrics.js";
import { computeArrowhead } from "./arrow.js";
import { groupsOuterFirst } from "./group-order.js";
import { labelBackdropBox } from "./label-backdrop.js";

/**
 * Geometry contract v1: everything a renderer needs, already solved.
 *
 * The document is plain numbers in one coordinate system (px, origin top
 * left, y down): outlines as primitives and as path commands, container
 * rectangles, edge routes with line jumps cut in, arrowhead triangles,
 * every text line with its baseline, backdrop boxes and the paint order.
 * Drawing it is a loop over `zOrder` that emits rectangles, paths and text
 * runs; no renderer has to measure text, route lines or place labels.
 *
 * The contract is versioned: fields are only added within `version: 1`;
 * anything that changes meaning bumps the version.
 */
export const GEOMETRY_FORMAT = "dge-geometry";
export const GEOMETRY_VERSION = 1;

const point = z.object({ x: z.number(), y: z.number() });
const box = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});
const side = z.enum(["top", "right", "bottom", "left"]);

/** SVG-style path commands with absolute coordinates. */
const pathCommand = z.discriminatedUnion("op", [
	z.object({ op: z.literal("M"), x: z.number(), y: z.number() }),
	z.object({ op: z.literal("L"), x: z.number(), y: z.number() }),
	z.object({
		op: z.literal("A"),
		rx: z.number(),
		ry: z.number(),
		rotation: z.number(),
		largeArc: z.boolean(),
		sweep: z.boolean(),
		x: z.number(),
		y: z.number(),
	}),
	z.object({ op: z.literal("Z") }),
]);

const outline = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("rect"), box, cornerRadius: z.number() }),
	z.object({
		kind: z.literal("ellipse"),
		cx: z.number(),
		cy: z.number(),
		rx: z.number(),
		ry: z.number(),
	}),
	z.object({ kind: z.literal("polygon"), points: z.array(point) }),
	z.object({
		kind: z.literal("cylinder"),
		box,
		/** Vertical radius of the top and bottom caps. */
		capRadius: z.number(),
	}),
]);

const textLine = z.object({
	text: z.string(),
	/** Left edge of the line's ink box. */
	x: z.number(),
	/** Baseline. */
	y: z.number(),
	width: z.number(),
	/** Line box (top = baseline - ascent). */
	box,
});

const textBlock = z.object({
	id: z.string(),
	ownerId: z.string(),
	surface: z.enum([
		"node-label",
		"group-label",
		"port-label",
		"edge-label",
		"compartment-row",
		"swimlane-label",
		"frame-title",
		"sequence-note",
		"fragment-tag",
		"fragment-guard",
		"sequence-divider",
	]),
	text: z.string(),
	/** Box reserved for the text (padding included). */
	box,
	font: z.object({ family: z.string(), size: z.number() }),
	/** Lines are centred in `box` horizontally. */
	align: z.enum(["center", "start", "end"]),
	lines: z.array(textLine),
	/** Opaque box to paint behind the text, when it may sit over lines. */
	backdrop: box.nullable(),
	/** Rotation in degrees about the centre of `box` (0 or -90). */
	rotation: z.number(),
});

const endpoint = z.object({
	nodeId: z.string(),
	portId: z.string().optional(),
	point,
	/** Side of the node (or port) box the route leaves or enters. */
	side,
});

const node = z.object({
	id: z.string(),
	shape: z.string(),
	box,
	outline,
	/** Outline as path commands (fill this; draw it for the stroke). */
	path: z.array(pathCommand),
	/** Stroke `path` without filling it (an actor's stick figure). */
	strokeOnly: z.boolean().optional(),
	parentId: z.string().optional(),
	ports: z.array(
		z.object({
			id: z.string(),
			side,
			kind: z.string(),
			box,
			anchor: point,
		}),
	),
	labelId: z.string().optional(),
});

const container = z.object({
	id: z.string(),
	kind: z.enum(["group", "swimlane", "lane"]),
	box,
	parentId: z.string().optional(),
	/** Lane header strip (lanes only). */
	headerBox: box.optional(),
	nodeIds: z.array(z.string()),
	containerIds: z.array(z.string()),
	labelId: z.string().optional(),
});

const edge = z.object({
	id: z.string(),
	source: endpoint,
	target: endpoint,
	/** The solved orthogonal route, source to target. */
	points: z.array(point),
	/**
	 * What to stroke: the route shortened to the arrowhead base, with jumps
	 * over crossing edges (arcs) or gaps cut in.
	 */
	path: z.array(pathCommand),
	style: z.enum(["solid", "dashed"]),
	arrowheads: z.array(
		z.object({
			at: z.enum(["source", "target"]),
			/** `open`: stroke left → tip → right, no fill (the route runs to the tip). */
			fill: z.enum(["filled", "hollow", "open"]),
			tip: point,
			/** Triangle: tip, left, right. */
			points: z.array(point),
		}),
	),
	crossings: z.array(
		z.object({
			at: point,
			overEdgeId: z.string(),
			style: z.enum(["jump", "gap", "bridge"]),
		}),
	),
	labelId: z.string().optional(),
});

const segment = z.object({
	x1: z.number(),
	y1: z.number(),
	x2: z.number(),
	y2: z.number(),
});

/** Sequence diagrams: everything drawn besides heads (nodes) and messages (edges). */
const sequence = z.object({
	/** Dashed vertical lines. */
	lifelines: z.array(
		z.object({
			participantId: z.string(),
			kind: z.enum(["participant", "actor", "database"]),
			line: segment,
			created: z.boolean(),
			destroyed: z.boolean(),
		}),
	),
	activations: z.array(
		z.object({
			id: z.string(),
			participantId: z.string(),
			depth: z.number(),
			box,
		}),
	),
	/** Outermost first. `ref` fragments are filled; the others are not. */
	fragments: z.array(
		z.object({
			id: z.string(),
			kind: z.string(),
			box,
			/** Operator tag outline (a pentagon), filled. */
			tag: z.array(point),
			/** Dashed separators between operands. */
			separators: z.array(segment),
			depth: z.number(),
			tagTextId: z.string().optional(),
			guardTextIds: z.array(z.string()),
		}),
	),
	notes: z.array(
		z.object({
			id: z.string(),
			box,
			/** Outline (filled) and the fold line. */
			path: z.array(pathCommand),
			textId: z.string().optional(),
		}),
	),
	/** Double rules across the diagram, with an optional boxed text. */
	dividers: z.array(
		z.object({
			id: z.string(),
			lines: z.array(segment),
			box: box.optional(),
			textId: z.string().optional(),
		}),
	),
	/** X marks where lifelines end. */
	destructions: z.array(
		z.object({
			participantId: z.string(),
			at: point,
			lines: z.array(segment),
		}),
	),
	messageOrder: z.array(z.string()),
});

const paint = z.object({
	kind: z.enum([
		"container",
		"edge",
		"node",
		"port",
		"backdrop",
		"text",
		"lifeline",
		"activation",
		"fragment",
		"note",
		"divider",
		"destruction",
	]),
	id: z.string(),
});

export const geometryDocumentSchema = z.object({
	format: z.literal(GEOMETRY_FORMAT),
	version: z.literal(GEOMETRY_VERSION),
	units: z.literal("px"),
	coordinateSystem: z.object({
		origin: z.literal("top-left"),
		yAxis: z.literal("down"),
	}),
	id: z.string(),
	title: z.string().optional(),
	direction: z.enum(["LR", "RL", "TB", "BT"]),
	/** Everything drawn, arrowheads and jump arcs included. */
	bounds: box,
	nodes: z.array(node),
	containers: z.array(container),
	edges: z.array(edge),
	texts: z.array(textBlock),
	/** Present for sequence diagrams. */
	sequence: sequence.optional(),
	/** Back to front. */
	zOrder: z.array(paint),
	metrics: z.record(z.string(), z.number()),
	diagnostics: z.array(
		z.object({
			severity: z.enum(["error", "warning", "info"]),
			code: z.string(),
			message: z.string(),
		}),
	),
	/** Diagram parts this version does not describe (drawn by exporters). */
	omitted: z.array(z.string()),
	/**
	 * A split diagram (`remediationPolicy.pageSplit: auto`): every page as
	 * a document of its own, page 1 first (the top level describes page 1).
	 */
	get pages() {
		return z.array(geometryDocumentSchema).optional();
	},
});

export type GeometryDocument = z.infer<typeof geometryDocumentSchema>;
export type GeometryPathCommand = z.infer<typeof pathCommand>;

/** JSON Schema (draft 2020-12) of the geometry contract. */
export function geometryJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(geometryDocumentSchema) as Record<string, unknown>;
}

/**
 * Read a geometry document (e.g. a previous `--format geometry` output)
 * back as the previous layout of the next solve.
 */
export function previousLayoutFromGeometry(
	value: unknown,
): { layout: PreviousLayout } | { error: string } {
	const parsed = geometryDocumentSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			error: `Not a ${GEOMETRY_FORMAT} v${GEOMETRY_VERSION} document${
				issue === undefined
					? ""
					: ` (${issue.path.join(".") || "root"}: ${issue.message})`
			}.`,
		};
	}
	return { layout: previousLayoutOf(parsed.data) };
}

/** Radius of the jump arc drawn where an edge passes under another. */
const JUMP_RADIUS = 6;
const ROUNDED_CORNER_RADIUS = 8;

export function exportGeometry(diagram: CoordinatedDiagram): GeometryDocument {
	const annotations = diagram.textAnnotations ?? [];
	const crossings = diagram.edgeCrossings ?? [];
	const texts = annotations.map((annotation, index) =>
		textBlockOf(annotation, index, diagram),
	);
	const textId = (surface: string, ownerId: string) =>
		texts.find(
			(text, index) =>
				text.surface === surface &&
				text.ownerId === ownerId &&
				annotations[index]?.surfaceIndex === undefined,
		)?.id;

	const nodes: GeometryDocument["nodes"] = diagram.nodes.map((item) => {
		const labelId = textId("node-label", item.id);
		const actor = item.metadata?.sequenceParticipant === "actor";
		return {
			id: item.id,
			shape: actor ? "actor" : item.shape,
			box: { ...item.box },
			outline: actor
				? { kind: "rect" as const, box: { ...item.box }, cornerRadius: 0 }
				: outlineOf(item),
			path: actor ? actorPath(item.box) : outlinePath(item),
			...(actor ? { strokeOnly: true } : {}),
			...(item.parentId === undefined ? {} : { parentId: item.parentId }),
			ports: (item.ports ?? []).map((port) => ({
				id: port.id,
				side: port.side,
				kind: port.kind,
				box: { ...port.box },
				anchor: { ...port.anchor },
			})),
			...(labelId === undefined ? {} : { labelId }),
		};
	});

	const containers: GeometryDocument["containers"] = [];
	const groupParent = new Map<string, string>();
	for (const group of diagram.groups) {
		for (const child of group.groupIds) groupParent.set(child, group.id);
	}
	// Outer containers paint first: a filled outer frame would cover the
	// ones nested in it.
	for (const group of groupsOuterFirst(diagram.groups)) {
		const labelId = textId("group-label", group.id);
		const parentId = groupParent.get(group.id);
		containers.push({
			id: group.id,
			kind: "group",
			box: { ...group.box },
			...(parentId === undefined ? {} : { parentId }),
			nodeIds: [...group.nodeIds],
			containerIds: [...group.groupIds],
			...(labelId === undefined ? {} : { labelId }),
		});
	}
	for (const swimlane of diagram.swimlanes ?? []) {
		if (swimlane.box === undefined) continue;
		const laneIds = swimlane.lanes
			.filter((lane) => lane.box !== undefined)
			.map((lane) => `${swimlane.id}.${lane.id}`);
		containers.push({
			id: swimlane.id,
			kind: "swimlane",
			box: { ...swimlane.box },
			nodeIds: [],
			containerIds: laneIds,
		});
		for (const lane of swimlane.lanes) {
			if (lane.box === undefined) continue;
			const id = `${swimlane.id}.${lane.id}`;
			const labelId = textId("swimlane-label", id);
			containers.push({
				id,
				kind: "lane",
				box: { ...lane.box },
				parentId: swimlane.id,
				...(lane.headerBox === undefined
					? {}
					: { headerBox: { ...lane.headerBox } }),
				nodeIds: [...lane.children],
				containerIds: [],
				...(labelId === undefined ? {} : { labelId }),
			});
		}
	}

	const nodeById = new Map(diagram.nodes.map((item) => [item.id, item]));
	const edges: GeometryDocument["edges"] = diagram.edges
		.filter((item) => item.points.length >= 2)
		.map((item) => edgeOf(item, nodeById, crossings, textId));

	const sequenceDoc =
		diagram.sequence === undefined
			? undefined
			: sequenceOf(diagram.sequence, texts, annotations);
	const zOrder: GeometryDocument["zOrder"] = [
		...containers.map((item) => ({ kind: "container" as const, id: item.id })),
		...(sequenceDoc === undefined
			? []
			: [
					...sequenceDoc.lifelines.map((item) => ({
						kind: "lifeline" as const,
						id: item.participantId,
					})),
					...sequenceDoc.activations.map((item) => ({
						kind: "activation" as const,
						id: item.id,
					})),
					...sequenceDoc.fragments.map((item) => ({
						kind: "fragment" as const,
						id: item.id,
					})),
				]),
		...edges.map((item) => ({ kind: "edge" as const, id: item.id })),
		...(sequenceDoc === undefined
			? []
			: [
					...sequenceDoc.notes.map((item) => ({
						kind: "note" as const,
						id: item.id,
					})),
					...sequenceDoc.dividers.map((item) => ({
						kind: "divider" as const,
						id: item.id,
					})),
					...sequenceDoc.destructions.map((item) => ({
						kind: "destruction" as const,
						id: item.participantId,
					})),
				]),
		...nodes.map((item) => ({ kind: "node" as const, id: item.id })),
		...nodes.flatMap((item) =>
			item.ports.map((port) => ({
				kind: "port" as const,
				id: `${item.id}.${port.id}`,
			})),
		),
		...texts.flatMap((text) => [
			...(text.backdrop === null
				? []
				: [{ kind: "backdrop" as const, id: text.id }]),
			{ kind: "text" as const, id: text.id },
		]),
	];

	const metrics = measureLayoutQuality(diagram) as unknown as Record<
		string,
		number
	>;
	const omitted = [
		...((diagram.matrices ?? []).length > 0 ? ["matrices"] : []),
		...((diagram.tables ?? []).length > 0 ? ["tables"] : []),
		...((diagram.evidencePanels ?? []).length > 0 ? ["evidencePanels"] : []),
		...(diagram.frame === undefined ? [] : ["frame"]),
		...(diagram.nodes.some((item) => item.compartments !== undefined)
			? ["compartments"]
			: []),
	];

	return roundNumbers({
		format: GEOMETRY_FORMAT,
		version: GEOMETRY_VERSION,
		units: "px",
		coordinateSystem: { origin: "top-left", yAxis: "down" },
		id: diagram.id,
		...(diagram.title === undefined ? {} : { title: diagram.title }),
		direction: diagram.direction,
		bounds:
			crossings.length === 0
				? { ...diagram.bounds }
				: {
						x: diagram.bounds.x - JUMP_RADIUS,
						y: diagram.bounds.y - JUMP_RADIUS,
						width: diagram.bounds.width + 2 * JUMP_RADIUS,
						height: diagram.bounds.height + 2 * JUMP_RADIUS,
					},
		nodes,
		containers,
		edges,
		texts,
		...(sequenceDoc === undefined ? {} : { sequence: sequenceDoc }),
		zOrder,
		metrics: Object.fromEntries(
			Object.entries(metrics).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number",
			),
		),
		diagnostics: diagram.diagnostics.map((diagnostic) => ({
			severity: diagnostic.severity,
			code: diagnostic.code,
			message: diagnostic.message,
		})),
		omitted,
		...(diagram.pages !== undefined && diagram.pages.length > 1
			? { pages: diagram.pages.map((page) => exportGeometry(page)) }
			: {}),
	});
}

/** Decimals kept in the document (the canonical serialization precision). */
const PRECISION = 1000;

/** Round every number to `PRECISION`, so the output is byte-stable. */
function roundNumbers<T>(value: T): T {
	if (typeof value === "number") {
		const rounded = Math.round(value * PRECISION) / PRECISION;
		return (Object.is(rounded, -0) ? 0 : rounded) as T;
	}
	if (Array.isArray(value)) return value.map(roundNumbers) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, roundNumbers(item)]),
		) as T;
	}
	return value;
}

function textBlockOf(
	annotation: SolvedTextAnnotation,
	index: number,
	diagram: CoordinatedDiagram,
): GeometryDocument["texts"][number] {
	const withBackdrop =
		annotation.surfaceKind === "edge-label" ||
		annotation.surfaceKind === "group-label" ||
		annotation.surfaceKind === "port-label";
	const rotated =
		annotation.surfaceKind === "swimlane-label" &&
		(diagram.swimlanes ?? []).some(
			(swimlane) =>
				swimlane.orientation === "horizontal" &&
				annotation.ownerId.startsWith(`${swimlane.id}.`),
		);
	return {
		id: `text:${index}`,
		ownerId: annotation.ownerId,
		surface: annotation.surfaceKind,
		text: annotation.text,
		box: { ...annotation.box },
		font: { family: annotation.fontFamily, size: annotation.fontSize },
		align: "center",
		lines: annotation.lines.map((line) => ({
			text: line.text,
			x: annotation.box.x + line.box.x,
			y: annotation.box.y + line.baselineY,
			width: line.width,
			box: {
				x: annotation.box.x + line.box.x,
				y: annotation.box.y + line.box.y,
				width: line.box.width,
				height: line.box.height,
			},
		})),
		backdrop: withBackdrop ? labelBackdropBox(annotation) : null,
		rotation: rotated ? -90 : 0,
	};
}

function outlineOf(
	item: CoordinatedNode,
): GeometryDocument["nodes"][number]["outline"] {
	const b = item.box;
	switch (item.shape) {
		case "rectangle":
			return { kind: "rect", box: { ...b }, cornerRadius: 0 };
		case "rounded-rectangle":
			return {
				kind: "rect",
				box: { ...b },
				cornerRadius: ROUNDED_CORNER_RADIUS,
			};
		case "ellipse":
			return {
				kind: "ellipse",
				cx: b.x + b.width / 2,
				cy: b.y + b.height / 2,
				rx: b.width / 2,
				ry: b.height / 2,
			};
		case "cylinder":
			return {
				kind: "cylinder",
				box: { ...b },
				capRadius: cylinderCapRadius(b),
			};
		default:
			return { kind: "polygon", points: polygonPoints(item.shape, b) };
	}
}

function polygonPoints(shape: string, b: Box): Point[] {
	const left = b.x;
	const right = b.x + b.width;
	const top = b.y;
	const bottom = b.y + b.height;
	const midX = b.x + b.width / 2;
	const midY = b.y + b.height / 2;
	const skew = shapeSkew(b);
	switch (shape) {
		case "diamond":
			return [
				{ x: midX, y: top },
				{ x: right, y: midY },
				{ x: midX, y: bottom },
				{ x: left, y: midY },
			];
		case "parallelogram":
			return [
				{ x: left + skew, y: top },
				{ x: right, y: top },
				{ x: right - skew, y: bottom },
				{ x: left, y: bottom },
			];
		case "hexagon":
			return [
				{ x: left + skew, y: top },
				{ x: right - skew, y: top },
				{ x: right, y: midY },
				{ x: right - skew, y: bottom },
				{ x: left + skew, y: bottom },
				{ x: left, y: midY },
			];
		default:
			return [
				{ x: left, y: top },
				{ x: right, y: top },
				{ x: right, y: bottom },
				{ x: left, y: bottom },
			];
	}
}

function arc(
	rx: number,
	ry: number,
	sweep: boolean,
	to: Point,
): GeometryPathCommand {
	return {
		op: "A",
		rx,
		ry,
		rotation: 0,
		largeArc: false,
		sweep,
		x: to.x,
		y: to.y,
	};
}

function outlinePath(item: CoordinatedNode): GeometryPathCommand[] {
	const outline = outlineOf(item);
	switch (outline.kind) {
		case "rect": {
			const { x, y, width, height } = outline.box;
			const r = Math.min(outline.cornerRadius, width / 2, height / 2);
			if (r <= 0) {
				return [
					{ op: "M", x, y },
					{ op: "L", x: x + width, y },
					{ op: "L", x: x + width, y: y + height },
					{ op: "L", x, y: y + height },
					{ op: "Z" },
				];
			}
			return [
				{ op: "M", x: x + r, y },
				{ op: "L", x: x + width - r, y },
				arc(r, r, true, { x: x + width, y: y + r }),
				{ op: "L", x: x + width, y: y + height - r },
				arc(r, r, true, { x: x + width - r, y: y + height }),
				{ op: "L", x: x + r, y: y + height },
				arc(r, r, true, { x, y: y + height - r }),
				{ op: "L", x, y: y + r },
				arc(r, r, true, { x: x + r, y }),
				{ op: "Z" },
			];
		}
		case "ellipse":
			return [
				{ op: "M", x: outline.cx - outline.rx, y: outline.cy },
				arc(outline.rx, outline.ry, true, {
					x: outline.cx + outline.rx,
					y: outline.cy,
				}),
				arc(outline.rx, outline.ry, true, {
					x: outline.cx - outline.rx,
					y: outline.cy,
				}),
				{ op: "Z" },
			];
		case "polygon":
			return [
				...outline.points.map(
					(p, index): GeometryPathCommand => ({
						op: index === 0 ? "M" : "L",
						x: p.x,
						y: p.y,
					}),
				),
				{ op: "Z" },
			];
		case "cylinder": {
			const { x, y, width, height } = outline.box;
			const rx = width / 2;
			const ry = outline.capRadius;
			// Body, then the front half of the top cap.
			return [
				{ op: "M", x, y: y + ry },
				arc(rx, ry, true, { x: x + width, y: y + ry }),
				{ op: "L", x: x + width, y: y + height - ry },
				arc(rx, ry, true, { x, y: y + height - ry }),
				{ op: "Z" },
				{ op: "M", x, y: y + ry },
				arc(rx, ry, false, { x: x + width, y: y + ry }),
			];
		}
	}
}

function sideOf(p: Point, b: Box): "top" | "right" | "bottom" | "left" {
	const distances: ["top" | "right" | "bottom" | "left", number][] = [
		["top", Math.abs(p.y - b.y)],
		["right", Math.abs(p.x - (b.x + b.width))],
		["bottom", Math.abs(p.y - (b.y + b.height))],
		["left", Math.abs(p.x - b.x)],
	];
	let best = distances[0] as ["top" | "right" | "bottom" | "left", number];
	for (const entry of distances) if (entry[1] < best[1]) best = entry;
	return best[0];
}

function edgeOf(
	item: CoordinatedEdge,
	nodeById: ReadonlyMap<string, CoordinatedNode>,
	crossings: readonly EdgeCrossing[],
	textId: (surface: string, ownerId: string) => string | undefined,
): GeometryDocument["edges"][number] {
	const first = item.points[0] as Point;
	const last = item.points.at(-1) as Point;
	const endBox = (nodeId: string, portId: string | undefined, at: Point) => {
		const owner = nodeById.get(nodeId);
		const port = owner?.ports?.find((candidate) => candidate.id === portId);
		return port?.box ?? owner?.box ?? { x: at.x, y: at.y, width: 0, height: 0 };
	};
	const endpointOf = (
		end: CoordinatedEdge["source"],
		at: Point,
	): GeometryDocument["edges"][number]["source"] => ({
		nodeId: end.nodeId,
		...(end.portId === undefined ? {} : { portId: end.portId }),
		point: { ...at },
		side: sideOf(at, endBox(end.nodeId, end.portId, at)),
	});
	const arrowhead = computeArrowhead(item.points);
	const base = {
		x: (arrowhead.left.x + arrowhead.right.x) / 2,
		y: (arrowhead.left.y + arrowhead.right.y) / 2,
	};
	// An open arrowhead is two strokes: the route runs on to its tip.
	const stroked =
		item.arrowhead === "open"
			? item.points.map((p) => ({ ...p }))
			: [...item.points.slice(0, -1), base];
	const under = crossings.filter(
		(crossing) => crossing.underEdgeId === item.id,
	);
	const labelId = textId("edge-label", item.id);
	return {
		id: item.id,
		source: endpointOf(item.source, first),
		target: endpointOf(item.target, last),
		points: item.points.map((p) => ({ ...p })),
		path: pathWithJumps(stroked, under),
		style: item.style === "dashed" ? "dashed" : "solid",
		arrowheads: [
			{
				at: "target",
				fill:
					item.arrowhead === "hollowTriangle"
						? "hollow"
						: item.arrowhead === "open"
							? "open"
							: "filled",
				tip: { ...arrowhead.tip },
				points: [arrowhead.tip, arrowhead.left, arrowhead.right].map((p) => ({
					...p,
				})),
			},
		],
		crossings: under.map((crossing) => ({
			at: { x: crossing.x, y: crossing.y },
			overEdgeId: crossing.overEdgeId,
			style: crossing.style,
		})),
		...(labelId === undefined ? {} : { labelId }),
	};
}

/** An actor's stick figure as strokes: the head circle, body, arms, legs. */
function actorPath(box: Box): GeometryPathCommand[] {
	const figure = actorFigure(box);
	const { cx, cy, r } = figure.head;
	return [
		{ op: "M", x: cx - r, y: cy },
		arc(r, r, true, { x: cx + r, y: cy }),
		arc(r, r, true, { x: cx - r, y: cy }),
		...figure.lines.flatMap(([from, to]): GeometryPathCommand[] => [
			{ op: "M", x: from.x, y: from.y },
			{ op: "L", x: to.x, y: to.y },
		]),
	];
}

function sequenceOf(
	sequence: CoordinatedSequence,
	texts: GeometryDocument["texts"],
	annotations: readonly SolvedTextAnnotation[],
): NonNullable<GeometryDocument["sequence"]> {
	const textFor = (surface: string, ownerId: string, index?: number) =>
		texts.find(
			(text, position) =>
				text.surface === surface &&
				text.ownerId === ownerId &&
				annotations[position]?.surfaceIndex === index,
		)?.id;
	const h = SEQUENCE_DESTRUCTION_HALF_SIZE;
	return {
		lifelines: sequence.lifelines.map((lifeline) => ({
			participantId: lifeline.participantId,
			kind: lifeline.kind,
			line: {
				x1: lifeline.x,
				y1: lifeline.top,
				x2: lifeline.x,
				y2: lifeline.bottom,
			},
			created: lifeline.created,
			destroyed: lifeline.destroyed,
		})),
		activations: sequence.activations.map((activation) => ({
			id: activation.id,
			participantId: activation.participantId,
			depth: activation.depth,
			box: { ...activation.box },
		})),
		fragments: sequence.fragments.map((fragment) => {
			const tagTextId = textFor("fragment-tag", fragment.id);
			return {
				id: fragment.id,
				kind: fragment.kind,
				box: { ...fragment.box },
				tag: fragmentTagPoints(fragment.tagBox, SEQUENCE_TAG_CUT),
				separators: fragment.operands.slice(1).map((operand) => ({
					x1: fragment.box.x,
					y1: operand.top,
					x2: fragment.box.x + fragment.box.width,
					y2: operand.top,
				})),
				depth: fragment.depth,
				...(tagTextId === undefined ? {} : { tagTextId }),
				guardTextIds: fragment.operands.flatMap((_, index) => {
					const id = textFor("fragment-guard", fragment.id, index);
					return id === undefined ? [] : [id];
				}),
			};
		}),
		notes: sequence.notes.map((note) => {
			const outline = noteOutlinePoints(note.box, SEQUENCE_NOTE_FOLD);
			const corner = {
				x: note.box.x + note.box.width - SEQUENCE_NOTE_FOLD,
				y: note.box.y,
			};
			const textId = textFor("sequence-note", note.id);
			return {
				id: note.id,
				box: { ...note.box },
				path: [
					...outline.map(
						(p, index): GeometryPathCommand => ({
							op: index === 0 ? "M" : "L",
							x: p.x,
							y: p.y,
						}),
					),
					{ op: "Z" as const },
					{ op: "M" as const, x: corner.x, y: corner.y },
					{ op: "L" as const, x: corner.x, y: corner.y + SEQUENCE_NOTE_FOLD },
					{
						op: "L" as const,
						x: note.box.x + note.box.width,
						y: corner.y + SEQUENCE_NOTE_FOLD,
					},
				],
				...(textId === undefined ? {} : { textId }),
			};
		}),
		dividers: sequence.dividers.map((divider) => {
			const textId = textFor("sequence-divider", divider.id);
			return {
				id: divider.id,
				lines: [-1.5, 1.5].map((offset) => ({
					x1: divider.x1,
					y1: divider.y + offset,
					x2: divider.x2,
					y2: divider.y + offset,
				})),
				...(divider.box === undefined ? {} : { box: { ...divider.box } }),
				...(textId === undefined ? {} : { textId }),
			};
		}),
		destructions: sequence.destructions.map((destruction) => {
			const { x, y } = destruction.point;
			return {
				participantId: destruction.participantId,
				at: { x, y },
				lines: [
					{ x1: x - h, y1: y - h, x2: x + h, y2: y + h },
					{ x1: x - h, y1: y + h, x2: x + h, y2: y - h },
				],
			};
		}),
		messageOrder: [...sequence.messageOrder],
	};
}

/** The polyline as path commands, with a jump arc or gap at each crossing. */
function pathWithJumps(
	points: readonly Point[],
	jumps: readonly EdgeCrossing[],
): GeometryPathCommand[] {
	const commands: GeometryPathCommand[] = [];
	const start = points[0];
	if (start === undefined) return commands;
	commands.push({ op: "M", x: start.x, y: start.y });
	for (let index = 0; index + 1 < points.length; index += 1) {
		const a = points[index] as Point;
		const b = points[index + 1] as Point;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length > 1e-9) {
			const ux = (b.x - a.x) / length;
			const uy = (b.y - a.y) / length;
			const glyphs = hopGlyphs(
				jumps
					.map((jump) => ({
						jump,
						t: ((jump.x - a.x) * ux + (jump.y - a.y) * uy) / length,
						off: Math.abs((jump.x - a.x) * uy - (jump.y - a.y) * ux),
					}))
					.filter(
						(entry) =>
							entry.off <= 0.75 &&
							entry.t > EDGE_CROSSING_END_CUTOFF &&
							entry.t < 1 - EDGE_CROSSING_END_CUTOFF,
					)
					.sort((left, right) => left.t - right.t)
					.map((entry) => entry.jump),
				a,
				b,
				0,
				(jump) => jump.style ?? "jump",
			);
			for (const glyph of glyphs) {
				commands.push({ op: "L", x: glyph.before.x, y: glyph.before.y });
				if ((glyph.hops[0] as EdgeCrossing).style === "gap") {
					commands.push({ op: "M", x: glyph.after.x, y: glyph.after.y });
				} else {
					// A cluster of close crossings shares one wider, flat hop.
					const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
					const sweep = horizontal ? b.x < a.x : b.y >= a.y;
					commands.push(arc(glyph.halfLength, JUMP_RADIUS, sweep, glyph.after));
				}
			}
		}
		commands.push({ op: "L", x: b.x, y: b.y });
	}
	return commands;
}
