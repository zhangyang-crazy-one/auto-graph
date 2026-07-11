import { EDGE_CROSSING_GLYPH_RADIUS } from "../geometry/edge-crossings.js";
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
import type { ExportOptions } from "./types.js";

type ExcalidrawElement =
	| ExcalidrawShapeElement
	| ExcalidrawTextElement
	| ExcalidrawArrowElement;

type ExcalidrawElementType =
	| "rectangle"
	| "ellipse"
	| "diamond"
	| "parallelogram"
	| "hexagon"
	| "cylinder"
	| "text"
	| "arrow";

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
	startBinding: { elementId: string; focus: 0; gap: 0 };
	endBinding: { elementId: string; focus: 0; gap: 0 };
	startArrowhead: null;
	endArrowhead: "arrow" | "triangle" | "triangle_outline";
}

export function exportExcalidraw(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const elements: ExcalidrawElement[] = [];
	const groupIdByChildId = createGroupMembership(diagram.groups);

	for (const group of diagram.groups) {
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

	for (const node of diagram.nodes) {
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
		elements.push(...renderArrowElements(edge, diagram.edgeCrossings ?? []));
		elements.push(
			...renderEdgeLabelAnnotations(edge, diagram.textAnnotations ?? []),
		);
	}

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
	const gaps = under.filter((crossing) => crossing.style === "gap");
	const hops = under.filter(
		(crossing) => crossing.style === "jump" || crossing.style === "bridge",
	);
	if (gaps.length === 0) {
		return [renderArrow(edge, hops)];
	}
	const segments = splitPolylineAtGaps(edge.points, gaps);
	return segments.map((points, index) => {
		const { arrowhead: _ignored, ...rest } = edge;
		const segmentEdge: CoordinatedEdge = {
			...rest,
			id: index === 0 ? edge.id : `${edge.id}:gap-${index}`,
			points,
			...(index === segments.length - 1 && edge.arrowhead !== undefined
				? { arrowhead: edge.arrowhead }
				: {}),
		};
		return renderArrow(segmentEdge, index === 0 ? hops : []);
	});
}

function splitPolylineAtGaps(
	points: readonly Point[],
	gaps: readonly EdgeCrossing[],
): Point[][] {
	if (points.length < 2 || gaps.length === 0) {
		return [points.map((point) => ({ ...point }))];
	}
	const segments: Point[][] = [];
	let current: Point[] = [];
	for (let i = 0; i < points.length - 1; i += 1) {
		const start = points[i];
		const end = points[i + 1];
		if (start === undefined || end === undefined) continue;
		if (current.length === 0) {
			current.push({ ...start });
		}
		const segmentGaps = gaps
			.filter((gap) => excalidrawPointOnSegment(gap, start, end))
			.sort(
				(left, right) =>
					excalidrawSquaredDistance(start, left) -
					excalidrawSquaredDistance(start, right),
			);
		let cursor = start;
		for (const gap of segmentGaps) {
			const before = excalidrawPointAlong(
				start,
				end,
				gap,
				-EDGE_CROSSING_GLYPH_RADIUS,
			);
			const after = excalidrawPointAlong(
				start,
				end,
				gap,
				EDGE_CROSSING_GLYPH_RADIUS,
			);
			current.push(before);
			if (current.length >= 2) {
				segments.push(current);
			}
			current = [after];
			cursor = after;
		}
		current.push({ ...end });
		void cursor;
	}
	if (current.length >= 2) {
		segments.push(current);
	}
	return segments.length > 0
		? segments
		: [points.map((point) => ({ ...point }))];
}

function renderArrow(
	edge: CoordinatedEdge,
	crossings: readonly EdgeCrossing[] = [],
): ExcalidrawArrowElement {
	const first = edge.points[0];
	if (first === undefined) {
		throw new TypeError(
			`Excalidraw edge ${edge.id} requires at least one point`,
		);
	}

	const hopped = applyJumpBumps(
		edge.points,
		crossings.filter(
			(crossing) => crossing.style === "jump" || crossing.style === "bridge",
		),
	);
	const origin = hopped[0] ?? first;
	const relativePoints = hopped.map((point) => ({
		x: point.x - origin.x,
		y: point.y - origin.y,
	}));
	const box = pointsBox(relativePoints);

	return {
		...baseElement(`edge:${edge.id}`, "arrow", {
			x: origin.x,
			y: origin.y,
			width: box.width,
			height: box.height,
		}),
		backgroundColor: "transparent",
		strokeStyle: edge.style ?? "solid",
		points: relativePoints,
		startBinding: { elementId: `node:${edge.source.nodeId}`, focus: 0, gap: 0 },
		endBinding: { elementId: `node:${edge.target.nodeId}`, focus: 0, gap: 0 },
		startArrowhead: null,
		endArrowhead: mapArrowhead(edge.arrowhead),
	};
}

function applyJumpBumps(
	points: readonly Point[],
	jumps: readonly EdgeCrossing[],
): Point[] {
	if (jumps.length === 0 || points.length < 2) {
		return points.map((point) => ({ ...point }));
	}
	const result: Point[] = [];
	for (let i = 0; i < points.length - 1; i += 1) {
		const start = points[i];
		const end = points[i + 1];
		if (start === undefined || end === undefined) continue;
		if (i === 0) {
			result.push({ ...start });
		}
		const segmentJumps = jumps
			.filter((jump) => excalidrawPointOnSegment(jump, start, end))
			.sort(
				(left, right) =>
					excalidrawSquaredDistance(start, left) -
					excalidrawSquaredDistance(start, right),
			);
		for (const jump of segmentJumps) {
			const before = excalidrawPointAlong(
				start,
				end,
				jump,
				-EDGE_CROSSING_GLYPH_RADIUS,
			);
			const after = excalidrawPointAlong(
				start,
				end,
				jump,
				EDGE_CROSSING_GLYPH_RADIUS,
			);
			const apex = hopApex(start, end, jump, EDGE_CROSSING_GLYPH_RADIUS);
			result.push(before, apex, after);
		}
		result.push({ ...end });
	}
	return result;
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
	if (t <= 0.02 || t >= 0.98) {
		return false;
	}
	const proj = { x: start.x + t * dx, y: start.y + t * dy };
	return excalidrawSquaredDistance(proj, point) <= tolerance * tolerance;
}

function excalidrawPointAlong(
	start: Point,
	end: Point,
	at: { x: number; y: number },
	offset: number,
): Point {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy);
	if (length < 1e-9) {
		return { x: at.x, y: at.y };
	}
	return {
		x: at.x + (dx / length) * offset,
		y: at.y + (dy / length) * offset,
	};
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
): ExcalidrawTextElement[] {
	const matching = annotations.filter(
		(annotation) =>
			annotation.surfaceKind === "edge-label" && annotation.ownerId === edge.id,
	);
	return matching.map((annotation, index) => {
		const role =
			typeof annotation.placementDetail?.role === "string"
				? annotation.placementDetail.role
				: "label";
		return renderAnnotationText(
			`edge-label:${edge.id}:${role}:${index}`,
			annotation,
		);
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
