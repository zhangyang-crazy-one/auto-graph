import {
	ARROWHEAD_LENGTH,
	EDGE_CROSSING_END_CUTOFF,
	EDGE_CROSSING_GLYPH_RADIUS,
	hopGlyphs,
} from "../geometry/edge-crossings.js";
import {
	actorFigure,
	fragmentTagPoints,
	noteOutlinePoints,
} from "../geometry/sequence-shapes.js";
import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedEvidencePanel,
	CoordinatedGroup,
	CoordinatedMatrixBlock,
	CoordinatedNode,
	CoordinatedTableBlock,
	EdgeArrowhead,
	EdgeCrossing,
	Label,
	NodeShape,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import {
	type CoordinatedSequence,
	SEQUENCE_DESTRUCTION_HALF_SIZE,
	SEQUENCE_NOTE_FOLD,
	SEQUENCE_TAG_CUT,
} from "../ir/sequence.js";
import { LABEL_BACKDROP_FILL, labelBackdropBox } from "./label-backdrop.js";
import type { ExportOptions } from "./types.js";

type ExcalidrawElement =
	| ExcalidrawShapeElement
	| ExcalidrawTextElement
	| ExcalidrawArrowElement
	| ExcalidrawLineElement;

type ExcalidrawElementType =
	| "rectangle"
	| "ellipse"
	| "diamond"
	| "parallelogram"
	| "hexagon"
	| "cylinder"
	| "text"
	| "arrow"
	| "line";

interface ExcalidrawElementBase<TType extends ExcalidrawElementType> {
	id: string;
	type: TType;
	x: number;
	y: number;
	width: number;
	height: number;
	angle: 0;
	strokeColor: string;
	backgroundColor: string;
	fillStyle: "solid";
	strokeWidth: number;
	strokeStyle: "solid" | "dashed";
	roughness: 0;
	opacity: 100;
	groupIds: string[];
	seed: number;
	version: 1;
	versionNonce: number;
	isDeleted: false;
	boundElements: null;
	updated: 0;
	link: null;
	locked: false;
}

interface ExcalidrawShapeElement
	extends ExcalidrawElementBase<
		| "rectangle"
		| "ellipse"
		| "diamond"
		| "parallelogram"
		| "hexagon"
		| "cylinder"
	> {
	type:
		| "rectangle"
		| "ellipse"
		| "diamond"
		| "parallelogram"
		| "hexagon"
		| "cylinder";
}

interface ExcalidrawTextElement extends ExcalidrawElementBase<"text"> {
	type: "text";
	text: string;
	fontSize: number;
	fontFamily: 1;
	textAlign: "center" | "left";
	verticalAlign: "middle" | "top";
	baseline: number;
	containerId: string | null;
	originalText: string;
	lineHeight: number;
}

interface ExcalidrawArrowElement extends ExcalidrawElementBase<"arrow"> {
	type: "arrow";
	points: Point[];
	startBinding: { elementId: string; focus: 0; gap: 0 } | null;
	endBinding: { elementId: string; focus: 0; gap: 0 } | null;
	startArrowhead: null;
	endArrowhead: "arrow" | "triangle" | "triangle_outline" | null;
}

/** A polyline; closed (first point repeated) and filled for polygons. */
interface ExcalidrawLineElement extends ExcalidrawElementBase<"line"> {
	type: "line";
	points: Point[];
	startBinding: null;
	endBinding: null;
	startArrowhead: null;
	endArrowhead: null;
}

export function exportExcalidraw(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const elements =
		diagram.pages !== undefined && diagram.pages.length > 1
			? stackedPageElements(diagram.pages)
			: sceneElements(diagram);
	const scene = {
		type: "excalidraw",
		version: 2,
		source: "auto-graph",
		elements,
		appState: {
			name: options.title ?? diagram.title ?? diagram.id,
			viewBackgroundColor: "#ffffff",
			gridSize: null,
			...(options.viewportPadding === undefined
				? {}
				: viewportAppState(diagram.bounds, options.viewportPadding)),
		},
		files: {},
	};

	return `${JSON.stringify(scene, null, 2)}\n`;
}

/** Space between the pages of a split diagram (px). */
const PAGE_GAP = 80;

/**
 * A split diagram's pages one below the other, left edges aligned. Ids
 * from page 2 on carry a `page-N:` prefix so the scene's ids stay unique.
 */
function stackedPageElements(
	pages: readonly CoordinatedDiagram[],
): ExcalidrawElement[] {
	const left = (pages[0] as CoordinatedDiagram).bounds.x;
	let top = (pages[0] as CoordinatedDiagram).bounds.y;
	return pages.flatMap((page, index) => {
		const dx = left - page.bounds.x;
		const dy = top - page.bounds.y;
		top += page.bounds.height + PAGE_GAP;
		const rename = (id: string) =>
			index === 0 ? id : `page-${index + 1}:${id}`;
		return sceneElements(page).map((element): ExcalidrawElement => {
			const moved = {
				...element,
				id: rename(element.id),
				x: finite(element.x + dx),
				y: finite(element.y + dy),
				groupIds: element.groupIds.map(rename),
			};
			if (moved.type === "text") {
				return {
					...moved,
					containerId:
						moved.containerId === null ? null : rename(moved.containerId),
				};
			}
			if (moved.type === "arrow") {
				return {
					...moved,
					startBinding:
						moved.startBinding === null
							? null
							: {
									...moved.startBinding,
									elementId: rename(moved.startBinding.elementId),
								},
					endBinding:
						moved.endBinding === null
							? null
							: {
									...moved.endBinding,
									elementId: rename(moved.endBinding.elementId),
								},
				};
			}
			return moved;
		});
	});
}

function sceneElements(diagram: CoordinatedDiagram): ExcalidrawElement[] {
	const elements: ExcalidrawElement[] = [];
	const groupIdByChildId = createGroupMembership(diagram.groups);

	for (const group of diagram.groups) {
		// A frameless group is a layout container: nothing to draw.
		if (group.frame === false) continue;
		const groupElementId = groupElementIdFor(group.id);
		elements.push(renderGroup(group));
		const text = renderText(
			`group-text:${group.id}`,
			group.label,
			group.box,
			groupElementId,
			groupIdByChildId.get(group.id) ?? [],
		);
		if (text !== undefined) {
			elements.push(text);
		}
	}

	if (diagram.sequence !== undefined) {
		elements.push(...renderSequenceBackground(diagram.sequence));
	}

	for (const node of diagram.nodes) {
		if (node.metadata?.sequenceParticipant === "actor") {
			// The stick figure, and its name below it as solved.
			elements.push(...renderActor(node));
			const label = (diagram.textAnnotations ?? []).find(
				(annotation) =>
					annotation.surfaceKind === "node-label" &&
					annotation.ownerId === node.id,
			);
			if (label !== undefined) {
				elements.push(renderAnnotationText(`node-text:${node.id}`, label));
			}
			continue;
		}
		elements.push(renderNode(node, groupIdByChildId.get(node.id) ?? []));
		const text = renderText(
			`node-text:${node.id}`,
			node.label,
			node.box,
			`node:${node.id}`,
			groupIdByChildId.get(node.id) ?? [],
		);
		if (text !== undefined) {
			elements.push(text);
		}
	}

	for (const matrix of diagram.matrices ?? []) {
		elements.push(...renderMatrixBlock(matrix as CoordinatedMatrixBlock));
	}

	for (const table of diagram.tables ?? []) {
		elements.push(...renderTableBlock(table as CoordinatedTableBlock));
	}

	for (const panel of diagram.evidencePanels ?? []) {
		elements.push(...renderEvidencePanel(panel as CoordinatedEvidencePanel));
	}

	for (const edge of diagram.edges) {
		const arrows = renderArrowElements(edge, diagram.edgeCrossings ?? []);
		// A message runs between lifelines, not into its participants'
		// heads: binding it would snap it to a head when one is moved.
		elements.push(
			...(diagram.sequence === undefined
				? arrows
				: arrows.map((arrow) => ({
						...arrow,
						startBinding: null,
						endBinding: null,
					}))),
		);
	}
	if (diagram.sequence !== undefined) {
		elements.push(...renderSequenceForeground(diagram.sequence));
	}
	// Labels after every arrow: element order is z-order, and a label's
	// backdrop must cover all strokes, not only its own edge's.
	for (const edge of diagram.edges) {
		elements.push(
			...renderEdgeLabelAnnotations(edge, diagram.textAnnotations ?? []),
		);
	}

	// Fragment tags and guards, note and divider texts, over everything.
	for (const annotation of diagram.textAnnotations ?? []) {
		if (!SEQUENCE_SURFACES.has(annotation.surfaceKind)) continue;
		// The solved line breaks, so Excalidraw does not rewrap the text.
		const text =
			annotation.lines.length > 0
				? annotation.lines.map((line) => line.text).join("\n")
				: annotation.text;
		elements.push({
			...renderAnnotationText(
				`${annotation.surfaceKind}:${annotation.ownerId}:${annotation.surfaceIndex ?? 0}`,
				annotation,
			),
			text,
			originalText: text,
			textAlign: "left",
			verticalAlign: "top",
		});
	}

	return elements;
}

const SEQUENCE_SURFACES = new Set<SolvedTextAnnotation["surfaceKind"]>([
	"sequence-note",
	"fragment-tag",
	"fragment-guard",
	"sequence-divider",
]);

function renderLine(
	id: string,
	points: readonly Point[],
	options: {
		dashed?: boolean;
		fill?: string;
		strokeWidth?: number;
		strokeColor?: string;
	} = {},
): ExcalidrawLineElement {
	const origin = points[0] ?? { x: 0, y: 0 };
	const relative = points.map((point) => ({
		x: point.x - origin.x,
		y: point.y - origin.y,
	}));
	const box = pointsBox(relative);
	return {
		...baseElement(id, "line", {
			x: origin.x,
			y: origin.y,
			width: box.width,
			height: box.height,
		}),
		backgroundColor: options.fill ?? "transparent",
		strokeStyle: options.dashed === true ? "dashed" : "solid",
		strokeWidth: options.strokeWidth ?? 1,
		strokeColor: options.strokeColor ?? "#374151",
		points: relative,
		startBinding: null,
		endBinding: null,
		startArrowhead: null,
		endArrowhead: null,
	};
}

function closed(points: readonly Point[]): Point[] {
	const first = points[0];
	return first === undefined ? [] : [...points, { ...first }];
}

/** Lifelines, activation bars and fragments: below the messages. */
function renderSequenceBackground(
	sequence: CoordinatedSequence,
): ExcalidrawElement[] {
	return [
		...sequence.lifelines.map((lifeline) =>
			renderLine(
				`lifeline:${lifeline.participantId}`,
				[
					{ x: lifeline.x, y: lifeline.top },
					{ x: lifeline.x, y: lifeline.bottom },
				],
				{ dashed: true, strokeColor: "#6b7280" },
			),
		),
		...sequence.activations.map(
			(activation): ExcalidrawShapeElement => ({
				...baseElement(
					`activation:${activation.id}`,
					"rectangle",
					activation.box,
				),
				backgroundColor: "#f3f4f6",
			}),
		),
		...sequence.fragments.flatMap((fragment): ExcalidrawElement[] => [
			{
				...baseElement(`fragment:${fragment.id}`, "rectangle", fragment.box),
				backgroundColor: fragment.kind === "ref" ? "#ffffff" : "transparent",
			},
			renderLine(
				`fragment-tag:${fragment.id}`,
				closed(fragmentTagPoints(fragment.tagBox, SEQUENCE_TAG_CUT)),
				{ fill: "#ffffff" },
			),
			...fragment.operands.slice(1).map((operand, index) =>
				renderLine(
					`fragment-separator:${fragment.id}:${index + 1}`,
					[
						{ x: fragment.box.x, y: operand.top },
						{ x: fragment.box.x + fragment.box.width, y: operand.top },
					],
					{ dashed: true },
				),
			),
		]),
	];
}

/** Notes, dividers and destruction marks: above the messages. */
function renderSequenceForeground(
	sequence: CoordinatedSequence,
): ExcalidrawElement[] {
	const h = SEQUENCE_DESTRUCTION_HALF_SIZE;
	return [
		...sequence.notes.flatMap((note) => {
			const fold = SEQUENCE_NOTE_FOLD;
			const corner = { x: note.box.x + note.box.width - fold, y: note.box.y };
			return [
				renderLine(
					`note:${note.id}`,
					closed(noteOutlinePoints(note.box, fold)),
					{ fill: "#fffbeb", strokeColor: "#b45309" },
				),
				renderLine(
					`note-fold:${note.id}`,
					[
						corner,
						{ x: corner.x, y: corner.y + fold },
						{ x: note.box.x + note.box.width, y: corner.y + fold },
					],
					{ strokeColor: "#b45309" },
				),
			];
		}),
		...sequence.dividers.flatMap((divider): ExcalidrawElement[] => [
			...[-1.5, 1.5].map((offset, index) =>
				renderLine(`divider:${divider.id}:${index}`, [
					{ x: divider.x1, y: divider.y + offset },
					{ x: divider.x2, y: divider.y + offset },
				]),
			),
			...(divider.box === undefined
				? []
				: [
						{
							...baseElement(
								`divider-box:${divider.id}`,
								"rectangle",
								divider.box,
							),
							backgroundColor: "#ffffff",
						},
					]),
		]),
		...sequence.destructions.flatMap((destruction) => {
			const { x, y } = destruction.point;
			return [
				renderLine(
					`destruction:${destruction.participantId}:0`,
					[
						{ x: x - h, y: y - h },
						{ x: x + h, y: y + h },
					],
					{ strokeWidth: 2, strokeColor: "#111827" },
				),
				renderLine(
					`destruction:${destruction.participantId}:1`,
					[
						{ x: x - h, y: y + h },
						{ x: x + h, y: y - h },
					],
					{ strokeWidth: 2, strokeColor: "#111827" },
				),
			];
		}),
	];
}

/** An actor head: the stick figure, grouped so it moves as one. */
function renderActor(node: CoordinatedNode): ExcalidrawElement[] {
	const figure = actorFigure(node.box);
	const group = [`actor:${node.id}`];
	const { cx, cy, r } = figure.head;
	return [
		{
			...baseElement(`node:${node.id}`, "ellipse", {
				x: cx - r,
				y: cy - r,
				width: 2 * r,
				height: 2 * r,
			}),
			backgroundColor: node.style?.fill ?? "#ffffff",
			groupIds: group,
		},
		...figure.lines.map(([from, to], index) => ({
			...renderLine(`actor-line:${node.id}:${index}`, [from, to], {
				strokeWidth: 1.5,
			}),
			groupIds: group,
		})),
	];
}

function viewportAppState(
	bounds: Box,
	padding: number,
): {
	scrollX: number;
	scrollY: number;
	zoom: { value: number };
} {
	const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
	return {
		scrollX: finite(-bounds.x + safePadding),
		scrollY: finite(-bounds.y + safePadding),
		zoom: { value: 1 },
	};
}

function renderGroup(group: CoordinatedGroup): ExcalidrawShapeElement {
	return {
		...baseElement(`group:${group.id}`, "rectangle", group.box),
		backgroundColor: "transparent",
		strokeStyle: "dashed",
		groupIds: groupGroupIds(group.id),
	};
}

function renderNode(
	node: CoordinatedNode,
	groupIds: string[],
): ExcalidrawShapeElement {
	return {
		...baseElement(`node:${node.id}`, mapShape(node.shape), node.box),
		groupIds,
	};
}

function renderMatrixBlock(
	matrix: CoordinatedMatrixBlock,
): ExcalidrawElement[] {
	const containerId = `matrix:${matrix.id}`;
	const groupIds = [containerId];
	const label = blockText([
		matrix.id,
		`row | ${matrix.cols.join(" | ")}`,
		...matrix.rows.map((rowId, rowIndex) => {
			const row = matrix.cells[rowIndex] ?? [];
			return `${rowId}: ${matrix.cols
				.map((_, columnIndex) => row[columnIndex]?.text ?? "")
				.join(" | ")}`;
		}),
	]);
	return [
		{
			...baseElement(containerId, "rectangle", matrix.box),
			backgroundColor: matrix.style?.fill ?? "#f8fafc",
			strokeColor: matrix.style?.stroke ?? "#374151",
			groupIds,
		},
		renderTextBlock(
			`matrix-text:${matrix.id}`,
			label,
			matrix.box,
			containerId,
			groupIds,
		),
	];
}

function renderTableBlock(table: CoordinatedTableBlock): ExcalidrawElement[] {
	const containerId = `table:${table.id}`;
	const groupIds = [containerId];
	const label = blockText([
		table.columns.map((column) => column.label.text).join(" | "),
		...table.rows.map((row) =>
			table.columns
				.map((column) => row.cells[column.id]?.text ?? "")
				.join(" | "),
		),
	]);
	return [
		{
			...baseElement(containerId, "rectangle", table.box),
			backgroundColor: table.style?.fill ?? "#f8fafc",
			strokeColor: table.style?.stroke ?? "#374151",
			groupIds,
		},
		renderTextBlock(
			`table-text:${table.id}`,
			label,
			table.box,
			containerId,
			groupIds,
		),
	];
}

function renderEvidencePanel(
	panel: CoordinatedEvidencePanel,
): ExcalidrawElement[] {
	const containerId = `evidence-panel:${panel.id}`;
	const groupIds = [containerId];
	const label = blockText([
		`${panel.kind}: ${panel.id}`,
		...panel.items.map((item) =>
			item.detail?.text === undefined
				? item.label.text
				: `${item.label.text}: ${item.detail.text}`,
		),
	]);
	return [
		{
			...baseElement(containerId, "rectangle", panel.box),
			backgroundColor: panel.style?.fill ?? panelKindFill(panel.kind),
			strokeColor: panel.style?.stroke ?? "#374151",
			groupIds,
		},
		renderTextBlock(
			`evidence-panel-text:${panel.id}`,
			label,
			panel.box,
			containerId,
			groupIds,
		),
	];
}

function renderArrowElements(
	edge: CoordinatedEdge,
	crossings: readonly EdgeCrossing[] = [],
): ExcalidrawArrowElement[] {
	const under = crossings.filter(
		(crossing) => crossing.underEdgeId === edge.id,
	);
	const pieces = piecesWithCrossings(edge.points, under);
	// A gap cuts the arrow into pieces; only the last one ends at the
	// target, so only it carries the arrowhead, and only the first binds
	// to the source.
	// Later pieces live in their own id namespace: appending a suffix to
	// the edge id could collide with another edge's id.
	return pieces.map((points, index) =>
		renderArrow(
			{ ...edge, points },
			index === pieces.length - 1,
			index === 0,
			index === 0 ? `edge:${edge.id}` : `edge-piece:${index}:${edge.id}`,
		),
	);
}

/**
 * The edge's polyline with its crossings drawn, as the SVG draws them: a
 * jump (or bridge) bumps over the other edge, a gap cuts the line into
 * pieces. Crossings closer than a glyph share it, and a run of mixed
 * styles is split halfway between neighbours, so each keeps its style.
 */
function piecesWithCrossings(
	points: readonly Point[],
	under: readonly EdgeCrossing[],
): Point[][] {
	if (points.length < 2) return [points.map((point) => ({ ...point }))];
	const pieces: Point[][] = [];
	let current: Point[] = [];
	for (let i = 0; i < points.length - 1; i += 1) {
		const start = points[i];
		const end = points[i + 1];
		if (start === undefined || end === undefined) continue;
		if (current.length === 0) current.push({ ...start });
		const glyphs = hopGlyphs(
			under
				.filter((crossing) => excalidrawPointOnSegment(crossing, start, end))
				.sort(
					(left, right) =>
						excalidrawSquaredDistance(start, left) -
						excalidrawSquaredDistance(start, right),
				),
			start,
			end,
			// Excalidraw draws the arrowhead on the full final segment.
			i === points.length - 2 ? ARROWHEAD_LENGTH : 0,
			(crossing) => (crossing.style === "gap" ? "gap" : "jump"),
		);
		for (const glyph of glyphs) {
			if ((glyph.hops[0] as EdgeCrossing).style === "gap") {
				current.push({ ...glyph.before });
				if (current.length >= 2) pieces.push(current);
				current = [{ ...glyph.after }];
				continue;
			}
			// A cluster of close crossings shares one wider hop.
			const center = {
				x: (glyph.before.x + glyph.after.x) / 2,
				y: (glyph.before.y + glyph.after.y) / 2,
			};
			const apex = hopApex(start, end, center, EDGE_CROSSING_GLYPH_RADIUS);
			current.push({ ...glyph.before }, apex, { ...glyph.after });
		}
		current.push({ ...end });
	}
	if (current.length >= 2) pieces.push(current);
	return pieces.length > 0 ? pieces : [points.map((point) => ({ ...point }))];
}

function renderArrow(
	/** The piece to draw, its crossings already drawn into the points. */
	edge: CoordinatedEdge,
	/** False for a piece cut at a gap before the target: no arrowhead. */
	endsAtTarget = true,
	/** False for a piece that starts at a gap, not at the source. */
	startsAtSource = true,
	elementId = `edge:${edge.id}`,
): ExcalidrawArrowElement {
	const first = edge.points[0];
	if (first === undefined) {
		throw new TypeError(
			`Excalidraw edge ${edge.id} requires at least one point`,
		);
	}

	const hopped = edge.points.map((point) => ({ ...point }));
	const origin = hopped[0] ?? first;
	const relativePoints = hopped.map((point) => ({
		x: point.x - origin.x,
		y: point.y - origin.y,
	}));
	const box = pointsBox(relativePoints);

	return {
		...baseElement(elementId, "arrow", {
			x: origin.x,
			y: origin.y,
			width: box.width,
			height: box.height,
		}),
		backgroundColor: "transparent",
		strokeStyle: edge.style ?? "solid",
		points: relativePoints,
		// Only ends that reach a node bind to it; a cut end stays free.
		startBinding: startsAtSource
			? { elementId: `node:${edge.source.nodeId}`, focus: 0, gap: 0 }
			: null,
		endBinding: endsAtTarget
			? { elementId: `node:${edge.target.nodeId}`, focus: 0, gap: 0 }
			: null,
		startArrowhead: null,
		endArrowhead: endsAtTarget ? mapArrowhead(edge.arrowhead) : null,
	};
}

function hopApex(
	start: Point,
	end: Point,
	at: { x: number; y: number },
	radius: number,
): Point {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy);
	if (length < 1e-9) {
		return { x: at.x, y: at.y - radius };
	}
	const nx = -dy / length;
	const ny = dx / length;
	const sign =
		Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? -1 : 1) : dy >= 0 ? 1 : -1;
	return { x: at.x + nx * radius * sign, y: at.y + ny * radius * sign };
}

function excalidrawPointOnSegment(
	point: { x: number; y: number },
	start: Point,
	end: Point,
	tolerance = 0.75,
): boolean {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq < 1e-9) {
		return excalidrawSquaredDistance(start, point) <= tolerance * tolerance;
	}
	const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
	if (t <= EDGE_CROSSING_END_CUTOFF || t >= 1 - EDGE_CROSSING_END_CUTOFF) {
		return false;
	}
	const proj = { x: start.x + t * dx, y: start.y + t * dy };
	return excalidrawSquaredDistance(proj, point) <= tolerance * tolerance;
}

function excalidrawSquaredDistance(
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function renderEdgeLabelAnnotations(
	edge: CoordinatedEdge,
	annotations: readonly SolvedTextAnnotation[],
): Array<ExcalidrawShapeElement | ExcalidrawTextElement> {
	const matching = annotations.filter(
		(annotation) =>
			annotation.surfaceKind === "edge-label" && annotation.ownerId === edge.id,
	);
	return matching.flatMap((annotation, index) => {
		const role =
			typeof annotation.placementDetail?.role === "string"
				? annotation.placementDetail.role
				: "label";
		const id = `edge-label:${edge.id}:${role}:${index}`;
		return [
			// Text-fitted white box so the arrow behind the label stays out of
			// the way; grouped with the text so they move together.
			{
				...baseElement(
					`${id}:backdrop`,
					"rectangle",
					labelBackdropBox(annotation),
				),
				strokeColor: "transparent",
				backgroundColor: LABEL_BACKDROP_FILL,
				groupIds: [id],
			},
			{ ...renderAnnotationText(id, annotation), groupIds: [id] },
		];
	});
}

function renderAnnotationText(
	id: string,
	annotation: SolvedTextAnnotation,
): ExcalidrawTextElement {
	const fontSize = annotation.fontSize > 0 ? annotation.fontSize : 12;
	return {
		...baseElement(id, "text", {
			x: annotation.box.x,
			y: annotation.box.y,
			width: Math.max(fontSize, annotation.box.width),
			height: Math.max(fontSize, annotation.box.height),
		}),
		backgroundColor: "transparent",
		strokeColor: "#111827",
		groupIds: [],
		text: annotation.text,
		fontSize,
		fontFamily: 1,
		textAlign: "center",
		verticalAlign: "middle",
		baseline: fontSize,
		containerId: null,
		originalText: annotation.text,
		lineHeight: 1.25,
		boundElements: null,
		link: null,
		locked: false,
		seed: seedFor(id),
		versionNonce: seedFor(`${id}:nonce`),
	};
}

function renderText(
	id: string,
	label: Label | undefined,
	box: Box,
	containerId: string,
	groupIds: string[],
): ExcalidrawTextElement | undefined {
	if (label?.text === undefined) {
		return undefined;
	}

	const fontSize = 14;
	return {
		...baseElement(id, "text", {
			x: box.x,
			y: box.y + box.height / 2 - fontSize / 2,
			width: box.width,
			height: fontSize,
		}),
		backgroundColor: "transparent",
		strokeColor: "#111827",
		groupIds,
		text: label.text,
		fontSize,
		fontFamily: 1,
		textAlign: "center",
		verticalAlign: "middle",
		baseline: fontSize,
		containerId,
		originalText: label.text,
		lineHeight: 1.25,
		boundElements: null,
		link: null,
		locked: false,
		seed: seedFor(id),
		versionNonce: seedFor(`${id}:nonce`),
	};
}

function renderTextBlock(
	id: string,
	text: string,
	box: Box,
	containerId: string,
	groupIds: string[],
): ExcalidrawTextElement {
	const fontSize = 12;
	return {
		...baseElement(id, "text", {
			x: box.x + 8,
			y: box.y + 8,
			width: Math.max(0, box.width - 16),
			height: Math.max(fontSize, box.height - 16),
		}),
		backgroundColor: "transparent",
		strokeColor: "#111827",
		groupIds,
		text,
		fontSize,
		fontFamily: 1,
		textAlign: "left",
		verticalAlign: "top",
		baseline: fontSize,
		containerId,
		originalText: text,
		lineHeight: 1.25,
		boundElements: null,
		link: null,
		locked: false,
		seed: seedFor(id),
		versionNonce: seedFor(`${id}:nonce`),
	};
}

function baseElement<TType extends ExcalidrawElementType>(
	id: string,
	type: TType,
	box: Box,
): ExcalidrawElementBase<TType> {
	return {
		id,
		type,
		x: finite(box.x),
		y: finite(box.y),
		width: finite(box.width),
		height: finite(box.height),
		angle: 0,
		strokeColor: "#374151",
		backgroundColor: "#f8fafc",
		fillStyle: "solid",
		strokeWidth: 1,
		strokeStyle: "solid",
		roughness: 0,
		opacity: 100,
		groupIds: [],
		seed: seedFor(id),
		version: 1,
		versionNonce: seedFor(`${id}:nonce`),
		isDeleted: false,
		boundElements: null,
		updated: 0,
		link: null,
		locked: false,
	};
}

function mapShape(shape: NodeShape): ExcalidrawShapeElement["type"] {
	switch (shape) {
		case "rounded-rectangle":
		case "rectangle":
			return "rectangle";
		case "ellipse":
			return "ellipse";
		case "diamond":
			return "diamond";
		case "parallelogram":
			return "parallelogram";
		case "hexagon":
			return "hexagon";
		case "cylinder":
			return "cylinder";
	}
}

function mapArrowhead(
	arrowhead: EdgeArrowhead | undefined,
): ExcalidrawArrowElement["endArrowhead"] {
	switch (arrowhead) {
		case undefined:
			return "arrow";
		case "triangle":
			return "triangle";
		case "hollowTriangle":
			return "triangle_outline";
		case "open":
			return "arrow";
	}
}

function createGroupMembership(
	groups: readonly CoordinatedGroup[],
): Map<string, string[]> {
	const membership = new Map<string, string[]>();
	for (const group of groups) {
		const groupElementId = groupElementIdFor(group.id);
		for (const nodeId of group.nodeIds) {
			addMembership(membership, nodeId, groupElementId);
		}
		for (const childGroupId of group.groupIds) {
			addMembership(membership, childGroupId, groupElementId);
		}
	}
	return membership;
}

function addMembership(
	membership: Map<string, string[]>,
	childId: string,
	groupElementId: string,
): void {
	const existing = membership.get(childId) ?? [];
	membership.set(childId, [...existing, groupElementId].sort());
}

function groupGroupIds(groupId: string): string[] {
	return [groupElementIdFor(groupId)];
}

function groupElementIdFor(groupId: string): string {
	return `group:${groupId}`;
}

function blockText(lines: readonly string[]): string {
	return lines.filter((line) => line.length > 0).join("\n");
}

function panelKindFill(kind: CoordinatedEvidencePanel["kind"]): string {
	switch (kind) {
		case "legend":
			return "#ecfdf5";
		case "rule":
			return "#eff6ff";
		case "note":
			return "#fffbeb";
		case "verification":
			return "#fef2f2";
	}
}

function pointsBox(points: readonly Point[]): Box {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function finite(value: number): number {
	if (!Number.isFinite(value)) {
		throw new TypeError(
			"Excalidraw export requires finite coordinated numbers",
		);
	}
	return Number.parseFloat(value.toFixed(3));
}

function seedFor(id: string): number {
	let hash = 2166136261;
	for (let index = 0; index < id.length; index += 1) {
		hash ^= id.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash);
}
