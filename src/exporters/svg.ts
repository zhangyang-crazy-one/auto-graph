import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedFrame,
	CoordinatedGroup,
	CoordinatedNode,
	EvidenceCell,
	EvidencePanel,
	Label,
	MatrixBlock,
	NodeShape,
	Swimlane,
	TableBlock,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import { computeArrowhead } from "./arrow.js";
import type { ExportOptions } from "./types.js";

const NODE_FILL = "#f8fafc";
const GROUP_FILL = "#f9fafb";
const STROKE = "#374151";
const EDGE_STROKE = "#111827";
const FONT_FAMILY = "Arial, sans-serif";
const EVIDENCE_FILL = "#f8fafc";
const EVIDENCE_HEADER_FILL = "#e5e7eb";
const EVIDENCE_PANEL_KIND_FILL = {
	legend: "#ecfdf5",
	rule: "#eff6ff",
	note: "#fffbeb",
	verification: "#fef2f2",
} as const;

type EvidenceBlockWithBox<T> = T & { box: Box };
type CoordinatedMatrixBlock = EvidenceBlockWithBox<MatrixBlock>;
type CoordinatedEvidencePanel = EvidenceBlockWithBox<EvidencePanel>;
type CoordinatedTableBlock = TableBlock & {
	box: Box;
	columnXOffsets: number[];
};

export function exportSvg(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const title = options.title ?? diagram.title;
	const annotations = diagram.textAnnotations ?? [];
	return `${[
		`<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="${formatBoxViewBox(diagram.bounds)}">`,
		...(title === undefined ? [] : [`  <title>${escapeXml(title)}</title>`]),
		`  <rect class="background" x="${formatNumber(diagram.bounds.x)}" y="${formatNumber(diagram.bounds.y)}" width="${formatNumber(diagram.bounds.width)}" height="${formatNumber(diagram.bounds.height)}" fill="#ffffff"/>`,
		...(diagram.frame === undefined
			? []
			: [indent(renderFrame(diagram.frame, annotations))]),
		...(diagram.swimlanes ?? []).flatMap((swimlane) =>
			renderSwimlane(swimlane, annotations),
		),
		...diagram.groups.map((group) => indent(renderGroup(group))),
		...(diagram.matrices ?? []).flatMap((matrix) =>
			indentLines(renderMatrixBlock(matrix as CoordinatedMatrixBlock)),
		),
		...(diagram.tables ?? []).flatMap((table) =>
			indentLines(renderTableBlock(table as CoordinatedTableBlock)),
		),
		...(diagram.evidencePanels ?? []).flatMap((panel) =>
			indentLines(renderEvidencePanel(panel as CoordinatedEvidencePanel)),
		),
		...diagram.edges.flatMap((edge) => {
			const path = renderEdgePath(edge);
			return path === undefined
				? []
				: [indent(path), indent(renderArrowhead(edge))];
		}),
		...diagram.nodes.map((node) => indent(renderNode(node))),
		...diagram.nodes.flatMap((node) => renderCompartments(node, annotations)),
		...diagram.nodes.flatMap((node) => renderPorts(node, annotations)),
		...diagram.groups.flatMap((group) =>
			renderLabel(group.label, group.box, group, annotations, "group-label"),
		),
		...diagram.nodes.flatMap((node) =>
			node.compartments === undefined
				? renderLabel(node.label, node.box, node, annotations, "node-label")
				: [],
		),
		...diagram.edges.flatMap((edge) => renderEdgeLabel(edge, annotations)),
		"</svg>",
	].join("\n")}\n`;
}

function renderGroup(group: CoordinatedGroup): string {
	return `<rect class="group" data-id="${escapeAttribute(group.id)}" x="${formatNumber(group.box.x)}" y="${formatNumber(group.box.y)}" width="${formatNumber(group.box.width)}" height="${formatNumber(group.box.height)}" fill="${GROUP_FILL}" stroke="${STROKE}" stroke-dasharray="6 4"/>`;
}

function renderMatrixBlock(matrix: CoordinatedMatrixBlock): string[] {
	const columnCount = Math.max(1, matrix.cols.length);
	const rowCount = matrix.rows.length;
	const cellWidth = matrix.box.width / columnCount;
	const rowHeight = matrix.box.height / Math.max(1, rowCount + 1);
	const lines = [
		`<g class="matrix-block" data-id="${escapeAttribute(matrix.id)}" data-row-count="${rowCount}" data-column-count="${matrix.cols.length}">`,
		`  <rect class="matrix-frame" x="${formatNumber(matrix.box.x)}" y="${formatNumber(matrix.box.y)}" width="${formatNumber(matrix.box.width)}" height="${formatNumber(matrix.box.height)}" fill="${escapeAttribute(matrix.style?.fill ?? EVIDENCE_FILL)}" stroke="${escapeAttribute(matrix.style?.stroke ?? STROKE)}"/>`,
	];

	for (let columnIndex = 0; columnIndex < matrix.cols.length; columnIndex += 1) {
		const column = matrix.cols[columnIndex];
		if (column === undefined) {
			continue;
		}
		const x = matrix.box.x + columnIndex * cellWidth;
		lines.push(
			`  <rect class="matrix-column-header" data-col="${escapeAttribute(column)}" x="${formatNumber(x)}" y="${formatNumber(matrix.box.y)}" width="${formatNumber(cellWidth)}" height="${formatNumber(rowHeight)}" fill="${EVIDENCE_HEADER_FILL}" stroke="${STROKE}"/>`,
			renderEvidenceText("matrix-column-label", column, {
				x,
				y: matrix.box.y,
				width: cellWidth,
				height: rowHeight,
			}),
		);
	}

	for (let rowIndex = 0; rowIndex < matrix.rows.length; rowIndex += 1) {
		const row = matrix.rows[rowIndex];
		const cells = matrix.cells[rowIndex] ?? [];
		if (row === undefined) {
			continue;
		}
		for (let columnIndex = 0; columnIndex < matrix.cols.length; columnIndex += 1) {
			const column = matrix.cols[columnIndex];
			if (column === undefined) {
				continue;
			}
			const cell = cells[columnIndex] ?? { text: "" };
			const box = {
				x: matrix.box.x + columnIndex * cellWidth,
				y: matrix.box.y + (rowIndex + 1) * rowHeight,
				width: cellWidth,
				height: rowHeight,
			};
			lines.push(
				`  <rect class="matrix-cell" data-row="${escapeAttribute(row)}" data-col="${escapeAttribute(column)}" x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" fill="${escapeAttribute(cell.style?.fill ?? "#ffffff")}" stroke="${escapeAttribute(cell.style?.stroke ?? STROKE)}"/>`,
				renderEvidenceText("matrix-cell-label", cell.text, box),
			);
		}
	}

	lines.push("</g>");
	return lines;
}

function renderTableBlock(table: CoordinatedTableBlock): string[] {
	const columnCount = Math.max(1, table.columns.length);
	const rowHeight = table.box.height / Math.max(1, table.rows.length + 1);
	const lines = [
		`<g class="table-block" data-id="${escapeAttribute(table.id)}" data-row-count="${table.rows.length}" data-column-count="${table.columns.length}">`,
		`  <rect class="table-frame" x="${formatNumber(table.box.x)}" y="${formatNumber(table.box.y)}" width="${formatNumber(table.box.width)}" height="${formatNumber(table.box.height)}" fill="${escapeAttribute(table.style?.fill ?? EVIDENCE_FILL)}" stroke="${escapeAttribute(table.style?.stroke ?? STROKE)}"/>`,
		`  <g class="table-header" data-column-count="${table.columns.length}">`,
	];

	for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex += 1) {
		const column = table.columns[columnIndex];
		if (column === undefined) {
			continue;
		}
		const columnBox = tableCellBox(table, columnIndex, 0, rowHeight, columnCount);
		lines.push(
			`    <rect class="table-header-cell" data-col="${escapeAttribute(column.id)}" x="${formatNumber(columnBox.x)}" y="${formatNumber(columnBox.y)}" width="${formatNumber(columnBox.width)}" height="${formatNumber(columnBox.height)}" fill="${EVIDENCE_HEADER_FILL}" stroke="${STROKE}"/>`,
			`    ${renderEvidenceText("table-header-label", column.label.text, columnBox)}`,
		);
	}
	lines.push("  </g>");

	for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
		const row = table.rows[rowIndex];
		if (row === undefined) {
			continue;
		}
		const rowBox = {
			x: table.box.x,
			y: table.box.y + (rowIndex + 1) * rowHeight,
			width: table.box.width,
			height: rowHeight,
		};
		const rowClass = rowIndex % 2 === 0 ? "table-row-even" : "table-row-odd";
		lines.push(
			`  <g class="table-row ${rowClass}" data-row="${escapeAttribute(row.id)}">`,
			`    <rect class="${rowClass}" data-row="${escapeAttribute(row.id)}" x="${formatNumber(rowBox.x)}" y="${formatNumber(rowBox.y)}" width="${formatNumber(rowBox.width)}" height="${formatNumber(rowBox.height)}" fill="${rowIndex % 2 === 0 ? "#ffffff" : "#f3f4f6"}" stroke="none"/>`,
		);
		for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex += 1) {
			const column = table.columns[columnIndex];
			if (column === undefined) {
				continue;
			}
			const cell = row.cells[column.id] ?? { text: "" };
			const cellBox = tableCellBox(
				table,
				columnIndex,
				rowIndex + 1,
				rowHeight,
				columnCount,
			);
			lines.push(
				`    <rect class="table-cell" data-col="${escapeAttribute(column.id)}" x="${formatNumber(cellBox.x)}" y="${formatNumber(cellBox.y)}" width="${formatNumber(cellBox.width)}" height="${formatNumber(cellBox.height)}" fill="${escapeAttribute(cell.style?.fill ?? "transparent")}" stroke="${escapeAttribute(cell.style?.stroke ?? STROKE)}"/>`,
				`    ${renderEvidenceText("table-cell-label", cell.text, cellBox)}`,
			);
		}
		lines.push("  </g>");
	}

	lines.push("</g>");
	return lines;
}

function renderEvidencePanel(panel: CoordinatedEvidencePanel): string[] {
	const titleWidth = Math.min(panel.box.width * 0.36, 140);
	const itemBox = {
		x: panel.box.x + titleWidth,
		y: panel.box.y,
		width: panel.box.width - titleWidth,
		height: panel.box.height,
	};
	const titleBox = {
		x: panel.box.x,
		y: panel.box.y,
		width: titleWidth,
		height: panel.box.height,
	};
	const itemHeight = panel.box.height / Math.max(1, panel.items.length);
	const lines = [
		`<g class="evidence-panel evidence-panel--${panel.kind}" data-id="${escapeAttribute(panel.id)}" data-kind="${escapeAttribute(panel.kind)}" data-item-count="${panel.items.length}">`,
		`  <rect class="evidence-panel-frame" x="${formatNumber(panel.box.x)}" y="${formatNumber(panel.box.y)}" width="${formatNumber(panel.box.width)}" height="${formatNumber(panel.box.height)}" fill="${escapeAttribute(panel.style?.fill ?? EVIDENCE_PANEL_KIND_FILL[panel.kind])}" stroke="${escapeAttribute(panel.style?.stroke ?? STROKE)}"/>`,
		`  <g class="evidence-panel-title-cell">`,
		`    <rect class="evidence-panel-title-bg" x="${formatNumber(titleBox.x)}" y="${formatNumber(titleBox.y)}" width="${formatNumber(titleBox.width)}" height="${formatNumber(titleBox.height)}" fill="${EVIDENCE_HEADER_FILL}" stroke="${STROKE}"/>`,
		`    ${renderEvidenceText("evidence-panel-title", `${panel.kind}: ${panel.id}`, titleBox)}`,
		"  </g>",
		`  <g class="evidence-panel-items-cell">`,
		`    <rect class="evidence-panel-items-bg" x="${formatNumber(itemBox.x)}" y="${formatNumber(itemBox.y)}" width="${formatNumber(itemBox.width)}" height="${formatNumber(itemBox.height)}" fill="transparent" stroke="${STROKE}"/>`,
	];

	for (let index = 0; index < panel.items.length; index += 1) {
		const item = panel.items[index];
		if (item === undefined) {
			continue;
		}
		const text = panelItemText(item.label.text, item.detail?.text);
		const box = {
			x: itemBox.x,
			y: itemBox.y + index * itemHeight,
			width: itemBox.width,
			height: itemHeight,
		};
		lines.push(
			`    <rect class="evidence-panel-item" data-item="${escapeAttribute(item.id ?? String(index))}" x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" fill="${escapeAttribute(item.style?.fill ?? "transparent")}" stroke="${escapeAttribute(item.style?.stroke ?? "none")}"/>`,
			`    ${renderEvidenceText("evidence-panel-item-label", text, box)}`,
		);
	}

	lines.push("  </g>", "</g>");
	return lines;
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

function renderFrame(
	frame: CoordinatedFrame,
	annotations: readonly SolvedTextAnnotation[],
): string {
	const stroke = frame.style?.stroke ?? "#6b7280";
	const fill = frame.style?.fill ?? "transparent";
	return [
		`<g class="sysml-frame" data-kind="${escapeAttribute(frame.kind)}">`,
		`  <rect class="sysml-frame-border" x="${formatNumber(frame.box.x)}" y="${formatNumber(frame.box.y)}" width="${formatNumber(frame.box.width)}" height="${formatNumber(frame.box.height)}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(stroke)}"/>`,
		`  <path class="sysml-title-tab" d="M ${formatNumber(frame.titleBox.x)} ${formatNumber(frame.titleBox.y + frame.titleBox.height)} L ${formatNumber(frame.titleBox.x)} ${formatNumber(frame.titleBox.y)} L ${formatNumber(frame.titleBox.x + frame.titleBox.width - 16)} ${formatNumber(frame.titleBox.y)} L ${formatNumber(frame.titleBox.x + frame.titleBox.width)} ${formatNumber(frame.titleBox.y + frame.titleBox.height)} Z" fill="#f3f4f6" stroke="${escapeAttribute(stroke)}"/>`,
		...(renderSolvedTextAnnotation(
			findAnnotation(annotations, "frame-title", frame.kind),
			`sysml-title-tab-label`,
			{
				indent: "  ",
				mode: "center",
				fallbackText: frame.titleTab,
				fallbackFontSize: 12,
			},
		) ?? [
			`  <text class="sysml-title-tab-label" x="${formatNumber(frame.titleBox.x + 8)}" y="${formatNumber(frame.titleBox.y + frame.titleBox.height / 2)}" dominant-baseline="middle" font-family="${FONT_FAMILY}" font-size="12" fill="#111827">${escapeXml(frame.titleTab)}</text>`,
		]),
		"</g>",
	].join("\n");
}

function renderSwimlane(
	swimlane: Swimlane,
	annotations: readonly SolvedTextAnnotation[],
): string[] {
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
			const annotation = findAnnotation(
				annotations,
				"swimlane-label",
				`${swimlane.id}.${lane.id}`,
			);
			lines.push(
				...(annotation === undefined
					? [
							renderSwimlaneLabel(
								swimlane,
								lane.label.text,
								lane.headerBox ?? lane.box,
							),
						]
					: (renderSolvedTextAnnotation(annotation, "swimlane-label", {
							indent: "    ",
							mode: "center",
							rotate: swimlane.orientation === "horizontal",
						}) ?? [])),
			);
		}
	}
	lines.push("  </g>");
	return lines;
}

function renderPorts(
	node: CoordinatedNode,
	annotations: readonly SolvedTextAnnotation[],
): string[] {
	return (node.ports ?? []).flatMap((port) => [
		`  <rect class="port" data-kind="${escapeAttribute(port.kind)}" data-port="${escapeAttribute(`${node.id}.${port.id}`)}" x="${formatNumber(port.box.x)}" y="${formatNumber(port.box.y)}" width="${formatNumber(port.box.width)}" height="${formatNumber(port.box.height)}" fill="${escapeAttribute(port.style?.fill ?? "#d9ead3")}" stroke="${escapeAttribute(port.style?.stroke ?? STROKE)}"/>`,
		...(port.label?.text === undefined
			? []
			: (() => {
					const annotation = findAnnotation(
						annotations,
						"port-label",
						`${node.id}.${port.id}`,
					);
					return annotation === undefined
						? [
								`  <text class="port-label" data-for="${escapeAttribute(`${node.id}.${port.id}`)}" x="${formatNumber(portLabelX(port.anchor.x, port.side))}" y="${formatNumber(port.anchor.y - 8)}" text-anchor="${port.side === "left" ? "end" : "start"}" font-family="${FONT_FAMILY}" font-size="10" fill="#111827">${escapeXml(port.label.text)}</text>`,
							]
						: (renderSolvedTextAnnotation(annotation, "port-label", {
								indent: "  ",
								mode: "center",
								textAnchor: port.side === "left" ? "end" : "start",
							}) ?? []);
				})()),
	]);
}

function renderCompartments(
	node: CoordinatedNode,
	annotations: readonly SolvedTextAnnotation[],
): string[] {
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
	const lines = [
		`  <g class="compartment" data-for="${escapeAttribute(node.id)}">`,
	];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (row === undefined) {
			continue;
		}
		const y = node.box.y + 18 + index * 16;
		if (index > 1) {
			lines.push(
				`    <line class="compartment-separator" x1="${formatNumber(node.box.x)}" y1="${formatNumber(y - 12)}" x2="${formatNumber(node.box.x + node.box.width)}" y2="${formatNumber(y - 12)}" stroke="${STROKE}"/>`,
			);
		}
		const annotation = findAnnotation(
			annotations,
			"compartment-row",
			node.id,
			index,
		);
		lines.push(
			...(annotation === undefined
				? [
						`    <text class="compartment-${row.className}" x="${formatNumber(node.box.x + node.box.width / 2)}" y="${formatNumber(y)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#111827">${escapeXml(row.text)}</text>`,
					]
				: (renderSolvedTextAnnotation(
						annotation,
						`compartment-${row.className}`,
						{
							indent: "    ",
							mode: "center",
						},
					) ?? [])),
		);
	}
	lines.push("  </g>");
	return lines;
}

function renderLabel(
	label: Label | undefined,
	box: Box,
	item: CoordinatedNode | CoordinatedGroup,
	annotations: readonly SolvedTextAnnotation[],
	surfaceKind: SolvedTextAnnotation["surfaceKind"],
): string[] {
	const annotation = findAnnotation(annotations, surfaceKind, item.id);
	if (annotation !== undefined) {
		return (
			renderSolvedTextAnnotation(annotation, "label", {
				indent: "  ",
				mode: "center",
			}) ?? []
		);
	}
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

function renderEdgeLabel(
	edge: CoordinatedEdge,
	annotations: readonly SolvedTextAnnotation[],
): string[] {
	if (edge.label?.text === undefined || edge.points.length < 2) {
		return [];
	}
	const annotation = findAnnotation(annotations, "edge-label", edge.id);
	if (annotation !== undefined) {
		return (
			renderSolvedTextAnnotation(annotation, "edge-label", {
				indent: "  ",
				mode: "center",
			}) ?? []
		);
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

function renderSolvedTextAnnotation(
	annotation: SolvedTextAnnotation | undefined,
	className: string,
	options: {
		indent: string;
		mode: "center" | "start";
		textAnchor?: string;
		rotate?: boolean;
		fallbackText?: string;
		fallbackFontSize?: number;
	},
): string[] | undefined {
	if (annotation === undefined) {
		return undefined;
	}
	const x =
		options.mode === "center"
			? annotation.box.x + annotation.box.width / 2
			: annotation.box.x;
	const y =
		options.mode === "center"
			? annotation.box.y + annotation.box.height / 2
			: annotation.box.y + annotation.box.height;
	const rotate = options.rotate
		? ` transform="rotate(-90 ${formatNumber(x)} ${formatNumber(y)})"`
		: "";
	const attrs = [
		`class="${className}"`,
		`data-for="${escapeAttribute(annotation.ownerId)}"`,
		`data-text-surface="${escapeAttribute(annotation.surfaceKind)}"`,
		`data-owner-id="${escapeAttribute(annotation.ownerId)}"`,
		`data-text-backend="${escapeAttribute(annotation.textBackend ?? "deterministic")}"`,
		`font-family="${FONT_FAMILY}"`,
		`font-size="${formatNumber(annotation.fontSize)}"`,
		`fill="#111827"`,
	];
	if (options.mode === "center") {
		attrs.push('text-anchor="middle"');
	} else {
		attrs.push(`text-anchor="${options.textAnchor ?? "start"}"`);
	}
	if (annotation.lines.length > 1) {
		return [
			`${options.indent}<text ${attrs.join(" ")}${rotate}>`,
			...annotation.lines.map(
				(line) =>
					`${options.indent}  <tspan x="${formatNumber(textLineX(annotation, line, options))}" y="${formatNumber(annotation.box.y + line.baselineY)}">${escapeXml(line.text)}</tspan>`,
			),
			`${options.indent}</text>`,
		];
	}
	const line = annotation.lines[0];
	const text = line?.text ?? options.fallbackText ?? annotation.text;
	const singleLineAttrs =
		options.mode === "center"
			? [...attrs, 'dominant-baseline="middle"']
			: attrs;
	return [
		`${options.indent}<text ${singleLineAttrs.join(" ")} x="${formatNumber(x)}" y="${formatNumber(y)}"${rotate}>${escapeXml(text)}</text>`,
	];
}

function textLineX(
	annotation: SolvedTextAnnotation,
	line: SolvedTextAnnotation["lines"][number],
	options: {
		mode: "center" | "start";
		textAnchor?: string;
	},
): number {
	if (options.mode === "center") {
		return annotation.box.x + line.box.x + line.box.width / 2;
	}
	if ((options.textAnchor ?? "start") === "end") {
		return annotation.box.x + line.box.x + line.box.width;
	}
	return annotation.box.x + line.box.x;
}

function findAnnotation(
	annotations: readonly SolvedTextAnnotation[],
	surfaceKind: SolvedTextAnnotation["surfaceKind"],
	ownerId: string,
	index?: number,
): SolvedTextAnnotation | undefined {
	return annotations.find((annotation) => {
		if (annotation.surfaceKind !== surfaceKind) {
			return false;
		}
		if (annotation.ownerId !== ownerId) {
			return false;
		}
		if (index === undefined) {
			return annotation.surfaceIndex === undefined;
		}
		return annotation.surfaceIndex === index;
	});
}

function renderSwimlaneLabel(
	swimlane: Swimlane,
	text: string,
	labelBox: Box,
): string {
	const x = labelBox.x + labelBox.width / 2;
	const y = labelBox.y + labelBox.height / 2;
	const transform =
		swimlane.orientation === "horizontal"
			? ` transform="rotate(-90 ${formatNumber(x)} ${formatNumber(y)})"`
			: "";
	return `    <text class="swimlane-label" x="${formatNumber(x)}" y="${formatNumber(y)}" text-anchor="middle" dominant-baseline="middle"${transform} font-family="${FONT_FAMILY}" font-size="12" fill="#111827">${escapeXml(text)}</text>`;
}

function renderRect(box: Box, attributes: string): string {
	return `<rect ${attributes} x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}"/>`;
}

function tableCellBox(
	table: CoordinatedTableBlock,
	columnIndex: number,
	rowIndex: number,
	rowHeight: number,
	columnCount: number,
): Box {
	const x =
		table.columnXOffsets[columnIndex] ??
		table.box.x + (table.box.width / columnCount) * columnIndex;
	const nextX =
		table.columnXOffsets[columnIndex + 1] ?? table.box.x + table.box.width;
	return {
		x,
		y: table.box.y + rowIndex * rowHeight,
		width: nextX - x,
		height: rowHeight,
	};
}

function renderEvidenceText(className: string, text: string, box: Box): string {
	return `<text class="${className}" x="${formatNumber(box.x + box.width / 2)}" y="${formatNumber(box.y + box.height / 2)}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT_FAMILY}" font-size="10" fill="#111827">${escapeXml(text)}</text>`;
}

function panelItemText(label: string, detail: string | undefined): string {
	return detail === undefined ? label : `${label}: ${detail}`;
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
		case "hexagon":
			return [
				{ x: left + skew, y: top },
				{ x: right - skew, y: top },
				{ x: right, y: midY },
				{ x: right - skew, y: bottom },
				{ x: left + skew, y: bottom },
				{ x: left, y: midY },
			];
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
		.map(
			(point, index) =>
				`${index === 0 ? "M" : "L"} ${formatNumber(point.x)} ${formatNumber(point.y)}`,
		)
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

function indentLines(values: readonly string[]): string[] {
	return values.map(indent);
}
