import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedNode,
	Label,
	NodeShape,
	Swimlane,
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
		...(diagram.frame === undefined
			? []
			: [indent(renderFrame(diagram.frame))]),
		...(diagram.swimlanes ?? []).flatMap((swimlane) =>
			renderSwimlane(swimlane),
		),
		...diagram.groups.map((group) => indent(renderGroup(group))),
		...diagram.edges.flatMap((edge) => {
			const path = renderEdgePath(edge);
			if (path === undefined) {
				return [];
			}
			return [indent(path), indent(renderArrowhead(edge))];
		}),
		...diagram.nodes.map((node) => indent(renderNode(node))),
		...diagram.nodes.flatMap((node) => renderCompartments(node)),
		...diagram.nodes.flatMap((node) => renderPorts(node)),
		...diagram.groups.flatMap((group) =>
			renderLabel(group.label, group.box, group),
		),
		...diagram.nodes.flatMap((node) =>
			node.compartments === undefined
				? renderLabel(node.label, node.box, node)
				: [],
		),
		...diagram.edges.flatMap((edge) => renderEdgeLabel(edge)),
		"</svg>",
	];

	return `${lines.join("\n")}\n`;
}

function renderGroup(group: CoordinatedGroup): string {
	return `<rect class="group" data-id="${escapeAttribute(group.id)}" x="${formatNumber(group.box.x)}" y="${formatNumber(group.box.y)}" width="${formatNumber(group.box.width)}" height="${formatNumber(group.box.height)}" fill="${GROUP_FILL}" stroke="${STROKE}" stroke-dasharray="6 4"/>`;
}

function renderNode(node: CoordinatedNode): string {
	const fill = node.style?.fill ?? NODE_FILL;
	const stroke = node.style?.stroke ?? STROKE;
	const common = `class="node node-${node.shape}" data-id="${escapeAttribute(node.id)}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(stroke)}"`;
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

function renderFrame(frame: CoordinatedFrame): string {
	const stroke = frame.style?.stroke ?? "#6b7280";
	const fill = frame.style?.fill ?? "transparent";
	return [
		`<g class="sysml-frame" data-kind="${escapeAttribute(frame.kind)}">`,
		`  <rect class="sysml-frame-border" x="${formatNumber(frame.box.x)}" y="${formatNumber(frame.box.y)}" width="${formatNumber(frame.box.width)}" height="${formatNumber(frame.box.height)}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(stroke)}"/>`,
		`  <path class="sysml-title-tab" d="M ${formatNumber(frame.titleBox.x)} ${formatNumber(frame.titleBox.y + frame.titleBox.height)} L ${formatNumber(frame.titleBox.x)} ${formatNumber(frame.titleBox.y)} L ${formatNumber(frame.titleBox.x + frame.titleBox.width - 16)} ${formatNumber(frame.titleBox.y)} L ${formatNumber(frame.titleBox.x + frame.titleBox.width)} ${formatNumber(frame.titleBox.y + frame.titleBox.height)} Z" fill="#f3f4f6" stroke="${escapeAttribute(stroke)}"/>`,
		`  <text class="sysml-title-tab-label" x="${formatNumber(frame.titleBox.x + 8)}" y="${formatNumber(frame.titleBox.y + frame.titleBox.height / 2)}" dominant-baseline="middle" font-family="${FONT_FAMILY}" font-size="12" fill="#111827">${escapeXml(frame.titleTab)}</text>`,
		"</g>",
	].join("\n");
}

function renderSwimlane(swimlane: Swimlane): string[] {
	if (swimlane.box === undefined) {
		return [];
	}
	const lines = [
		`  <g class="swimlane" data-id="${escapeAttribute(swimlane.id)}">`,
		`    <rect class="swimlane-frame" x="${formatNumber(swimlane.box.x)}" y="${formatNumber(swimlane.box.y)}" width="${formatNumber(swimlane.box.width)}" height="${formatNumber(swimlane.box.height)}" fill="#ffffff" stroke="${STROKE}"/>`,
	];
	for (const lane of swimlane.lanes) {
		if (lane.box === undefined) {
			continue;
		}
		lines.push(
			`    <rect class="swimlane-lane" data-lane="${escapeAttribute(`${swimlane.id}.${lane.id}`)}" x="${formatNumber(lane.box.x)}" y="${formatNumber(lane.box.y)}" width="${formatNumber(lane.box.width)}" height="${formatNumber(lane.box.height)}" fill="none" stroke="${STROKE}"/>`,
		);
		if (lane.headerBox !== undefined) {
			lines.push(
				`    <rect class="swimlane-header" data-lane-header="${escapeAttribute(`${swimlane.id}.${lane.id}`)}" x="${formatNumber(lane.headerBox.x)}" y="${formatNumber(lane.headerBox.y)}" width="${formatNumber(lane.headerBox.width)}" height="${formatNumber(lane.headerBox.height)}" fill="#f3f4f6" stroke="${STROKE}"/>`,
			);
		}
		if (lane.contentBox !== undefined) {
			lines.push(
				`    <rect class="swimlane-content" data-lane-content="${escapeAttribute(`${swimlane.id}.${lane.id}`)}" x="${formatNumber(lane.contentBox.x)}" y="${formatNumber(lane.contentBox.y)}" width="${formatNumber(lane.contentBox.width)}" height="${formatNumber(lane.contentBox.height)}" fill="none" stroke="none"/>`,
			);
		}
		if (lane.label?.text !== undefined) {
			const labelBox = lane.headerBox ?? lane.box;
			lines.push(
				`    <text class="swimlane-label" x="${formatNumber(labelBox.x + labelBox.width / 2)}" y="${formatNumber(labelBox.y + labelBox.height / 2)}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT_FAMILY}" font-size="12" fill="#111827">${escapeXml(lane.label.text)}</text>`,
			);
		}
	}
	lines.push("  </g>");
	return lines;
}

function renderPorts(node: CoordinatedNode): string[] {
	return (node.ports ?? []).flatMap((port) => [
		`  <rect class="port" data-kind="${escapeAttribute(port.kind)}" data-port="${escapeAttribute(`${node.id}.${port.id}`)}" x="${formatNumber(port.box.x)}" y="${formatNumber(port.box.y)}" width="${formatNumber(port.box.width)}" height="${formatNumber(port.box.height)}" fill="${escapeAttribute(port.style?.fill ?? "#d9ead3")}" stroke="${escapeAttribute(port.style?.stroke ?? STROKE)}"/>`,
		...(port.label?.text === undefined
			? []
			: [
					`  <text class="port-label" data-for="${escapeAttribute(`${node.id}.${port.id}`)}" x="${formatNumber(portLabelX(port.anchor.x, port.side))}" y="${formatNumber(port.anchor.y - 8)}" text-anchor="${port.side === "left" ? "end" : "start"}" font-family="${FONT_FAMILY}" font-size="10" fill="#111827">${escapeXml(port.label.text)}</text>`,
				]),
	]);
}

function renderCompartments(node: CoordinatedNode): string[] {
	const compartments = node.compartments;
	if (compartments === undefined) {
		return [];
	}
	const rows = [
		...(compartments.stereotype === undefined
			? []
			: [{ className: "stereotype", text: compartments.stereotype }]),
		{
			className: "name",
			text: compartments.name ?? node.label?.text ?? node.id,
		},
		...(compartments.properties ?? []).map((text) => ({
			className: "properties",
			text,
		})),
		...(compartments.constraints ?? []).map((text) => ({
			className: "constraints",
			text,
		})),
	];
	const lineHeight = 16;
	const lines = [
		`  <g class="compartment" data-for="${escapeAttribute(node.id)}">`,
	];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (row === undefined) {
			continue;
		}
		const y = node.box.y + 18 + index * lineHeight;
		if (index > 1) {
			lines.push(
				`    <line class="compartment-separator" x1="${formatNumber(node.box.x)}" y1="${formatNumber(y - 12)}" x2="${formatNumber(node.box.x + node.box.width)}" y2="${formatNumber(y - 12)}" stroke="${STROKE}"/>`,
			);
		}
		lines.push(
			`    <text class="compartment-${row.className}" x="${formatNumber(node.box.x + node.box.width / 2)}" y="${formatNumber(y)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#111827">${escapeXml(row.text)}</text>`,
		);
	}
	lines.push("  </g>");
	return lines;
}

function portLabelX(x: number, side: string): number {
	if (side === "left") {
		return x - 8;
	}
	if (side === "right") {
		return x + 8;
	}
	return x + 8;
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
		const offset = { x: box.x, y: box.y };
		return [
			`  <text class="label" data-for="${escapeAttribute(item.id)}" font-family="${FONT_FAMILY}" font-size="${formatNumber(labelLayout.font.fontSize)}" fill="#111827">`,
			...labelLayout.lines.map(
				(line) =>
					`    <tspan x="${formatNumber(offset.x + line.box.x)}" y="${formatNumber(offset.y + line.baselineY)}">${escapeXml(line.text)}</tspan>`,
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

function renderEdgePath(edge: CoordinatedEdge): string | undefined {
	if (edge.points.length < 2) {
		return undefined;
	}

	const dash = edge.style === "dashed" ? ' stroke-dasharray="6 4"' : "";
	return `<path class="edge" data-id="${escapeAttribute(edge.id)}" d="${formatPath(pathPointsBeforeArrowhead(edge.points))}" fill="none" stroke="${EDGE_STROKE}" stroke-width="1.5"${dash}/>`;
}

function renderEdgeLabel(edge: CoordinatedEdge): string[] {
	if (edge.label?.text === undefined || edge.points.length < 2) {
		return [];
	}

	const placement = labelPlacementOnPolyline(edge.points);
	if (placement === undefined) {
		return [];
	}

	return [
		`  <text class="edge-label" data-for="${escapeAttribute(edge.id)}" x="${formatNumber(placement.x)}" y="${formatNumber(placement.y)}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT_FAMILY}" font-size="12" fill="#111827">${escapeXml(edge.label.text)}</text>`,
	];
}

function renderArrowhead(edge: CoordinatedEdge): string {
	const arrowhead = computeArrowhead(edge.points);
	const fill = edge.arrowhead === "hollowTriangle" ? "none" : EDGE_STROKE;
	return `<polygon class="edge-arrowhead" data-edge="${escapeAttribute(edge.id)}" points="${formatPoints([arrowhead.tip, arrowhead.left, arrowhead.right])}" fill="${fill}" stroke="${EDGE_STROKE}"/>`;
}

function labelPlacementOnPolyline(points: readonly Point[]): Point | undefined {
	const segments = nonZeroSegments(points);
	const totalLength = segments.reduce(
		(sum, segment) => sum + segment.length,
		0,
	);
	if (totalLength <= 0) {
		return undefined;
	}

	let remaining = totalLength / 2;
	for (const segment of segments) {
		if (remaining <= segment.length) {
			const ratio = remaining / segment.length;
			const x = segment.start.x + (segment.end.x - segment.start.x) * ratio;
			const y = segment.start.y + (segment.end.y - segment.start.y) * ratio;
			const offset = labelOffset(segment);
			return { x: x + offset.x, y: y + offset.y };
		}
		remaining -= segment.length;
	}

	const last = segments.at(-1);
	if (last === undefined) {
		return undefined;
	}
	const offset = labelOffset(last);
	return { x: last.end.x + offset.x, y: last.end.y + offset.y };
}

function nonZeroSegments(points: readonly Point[]): Array<{
	start: Point;
	end: Point;
	length: number;
}> {
	const segments: Array<{ start: Point; end: Point; length: number }> = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		if (length > 0) {
			segments.push({ start, end, length });
		}
	}
	return segments;
}

function labelOffset(segment: {
	start: Point;
	end: Point;
	length: number;
}): Point {
	const offset = 10;
	const dx = segment.end.x - segment.start.x;
	const dy = segment.end.y - segment.start.y;
	return {
		x: (-dy / segment.length) * offset,
		y: (dx / segment.length) * offset,
	};
}

function pathPointsBeforeArrowhead(points: readonly Point[]): Point[] {
	const arrowhead = computeArrowhead(points);
	const base = {
		x: (arrowhead.left.x + arrowhead.right.x) / 2,
		y: (arrowhead.left.y + arrowhead.right.y) / 2,
	};
	return [...points.slice(0, -1), base];
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
