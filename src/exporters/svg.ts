import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedGroup,
	CoordinatedNode,
	Label,
	NodeShape,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import { computeArrowhead } from "./arrow.js";
import type { ExportOptions } from "./types.js";

const NODE_FILL = "#f8fafc";
const GROUP_FILL = "#f9fafb";
const STROKE = "#374151";
const EDGE_STROKE = "#111827";
const FONT_FAMILY = "Arial, sans-serif";

export function exportSvg(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const title = options.title ?? diagram.title;
	const lines = [
		`<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="${formatBoxViewBox(diagram.bounds)}">`,
		...(title === undefined ? [] : [`  <title>${escapeXml(title)}</title>`]),
		`  <rect class="background" x="${formatNumber(diagram.bounds.x)}" y="${formatNumber(diagram.bounds.y)}" width="${formatNumber(diagram.bounds.width)}" height="${formatNumber(diagram.bounds.height)}" fill="#ffffff"/>`,
		...diagram.groups.map((group) => indent(renderGroup(group))),
		...diagram.edges.flatMap((edge) => {
			const path = renderEdgePath(edge.points, edge.id);
			if (path === undefined) {
				return [];
			}
			return [indent(path), indent(renderArrowhead(edge.points, edge.id))];
		}),
		...diagram.nodes.map((node) => indent(renderNode(node))),
		...diagram.groups.flatMap((group) =>
			renderLabel(group.label, group.box, group),
		),
		...diagram.nodes.flatMap((node) => renderLabel(node.label, node.box, node)),
		"</svg>",
	];

	return `${lines.join("\n")}\n`;
}

function renderGroup(group: CoordinatedGroup): string {
	return `<rect class="group" data-id="${escapeAttribute(group.id)}" x="${formatNumber(group.box.x)}" y="${formatNumber(group.box.y)}" width="${formatNumber(group.box.width)}" height="${formatNumber(group.box.height)}" fill="${GROUP_FILL}" stroke="${STROKE}" stroke-dasharray="6 4"/>`;
}

function renderNode(node: CoordinatedNode): string {
	const common = `class="node node-${node.shape}" data-id="${escapeAttribute(node.id)}" fill="${NODE_FILL}" stroke="${STROKE}"`;
	switch (node.shape) {
		case "rectangle":
			return renderRect(node.box, common);
		case "rounded-rectangle":
			return renderRect(node.box, `${common} rx="8" ry="8"`);
		case "ellipse":
			return `<ellipse ${common} cx="${formatNumber(node.box.x + node.box.width / 2)}" cy="${formatNumber(node.box.y + node.box.height / 2)}" rx="${formatNumber(node.box.width / 2)}" ry="${formatNumber(node.box.height / 2)}"/>`;
		case "diamond":
		case "parallelogram":
		case "hexagon":
			return `<polygon ${common} points="${formatPoints(shapePoints(node.shape, node.box))}"/>`;
		case "cylinder":
			return `<path ${common} d="${formatCylinderPath(node.box)}"/>`;
	}
}

function renderRect(box: Box, attributes: string): string {
	return `<rect ${attributes} x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}"/>`;
}

function renderLabel(
	label: Label | undefined,
	box: Box,
	item: CoordinatedNode | CoordinatedGroup,
): string[] {
	const labelLayout = item.labelLayout;
	if (labelLayout?.lines !== undefined && labelLayout.lines.length > 0) {
		return [
			`  <text class="label" data-for="${escapeAttribute(item.id)}" font-family="${FONT_FAMILY}" font-size="${formatNumber(labelLayout.font.fontSize)}" fill="#111827">`,
			...labelLayout.lines.map(
				(line) =>
					`    <tspan x="${formatNumber(line.box.x)}" y="${formatNumber(line.baselineY)}">${escapeXml(line.text)}</tspan>`,
			),
			"  </text>",
		];
	}

	if (label?.text === undefined) {
		return [];
	}

	return [
		`  <text class="label" data-for="${escapeAttribute(item.id)}" x="${formatNumber(box.x + box.width / 2)}" y="${formatNumber(box.y + box.height / 2)}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT_FAMILY}" font-size="14" fill="#111827">${escapeXml(label.text)}</text>`,
	];
}

function renderEdgePath(
	points: readonly Point[],
	id: string,
): string | undefined {
	if (points.length < 2) {
		return undefined;
	}

	return `<path class="edge" data-id="${escapeAttribute(id)}" d="${formatPath(points)}" fill="none" stroke="${EDGE_STROKE}" stroke-width="1.5"/>`;
}

function renderArrowhead(points: readonly Point[], id: string): string {
	const arrowhead = computeArrowhead(points);
	return `<polygon class="edge-arrowhead" data-edge="${escapeAttribute(id)}" points="${formatPoints([arrowhead.tip, arrowhead.left, arrowhead.right])}" fill="${EDGE_STROKE}" stroke="${EDGE_STROKE}"/>`;
}

function shapePoints(
	shape: Exclude<
		NodeShape,
		"rectangle" | "rounded-rectangle" | "ellipse" | "cylinder"
	>,
	box: Box,
): Point[] {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	const midX = box.x + box.width / 2;
	const midY = box.y + box.height / 2;
	const skew = Math.min(box.width * 0.2, 24);

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
		case "hexagon": {
			const inset = Math.min(box.width * 0.2, 24);
			return [
				{ x: left + inset, y: top },
				{ x: right - inset, y: top },
				{ x: right, y: midY },
				{ x: right - inset, y: bottom },
				{ x: left + inset, y: bottom },
				{ x: left, y: midY },
			];
		}
	}
}

function formatCylinderPath(box: Box): string {
	const rx = box.width / 2;
	const ry = Math.min(12, box.height / 4);
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;
	const midX = box.x + rx;

	return [
		`M ${formatNumber(left)} ${formatNumber(top + ry)}`,
		`A ${formatNumber(rx)} ${formatNumber(ry)} 0 0 1 ${formatNumber(right)} ${formatNumber(top + ry)}`,
		`L ${formatNumber(right)} ${formatNumber(bottom - ry)}`,
		`A ${formatNumber(rx)} ${formatNumber(ry)} 0 0 1 ${formatNumber(left)} ${formatNumber(bottom - ry)}`,
		"Z",
		`M ${formatNumber(left)} ${formatNumber(top + ry)}`,
		`A ${formatNumber(rx)} ${formatNumber(ry)} 0 0 0 ${formatNumber(right)} ${formatNumber(top + ry)}`,
		`M ${formatNumber(left)} ${formatNumber(bottom - ry)}`,
		`A ${formatNumber(rx)} ${formatNumber(ry)} 0 0 0 ${formatNumber(right)} ${formatNumber(bottom - ry)}`,
		`M ${formatNumber(midX)} ${formatNumber(top)}`,
	].join(" ");
}

function formatPath(points: readonly Point[]): string {
	return points
		.map((point, index) => {
			const command = index === 0 ? "M" : "L";
			return `${command} ${formatNumber(point.x)} ${formatNumber(point.y)}`;
		})
		.join(" ");
}

function formatPoints(points: readonly Point[]): string {
	return points
		.map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`)
		.join(" ");
}

function formatBoxViewBox(box: Box): string {
	return `${formatNumber(box.x)} ${formatNumber(box.y)} ${formatNumber(box.width)} ${formatNumber(box.height)}`;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new TypeError("SVG export requires finite coordinated numbers");
	}
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeXml(value).replaceAll('"', "&quot;");
}

function indent(value: string): string {
	return `  ${value}`;
}
