import { intersectsAabb, normalizeInsets } from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type {
	CoordinatedEvidencePanel,
	CoordinatedMatrixBlock,
	CoordinatedTableBlock,
	EvidencePanel,
	EvidenceTextLayout,
	MatrixBlock,
	TableBlock,
} from "../ir/elements.js";
import type { Box, Insets, Point, Size } from "../ir/geometry.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import type { TextMeasurer } from "../text/types.js";

const DEFAULT_MATRIX_CELL_SIZE: Size = { width: 120, height: 36 };
const DEFAULT_TABLE_CELL_SIZE: Size = { width: 128, height: 34 };
const DEFAULT_PANEL_WIDTH = 320;
const DEFAULT_PANEL_ITEM_HEIGHT = 28;
const DEFAULT_EVIDENCE_BLOCK_GAP = 24;

const EVIDENCE_TEXT_FONT = {
	fontFamily: "Arial, sans-serif",
	fontSize: 10,
	lineHeight: 12,
} as const;

export function coordinateMatrices(
	matrices: readonly MatrixBlock[],
): CoordinatedMatrixBlock[] {
	return matrices.map((block) => ({
		...block,
		box: blockBox(block, {
			width:
				defaultMatrixRowHeaderWidth(block) +
				Math.max(1, block.cols.length) * DEFAULT_MATRIX_CELL_SIZE.width,
			height:
				Math.max(1, block.rows.length + 1) * DEFAULT_MATRIX_CELL_SIZE.height,
		}),
	}));
}

function defaultMatrixRowHeaderWidth(block: MatrixBlock): number {
	return block.rows.length === 0
		? 0
		: Math.min(96, DEFAULT_MATRIX_CELL_SIZE.width);
}

export function coordinateTables(
	tables: readonly TableBlock[],
): CoordinatedTableBlock[] {
	return tables.map((table) => {
		const box = blockBox(table, {
			width: Math.max(1, table.columns.length) * DEFAULT_TABLE_CELL_SIZE.width,
			height:
				Math.max(1, table.rows.length + 1) * DEFAULT_TABLE_CELL_SIZE.height,
		});
		return {
			...table,
			box,
			columnXOffsets: columnXOffsets(table, box),
		};
	});
}

export function coordinateEvidencePanels(
	panels: readonly EvidencePanel[],
): CoordinatedEvidencePanel[] {
	return panels.map((block) => ({
		...block,
		box: blockBox(block, {
			width: DEFAULT_PANEL_WIDTH,
			height: Math.max(1, block.items.length) * DEFAULT_PANEL_ITEM_HEIGHT,
		}),
	}));
}
function blockBox(
	block: { position?: Point; size?: Size },
	defaultSize: Size,
): Box {
	return {
		x: block.position?.x ?? 0,
		y: block.position?.y ?? 0,
		width: block.size?.width ?? defaultSize.width,
		height: block.size?.height ?? defaultSize.height,
	};
}

export function placeEvidenceBlocks(
	obstacleMargin: number | Insets,
	blocks: Array<{ position?: Point; box: Box }>,
	contentBounds: Box,
): void {
	const margin = normalizeInsets(obstacleMargin);
	const horizontalGap = Math.max(
		DEFAULT_EVIDENCE_BLOCK_GAP,
		margin.right + margin.left,
	);
	const verticalGap = Math.max(
		DEFAULT_EVIDENCE_BLOCK_GAP,
		margin.bottom + margin.top,
	);
	let nextY = contentBounds.y;
	const x = contentBounds.x + contentBounds.width + horizontalGap;
	for (const block of blocks) {
		if (block.position !== undefined) {
			continue;
		}
		block.box.x = x;
		block.box.y = nextY;
		nextY += block.box.height + verticalGap;
	}
}

function columnXOffsets(table: TableBlock, box: Box): number[] {
	if (table.columns.length === 0) {
		return [];
	}
	const columnWidth = box.width / table.columns.length;
	return table.columns.map((_, index) => box.x + index * columnWidth);
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

export function refreshTableColumnXOffsets(
	tables: CoordinatedTableBlock[],
): void {
	for (const table of tables) {
		table.columnXOffsets = columnXOffsets(table, table.box);
	}
}

export function measureEvidenceTextBlocks(
	matrices: CoordinatedMatrixBlock[],
	tables: CoordinatedTableBlock[],
	panels: CoordinatedEvidencePanel[],
	textMeasurer?: TextMeasurer,
): void {
	const measurer = textMeasurer ?? createDefaultTextMeasurer();
	for (const matrix of matrices) {
		const geometry = matrixGeometry(matrix);
		matrix.columnLabelLayouts = matrix.cols.map((column) =>
			measureEvidenceTextLayout(column, geometry.columnHeaderBox, measurer),
		);
		matrix.rowLabelLayouts = matrix.rows.map((row, index) =>
			measureEvidenceTextLayout(row, geometry.rowHeaderBox(index), measurer),
		);
		matrix.cellLabelLayouts = matrix.rows.map((_, rowIndex) =>
			matrix.cols.map((_, columnIndex) => {
				const cell = matrix.cells[rowIndex]?.[columnIndex] ?? { text: "" };
				return measureEvidenceTextLayout(
					cell.text,
					geometry.cellBox(rowIndex, columnIndex),
					measurer,
				);
			}),
		);
	}
	for (const table of tables) {
		const rowHeight = table.box.height / Math.max(1, table.rows.length + 1);
		const columnCount = Math.max(1, table.columns.length);
		table.columnLabelLayouts = table.columns.map((column, columnIndex) =>
			measureEvidenceTextLayout(
				column.label.text,
				tableCellBox(table, columnIndex, 0, rowHeight, columnCount),
				measurer,
			),
		);
		table.cellLabelLayouts = table.rows.map((row, rowIndex) =>
			table.columns.map((column, columnIndex) => {
				const cell = row.cells[column.id] ?? { text: "" };
				return measureEvidenceTextLayout(
					cell.text,
					tableCellBox(
						table,
						columnIndex,
						rowIndex + 1,
						rowHeight,
						columnCount,
					),
					measurer,
				);
			}),
		);
	}
	for (const panel of panels) {
		const geometry = panelGeometry(panel);
		panel.titleLayout = measureEvidenceTextLayout(
			`${panel.kind}: ${panel.id}`,
			geometry.titleBox,
			measurer,
		);
		panel.itemLayouts = panel.items.map((item, index) =>
			measureEvidenceTextLayout(
				panelItemText(item.label.text, item.detail?.text),
				geometry.itemRowBox(index),
				measurer,
			),
		);
	}
}

function measureEvidenceTextLayout(
	text: string,
	box: Box,
	textMeasurer: TextMeasurer,
): EvidenceTextLayout {
	const lineHeight = EVIDENCE_TEXT_FONT.lineHeight;
	return {
		lines: wrapEvidenceText(text, {
			maxWidth: Math.max(0, box.width - 8),
			maxLines: Math.max(1, Math.floor((box.height - 4) / lineHeight)),
			textMeasurer,
		}),
	};
}

function wrapEvidenceText(
	text: string,
	options: { maxWidth: number; maxLines: number; textMeasurer: TextMeasurer },
): string[] {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		return [""];
	}

	const lines: string[] = [];
	let current = "";
	let overflow = false;
	for (const word of normalized.split(" ")) {
		const chunks = chunkEvidenceWord(
			word,
			options.maxWidth,
			options.textMeasurer,
		);
		for (const chunk of chunks) {
			const candidate = current.length === 0 ? chunk : `${current} ${chunk}`;
			if (
				measureEvidenceText(candidate, options.textMeasurer) <= options.maxWidth
			) {
				current = candidate;
				continue;
			}
			if (current.length > 0) {
				lines.push(current);
				current = chunk;
			} else {
				lines.push(chunk);
				current = "";
			}
			if (lines.length >= options.maxLines) {
				overflow = true;
				break;
			}
		}
		if (overflow) {
			break;
		}
	}
	if (!overflow && current.length > 0) {
		lines.push(current);
	}
	if (lines.length > options.maxLines) {
		overflow = true;
		lines.length = options.maxLines;
	}
	if (overflow || lines.length === options.maxLines) {
		const rendered = lines.join(" ");
		if (rendered.length < normalized.length) {
			lines[lines.length - 1] = ellipsizeMeasuredEvidenceLine(
				lines[lines.length - 1] ?? "",
				options.maxWidth,
				options.textMeasurer,
			);
		}
	}

	return lines.length === 0 ? [""] : lines;
}

function chunkEvidenceWord(
	word: string,
	maxWidth: number,
	textMeasurer: TextMeasurer,
): string[] {
	if (measureEvidenceText(word, textMeasurer) <= maxWidth) {
		return [word];
	}
	const chunks: string[] = [];
	let current = "";
	for (const char of Array.from(word)) {
		const candidate = `${current}${char}`;
		if (
			current.length > 0 &&
			measureEvidenceText(candidate, textMeasurer) > maxWidth
		) {
			chunks.push(current);
			current = char;
			continue;
		}
		current = candidate;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks.length === 0 ? [word] : chunks;
}

function ellipsizeMeasuredEvidenceLine(
	line: string,
	maxWidth: number,
	textMeasurer: TextMeasurer,
): string {
	const ellipsis = "...";
	if (measureEvidenceText(ellipsis, textMeasurer) > maxWidth) {
		return "";
	}
	let candidate = line.trimEnd();
	while (
		candidate.length > 0 &&
		measureEvidenceText(`${candidate}${ellipsis}`, textMeasurer) > maxWidth
	) {
		candidate = Array.from(candidate).slice(0, -1).join("").trimEnd();
	}
	return `${candidate}${ellipsis}`;
}

function measureEvidenceText(text: string, textMeasurer: TextMeasurer): number {
	return textMeasurer.naturalWidth(
		textMeasurer.prepare(text, EVIDENCE_TEXT_FONT),
	);
}

function matrixGeometry(matrix: CoordinatedMatrixBlock): {
	rowHeaderWidth: number;
	cellWidth: number;
	rowHeight: number;
	columnHeaderBox: Box;
	rowHeaderBox: (rowIndex: number) => Box;
	cellBox: (rowIndex: number, columnIndex: number) => Box;
} {
	const columnCount = Math.max(1, matrix.cols.length);
	const rowCount = matrix.rows.length;
	const rowHeaderWidth =
		rowCount > 0 ? Math.min(96, matrix.box.width * 0.28) : 0;
	const dataWidth = Math.max(0, matrix.box.width - rowHeaderWidth);
	const cellWidth = dataWidth / columnCount;
	const rowHeight = matrix.box.height / Math.max(1, rowCount + 1);
	return {
		rowHeaderWidth,
		cellWidth,
		rowHeight,
		columnHeaderBox: {
			x: matrix.box.x + rowHeaderWidth,
			y: matrix.box.y,
			width: cellWidth,
			height: rowHeight,
		},
		rowHeaderBox: (rowIndex) => ({
			x: matrix.box.x,
			y: matrix.box.y + (rowIndex + 1) * rowHeight,
			width: rowHeaderWidth,
			height: rowHeight,
		}),
		cellBox: (rowIndex, columnIndex) => ({
			x: matrix.box.x + rowHeaderWidth + columnIndex * cellWidth,
			y: matrix.box.y + (rowIndex + 1) * rowHeight,
			width: cellWidth,
			height: rowHeight,
		}),
	};
}

function panelGeometry(panel: CoordinatedEvidencePanel): {
	titleBox: Box;
	itemRowBox: (index: number) => Box;
} {
	const titleWidth = Math.min(panel.box.width * 0.36, 140);
	const itemBox = {
		x: panel.box.x + titleWidth,
		y: panel.box.y,
		width: panel.box.width - titleWidth,
		height: panel.box.height,
	};
	const itemHeight = panel.box.height / Math.max(1, panel.items.length);
	return {
		titleBox: {
			x: panel.box.x,
			y: panel.box.y,
			width: titleWidth,
			height: panel.box.height,
		},
		itemRowBox: (index) => ({
			x: itemBox.x,
			y: itemBox.y + index * itemHeight,
			width: itemBox.width,
			height: itemHeight,
		}),
	};
}

function panelItemText(label: string, detail: string | undefined): string {
	return detail === undefined ? label : `${label}: ${detail}`;
}

export function reportEvidenceBlockOverlaps(
	evidenceBlocks: Array<{
		id: string;
		kind: string;
		position?: Point;
		box: Box;
	}>,
	contentBlocks: Array<{ id: string; kind: string; box: Box }>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (let index = 0; index < evidenceBlocks.length; index += 1) {
		const block = evidenceBlocks[index];
		if (block === undefined || block.position === undefined) {
			continue;
		}
		for (const content of contentBlocks) {
			if (intersectsAabb(block.box, content.box)) {
				diagnostics.push(evidenceOverlapDiagnostic(block, content));
			}
		}
		for (
			let otherIndex = 0;
			otherIndex < evidenceBlocks.length;
			otherIndex += 1
		) {
			if (otherIndex === index) {
				continue;
			}
			const other = evidenceBlocks[otherIndex];
			if (
				other === undefined ||
				(other.position !== undefined && otherIndex < index) ||
				!intersectsAabb(block.box, other.box)
			) {
				continue;
			}
			diagnostics.push(evidenceOverlapDiagnostic(block, other));
		}
	}
	return diagnostics;
}

function evidenceOverlapDiagnostic(
	block: { id: string; kind: string },
	conflict: { id: string; kind: string },
): Diagnostic {
	return {
		severity: "warning",
		code: "constraints.overlap.unresolved",
		message: `Evidence block ${block.id} overlaps ${conflict.kind} ${conflict.id}.`,
		path: ["evidence", block.id],
		detail: {
			evidenceBlockId: block.id,
			evidenceBlockKind: block.kind,
			conflictingObjectId: conflict.id,
			conflictingObjectKind: conflict.kind,
		},
	};
}
