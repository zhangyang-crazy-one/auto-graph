import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedGroup,
	CoordinatedNode,
	Label,
	NodeShape,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
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
	endArrowhead: "arrow" | "triangle";
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

	for (const edge of diagram.edges) {
		elements.push(renderArrow(edge));
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
		},
		files: {},
	};

	return `${JSON.stringify(scene, null, 2)}\n`;
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

function renderArrow(edge: CoordinatedEdge): ExcalidrawArrowElement {
	const first = edge.points[0];
	if (first === undefined) {
		throw new TypeError(
			`Excalidraw edge ${edge.id} requires at least one point`,
		);
	}

	const relativePoints = edge.points.map((point) => ({
		x: point.x - first.x,
		y: point.y - first.y,
	}));
	const box = pointsBox(relativePoints);

	return {
		...baseElement(`edge:${edge.id}`, "arrow", {
			x: first.x,
			y: first.y,
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

function mapArrowhead(
	arrowhead: CoordinatedEdge["arrowhead"],
): ExcalidrawArrowElement["endArrowhead"] {
	if (arrowhead === "triangle" || arrowhead === "hollowTriangle") {
		return "triangle";
	}
	return "arrow";
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
