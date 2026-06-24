import type { Box, Point } from "../ir/geometry.js";
import { intersectsAabb } from "./boxes.js";

export interface BoxSpatialIndexEntry {
	id: string;
	box: Box;
}

export interface BoxSpatialIndex {
	cellSize: number;
	entries: ReadonlyMap<string, Box>;
	cells: ReadonlyMap<string, readonly string[]>;
}

export function createBoxSpatialIndex(
	entries: Iterable<BoxSpatialIndexEntry>,
	cellSize = 128,
): BoxSpatialIndex {
	const normalizedCellSize =
		Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 128;
	const boxes = new Map<string, Box>();
	const mutableCells = new Map<string, string[]>();

	for (const entry of entries) {
		boxes.set(entry.id, { ...entry.box });
		for (const key of cellKeysForBox(entry.box, normalizedCellSize)) {
			const ids = mutableCells.get(key) ?? [];
			ids.push(entry.id);
			mutableCells.set(key, ids);
		}
	}

	const cells = new Map<string, readonly string[]>();
	for (const [key, ids] of mutableCells) {
		cells.set(key, [...new Set(ids)].sort());
	}

	return { cellSize: normalizedCellSize, entries: boxes, cells };
}

export function queryBoxSpatialIndex(
	index: BoxSpatialIndex,
	box: Box,
): BoxSpatialIndexEntry[] {
	const ids = new Set<string>();
	for (const key of cellKeysForBox(box, index.cellSize)) {
		for (const id of index.cells.get(key) ?? []) {
			ids.add(id);
		}
	}

	return [...ids].sort().flatMap((id) => {
		const candidate = index.entries.get(id);
		return candidate !== undefined && intersectsAabb(candidate, box)
			? [{ id, box: candidate }]
			: [];
	});
}

export function querySegmentSpatialIndex(
	index: BoxSpatialIndex,
	start: Point,
	end: Point,
): BoxSpatialIndexEntry[] {
	return queryBoxSpatialIndex(index, segmentBox(start, end));
}

export function expandBoxForQuery(box: Box, margin: number): Box {
	return {
		x: box.x - margin,
		y: box.y - margin,
		width: box.width + margin * 2,
		height: box.height + margin * 2,
	};
}

function cellKeysForBox(box: Box, cellSize: number): string[] {
	const minCol = Math.floor(box.x / cellSize);
	const maxCol = Math.floor((box.x + Math.max(1, box.width)) / cellSize);
	const minRow = Math.floor(box.y / cellSize);
	const maxRow = Math.floor((box.y + Math.max(1, box.height)) / cellSize);
	const keys: string[] = [];
	for (let col = minCol; col <= maxCol; col += 1) {
		for (let row = minRow; row <= maxRow; row += 1) {
			keys.push(`${col}:${row}`);
		}
	}
	return keys;
}

function segmentBox(start: Point, end: Point): Box {
	const x = Math.min(start.x, end.x);
	const y = Math.min(start.y, end.y);
	return {
		x,
		y,
		width: Math.max(1, Math.abs(start.x - end.x)),
		height: Math.max(1, Math.abs(start.y - end.y)),
	};
}
