import type { CoordinatedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedEvidencePanel,
	CoordinatedMatrixBlock,
	CoordinatedNode,
	CoordinatedTableBlock,
	EdgeCrossing,
	EdgeCrossingStyle,
	NodeShape,
	Swimlane,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import type { ExportOptions } from "./types.js";

/**
 * mxGraph / draw.io XML adapter (#89).
 *
 * Every solved element is written at its solved geometry, translated so the
 * diagram bounds start at the page origin: frame, swimlanes, groups,
 * matrices, tables and evidence panels behind the nodes, then edges (with
 * their exact end points pinned through entry/exit constraints and their
 * crossings mapped to per-edge jump styles), then external label callouts.
 */
export function exportDrawio(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): string {
	const title = options.title ?? diagram.title ?? diagram.id;
	const origin = { x: diagram.bounds.x, y: diagram.bounds.y };
	const shift = (box: Box): Box => ({
		x: box.x - origin.x,
		y: box.y - origin.y,
		width: box.width,
		height: box.height,
	});
	const move = (point: Point): Point => ({
		x: point.x - origin.x,
		y: point.y - origin.y,
	});
	const crossings = diagram.edgeCrossings ?? [];
	const annotations = diagram.textAnnotations ?? [];
	const cells: string[] = [`<mxCell id="0"/>`, `<mxCell id="1" parent="0"/>`];
	let nextId = 2;
	// `value` is draw.io HTML (every style sets html=1): plain text goes
	// through escapeHtml first, generated markup is passed as is.
	const vertex = (
		value: string,
		style: string,
		box: Box,
		parent?: { id: string; box: Box },
	): void => {
		const cellId = String(nextId++);
		// A child's geometry is relative to its parent's origin.
		const placed =
			parent === undefined
				? shift(box)
				: {
						x: box.x - parent.box.x,
						y: box.y - parent.box.y,
						width: box.width,
						height: box.height,
					};
		cells.push(
			`<mxCell id="${cellId}" value="${escapeXml(value)}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parent?.id ?? "1")}">${geometry(placed)}</mxCell>`,
		);
	};

	if (diagram.frame !== undefined) {
		const frame = diagram.frame;
		vertex(
			escapeHtml(frame.titleTab),
			[
				"shape=umlFrame;whiteSpace=wrap;html=1;",
				`width=${formatNumber(frame.titleBox.width)};height=${formatNumber(frame.titleBox.height)};`,
				...(frame.style?.fill === undefined
					? []
					: [`fillColor=${frame.style.fill};`]),
				...(frame.style?.stroke === undefined
					? []
					: [`strokeColor=${frame.style.stroke};`]),
			].join(""),
			frame.box,
		);
	}
	for (const swimlane of diagram.swimlanes ?? []) {
		for (const cell of swimlaneCells(swimlane)) {
			vertex(cell.value, cell.style, cell.box);
		}
	}
	// Outer groups first so nested ones are drawn on top.
	for (const group of [...diagram.groups].sort(
		(left, right) =>
			right.box.width * right.box.height - left.box.width * left.box.height ||
			left.id.localeCompare(right.id),
	)) {
		// The solved title (its lines, typography and collision-safe box)
		// is a text cell of its own, so draw.io does not rewrap it across
		// the whole group.
		const title = annotations.find(
			(annotation) =>
				annotation.surfaceKind === "group-label" &&
				annotation.ownerId === group.id,
		);
		vertex(
			title === undefined ? escapeHtml(group.label?.text ?? "") : "",
			"rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;verticalAlign=top;align=left;spacingLeft=6;",
			group.box,
		);
		if (title !== undefined) {
			vertex(
				calloutText(title),
				`${GROUP_LABEL_STYLE}${labelFontStyle(title)
					.map((entry) => `${entry};`)
					.join("")}`,
				title.box,
			);
		}
	}
	// Matrices and tables are laid out cell by cell on the solved geometry,
	// as the SVG exporter draws them, so draw.io keeps the column widths.
	for (const matrix of diagram.matrices ?? []) {
		for (const cell of matrixCells(matrix)) {
			vertex(cell.value, cell.style, cell.box);
		}
	}
	for (const table of diagram.tables ?? []) {
		for (const cell of tableCells(table)) {
			vertex(cell.value, cell.style, cell.box);
		}
	}
	for (const panel of diagram.evidencePanels ?? []) {
		for (const cell of panelCells(panel)) {
			vertex(cell.value, cell.style, cell.box);
		}
	}

	// Ports and their labels are children of their node, so they move with
	// it (and with the edges pinned to it) when the node is dragged.
	const nodeCellIds = new Map<string, string>();
	const portParents = new Map<string, { id: string; box: Box }>();
	for (const node of diagram.nodes) {
		const cellId = String(nextId++);
		nodeCellIds.set(node.id, cellId);
		cells.push(renderNodeCell(cellId, node, shift(node.box)));
		const parent = { id: cellId, box: node.box };
		for (const port of node.ports ?? []) {
			portParents.set(`${node.id}.${port.id}`, parent);
			vertex("", portStyle(port.style), port.box, parent);
		}
	}
	for (const portLabel of annotations.filter(
		(annotation) => annotation.surfaceKind === "port-label",
	)) {
		// The label box was measured from its lines and typography.
		const font = labelFontStyle(portLabel);
		vertex(
			calloutText(portLabel),
			`${PORT_LABEL_STYLE}${
				font.some((entry) => entry.startsWith("fontSize="))
					? ""
					: "fontSize=10;"
			}${font.map((entry) => `${entry};`).join("")}`,
			portLabel.box,
			portParents.get(portLabel.ownerId),
		);
	}

	const nodeById = new Map(diagram.nodes.map((node) => [node.id, node]));
	const boxOf = (node: CoordinatedNode | undefined) =>
		node === undefined ? undefined : shift(node.box);
	// The solved label of each edge: its callout key when externalized,
	// otherwise the inline edge label.
	const labelByEdge = new Map<string, SolvedTextAnnotation>();
	for (const annotation of annotations) {
		if (annotation.surfaceKind !== "edge-label") continue;
		const role = annotation.placementDetail?.role;
		if (role === "callout") continue;
		if (role === "key" || !labelByEdge.has(annotation.ownerId)) {
			labelByEdge.set(annotation.ownerId, annotation);
		}
	}
	for (const edge of diagram.edges) {
		const cellId = String(nextId++);
		cells.push(
			renderEdgeCell({
				cellId,
				edge,
				points: edge.points.map(move),
				sourceBox: boxOf(nodeById.get(edge.source.nodeId)),
				targetBox: boxOf(nodeById.get(edge.target.nodeId)),
				sourceId: nodeCellIds.get(edge.source.nodeId),
				targetId: nodeCellIds.get(edge.target.nodeId),
				crossings: crossings
					.filter(
						(crossing) =>
							crossing.underEdgeId === edge.id ||
							crossing.overEdgeId === edge.id,
					)
					.map((crossing) => ({ ...crossing, ...move(crossing) })),
				label: edgeLabelHtml(labelByEdge.get(edge.id), edge.label?.text),
				labelBox: (() => {
					const box = labelByEdge.get(edge.id)?.box;
					return box === undefined ? undefined : shift(box);
				})(),
				labelFont: labelByEdge.get(edge.id),
			}),
		);
	}

	for (const callout of annotations.filter(
		(annotation) => annotation.placementDetail?.role === "callout",
	)) {
		// The shelf box was measured with the callout's own typography.
		vertex(
			calloutText(callout),
			`${CALLOUT_STYLE}${labelFontStyle(callout)
				.map((entry) => `${entry};`)
				.join("")}`,
			callout.box,
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

/** Port cells keep the authored fill/stroke, with the SVG exporter's defaults. */
function portStyle(style: { fill?: string; stroke?: string } | undefined) {
	return [
		"rounded=0;whiteSpace=wrap;html=1;",
		`fillColor=${style?.fill ?? "#d9ead3"};`,
		...(style?.stroke === undefined ? [] : [`strokeColor=${style.stroke};`]),
	].join("");
}
const PORT_LABEL_STYLE =
	"text;html=1;whiteSpace=nowrap;align=center;verticalAlign=middle;";
/** A group title on the group border: a backdrop keeps passing edges off it. */
const GROUP_LABEL_STYLE =
	"text;html=1;whiteSpace=nowrap;align=center;verticalAlign=middle;labelBackgroundColor=#ffffff;";
const CALLOUT_STYLE =
	"text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;fillColor=#ffffff;";

function geometry(box: Box): string {
	return `<mxGeometry x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" as="geometry"/>`;
}

function renderNodeCell(
	cellId: string,
	node: CoordinatedNode,
	box: Box,
): string {
	const visual = node.style;
	const style = [
		nodeShapeStyle(node.shape),
		...(node.compartments === undefined ? [] : ["verticalAlign=top;"]),
		...(visual?.fill === undefined ? [] : [`fillColor=${visual.fill};`]),
		...(visual?.stroke === undefined ? [] : [`strokeColor=${visual.stroke};`]),
		...(visual?.fontFamily === undefined
			? []
			: [`fontFamily=${visual.fontFamily};`]),
		// The solver measured the label at this size.
		...(visual?.fontSize === undefined
			? node.labelLayout === undefined
				? []
				: [`fontSize=${formatNumber(node.labelLayout.font.fontSize)};`]
			: [`fontSize=${formatNumber(visual.fontSize)};`]),
	].join("");
	const label = escapeXml(
		node.compartments === undefined
			? nodeLabelHtml(node)
			: compartmentHtml(node),
	);
	return `<mxCell id="${escapeXml(cellId)}" value="${label}" style="${escapeXml(style)}" vertex="1" parent="1">${geometry(box)}</mxCell>`;
}

/**
 * A node label as draw.io HTML with the solver's line breaks, so draw.io
 * does not rewrap it with its own text engine.
 */
function nodeLabelHtml(node: CoordinatedNode): string {
	const lines = node.labelLayout?.lines ?? [];
	return lines.length > 1
		? lines.map((line) => escapeHtml(line.text)).join("<br>")
		: // A node without a label stays blank, as in the SVG.
			escapeHtml(node.label?.text ?? "");
}

/** SysML compartments as the SVG draws them: header, properties, constraints. */
function compartmentHtml(node: CoordinatedNode): string {
	const compartments = node.compartments ?? {};
	const header = [
		...(compartments.stereotype === undefined
			? []
			: [escapeHtml(compartments.stereotype)]),
		`<b>${escapeHtml(compartments.name ?? node.label?.text ?? node.id)}</b>`,
	].join("<br>");
	const sections = [
		header,
		(compartments.properties ?? []).map(escapeHtml).join("<br>"),
		(compartments.constraints ?? []).map(escapeHtml).join("<br>"),
	].filter((section) => section.length > 0);
	return sections.join("<hr>");
}

function swimlaneCells(
	swimlane: Swimlane,
): { value: string; style: string; box: Box }[] {
	const cells: { value: string; style: string; box: Box }[] = [];
	for (const lane of swimlane.lanes) {
		if (lane.box === undefined) continue;
		const header = lane.headerBox;
		// A header spanning the lane's height sits on its left (horizontal
		// lanes); otherwise it is a title bar on top.
		const leftHeader =
			header !== undefined &&
			Math.abs(header.height - lane.box.height) < 0.5 &&
			header.width < lane.box.width;
		const startSize =
			header === undefined ? 0 : leftHeader ? header.width : header.height;
		cells.push({
			value: escapeHtml(lane.label?.text ?? lane.id),
			style: `swimlane;whiteSpace=wrap;html=1;startSize=${formatNumber(startSize)};${leftHeader ? "horizontal=0;" : ""}`,
			box: lane.box,
		});
	}
	return cells;
}

function renderEdgeCell(input: {
	cellId: string;
	edge: CoordinatedEdge;
	points: readonly Point[];
	sourceBox: Box | undefined;
	targetBox: Box | undefined;
	sourceId: string | undefined;
	targetId: string | undefined;
	crossings: readonly EdgeCrossing[];
	label: string;
	labelBox: Box | undefined;
	/** The solved label's typography (the box was measured with it). */
	labelFont: Pick<SolvedTextAnnotation, "fontFamily" | "fontSize"> | undefined;
}): string {
	const { edge, points, crossings } = input;
	const orthogonal = points.every((point, index) => {
		const next = points[index + 1];
		return (
			next === undefined ||
			Math.abs(point.x - next.x) < 0.5 ||
			Math.abs(point.y - next.y) < 0.5
		);
	});
	const jumps = crossings.filter(
		(crossing) => crossing.underEdgeId === edge.id,
	);
	const styleParts = [
		// Straight or diagonal routes are drawn exactly as solved.
		orthogonal ? "edgeStyle=orthogonalEdgeStyle" : "edgeStyle=none",
		"rounded=0",
		"orthogonalLoop=1",
		"jettySize=auto",
		"html=1",
		`jumpStyle=${jumpStyleOf(jumps)}`,
		"jumpSize=6",
		"endArrow=block",
		`endFill=${edge.arrowhead === "hollowTriangle" ? 0 : 1}`,
	];
	if (edge.style === "dashed") styleParts.push("dashed=1");
	if (input.labelFont !== undefined) {
		styleParts.push(...labelFontStyle(input.labelFont));
	}
	const first = points[0];
	const last = points.at(-1);
	// mxGraph ignores sourcePoint/targetPoint once a terminal cell is set,
	// so the solved end points are pinned as relative exit/entry points.
	const exit =
		input.sourceBox === undefined || first === undefined
			? undefined
			: relativePoint(first, input.sourceBox);
	const entry =
		input.targetBox === undefined || last === undefined
			? undefined
			: relativePoint(last, input.targetBox);
	if (exit !== undefined) {
		styleParts.push(
			`exitX=${formatNumber(exit.x)}`,
			`exitY=${formatNumber(exit.y)}`,
			"exitDx=0",
			"exitDy=0",
			"exitPerimeter=0",
		);
	}
	if (entry !== undefined) {
		styleParts.push(
			`entryX=${formatNumber(entry.x)}`,
			`entryY=${formatNumber(entry.y)}`,
			"entryDx=0",
			"entryDy=0",
			"entryPerimeter=0",
		);
	}
	if (crossings.length > 0) {
		styleParts.push(
			`dgeCrossings=${crossings
				.map(
					(crossing) =>
						`${formatNumber(crossing.x)},${formatNumber(crossing.y)},${crossing.style}`,
				)
				.join(";")}`,
		);
	}
	const geometryChildren: string[] = [];
	if (points.length >= 2 && first !== undefined && last !== undefined) {
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
		geometryChildren.push(
			`<mxPoint as="sourcePoint" x="${formatNumber(first.x)}" y="${formatNumber(first.y)}"/>`,
			`<mxPoint as="targetPoint" x="${formatNumber(last.x)}" y="${formatNumber(last.y)}"/>`,
		);
	}
	// draw.io puts an edge label at the route's middle (by length) plus an
	// offset: encode the solved label position that way.
	const middle = pointAtHalfLength(points);
	if (input.labelBox !== undefined && middle !== undefined) {
		const center = {
			x: input.labelBox.x + input.labelBox.width / 2,
			y: input.labelBox.y + input.labelBox.height / 2,
		};
		geometryChildren.push(
			`<mxPoint as="offset" x="${formatNumber(center.x - middle.x)}" y="${formatNumber(center.y - middle.y)}"/>`,
		);
	}
	for (const jump of jumps) {
		geometryChildren.push(
			`<mxPoint as="dgeJump" x="${formatNumber(jump.x)}" y="${formatNumber(jump.y)}" />`,
		);
	}
	const terminals = `${input.sourceId === undefined ? "" : ` source="${escapeXml(input.sourceId)}"`}${input.targetId === undefined ? "" : ` target="${escapeXml(input.targetId)}"`}`;
	return `<mxCell id="${escapeXml(input.cellId)}" value="${escapeXml(input.label)}" style="${escapeXml(styleParts.join(";"))}" edge="1" parent="1"${terminals}><mxGeometry relative="1" as="geometry">${geometryChildren.join("")}</mxGeometry></mxCell>`;
}

/**
 * An edge label as draw.io HTML: the solved line breaks kept, so a label
 * the solver wrapped does not come back as one wide line.
 */
function edgeLabelHtml(
	annotation: SolvedTextAnnotation | undefined,
	fallback: string | undefined,
): string {
	if (annotation === undefined) return escapeHtml(fallback ?? "");
	return annotation.lines.length > 1
		? annotation.lines.map((line) => escapeHtml(line.text)).join("<br>")
		: escapeHtml(annotation.text);
}

function pointAtHalfLength(points: readonly Point[]): Point | undefined {
	let total = 0;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as Point;
		const b = points[index] as Point;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	let remaining = total / 2;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as Point;
		const b = points[index] as Point;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (remaining <= length && length > 0) {
			const t = remaining / length;
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		}
		remaining -= length;
	}
	return points[0];
}

function relativePoint(point: Point, box: Box): Point {
	const clamp = (value: number) => Math.min(1, Math.max(0, value));
	return {
		x: box.width > 0 ? clamp((point.x - box.x) / box.width) : 0.5,
		y: box.height > 0 ? clamp((point.y - box.y) / box.height) : 0.5,
	};
}

/** draw.io jump style for the crossings an edge jumps over (most common). */
function jumpStyleOf(jumps: readonly EdgeCrossing[]): string {
	if (jumps.length === 0) return "none";
	const counts = new Map<EdgeCrossingStyle, number>();
	for (const jump of jumps) {
		counts.set(jump.style, (counts.get(jump.style) ?? 0) + 1);
	}
	const [style] = [...counts.entries()].sort(
		(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
	)[0] as [EdgeCrossingStyle, number];
	return style === "gap" ? "gap" : "arc";
}

function nodeShapeStyle(shape: NodeShape): string {
	switch (shape) {
		case "ellipse":
			return "ellipse;whiteSpace=wrap;html=1;";
		case "diamond":
			return "rhombus;whiteSpace=wrap;html=1;";
		case "cylinder":
			return "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;";
		case "rounded-rectangle":
			return "rounded=1;whiteSpace=wrap;html=1;arcSize=20;";
		case "parallelogram":
			return "shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;";
		case "hexagon":
			return "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;";
		case "rectangle":
			return "rounded=0;whiteSpace=wrap;html=1;";
	}
}

interface EvidenceCellVertex {
	value: string;
	style: string;
	box: Box;
}

const EVIDENCE_HEADER_FILL = "#e5e7eb";

function evidenceCellStyle(fill: string, stroke = "#9ca3af"): string {
	return `rounded=0;whiteSpace=wrap;html=1;overflow=hidden;fontSize=10;spacing=2;fillColor=${fill};strokeColor=${stroke};`;
}

function evidenceCellText(
	layout: { lines: readonly string[] } | undefined,
	text: string,
): string {
	const lines = layout?.lines ?? [];
	return lines.length > 0
		? lines.map(escapeHtml).join("<br>")
		: escapeHtml(text);
}

function matrixCells(matrix: CoordinatedMatrixBlock): EvidenceCellVertex[] {
	const { box } = matrix;
	const rowCount = matrix.rows.length;
	const rowHeaderWidth = rowCount > 0 ? Math.min(96, box.width * 0.28) : 0;
	const cellWidth =
		Math.max(0, box.width - rowHeaderWidth) / Math.max(1, matrix.cols.length);
	const rowHeight = box.height / Math.max(1, rowCount + 1);
	const header = evidenceCellStyle(EVIDENCE_HEADER_FILL);
	const cells: EvidenceCellVertex[] = [
		{
			value: "",
			style: evidenceCellStyle(
				matrix.style?.fill ?? "#f8fafc",
				matrix.style?.stroke,
			),
			box,
		},
	];
	if (rowCount > 0) {
		cells.push({
			value: "",
			style: header,
			box: { x: box.x, y: box.y, width: rowHeaderWidth, height: rowHeight },
		});
	}
	matrix.cols.forEach((col, colIndex) => {
		cells.push({
			value: evidenceCellText(matrix.columnLabelLayouts?.[colIndex], col),
			style: header,
			box: {
				x: box.x + rowHeaderWidth + colIndex * cellWidth,
				y: box.y,
				width: cellWidth,
				height: rowHeight,
			},
		});
	});
	matrix.rows.forEach((row, rowIndex) => {
		const y = box.y + (rowIndex + 1) * rowHeight;
		cells.push({
			value: evidenceCellText(matrix.rowLabelLayouts?.[rowIndex], row),
			style: header,
			box: { x: box.x, y, width: rowHeaderWidth, height: rowHeight },
		});
		matrix.cols.forEach((_, colIndex) => {
			const cell = matrix.cells[rowIndex]?.[colIndex];
			cells.push({
				value: evidenceCellText(
					matrix.cellLabelLayouts?.[rowIndex]?.[colIndex],
					cell?.text ?? "",
				),
				style: evidenceCellStyle(
					cell?.style?.fill ?? "#ffffff",
					cell?.style?.stroke,
				),
				box: {
					x: box.x + rowHeaderWidth + colIndex * cellWidth,
					y,
					width: cellWidth,
					height: rowHeight,
				},
			});
		});
	});
	return cells;
}

function tableCells(table: CoordinatedTableBlock): EvidenceCellVertex[] {
	const { box } = table;
	const columnCount = Math.max(1, table.columns.length);
	const rowHeight = box.height / Math.max(1, table.rows.length + 1);
	const cellBox = (columnIndex: number, rowIndex: number): Box => {
		const x =
			table.columnXOffsets[columnIndex] ??
			box.x + (box.width / columnCount) * columnIndex;
		const nextX = table.columnXOffsets[columnIndex + 1] ?? box.x + box.width;
		return {
			x,
			y: box.y + rowIndex * rowHeight,
			width: nextX - x,
			height: rowHeight,
		};
	};
	const cells: EvidenceCellVertex[] = [
		{
			value: "",
			style: evidenceCellStyle(
				table.style?.fill ?? "#f8fafc",
				table.style?.stroke,
			),
			box,
		},
	];
	table.columns.forEach((column, columnIndex) => {
		cells.push({
			value: evidenceCellText(
				table.columnLabelLayouts?.[columnIndex],
				column.label.text,
			),
			style: evidenceCellStyle(EVIDENCE_HEADER_FILL),
			box: cellBox(columnIndex, 0),
		});
	});
	table.rows.forEach((row, rowIndex) => {
		const rowFill = rowIndex % 2 === 0 ? "#ffffff" : "#f3f4f6";
		table.columns.forEach((column, columnIndex) => {
			const cell = row.cells[column.id];
			cells.push({
				value: evidenceCellText(
					table.cellLabelLayouts?.[rowIndex]?.[columnIndex],
					cell?.text ?? "",
				),
				style: evidenceCellStyle(
					cell?.style?.fill ?? rowFill,
					cell?.style?.stroke,
				),
				box: cellBox(columnIndex, rowIndex + 1),
			});
		});
	});
	return cells;
}

/** Evidence panel fills per kind, as the SVG exporter draws them. */
const EVIDENCE_PANEL_FILL = {
	legend: "#ecfdf5",
	rule: "#eff6ff",
	note: "#fffbeb",
	verification: "#fef2f2",
} as const;

/**
 * An evidence panel cell by cell, as the SVG exporter draws it: the title
 * column and one row per item, each with its solved line breaks.
 */
function panelCells(panel: CoordinatedEvidencePanel): EvidenceCellVertex[] {
	const { box } = panel;
	const titleWidth = Math.min(box.width * 0.36, 140);
	const itemHeight = box.height / Math.max(1, panel.items.length);
	const cells: EvidenceCellVertex[] = [
		{
			value: "",
			style: evidenceCellStyle(
				panel.style?.fill ?? EVIDENCE_PANEL_FILL[panel.kind],
				panel.style?.stroke,
			),
			box,
		},
		{
			value: evidenceCellText(panel.titleLayout, `${panel.kind}: ${panel.id}`),
			style: evidenceCellStyle(EVIDENCE_HEADER_FILL),
			box: { x: box.x, y: box.y, width: titleWidth, height: box.height },
		},
	];
	panel.items.forEach((item, index) => {
		cells.push({
			value: evidenceCellText(
				panel.itemLayouts?.[index],
				item.detail === undefined
					? item.label.text
					: `${item.label.text}: ${item.detail.text}`,
			),
			style: evidenceCellStyle(
				item.style?.fill ?? "none",
				item.style?.stroke ?? "none",
			),
			box: {
				x: box.x + titleWidth,
				y: box.y + index * itemHeight,
				width: box.width - titleWidth,
				height: itemHeight,
			},
		});
	});
	return cells;
}

/** Style entries for a solved label's typography (the box was measured with it). */
function labelFontStyle(
	font: Partial<Pick<SolvedTextAnnotation, "fontFamily" | "fontSize">>,
): string[] {
	const entries: string[] = [];
	// `;` separates style entries, so it cannot appear in a value.
	const family = font.fontFamily?.replaceAll(";", "");
	if (family) entries.push(`fontFamily=${family}`);
	if (font.fontSize !== undefined && Number.isFinite(font.fontSize)) {
		entries.push(`fontSize=${formatNumber(font.fontSize)}`);
	}
	return entries;
}

/** A solved label's lines, joined with HTML line breaks. */
function calloutText(annotation: SolvedTextAnnotation): string {
	return annotation.lines.length > 0
		? annotation.lines.map((line) => escapeHtml(line.text)).join("<br>")
		: escapeHtml(annotation.text);
}

function formatNumber(value: number): string {
	return Number.isFinite(value) ? String(Number(value.toFixed(3))) : "0";
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
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
