import { EDGE_CROSSING_GLYPH_RADIUS, unionBoxes } from "../geometry/index.js";
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
	SwimlaneLane,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import { compartmentSeparatorRows } from "./compartments.js";
import { fallbackTextWidth } from "./fallback-text.js";
import { fittedPageScale, usablePage } from "./page.js";
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
	const fallbackLabels = fallbackPortLabels(diagram);
	const page = drawioPageBox(diagram, options);
	// On a requested page (paper size and fit scale), the paper is drawn
	// at `1 / scale` in diagram units with the content centred, as the SVG
	// lays it out; printing at the page scale restores the paper size.
	// The scale shrinks when the content with its padding would not fit.
	const paper = usablePage(options.page);
	const scale = paper === undefined ? 1 : fittedPageScale(page, paper);
	const origin =
		paper === undefined
			? { x: page.x, y: page.y }
			: {
					x: page.x + page.width / 2 - paper.width / scale / 2,
					y: page.y + page.height / 2 - paper.height / scale / 2,
				};
	const pageAttributes =
		paper === undefined
			? `pageScale="1" pageWidth="${formatNumber(Math.max(page.width, 1))}" pageHeight="${formatNumber(Math.max(page.height, 1))}"`
			: `pageScale="${formatNumber(1 / scale)}" pageWidth="${formatNumber(Math.max(paper.width, 1))}" pageHeight="${formatNumber(Math.max(paper.height, 1))}"`;
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
	// draw.io paints cells in document order (a child with its parent), so
	// the XML follows the SVG's paint order: frame, lanes and evidence
	// blocks, then edges, then groups, nodes, ports and their labels, so
	// those labels' backdrops cover the edges. Ids still follow creation
	// order; draw.io resolves references to cells later in the document.
	const cells: string[] = [`<mxCell id="0"/>`, `<mxCell id="1" parent="0"/>`];
	const edgeLayer: string[] = [];
	const foreground: string[] = [];
	let layer = cells;
	let nextId = 2;
	// Each vertex's parent cell, so an edge can find the container its
	// ends share.
	const parentOf = new Map<string, { id: string; box: Box }>();
	// `value` is draw.io HTML (every style sets html=1): plain text goes
	// through escapeHtml first, generated markup is passed as is.
	const vertex = (
		value: string,
		style: string,
		box: Box,
		parent?: { id: string; box: Box },
	): string => {
		const cellId = String(nextId++);
		if (parent !== undefined) parentOf.set(cellId, parent);
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
		layer.push(
			`<mxCell id="${cellId}" value="${escapeXml(value)}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parent?.id ?? "1")}">${geometry(placed)}</mxCell>`,
		);
		return cellId;
	};

	if (diagram.frame !== undefined) {
		const frame = diagram.frame;
		const title = annotations.find(
			(annotation) =>
				annotation.surfaceKind === "frame-title" &&
				annotation.ownerId === frame.kind,
		);
		const frameId = vertex(
			title === undefined ? multilineHtml(frame.titleTab) : "",
			[
				"shape=umlFrame;whiteSpace=wrap;html=1;",
				`width=${formatNumber(frame.titleBox.width)};height=${formatNumber(frame.titleBox.height)};`,
				...(frame.style?.fill === undefined
					? []
					: [`fillColor=${styleValue(frame.style.fill)};`]),
				...(frame.style?.stroke === undefined
					? []
					: [`strokeColor=${styleValue(frame.style.stroke)};`]),
			].join(""),
			frame.box,
		);
		// The solved title in its tab (lines, typography and box), a child
		// of the frame so it moves with it.
		if (title !== undefined) {
			vertex(
				calloutText(title),
				`${SOLVED_TEXT_STYLE}${fontStyleEntries(title)}`,
				title.box,
				{ id: frameId, box: frame.box },
			);
		}
	}
	// Lane cells, so a lane's children (nodes, groups) can be its children
	// in draw.io too and move with it.
	const laneCells: { id: string; box: Box; children: readonly string[] }[] = [];
	for (const swimlane of diagram.swimlanes ?? []) {
		// The pool's outer frame, as the SVG draws it: one editable container
		// holding its lanes.
		const pool =
			swimlane.box === undefined
				? undefined
				: {
						id: vertex(
							"",
							"rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;",
							swimlane.box,
						),
						box: swimlane.box,
					};
		const lanes = swimlaneCells(swimlane, annotations);
		const laneIds: string[] = [];
		for (const cell of lanes) {
			const parent =
				cell.parentIndex === undefined ? undefined : lanes[cell.parentIndex];
			const id = vertex(
				cell.value,
				cell.style,
				cell.box,
				parent === undefined || cell.parentIndex === undefined
					? pool
					: { id: laneIds[cell.parentIndex] ?? "1", box: parent.box },
			);
			laneIds.push(id);
			if (cell.lane !== undefined) {
				laneCells.push({ id, box: cell.box, children: cell.lane.children });
			}
		}
	}
	// Group members are children of their group cell, so dragging a group
	// in draw.io carries its nodes and nested groups along. A member listed
	// by several groups goes to the innermost: one no other candidate
	// nests in (by `groupIds`, so equally large nested groups resolve),
	// then the smallest.
	const area = (box: Box) => box.width * box.height;
	const groupById = new Map(diagram.groups.map((group) => [group.id, group]));
	const nestsIn = (inner: string, outer: string): boolean => {
		const seen = new Set<string>();
		const stack = [...(groupById.get(outer)?.groupIds ?? [])];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (id === inner) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			stack.push(...(groupById.get(id)?.groupIds ?? []));
		}
		return false;
	};
	const innermost = (
		candidates: readonly (typeof diagram.groups)[number][],
	) => {
		// How many of the other candidates a group nests in: the innermost
		// nests in them all.
		const depthAmong = (group: (typeof diagram.groups)[number]) =>
			candidates.filter(
				(other) => other.id !== group.id && nestsIn(group.id, other.id),
			).length;
		return [...candidates].sort(
			(left, right) =>
				depthAmong(right) - depthAmong(left) ||
				area(left.box) - area(right.box) ||
				left.id.localeCompare(right.id),
		)[0];
	};
	const groupCells = new Map<string, { id: string; box: Box }>();
	const parentGroup = (group: (typeof diagram.groups)[number] | undefined) =>
		group === undefined ? undefined : groupCells.get(group.id);
	// The lane listing an element as a child (or, for a group, the lane its
	// box lies in): the parent of a node or top-level group outside groups.
	const laneOf = (id: string, box?: Box) =>
		laneCells.find((lane) => lane.children.includes(id)) ??
		(box === undefined
			? undefined
			: laneCells.find(
					(lane) =>
						box.x >= lane.box.x - 0.5 &&
						box.y >= lane.box.y - 0.5 &&
						box.x + box.width <= lane.box.x + lane.box.width + 0.5 &&
						box.y + box.height <= lane.box.y + lane.box.height + 0.5,
				));
	// A group's parent group: the innermost group listing it.
	const outerGroup = (group: (typeof diagram.groups)[number]) =>
		innermost(
			diagram.groups.filter(
				(outer) => outer.id !== group.id && outer.groupIds.includes(group.id),
			),
		);
	const depthCache = new Map<string, number>();
	const depth = (
		group: (typeof diagram.groups)[number],
		seen = new Set<string>(),
	): number => {
		const cached = depthCache.get(group.id);
		if (cached !== undefined) return cached;
		const outer = outerGroup(group);
		// A cycle in groupIds is broken at the repeated group.
		const value =
			outer === undefined || seen.has(outer.id)
				? 0
				: depth(outer, new Set([...seen, group.id])) + 1;
		depthCache.set(group.id, value);
		return value;
	};
	// Groups (and so their titles) paint above the edges.
	layer = foreground;
	// Parents before children (by nesting, not area: a parent with no
	// padding can be exactly as large as its child), so each parent cell
	// exists first; outer groups are drawn below nested ones.
	for (const group of [...diagram.groups].sort(
		(left, right) =>
			depth(left) - depth(right) ||
			area(right.box) - area(left.box) ||
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
		// Without a solved annotation, the group's label layout (a box
		// relative to the group) places the title the same way.
		const layout = group.labelLayout;
		const titleCell =
			title !== undefined
				? { value: calloutText(title), font: title, box: title.box }
				: layout?.box !== undefined
					? {
							value:
								(layout.lines ?? []).length > 0
									? layout.lines
											.map((line) => escapeHtml(line.text))
											.join("<br>")
									: multilineHtml(group.label?.text ?? ""),
							font: {
								...(layout.font?.fontFamily === undefined
									? {}
									: { fontFamily: layout.font.fontFamily }),
								...(layout.font?.fontSize === undefined
									? {}
									: { fontSize: layout.font.fontSize }),
							},
							box: {
								...layout.box,
								x: group.box.x + layout.box.x,
								y: group.box.y + layout.box.y,
							},
						}
					: undefined;
		const groupId = vertex(
			titleCell === undefined ? multilineHtml(group.label?.text ?? "") : "",
			"rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;verticalAlign=top;align=left;spacingLeft=6;",
			group.box,
			parentGroup(outerGroup(group)) ?? laneOf(group.id, group.box),
		);
		groupCells.set(group.id, { id: groupId, box: group.box });
		if (titleCell !== undefined) {
			vertex(
				titleCell.value,
				`${GROUP_LABEL_STYLE}${labelFontStyle(titleCell.font)
					.map((entry) => `${entry};`)
					.join("")}`,
				titleCell.box,
				{ id: groupId, box: group.box },
			);
		}
	}
	// Matrices and tables are laid out cell by cell on the solved geometry,
	// as the SVG exporter draws them, so draw.io keeps the column widths.
	// The first cell is the block's background; the others are its
	// children, so dragging the block carries its headers and cells along.
	const block = (blockCells: readonly EvidenceCellVertex[]) => {
		const [background, ...rest] = blockCells;
		if (background === undefined) return;
		const parent = {
			id: vertex(background.value, background.style, background.box),
			box: background.box,
		};
		for (const cell of rest) vertex(cell.value, cell.style, cell.box, parent);
	};
	// Evidence blocks sit below the edges, as in the SVG.
	layer = cells;
	for (const matrix of diagram.matrices ?? []) block(matrixCells(matrix));
	for (const table of diagram.tables ?? []) block(tableCells(table));
	for (const panel of diagram.evidencePanels ?? []) block(panelCells(panel));
	layer = foreground;

	// Ports are children of their node, so they move with it (and with the
	// edges pinned to it) when the node is dragged; a port label is a child
	// of its port, so it also follows the port when the port is moved.
	const nodeCellIds = new Map<string, string>();
	// A port label's owner id joins node and port ids with a dot, which is
	// ambiguous when ids contain dots: keep every port cell under that key
	// and give the label to the nearest one.
	const portParents = new Map<string, { id: string; box: Box }[]>();
	// Port cells are the terminals of edges docked at named ports, so the
	// connector follows a port moved in draw.io.
	// Keyed by node, then port: ids may contain dots, so "a"."b.c" and
	// "a.b"."c" must not share a key.
	const portCells = new Map<string, Map<string, { id: string; box: Box }>>();
	for (const node of diagram.nodes) {
		const cellId = String(nextId++);
		nodeCellIds.set(node.id, cellId);
		// Solved compartment rows are drawn at their own boxes (typography
		// and row pitch as solved), not reflowed into one node label.
		const solvedRows =
			node.compartments === undefined
				? []
				: annotations
						.filter(
							(annotation) =>
								annotation.surfaceKind === "compartment-row" &&
								annotation.ownerId === node.id,
						)
						.sort(
							(left, right) =>
								(left.surfaceIndex ?? 0) - (right.surfaceIndex ?? 0),
						);
		// Only a full set of solved rows replaces the authored compartments:
		// with some missing, the node keeps its authored rows (drawn by
		// draw.io) rather than losing the unsolved ones.
		const covered = new Set(solvedRows.map((row) => row.surfaceIndex ?? 0));
		const rowCount = compartmentRowCount(node);
		const rows =
			rowCount > 0 &&
			Array.from({ length: rowCount }, (_, index) => index).every((index) =>
				covered.has(index),
			)
				? solvedRows
				: [];
		// A node in a group is its child; otherwise a lane child is the
		// lane's.
		const group =
			parentGroup(
				innermost(
					diagram.groups.filter((candidate) =>
						candidate.nodeIds.includes(node.id),
					),
				),
			) ?? laneOf(node.id);
		if (group !== undefined) parentOf.set(cellId, group);
		layer.push(
			renderNodeCell(
				cellId,
				node,
				group === undefined
					? shift(node.box)
					: {
							x: node.box.x - group.box.x,
							y: node.box.y - group.box.y,
							width: node.box.width,
							height: node.box.height,
						},
				group?.id ?? "1",
				rows.length > 0,
				annotations.find(
					(annotation) =>
						annotation.surfaceKind === "node-label" &&
						annotation.ownerId === node.id,
				),
			),
		);
		const parent = { id: cellId, box: node.box };
		for (const port of node.ports ?? []) {
			const portCell = {
				id: vertex("", portStyle(port.style), port.box, parent),
				box: port.box,
			};
			const ownerKey = `${node.id}.${port.id}`;
			portParents.set(ownerKey, [
				...(portParents.get(ownerKey) ?? []),
				portCell,
			]);
			const nodePorts =
				portCells.get(node.id) ?? new Map<string, { id: string; box: Box }>();
			portCells.set(node.id, nodePorts);
			nodePorts.set(port.id, portCell);
		}
		const separators =
			node.compartments === undefined
				? new Set<number>()
				: compartmentSeparatorRows(node.compartments);
		for (const row of rows) {
			const index = row.surfaceIndex ?? 0;
			// Separators where the property and constraint sections start,
			// as the SVG.
			if (separators.has(index)) {
				vertex(
					"",
					COMPARTMENT_SEPARATOR_STYLE,
					{
						x: node.box.x,
						y: node.box.y + 18 + index * 16 - 12,
						width: node.box.width,
						height: 1,
					},
					parent,
				);
			}
			vertex(
				calloutText(row),
				`${SOLVED_TEXT_STYLE}${fontStyleEntries(row)}`,
				row.box,
				parent,
			);
		}
	}
	for (const portLabel of annotations.filter(
		(annotation) => annotation.surfaceKind === "port-label",
	)) {
		// The label box was measured from its lines and typography.
		const font = labelFontStyle(portLabel);
		// The nearest candidate port: a label sits beside its port.
		const port = nearestBox(
			portParents.get(portLabel.ownerId) ?? [],
			portLabel.box,
		);
		vertex(
			calloutText(portLabel),
			`${PORT_LABEL_STYLE}${
				font.some((entry) => entry.startsWith("fontSize="))
					? ""
					: "fontSize=10;"
			}${font.map((entry) => `${entry};`).join("")}`,
			portLabel.box,
			port,
		);
	}

	// A port with an authored label but no solved one (a diagram built
	// without text annotations) still gets its label, placed as the SVG
	// places it (see `fallbackPortLabels`).
	for (const fallback of fallbackLabels) {
		vertex(
			multilineHtml(fallback.text),
			`${PORT_LABEL_STYLE}fontSize=10;${fallback.left ? "align=right;" : "align=left;"}`,
			fallback.box,
			portCells.get(fallback.nodeId)?.get(fallback.portId),
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
	// The containers (groups, lanes) around a cell, innermost first.
	const containersOf = (cellId: string | undefined) => {
		const chain: { id: string; box: Box }[] = [];
		const seen = new Set<string>();
		let current = cellId === undefined ? undefined : parentOf.get(cellId);
		while (current !== undefined && !seen.has(current.id)) {
			seen.add(current.id);
			chain.push(current);
			current = parentOf.get(current.id);
		}
		return chain;
	};
	// draw.io draws a hop on a connector where it crosses one behind it
	// (earlier in the document). Each crossing's jumping edge is therefore
	// written after the edge it jumps: edges in z-order, over before under.
	// Edges whose over/under relations form a cycle cannot all be ordered;
	// they are split where their role changes, their jumping pieces written
	// after every other edge and the rest before them.
	const cyclic = hopCycleEdges(diagram.edges, crossings);
	const hopOrder = hopZOrder(diagram.edges, crossings, cyclic);
	const edgeCellsById = new Map<string, EdgeCellPiece[]>();
	for (const edge of diagram.edges) {
		const cellId = String(nextId++);
		// An edge between two cells of one group or lane is that
		// container's child (waypoints relative to it), so dragging the
		// container carries the whole route along.
		const sourceContainers = containersOf(nodeCellIds.get(edge.source.nodeId));
		const targetIds = new Set(
			containersOf(nodeCellIds.get(edge.target.nodeId)).map((cell) => cell.id),
		);
		// A self-loop belongs to its node: dragging the node carries the
		// loop's waypoints along.
		const loopNode =
			edge.source.nodeId === edge.target.nodeId
				? nodeById.get(edge.source.nodeId)
				: undefined;
		const loopCellId =
			loopNode === undefined ? undefined : nodeCellIds.get(loopNode.id);
		const container =
			loopNode !== undefined && loopCellId !== undefined
				? { id: loopCellId, box: loopNode.box }
				: sourceContainers.find((cell) => targetIds.has(cell.id));
		edgeCellsById.set(
			edge.id,
			renderEdgeCells(
				{
					cellId,
					edge,
					points: edge.points.map(move),
					...(container === undefined
						? {}
						: { parent: { id: container.id, origin: shift(container.box) } }),
					...(() => {
						const terminal = (end: CoordinatedEdge["source"]) => {
							const port =
								end.portId === undefined
									? undefined
									: portCells.get(end.nodeId)?.get(end.portId);
							return port === undefined
								? {
										box: boxOf(nodeById.get(end.nodeId)),
										id: nodeCellIds.get(end.nodeId),
									}
								: { box: shift(port.box), id: port.id };
						};
						const source = terminal(edge.source);
						const target = terminal(edge.target);
						return {
							sourceBox: source.box,
							targetBox: target.box,
							sourceId: source.id,
							targetId: target.id,
						};
					})(),
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
				},
				() => String(nextId++),
				cyclic.has(edge.id),
			),
		);
	}
	const piecesOf = (edgeId: string) => edgeCellsById.get(edgeId) ?? [];
	edgeLayer.push(
		...diagram.edges.flatMap((edge) =>
			cyclic.has(edge.id)
				? piecesOf(edge.id).flatMap((piece) =>
						piece.jumps ? [] : [piece.cell],
					)
				: [],
		),
		...hopOrder.flatMap((edgeId) =>
			piecesOf(edgeId).map((piece) => piece.cell),
		),
		...diagram.edges.flatMap((edge) =>
			cyclic.has(edge.id)
				? piecesOf(edge.id).flatMap((piece) =>
						piece.jumps ? [piece.cell] : [],
					)
				: [],
		),
	);

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

	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<mxfile host="auto-graph" type="device">`,
		`  <diagram id="${escapeXml(diagram.id)}" name="${escapeXml(title)}">`,
		`    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" ${pageAttributes}>`,
		`      <root>`,
		...[...cells, ...edgeLayer, ...foreground].map((cell) => `        ${cell}`),
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
		`fillColor=${styleValue(style?.fill ?? "#d9ead3")};`,
		...(style?.stroke === undefined
			? []
			: [`strokeColor=${styleValue(style.stroke)};`]),
	].join("");
}
/** A port label: a backdrop keeps passing edges off it, as in the SVG. */
const PORT_LABEL_STYLE =
	"text;html=1;whiteSpace=nowrap;align=center;verticalAlign=middle;labelBackgroundColor=#ffffff;";
/** A thin rule between SysML compartments. */
const COMPARTMENT_SEPARATOR_STYLE =
	"line;html=1;strokeWidth=1;fillColor=none;align=left;verticalAlign=middle;";
/** A solved text surface drawn as its own cell. */
const SOLVED_TEXT_STYLE =
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
	/** The node's geometry, relative to its parent cell. */
	box: Box,
	parentId: string,
	solvedRows = false,
	/** The solved node label, when there is one (not for compartments). */
	solvedLabel?: SolvedTextAnnotation,
): string {
	const visual = node.style;
	const labelled = node.compartments === undefined ? solvedLabel : undefined;
	// As for the size below: the solved label's, else the label layout's.
	const measuredFamily =
		labelled?.fontFamily ?? node.labelLayout?.font?.fontFamily;
	const style = [
		nodeShapeStyle(node.shape),
		...(node.compartments === undefined ? [] : ["verticalAlign=top;"]),
		...(visual?.fill === undefined
			? []
			: [`fillColor=${styleValue(visual.fill)};`]),
		...(visual?.stroke === undefined
			? []
			: [`strokeColor=${styleValue(visual.stroke)};`]),
		// The solver measured and wrapped the label in this family.
		...(visual?.fontFamily === undefined
			? measuredFamily === undefined
				? []
				: labelFontStyle({ fontFamily: measuredFamily }).map(
						(entry) => `${entry};`,
					)
			: [`fontFamily=${styleValue(visual.fontFamily)};`]),
		// The solver measured the label at this size.
		...(visual?.fontSize === undefined
			? labelled !== undefined
				? [`fontSize=${formatNumber(labelled.fontSize)};`]
				: node.labelLayout === undefined
					? []
					: [`fontSize=${formatNumber(node.labelLayout.font.fontSize)};`]
			: [`fontSize=${formatNumber(visual.fontSize)};`]),
		// The label stays the node's own (editable in draw.io); spacing moves
		// its centre to the solved box (e.g. a cylinder label below the cap).
		// Without a solved annotation the node's label layout (a box
		// relative to the node) places it the same way.
		...(labelled !== undefined
			? [labelOffsetStyle(labelled.box, node.box)]
			: node.compartments === undefined && node.labelLayout?.box !== undefined
				? [
						labelOffsetStyle(
							{
								...node.labelLayout.box,
								x: node.box.x + node.labelLayout.box.x,
								y: node.box.y + node.labelLayout.box.y,
							},
							node.box,
						),
					]
				: []),
	].join("");
	const label = escapeXml(
		node.compartments === undefined
			? labelled !== undefined
				? calloutText(labelled)
				: nodeLabelHtml(node)
			: solvedRows
				? ""
				: compartmentHtml(node),
	);
	return `<mxCell id="${escapeXml(cellId)}" value="${label}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parentId)}">${geometry(box)}</mxCell>`;
}

/**
 * draw.io centres a node label in the node box less its spacing: extra
 * spacing of 2d on one side moves the label centre by d the other way.
 */
function labelOffsetStyle(label: Box, node: Box): string {
	const dx = label.x + label.width / 2 - (node.x + node.width / 2);
	const dy = label.y + label.height / 2 - (node.y + node.height / 2);
	const entries: string[] = [];
	if (Math.abs(dx) > 0.5) {
		entries.push(
			`${dx > 0 ? "spacingLeft" : "spacingRight"}=${formatNumber(2 * Math.abs(dx))};`,
		);
	}
	if (Math.abs(dy) > 0.5) {
		entries.push(
			`${dy > 0 ? "spacingTop" : "spacingBottom"}=${formatNumber(2 * Math.abs(dy))};`,
		);
	}
	return entries.join("");
}

/**
 * A node label as draw.io HTML with the solver's line breaks, so draw.io
 * does not rewrap it with its own text engine.
 */
function nodeLabelHtml(node: CoordinatedNode): string {
	const lines = node.labelLayout?.lines ?? [];
	return lines.length > 1
		? lines.map((line) => escapeHtml(line.text)).join("<br>")
		: // A node without a label stays blank, as in the SVG; authored
			// line breaks become <br> (an attribute would flatten them).
			multilineHtml(node.label?.text ?? "");
}

/** SysML compartments as the SVG draws them: header, properties, constraints. */
/** Rows `compartmentHtml` draws: stereotype, name, properties, constraints. */
function compartmentRowCount(node: CoordinatedNode): number {
	const compartments = node.compartments;
	if (compartments === undefined) return 0;
	return (
		(compartments.stereotype === undefined ? 0 : 1) +
		1 +
		(compartments.properties ?? []).length +
		(compartments.constraints ?? []).length
	);
}

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

interface SwimlaneCell {
	value: string;
	style: string;
	box: Box;
	/** The lane this cell draws (lane cells only, not their titles). */
	lane?: SwimlaneLane;
	/** Index of the cell (in the same list) this one is a child of. */
	parentIndex?: number;
}

function swimlaneCells(
	swimlane: Swimlane,
	annotations: readonly SolvedTextAnnotation[],
): SwimlaneCell[] {
	const cells: SwimlaneCell[] = [];
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
		// The solved label (its lines, typography and box) is a text cell of
		// its own, so draw.io does not reflow it inside the header.
		// The owner id joins swimlane and lane ids with a dot, ambiguous when
		// ids contain dots: of the matching labels, take the one centred on
		// this lane's header.
		const titleArea = header ?? lane.box;
		const title =
			lane.label?.text === undefined
				? undefined
				: nearestBox(
						annotations.filter(
							(annotation) =>
								annotation.surfaceKind === "swimlane-label" &&
								annotation.ownerId === `${swimlane.id}.${lane.id}`,
						),
						titleArea,
					);
		cells.push({
			// A lane without a label stays blank, as in the SVG.
			value: title === undefined ? multilineHtml(lane.label?.text ?? "") : "",
			style: `swimlane;whiteSpace=wrap;html=1;startSize=${formatNumber(startSize)};${leftHeader ? "horizontal=0;" : ""}`,
			box: lane.box,
			lane,
		});
		if (title !== undefined) {
			cells.push({
				// A child of its lane, so it moves with the lane.
				parentIndex: cells.length - 1,
				value: calloutText(title),
				// Horizontal pools draw the label turned, as the SVG does.
				style: `${SOLVED_TEXT_STYLE}${swimlane.orientation === "horizontal" ? "rotation=-90;" : ""}${fontStyleEntries(title)}`,
				box: title.box,
			});
		}
	}
	return cells;
}

/** `labelFontStyle` entries as a style string. */
function fontStyleEntries(
	font: Partial<Pick<SolvedTextAnnotation, "fontFamily" | "fontSize">>,
): string {
	return labelFontStyle(font)
		.map((entry) => `${entry};`)
		.join("");
}

interface EdgeCellInput {
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
	/** The container cell this edge belongs to, with its page origin. */
	parent?: { id: string; origin: Point };
	/** False for a piece that stops before the target: no arrowhead. */
	endArrow?: boolean;
	/** Set on the pieces of a split edge: the edge they draw together. */
	pieceOf?: string;
}

/**
 * draw.io's `jumpStyle` is one style per edge cell. An edge whose
 * crossings mix styles (gap and jump, say) is drawn as consecutive pieces,
 * cut halfway between neighbouring crossings of different styles, so each
 * crossing keeps its own glyph. The first piece keeps the source terminal,
 * the last the target terminal and the arrowhead, and the label rides on
 * the piece nearest to it. Single-style edges stay one connector.
 */
function renderEdgeCells(
	input: EdgeCellInput,
	newCellId: () => string,
	/** Also cut where the edge turns from jumping to being jumped. */
	splitRoles = false,
): EdgeCellPiece[] {
	const { edge, points } = input;
	const jumps = input.crossings.filter(
		(crossing) => crossing.underEdgeId === edge.id,
	);
	// What each crossing asks of this edge: a hop of some style, or none.
	const roleOf = (crossing: EdgeCrossing) =>
		crossing.underEdgeId === edge.id ? crossing.style : "over";
	const marked = splitRoles ? input.crossings : jumps;
	if (new Set(marked.map(roleOf)).size <= 1 || points.length < 2) {
		return [{ cell: renderEdgeCell(input), jumps: jumps.length > 0 }];
	}
	const along = (point: Point) => distanceAlong(points, point);
	const sorted = marked
		.map((crossing) => ({ crossing, at: along(crossing) }))
		.sort((left, right) => left.at - right.at);
	const cuts: number[] = [];
	sorted.forEach((entry, index) => {
		const previous = sorted[index - 1];
		if (
			previous !== undefined &&
			roleOf(previous.crossing) !== roleOf(entry.crossing)
		) {
			cuts.push((previous.at + entry.at) / 2);
		}
	});
	const pieces = splitPolylineAt(points, cuts);
	// A label with no solved box (an authored fallback) rides on the piece
	// holding the route's middle, where draw.io would put it.
	const labelCenter =
		input.labelBox !== undefined
			? {
					x: input.labelBox.x + input.labelBox.width / 2,
					y: input.labelBox.y + input.labelBox.height / 2,
				}
			: input.label !== ""
				? pointAtHalfLength(points)
				: undefined;
	const labelAt = labelCenter === undefined ? undefined : along(labelCenter);
	const pieceIndex = (at: number) => cuts.filter((cut) => at > cut).length;
	const labelled = labelAt === undefined ? -1 : pieceIndex(labelAt);
	return pieces.map((piece, index) => {
		const first = index === 0;
		const last = index === pieces.length - 1;
		const hasLabel = index === labelled;
		const pieceCrossings = input.crossings.filter(
			(crossing) => pieceIndex(along(crossing)) === index,
		);
		return {
			jumps: pieceCrossings.some(
				(crossing) => crossing.underEdgeId === edge.id,
			),
			cell: renderEdgeCell({
				...input,
				cellId: first ? input.cellId : newCellId(),
				points: piece,
				sourceBox: first ? input.sourceBox : undefined,
				sourceId: first ? input.sourceId : undefined,
				targetBox: last ? input.targetBox : undefined,
				targetId: last ? input.targetId : undefined,
				crossings: pieceCrossings,
				label: hasLabel ? input.label : "",
				// A fallback label keeps the original route's middle: an empty
				// box there gives the piece its offset.
				labelBox: hasLabel
					? (input.labelBox ??
						(labelCenter === undefined
							? undefined
							: { ...labelCenter, width: 0, height: 0 }))
					: undefined,
				labelFont: hasLabel ? input.labelFont : undefined,
				endArrow: last,
				pieceOf: edge.id,
			}),
		};
	});
}

/** One draw.io edge cell, and whether it draws a hop. */
interface EdgeCellPiece {
	cell: string;
	jumps: boolean;
}

/**
 * Edges whose "jumped before jumping" relations (over edge, then the under
 * edge that hops it) form a cycle: no document order draws every hop.
 */
function hopCycleEdges(
	edges: readonly CoordinatedEdge[],
	crossings: readonly EdgeCrossing[],
): Set<string> {
	const next = hopSuccessors(crossings);
	// Tarjan's strongly connected components, iteratively.
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const cyclic = new Set<string>();
	let counter = 0;
	for (const root of edges.map((edge) => edge.id)) {
		if (index.has(root)) continue;
		const work: { id: string; children: string[] }[] = [];
		const open = (id: string) => {
			index.set(id, counter);
			low.set(id, counter);
			counter += 1;
			stack.push(id);
			onStack.add(id);
			work.push({ id, children: [...(next.get(id) ?? [])] });
		};
		open(root);
		while (work.length > 0) {
			const frame = work[work.length - 1] as (typeof work)[number];
			const child = frame.children.shift();
			if (child !== undefined) {
				if (!index.has(child)) open(child);
				else if (onStack.has(child)) {
					low.set(
						frame.id,
						Math.min(low.get(frame.id) ?? 0, index.get(child) ?? 0),
					);
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent !== undefined) {
				low.set(
					parent.id,
					Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0),
				);
			}
			if (low.get(frame.id) === index.get(frame.id)) {
				const component: string[] = [];
				for (;;) {
					const id = stack.pop() as string;
					onStack.delete(id);
					component.push(id);
					if (id === frame.id) break;
				}
				if (component.length > 1) for (const id of component) cyclic.add(id);
			}
		}
	}
	return cyclic;
}

/**
 * The other edges in document order: every over edge before the edges that
 * hop it, otherwise in diagram order.
 */
function hopZOrder(
	edges: readonly CoordinatedEdge[],
	crossings: readonly EdgeCrossing[],
	cyclic: ReadonlySet<string>,
): string[] {
	const ids = edges.map((edge) => edge.id).filter((id) => !cyclic.has(id));
	const position = new Map(ids.map((id, at) => [id, at] as const));
	const next = hopSuccessors(crossings);
	const pending = new Map<string, number>(ids.map((id) => [id, 0]));
	for (const id of ids) {
		for (const successor of next.get(id) ?? []) {
			if (pending.has(successor)) {
				pending.set(successor, (pending.get(successor) ?? 0) + 1);
			}
		}
	}
	const order: string[] = [];
	const ready = ids.filter((id) => pending.get(id) === 0);
	while (ready.length > 0) {
		ready.sort(
			(left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0),
		);
		const id = ready.shift() as string;
		order.push(id);
		for (const successor of next.get(id) ?? []) {
			if (!pending.has(successor)) continue;
			const left = (pending.get(successor) ?? 0) - 1;
			pending.set(successor, left);
			if (left === 0) ready.push(successor);
		}
	}
	return order;
}

/** Over edge → the under edges that hop it (deduplicated). */
function hopSuccessors(
	crossings: readonly EdgeCrossing[],
): Map<string, Set<string>> {
	const next = new Map<string, Set<string>>();
	for (const crossing of crossings) {
		if (crossing.overEdgeId === crossing.underEdgeId) continue;
		const set = next.get(crossing.overEdgeId) ?? new Set<string>();
		set.add(crossing.underEdgeId);
		next.set(crossing.overEdgeId, set);
	}
	return next;
}

/** Distance along a polyline to the point on it nearest to `point`. */
function distanceAlong(points: readonly Point[], point: Point): number {
	let best = { distance: Number.POSITIVE_INFINITY, at: 0 };
	let walked = 0;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as Point;
		const b = points[index] as Point;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		const t =
			length > 0
				? Math.min(
						1,
						Math.max(
							0,
							((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) /
								(length * length),
						),
					)
				: 0;
		const distance = Math.hypot(
			a.x + (b.x - a.x) * t - point.x,
			a.y + (b.y - a.y) * t - point.y,
		);
		if (distance < best.distance) best = { distance, at: walked + t * length };
		walked += length;
	}
	return best.at;
}

/** A polyline cut at the given distances along it (ascending). */
function splitPolylineAt(
	points: readonly Point[],
	cuts: readonly number[],
): Point[][] {
	const pieces: Point[][] = [];
	let current: Point[] = [{ ...(points[0] as Point) }];
	let walked = 0;
	let next = 0;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as Point;
		const b = points[index] as Point;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		while (next < cuts.length && (cuts[next] as number) <= walked + length) {
			const t = length > 0 ? ((cuts[next] as number) - walked) / length : 0;
			const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
			current.push(cut);
			pieces.push(current);
			current = [{ ...cut }];
			next += 1;
		}
		current.push({ ...b });
		walked += length;
	}
	pieces.push(current);
	return pieces;
}

function renderEdgeCell(input: EdgeCellInput): string {
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
		...(input.endArrow === false
			? ["endArrow=none"]
			: [
					"endArrow=block",
					`endFill=${edge.arrowhead === "hollowTriangle" ? 0 : 1}`,
				]),
		// Encoded: an id's ';' or '=' would otherwise split the style string.
		...(input.pieceOf === undefined
			? []
			: // Code points XML forbids go first: a lone surrogate would
				// make encodeURIComponent throw.
				[
					`dgeEdge=${encodeURIComponent(input.pieceOf.replace(XML_FORBIDDEN, ""))}`,
				]),
	];
	if (edge.style === "dashed") styleParts.push("dashed=1");
	// The label (inline or a callout key) sits over connectors like the
	// SVG's: an opaque backdrop keeps strokes from showing through it.
	if (input.label !== "") styleParts.push("labelBackgroundColor=#ffffff");
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
			// One style value: `;` would start a new style entry per record.
			`dgeCrossings=${encodeURIComponent(
				crossings
					.map(
						(crossing) =>
							`${formatNumber(crossing.x)},${formatNumber(crossing.y)},${crossing.style}`,
					)
					.join(";"),
			)}`,
		);
	}
	const geometryChildren: string[] = [];
	// Geometry points are relative to the edge's parent cell.
	const origin = input.parent?.origin ?? { x: 0, y: 0 };
	const local = (point: Point): Point => ({
		x: point.x - origin.x,
		y: point.y - origin.y,
	});
	if (points.length >= 2 && first !== undefined && last !== undefined) {
		const waypoints = points.slice(1, -1).map(local);
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
		const start = local(first);
		const end = local(last);
		geometryChildren.push(
			`<mxPoint as="sourcePoint" x="${formatNumber(start.x)}" y="${formatNumber(start.y)}"/>`,
			`<mxPoint as="targetPoint" x="${formatNumber(end.x)}" y="${formatNumber(end.y)}"/>`,
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
	for (const jump of jumps.map(local)) {
		geometryChildren.push(
			`<mxPoint as="dgeJump" x="${formatNumber(jump.x)}" y="${formatNumber(jump.y)}" />`,
		);
	}
	const terminals = `${input.sourceId === undefined ? "" : ` source="${escapeXml(input.sourceId)}"`}${input.targetId === undefined ? "" : ` target="${escapeXml(input.targetId)}"`}`;
	return `<mxCell id="${escapeXml(input.cellId)}" value="${escapeXml(input.label)}" style="${escapeXml(styleParts.join(";"))}" edge="1" parent="${escapeXml(input.parent?.id ?? "1")}"${terminals}><mxGeometry relative="1" as="geometry">${geometryChildren.join("")}</mxGeometry></mxCell>`;
}

/**
 * An edge label as draw.io HTML: the solved line breaks kept, so a label
 * the solver wrapped does not come back as one wide line.
 */
function edgeLabelHtml(
	annotation: SolvedTextAnnotation | undefined,
	fallback: string | undefined,
): string {
	if (annotation === undefined) return multilineHtml(fallback ?? "");
	return annotation.lines.length > 1
		? annotation.lines.map((line) => escapeHtml(line.text)).join("<br>")
		: escapeHtml(annotation.text);
}

/**
 * Authored text as draw.io HTML: a raw line break in an XML attribute is
 * normalised to a space, so each becomes `<br>`.
 */
function multilineHtml(text: string): string {
	return textLines(text).map(escapeHtml).join("<br>");
}

function textLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
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
	// The solver measured evidence text in Arial 10px (EVIDENCE_TEXT_FONT).
	return `rounded=0;whiteSpace=wrap;html=1;overflow=hidden;fontFamily=Arial;fontSize=10;spacing=2;fillColor=${styleValue(fill)};strokeColor=${styleValue(stroke)};`;
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

/**
 * An authored value inside mxGraph's `key=value;` style string: `;` would
 * end the entry and start a new key (e.g. `#fff;shape=ellipse`), so it is
 * dropped.
 */
function styleValue(value: string): string {
	return value.replaceAll(";", "");
}

/** Style entries for a solved label's typography (the box was measured with it). */
function labelFontStyle(
	font: Partial<Pick<SolvedTextAnnotation, "fontFamily" | "fontSize">>,
): string[] {
	const entries: string[] = [];
	const family =
		font.fontFamily === undefined ? undefined : styleValue(font.fontFamily);
	if (family) entries.push(`fontFamily=${family}`);
	if (font.fontSize !== undefined && Number.isFinite(font.fontSize)) {
		entries.push(`fontSize=${formatNumber(font.fontSize)}`);
	}
	return entries;
}

/** The annotation whose box centre is nearest to `target`'s centre. */
/**
 * Authored port labels that no solved port-label annotation covers, with
 * the box each is drawn in: beside the port, 8px out and just above its
 * anchor, as the SVG places it. A solved label goes to the nearest port
 * with its (dot-joined, so possibly ambiguous) owner id, as it is drawn.
 */
function fallbackPortLabels(diagram: CoordinatedDiagram): {
	nodeId: string;
	portId: string;
	text: string;
	left: boolean;
	box: Box;
}[] {
	const key = (nodeId: string, portId: string) => `${nodeId}\u0000${portId}`;
	const candidates = new Map<string, { key: string; box: Box }[]>();
	for (const node of diagram.nodes) {
		for (const port of node.ports ?? []) {
			const owner = `${node.id}.${port.id}`;
			candidates.set(owner, [
				...(candidates.get(owner) ?? []),
				{ key: key(node.id, port.id), box: port.box },
			]);
		}
	}
	const solved = new Set<string>();
	for (const annotation of diagram.textAnnotations ?? []) {
		if (annotation.surfaceKind !== "port-label") continue;
		const port = nearestBox(
			candidates.get(annotation.ownerId) ?? [],
			annotation.box,
		);
		if (port !== undefined) solved.add(port.key);
	}
	return diagram.nodes.flatMap((node) =>
		(node.ports ?? []).flatMap((port) => {
			const text = port.label?.text;
			if (text === undefined || solved.has(key(node.id, port.id))) return [];
			// One 14px row per authored line, bottom kept 4px above the port.
			const lines = textLines(text);
			const width = Math.max(
				10,
				...lines.map((line) => fallbackTextWidth(line, 10)),
			);
			const height = 14 * lines.length;
			const left = port.side === "left";
			return [
				{
					nodeId: node.id,
					portId: port.id,
					text,
					left,
					box: {
						x: left ? port.anchor.x - 8 - width : port.anchor.x + 8,
						y: port.anchor.y - 4 - height,
						width,
						height,
					},
				},
			];
		}),
	);
}

/**
 * Boxes of authored edge labels that no solved edge label covers: draw.io
 * draws them at the route's middle, at its default 11px font.
 */
function fallbackEdgeLabelBoxes(diagram: CoordinatedDiagram): Box[] {
	// A callout alone is not drawn as the edge's label (`labelByEdge` skips
	// it), so the authored text still goes to the route middle.
	const solved = new Set(
		(diagram.textAnnotations ?? [])
			.filter(
				(annotation) =>
					annotation.surfaceKind === "edge-label" &&
					annotation.placementDetail?.role !== "callout",
			)
			.map((annotation) => annotation.ownerId),
	);
	return diagram.edges.flatMap((edge) => {
		const text = edge.label?.text;
		const middle = pointAtHalfLength(edge.points);
		if (text === undefined || text === "" || solved.has(edge.id)) return [];
		if (middle === undefined) return [];
		// One 16px row per authored line, as wide as the widest.
		const lines = textLines(text);
		const width =
			Math.max(...lines.map((line) => fallbackTextWidth(line, 11))) + 4;
		const height = 16 * lines.length;
		return [
			{
				x: middle.x - width / 2,
				y: middle.y - height / 2,
				width,
				height,
			},
		];
	});
}

function nearestBox<T extends { box: Box }>(
	candidates: readonly T[],
	target: Box,
): T | undefined {
	const cx = target.x + target.width / 2;
	const cy = target.y + target.height / 2;
	const distance = (box: Box) =>
		Math.hypot(box.x + box.width / 2 - cx, box.y + box.height / 2 - cy);
	return [...candidates].sort(
		(left, right) => distance(left.box) - distance(right.box),
	)[0];
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

/**
 * Code points XML 1.0 forbids even as character references (C0 controls
 * other than tab and line breaks, lone surrogates, U+FFFE/U+FFFF): dropped,
 * or the document is not well-formed.
 */
const XML_FORBIDDEN =
	/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

function escapeXml(value: string): string {
	return value
		.replace(XML_FORBIDDEN, "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/**
 * The draw.io page around a diagram: the solved bounds plus the requested
 * viewport padding. Boundary ports and text drawn outside a node (port
 * labels, for one) can reach past the solved bounds: the page covers them
 * too.
 */
export function drawioPageBox(
	diagram: CoordinatedDiagram,
	options: ExportOptions = {},
): Box {
	const fallbackLabels = fallbackPortLabels(diagram);
	return expandBoxForDrawio(
		unionBoxes([
			diagram.bounds,
			...diagram.nodes.flatMap((node) =>
				(node.ports ?? []).map((port) => port.box),
			),
			...(diagram.textAnnotations ?? []).map((annotation) => annotation.box),
			...fallbackLabels.map((fallback) => fallback.box),
			...fallbackEdgeLabelBoxes(diagram),
			// A native hop arc reaches its glyph radius past the crossing.
			...(diagram.edgeCrossings ?? []).map((crossing) => ({
				x: crossing.x - EDGE_CROSSING_GLYPH_RADIUS,
				y: crossing.y - EDGE_CROSSING_GLYPH_RADIUS,
				width: 2 * EDGE_CROSSING_GLYPH_RADIUS,
				height: 2 * EDGE_CROSSING_GLYPH_RADIUS,
			})),
		]),
		// As in the SVG and Excalidraw viewports: a non-finite padding is none.
		Number.isFinite(options.viewportPadding)
			? Math.max(0, options.viewportPadding ?? 0)
			: 0,
	);
}

export function expandBoxForDrawio(bounds: Box, padding: number): Box {
	return {
		x: bounds.x - padding,
		y: bounds.y - padding,
		width: bounds.width + padding * 2,
		height: bounds.height + padding * 2,
	};
}
