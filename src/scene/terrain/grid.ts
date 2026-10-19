import { corners, type Footprint, type Vec2 } from "../geometry.js";

/**
 * Ground as a regular grid of elevations, sampled bilinearly.
 *
 * Sample (i, j) is at x = origin.x + i·spacing.x, y = origin.y +
 * j·spacing.y; `heights[j][i]` is its elevation, rows from south to north,
 * west to east. Inside a cell the ground is the bilinear surface through
 * the four corner samples, so elevation is continuous and the gradient is
 * piecewise smooth. Scene z is elevation minus `base` (the elevation of
 * the scene's floor, z = 0).
 */
export interface TerrainGrid {
	origin: Vec2;
	spacing: Vec2;
	/** Rows south to north, each west to east, metres. */
	heights: readonly (readonly number[])[];
	/** Elevation at scene z = 0. */
	base: number;
}

/** Elevation and slope of the ground under a footprint, exactly. */
export interface GroundRange {
	minElevation: number;
	maxElevation: number;
	/** Steepest slope anywhere under it, degrees. */
	maxSlope: number;
	/** False when part of the footprint is off the grid. */
	covered: boolean;
}

/** Points this close outside the grid (m) count as on its edge. */
const EDGE = 1e-6;

export class GridTerrain {
	readonly columns: number;
	readonly rows: number;
	readonly min: Vec2;
	readonly max: Vec2;

	constructor(readonly grid: TerrainGrid) {
		this.rows = grid.heights.length;
		this.columns = grid.heights[0]?.length ?? 0;
		this.min = { ...grid.origin };
		this.max = {
			x: grid.origin.x + (this.columns - 1) * grid.spacing.x,
			y: grid.origin.y + (this.rows - 1) * grid.spacing.y,
		};
	}

	covers(x: number, y: number): boolean {
		return (
			x >= this.min.x - EDGE &&
			x <= this.max.x + EDGE &&
			y >= this.min.y - EDGE &&
			y <= this.max.y + EDGE
		);
	}

	/** Elevation at a point (NaN off the grid). */
	elevation(x: number, y: number): number {
		if (!this.covers(x, y)) return Number.NaN;
		const cell = this.cell(x, y);
		return cell.at(x, y);
	}

	/** Scene z of the ground at a point (NaN off the grid). */
	height(x: number, y: number): number {
		return this.elevation(x, y) - this.grid.base;
	}

	/** Scene z of the ground at the nearest point of the grid. */
	heightNear(x: number, y: number): number {
		return this.height(
			Math.max(this.min.x, Math.min(this.max.x, x)),
			Math.max(this.min.y, Math.min(this.max.y, y)),
		);
	}

	/** dz/dx and dz/dy at a point (of the cell it falls in). */
	gradient(x: number, y: number): Vec2 {
		if (!this.covers(x, y)) return { x: Number.NaN, y: Number.NaN };
		return this.cell(x, y).gradient(x, y);
	}

	/** Slope at a point, degrees from level. */
	slope(x: number, y: number): number {
		const g = this.gradient(x, y);
		return (Math.atan(Math.hypot(g.x, g.y)) * 180) / Math.PI;
	}

	/**
	 * The lowest and highest ground and the steepest slope under a
	 * footprint, exactly: the footprint is clipped to each cell it
	 * crosses. In a cell the squared gradient is a convex function of the
	 * position, so it is largest at a corner of the clipped polygon; the
	 * elevation has no extreme inside a cell (a bilinear surface has only
	 * a saddle there), so it is extreme on the polygon's edges, where it
	 * is a quadratic in the distance along the edge.
	 */
	rangeUnder(shape: Footprint): GroundRange {
		const outline = corners(shape);
		const covered = outline.every((point) => this.covers(point.x, point.y));
		let minElevation = Number.POSITIVE_INFINITY;
		let maxElevation = Number.NEGATIVE_INFINITY;
		let steepest = 0;
		const xs = outline.map((point) => point.x);
		const ys = outline.map((point) => point.y);
		const { spacing } = this.grid;
		const i0 = this.index(Math.min(...xs), "x");
		const i1 = this.index(Math.max(...xs), "x");
		const j0 = this.index(Math.min(...ys), "y");
		const j1 = this.index(Math.max(...ys), "y");
		const pieces: { piece: Vec2[]; i: number; j: number }[] = [];
		for (let j = j0; j <= j1; j += 1) {
			for (let i = i0; i <= i1; i += 1) {
				const x0 = this.grid.origin.x + i * spacing.x;
				const y0 = this.grid.origin.y + j * spacing.y;
				const piece = clip(outline, x0, y0, x0 + spacing.x, y0 + spacing.y);
				if (piece.length > 0) pieces.push({ piece, i, j });
			}
		}
		// A cell the footprint only touches along a grid line (or grazes by
		// a rounding error: an edge at 639.9999999999999 for 640) adds
		// nothing: its piece is a sliver. A footprint of no width keeps them.
		const solid = pieces.filter(({ piece }) => !sliver(piece));
		for (const { piece, i, j } of solid.length > 0 ? solid : pieces) {
			const cell = this.cellAt(i, j);
			for (let k = 0; k < piece.length; k += 1) {
				const a = piece[k] as Vec2;
				const b = piece[(k + 1) % piece.length] as Vec2;
				const g = cell.gradient(a.x, a.y);
				steepest = Math.max(steepest, Math.hypot(g.x, g.y));
				for (const value of cell.alongEdge(a, b)) {
					minElevation = Math.min(minElevation, value);
					maxElevation = Math.max(maxElevation, value);
				}
			}
		}
		return {
			minElevation,
			maxElevation,
			maxSlope: (Math.atan(steepest) * 180) / Math.PI,
			covered,
		};
	}

	/**
	 * The plane that fits the ground under a footprint best (least
	 * squares over a 5×5 grid of points on it): its gradient.
	 */
	planeUnder(shape: Footprint): Vec2 {
		const samples: { x: number; y: number; z: number }[] = [];
		for (let a = -2; a <= 2; a += 1) {
			for (let b = -2; b <= 2; b += 1) {
				const u = (a / 2) * shape.halfX;
				const v = (b / 2) * shape.halfY;
				const x = shape.center.x + shape.axisX.x * u + shape.axisY.x * v;
				const y = shape.center.y + shape.axisX.y * u + shape.axisY.y * v;
				const z = this.elevation(x, y);
				if (Number.isFinite(z)) samples.push({ x, y, z });
			}
		}
		if (samples.length < 3)
			return this.gradient(shape.center.x, shape.center.y);
		// Normal equations for z = c + gx·(x - x̄) + gy·(y - ȳ).
		const n = samples.length;
		const mx = samples.reduce((sum, s) => sum + s.x, 0) / n;
		const my = samples.reduce((sum, s) => sum + s.y, 0) / n;
		const mz = samples.reduce((sum, s) => sum + s.z, 0) / n;
		let sxx = 0;
		let sxy = 0;
		let syy = 0;
		let sxz = 0;
		let syz = 0;
		for (const s of samples) {
			const dx = s.x - mx;
			const dy = s.y - my;
			const dz = s.z - mz;
			sxx += dx * dx;
			sxy += dx * dy;
			syy += dy * dy;
			sxz += dx * dz;
			syz += dy * dz;
		}
		const det = sxx * syy - sxy * sxy;
		if (Math.abs(det) < 1e-18) {
			return this.gradient(shape.center.x, shape.center.y);
		}
		return {
			x: (sxz * syy - syz * sxy) / det,
			y: (syz * sxx - sxz * sxy) / det,
		};
	}

	private index(value: number, axis: "x" | "y"): number {
		const last = (axis === "x" ? this.columns : this.rows) - 2;
		const k = Math.floor(
			(value - this.grid.origin[axis]) / this.grid.spacing[axis],
		);
		return Math.max(0, Math.min(last, k));
	}

	private cell(x: number, y: number): Cell {
		return this.cellAt(this.index(x, "x"), this.index(y, "y"));
	}

	private cellAt(i: number, j: number): Cell {
		const { origin, spacing, heights } = this.grid;
		const row0 = heights[j] as readonly number[];
		const row1 = heights[j + 1] as readonly number[];
		return new Cell(
			origin.x + i * spacing.x,
			origin.y + j * spacing.y,
			spacing.x,
			spacing.y,
			row0[i] as number,
			row0[i + 1] as number,
			row1[i] as number,
			row1[i + 1] as number,
		);
	}
}

/** One bilinear cell: h = a + b·u + c·v + d·u·v with u, v in [0, 1]. */
class Cell {
	private readonly a: number;
	private readonly b: number;
	private readonly c: number;
	private readonly d: number;

	constructor(
		private readonly x0: number,
		private readonly y0: number,
		private readonly dx: number,
		private readonly dy: number,
		h00: number,
		h10: number,
		h01: number,
		h11: number,
	) {
		this.a = h00;
		this.b = h10 - h00;
		this.c = h01 - h00;
		this.d = h00 - h10 - h01 + h11;
	}

	at(x: number, y: number): number {
		const u = (x - this.x0) / this.dx;
		const v = (y - this.y0) / this.dy;
		return this.a + this.b * u + this.c * v + this.d * u * v;
	}

	gradient(x: number, y: number): Vec2 {
		const u = (x - this.x0) / this.dx;
		const v = (y - this.y0) / this.dy;
		return {
			x: (this.b + this.d * v) / this.dx,
			y: (this.c + this.d * u) / this.dy,
		};
	}

	/** Elevations at the ends of a segment and at its extreme between. */
	alongEdge(p: Vec2, q: Vec2): number[] {
		const out = [this.at(p.x, p.y), this.at(q.x, q.y)];
		// h(t) = h(p) + t·(…) + t²·d·Δu·Δv: a stationary point when d·Δu·Δv ≠ 0.
		const du = (q.x - p.x) / this.dx;
		const dv = (q.y - p.y) / this.dy;
		const quadratic = this.d * du * dv;
		if (Math.abs(quadratic) > 1e-15) {
			const u = (p.x - this.x0) / this.dx;
			const v = (p.y - this.y0) / this.dy;
			const linear = this.b * du + this.c * dv + this.d * (u * dv + v * du);
			const t = -linear / (2 * quadratic);
			if (t > 0 && t < 1) {
				out.push(this.at(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t));
			}
		}
		return out;
	}
}

/** A convex polygon clipped to an axis-aligned rectangle (Sutherland–Hodgman). */
function clip(
	polygon: readonly Vec2[],
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): Vec2[] {
	let out = [...polygon];
	const planes: [(p: Vec2) => number, "x" | "y", number][] = [
		[(p) => p.x - x0, "x", x0],
		[(p) => x1 - p.x, "x", x1],
		[(p) => p.y - y0, "y", y0],
		[(p) => y1 - p.y, "y", y1],
	];
	for (const [inside, axis, value] of planes) {
		const input = out;
		out = [];
		for (let k = 0; k < input.length; k += 1) {
			const a = input[k] as Vec2;
			const b = input[(k + 1) % input.length] as Vec2;
			const da = inside(a);
			const db = inside(b);
			if (da >= 0) out.push(a);
			if (da >= 0 !== db >= 0) {
				const t = da / (da - db);
				const point = {
					x: a.x + (b.x - a.x) * t,
					y: a.y + (b.y - a.y) * t,
				};
				// Exactly on the plane, so the next cell sees the same point.
				point[axis] = value;
				out.push(point);
			}
		}
		if (out.length === 0) return out;
	}
	return out;
}

/** A grid sampled from a function, for synthetic terrain (tests, examples). */
export function sampleTerrain(
	height: (x: number, y: number) => number,
	options: {
		origin?: Vec2;
		spacing: number | Vec2;
		columns: number;
		rows: number;
		base?: number;
	},
): TerrainGrid {
	const origin = options.origin ?? { x: 0, y: 0 };
	const spacing =
		typeof options.spacing === "number"
			? { x: options.spacing, y: options.spacing }
			: options.spacing;
	const heights: number[][] = [];
	for (let j = 0; j < options.rows; j += 1) {
		const row: number[] = [];
		for (let i = 0; i < options.columns; i += 1) {
			row.push(height(origin.x + i * spacing.x, origin.y + j * spacing.y));
		}
		heights.push(row);
	}
	return { origin, spacing, heights, base: options.base ?? 0 };
}

/** The ground of a solved scene, if it has one. */
export function sceneTerrain(scene: {
	terrain?: {
		origin: [number, number];
		spacing: [number, number];
		base: number;
		heights: number[][];
	};
}): GridTerrain | undefined {
	const terrain = scene.terrain;
	if (terrain === undefined) return undefined;
	return new GridTerrain({
		origin: { x: terrain.origin[0], y: terrain.origin[1] },
		spacing: { x: terrain.spacing[0], y: terrain.spacing[1] },
		heights: terrain.heights,
		base: terrain.base,
	});
}

/**
 * Contour lines at an elevation: segments across the grid's cells
 * (marching squares; the line crosses each cell edge where the ground,
 * linear along the edge, reaches the level; a saddle is split by the
 * cell's center value, as the bilinear surface splits it).
 */
export function contourSegments(
	grid: TerrainGrid,
	level: number,
): [Vec2, Vec2][] {
	const { origin, spacing, heights } = grid;
	const out: [Vec2, Vec2][] = [];
	const rows = heights.length;
	const columns = heights[0]?.length ?? 0;
	for (let j = 0; j + 1 < rows; j += 1) {
		for (let i = 0; i + 1 < columns; i += 1) {
			const x0 = origin.x + i * spacing.x;
			const y0 = origin.y + j * spacing.y;
			const h = [
				heights[j]?.[i] as number,
				heights[j]?.[i + 1] as number,
				heights[j + 1]?.[i + 1] as number,
				heights[j + 1]?.[i] as number,
			];
			const p = [
				{ x: x0, y: y0 },
				{ x: x0 + spacing.x, y: y0 },
				{ x: x0 + spacing.x, y: y0 + spacing.y },
				{ x: x0, y: y0 + spacing.y },
			];
			const crossings: Vec2[] = [];
			for (let k = 0; k < 4; k += 1) {
				const a = h[k] as number;
				const b = h[(k + 1) % 4] as number;
				if (a >= level === b >= level) continue;
				const t = (level - a) / (b - a);
				const pa = p[k] as Vec2;
				const pb = p[(k + 1) % 4] as Vec2;
				crossings.push({
					x: pa.x + (pb.x - pa.x) * t,
					y: pa.y + (pb.y - pa.y) * t,
				});
			}
			if (crossings.length === 2) {
				out.push([crossings[0] as Vec2, crossings[1] as Vec2]);
			} else if (crossings.length === 4) {
				// A saddle: pair the crossings around the corners on the
				// center's side.
				const center = h.reduce((sum, value) => sum + value, 0) / 4;
				const [c0, c1, c2, c3] = crossings as [Vec2, Vec2, Vec2, Vec2];
				if (center >= level === (h[0] as number) >= level) {
					out.push([c0, c1], [c2, c3]);
				} else {
					out.push([c3, c0], [c1, c2]);
				}
			}
		}
	}
	return out;
}

/** Thinner than this across, a clipped piece is a sliver (metres). */
const SLIVER = 1e-6;

/** Whether a clipped piece is thinner than SLIVER along x or along y. */
function sliver(piece: readonly Vec2[]): boolean {
	const xs = piece.map((point) => point.x);
	const ys = piece.map((point) => point.y);
	return (
		Math.max(...xs) - Math.min(...xs) < SLIVER ||
		Math.max(...ys) - Math.min(...ys) < SLIVER
	);
}
