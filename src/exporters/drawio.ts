import { EDGE_CROSSING_GLYPH_RADIUS } from "../geometry/edge-crossings.js";
import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedNode,
	EdgeCrossing,
	NodeShape,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { ExportOptions } from "./types.js";

/**
 * Thin mxGraph / draw.io XML adapter (#89).
 * Emits waypoints and maps `edgeCrossings` to `jumpStyle` so hops are visible
 * downstream (global jumpStyle alone is insufficient for IR parity).
 */
export function exportDrawio(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const title = options.title ?? diagram.title ?? diagram.id;
	const crossings = diagram.edgeCrossings ?? [];
	const jumpStyle = crossings.length > 0 ? "arc" : "none";
	const cells: string[] = [`<mxCell id="0"/>`, `<mxCell id="1" parent="0"/>`];
	let nextId = 2;
	const nodeCellIds = new Map<string, string>();

	for (const node of diagram.nodes) {
		const cellId = String(nextId++);
		nodeCellIds.set(node.id, cellId);
		cells.push(renderNodeCell(cellId, node));
	}

	for (const edge of diagram.edges) {
		const cellId = String(nextId++);
		const sourceId = nodeCellIds.get(edge.source.nodeId) ?? "1";
		const targetId = nodeCellIds.get(edge.target.nodeId) ?? "1";
		const edgeCrossings = crossings.filter(
			(crossing) =>
				crossing.underEdgeId === edge.id || crossing.overEdgeId === edge.id,
		);
		cells.push(
			renderEdgeCell(
				cellId,
				edge,
				sourceId,
				targetId,
				jumpStyle,
				edgeCrossings,
			),
		);
	}

	const page = diagram.bounds;
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<mxfile host="auto-graph" type="device">`,
		`  <diagram id="${escapeXml(diagram.id)}" name="${escapeXml(title)}">`,
		`    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${formatNumber(Math.max(page.width, 1))}" pageHeight="${formatNumber(Math.max(page.height, 1))}">`,
		`      <root>`,
		...cells.map((cell) => `        ${cell}`),
		`      </root>`,
		`    </mxGraphModel>`,
		`  </diagram>`,
		`</mxfile>`,
		``,
	].join("\n");
}

function renderNodeCell(cellId: string, node: CoordinatedNode): string {
	const style = nodeShapeStyle(node.shape);
	const label = escapeXml(node.label?.text ?? node.id);
	return `<mxCell id="${escapeXml(cellId)}" value="${label}" style="${style}" vertex="1" parent="1"><mxGeometry x="${formatNumber(node.box.x)}" y="${formatNumber(node.box.y)}" width="${formatNumber(node.box.width)}" height="${formatNumber(node.box.height)}" as="geometry"/></mxCell>`;
}

function renderEdgeCell(
	cellId: string,
	edge: CoordinatedEdge,
	sourceId: string,
	targetId: string,
	jumpStyle: string,
	edgeCrossings: readonly EdgeCrossing[],
): string {
	const points = edge.points ?? [];
	const styleParts = [
		"edgeStyle=orthogonalEdgeStyle",
		"rounded=0",
		"orthogonalLoop=1",
		"jettySize=auto",
		"html=1",
		`jumpStyle=${jumpStyle}`,
		"jumpSize=6",
		"endArrow=block",
		"endFill=1",
	];
	if (edgeCrossings.length > 0) {
		styleParts.push(
			`dgeCrossings=${edgeCrossings
				.map(
					(crossing) =>
						`${formatNumber(crossing.x)},${formatNumber(crossing.y)},${crossing.style}`,
				)
				.join(";")}`,
		);
	}
	const geometryChildren: string[] = [];
	if (points.length >= 2) {
		const waypoints = points.slice(1, -1);
		if (waypoints.length > 0) {
			geometryChildren.push(
				`<Array as="points">${waypoints
					.map(
						(point) =>
							`<mxPoint x="${formatNumber(point.x)}" y="${formatNumber(point.y)}"/>`,
					)
					.join("")}</Array>`,
			);
		}
		const first = points[0] as Point;
		const last = points[points.length - 1] as Point;
		geometryChildren.push(
			`<mxPoint as="sourcePoint" x="${formatNumber(first.x)}" y="${formatNumber(first.y)}"/>`,
			`<mxPoint as="targetPoint" x="${formatNumber(last.x)}" y="${formatNumber(last.y)}"/>`,
		);
	}
	for (const crossing of edgeCrossings) {
		if (crossing.underEdgeId !== edge.id) continue;
		geometryChildren.push(
			`<mxPoint as="dgeJump" x="${formatNumber(crossing.x)}" y="${formatNumber(crossing.y)}" />`,
		);
	}
	void EDGE_CROSSING_GLYPH_RADIUS;
	return `<mxCell id="${escapeXml(cellId)}" value="${escapeXml(edge.label?.text ?? "")}" style="${escapeXml(styleParts.join(";"))}" edge="1" parent="1" source="${escapeXml(sourceId)}" target="${escapeXml(targetId)}"><mxGeometry relative="1" as="geometry">${geometryChildren.join("")}</mxGeometry></mxCell>`;
}

function nodeShapeStyle(shape: NodeShape): string {
	switch (shape) {
		case "ellipse":
			return "ellipse;whiteSpace=wrap;html=1;aspect=fixed;";
		case "diamond":
			return "rhombus;whiteSpace=wrap;html=1;";
		case "cylinder":
			return "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;";
		case "rounded-rectangle":
			return "rounded=1;whiteSpace=wrap;html=1;arcSize=20;";
		default:
			return "rounded=0;whiteSpace=wrap;html=1;";
	}
}

function formatNumber(value: number): string {
	return Number.isFinite(value) ? String(Number(value.toFixed(3))) : "0";
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function expandBoxForDrawio(bounds: Box, padding: number): Box {
	return {
		x: bounds.x - padding,
		y: bounds.y - padding,
		width: bounds.width + padding * 2,
		height: bounds.height + padding * 2,
	};
}
