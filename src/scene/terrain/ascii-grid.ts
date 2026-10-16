/**
 * ESRI ASCII grid (`.asc`), the plain-text DEM format GIS tools export:
 *
 *     ncols 4
 *     nrows 3
 *     xllcorner 500000
 *     yllcorner 4400000
 *     cellsize 10
 *     NODATA_value -9999
 *     102 103 104 106
 *     ...
 *
 * Rows run north to south in the file. The result is ready for a scene's
 * `terrain.grid`: rows south to north, `origin` the south-west sample (a
 * cell centre for `xllcorner`, the given point for `xllcenter`), in the
 * file's own coordinates; set `origin` to place it in the scene.
 */
export interface AsciiGrid {
	origin: [number, number];
	spacing: number;
	heights: number[][];
}

export function parseAsciiGrid(text: string): AsciiGrid {
	const tokens = text.trim().split(/\s+/);
	const header = new Map<string, number>();
	let at = 0;
	while (at + 1 < tokens.length && /^[a-z_]+$/i.test(tokens[at] as string)) {
		const value = Number(tokens[at + 1]);
		if (!Number.isFinite(value)) {
			throw new Error(`ASCII grid: "${tokens[at]}" is not a number.`);
		}
		header.set((tokens[at] as string).toLowerCase(), value);
		at += 2;
	}
	const need = (key: string): number => {
		const value = header.get(key);
		if (value === undefined) throw new Error(`ASCII grid: no ${key}.`);
		return value;
	};
	const columns = need("ncols");
	const rows = need("nrows");
	const size = need("cellsize");
	if (
		!Number.isInteger(columns) ||
		!Number.isInteger(rows) ||
		columns < 2 ||
		rows < 2
	) {
		throw new Error("ASCII grid: ncols and nrows must be whole numbers ≥ 2.");
	}
	if (!(size > 0)) throw new Error("ASCII grid: cellsize must be positive.");
	const corner = header.has("xllcorner");
	const x = header.get("xllcorner") ?? need("xllcenter");
	const y = header.get("yllcorner") ?? need("yllcenter");
	const shift = corner ? size / 2 : 0;
	const nodata = header.get("nodata_value");
	const values = tokens.slice(at).map(Number);
	if (values.length !== columns * rows) {
		throw new Error(
			`ASCII grid: ${values.length} values for ${columns} × ${rows} cells.`,
		);
	}
	const heights: number[][] = [];
	for (let row = rows - 1; row >= 0; row -= 1) {
		const line = values.slice(row * columns, (row + 1) * columns);
		const bad = line.findIndex(
			(value) => !Number.isFinite(value) || value === nodata,
		);
		if (bad >= 0) {
			throw new Error(
				`ASCII grid: no elevation at row ${row + 1}, column ${bad + 1}; fill the gaps first.`,
			);
		}
		heights.push(line);
	}
	return { origin: [x + shift, y + shift], spacing: size, heights };
}
