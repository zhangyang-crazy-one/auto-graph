import type { PlacedSceneObject, SceneAxis } from "../ir.js";
import type { GridTerrain } from "../terrain/index.js";

/**
 * Placeholder geometry and colors the 3D exporters share (glTF, USD):
 * boxes with their origin at the bottom center, front markers, cylinders
 * and the terrain mesh, in the scene frame (z up).
 */

export type Rgb = [number, number, number];

/** Vertices with normals and triangle indices, in a node's own frame. */
export interface Solid {
	positions: number[];
	normals: number[];
	indices: number[];
}

export const LEVEL_COLORS: Rgb[] = [
	[0.36, 0.55, 0.9],
	[0.98, 0.76, 0.22],
	[0.93, 0.45, 0.66],
	[0.52, 0.8, 0.3],
];
export const PATH_COLORS: Rgb[] = [
	[0.05, 0.58, 0.53],
	[0.76, 0.25, 0.05],
	[0.49, 0.23, 0.93],
	[0.01, 0.41, 0.63],
	[0.75, 0.07, 0.24],
];
export const COLORS = {
	front: [0.12, 0.23, 0.54],
	floor: [0.82, 0.8, 0.76],
	ground: [0.42, 0.56, 0.32],
	opening: [0.05, 0.58, 0.53],
	line: [0.39, 0.45, 0.55],
	waypoint: [0.49, 0.23, 0.93],
	landmark: [0.71, 0.33, 0.04],
} satisfies Record<string, Rgb>;

const FRONT_ANGLE: Record<SceneAxis, number> = {
	"+x": 0,
	"+y": 90,
	"-x": 180,
	"-y": -90,
};

/** How many objects down to the floor (0 on the floor). */
export function levelOf(
	item: PlacedSceneObject,
	byId: ReadonlyMap<string, PlacedSceneObject>,
): number {
	let level = 0;
	const seen = new Set<string>();
	let at = item.supportedBy;
	while (at !== undefined && !seen.has(at)) {
		seen.add(at);
		level += 1;
		at = byId.get(at)?.supportedBy;
	}
	return level;
}

/**
 * The ground: each grid cell cut into k × k quads (k up to 4, fewer on a
 * large grid) on the bilinear surface, relative to the south-west sample.
 */
export function terrainSolid(ground: GridTerrain): {
	solid: Solid;
	subdivision: number;
} {
	const { origin, spacing } = ground.grid;
	const cells = (ground.rows - 1) * (ground.columns - 1);
	const k = Math.max(1, Math.min(4, Math.floor(Math.sqrt(200_000 / cells))));
	const nx = (ground.columns - 1) * k + 1;
	const ny = (ground.rows - 1) * k + 1;
	const dx = spacing.x / k;
	const dy = spacing.y / k;
	const solid: Solid = { positions: [], normals: [], indices: [] };
	const at = (i: number, j: number) =>
		ground.heightNear(origin.x + i * dx, origin.y + j * dy);
	for (let j = 0; j < ny; j += 1) {
		for (let i = 0; i < nx; i += 1) {
			solid.positions.push(i * dx, j * dy, at(i, j));
			// The normal from the neighbouring vertices (one-sided at the edge).
			const gx =
				(at(Math.min(nx - 1, i + 1), j) - at(Math.max(0, i - 1), j)) /
				((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) * dx);
			const gy =
				(at(i, Math.min(ny - 1, j + 1)) - at(i, Math.max(0, j - 1))) /
				((Math.min(ny - 1, j + 1) - Math.max(0, j - 1)) * dy);
			const length = Math.hypot(gx, gy, 1);
			solid.normals.push(-gx / length, -gy / length, 1 / length);
		}
	}
	for (let j = 0; j < ny - 1; j += 1) {
		for (let i = 0; i < nx - 1; i += 1) {
			const a = j * nx + i;
			const b = a + 1;
			const c = a + nx + 1;
			const e = a + nx;
			solid.indices.push(a, b, c, a, c, e);
		}
	}
	return { solid, subdivision: k };
}

/** A box with its origin at the bottom center. */
export function box(width: number, depth: number, height: number): Solid {
	const hx = width / 2;
	const hy = depth / 2;
	const solid: Solid = { positions: [], normals: [], indices: [] };
	// Each face: its normal and four corners counter-clockwise from outside.
	const faces: [Rgb, Rgb[]][] = [
		[
			[0, 0, -1],
			[
				[-hx, -hy, 0],
				[-hx, hy, 0],
				[hx, hy, 0],
				[hx, -hy, 0],
			],
		],
		[
			[0, 0, 1],
			[
				[-hx, -hy, height],
				[hx, -hy, height],
				[hx, hy, height],
				[-hx, hy, height],
			],
		],
		[
			[0, -1, 0],
			[
				[-hx, -hy, 0],
				[hx, -hy, 0],
				[hx, -hy, height],
				[-hx, -hy, height],
			],
		],
		[
			[1, 0, 0],
			[
				[hx, -hy, 0],
				[hx, hy, 0],
				[hx, hy, height],
				[hx, -hy, height],
			],
		],
		[
			[0, 1, 0],
			[
				[hx, hy, 0],
				[-hx, hy, 0],
				[-hx, hy, height],
				[hx, hy, height],
			],
		],
		[
			[-1, 0, 0],
			[
				[-hx, hy, 0],
				[-hx, -hy, 0],
				[-hx, -hy, height],
				[-hx, hy, height],
			],
		],
	];
	for (const [normal, corners] of faces) {
		const base = solid.positions.length / 3;
		for (const corner of corners) {
			solid.positions.push(...corner);
			solid.normals.push(...normal);
		}
		solid.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}
	return solid;
}

/** A flat triangle on the top face, pointing out of the front side. */
export function frontMarker(
	width: number,
	depth: number,
	height: number,
	front: SceneAxis,
): Solid {
	const angle = (FRONT_ANGLE[front] * Math.PI) / 180;
	const fx = Math.round(Math.cos(angle));
	const fy = Math.round(Math.sin(angle));
	const reach = Math.abs(fx) * (width / 2) + Math.abs(fy) * (depth / 2);
	const size = Math.max(0.04, Math.min(width, depth) * 0.25);
	const back = [fx * (reach - size), fy * (reach - size)] as const;
	const side = [-fy * size * 0.6, fx * size * 0.6] as const;
	const z = height + 0.002;
	return {
		// Tip, then the two back corners counter-clockwise seen from above.
		positions: [
			fx * reach,
			fy * reach,
			z,
			back[0] + side[0],
			back[1] + side[1],
			z,
			back[0] - side[0],
			back[1] - side[1],
			z,
		],
		normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
		indices: [0, 1, 2],
	};
}

/** An upright cylinder with its origin at the bottom center. */
export function cylinder(radius: number, height: number, sides: number): Solid {
	const solid: Solid = { positions: [], normals: [], indices: [] };
	const ring = (k: number) => {
		const a = (2 * Math.PI * k) / sides;
		return [Math.cos(a), Math.sin(a)] as const;
	};
	// The side: a bottom and a top vertex per corner, normals outward.
	for (let k = 0; k <= sides; k += 1) {
		const [c, s] = ring(k % sides);
		solid.positions.push(
			radius * c,
			radius * s,
			0,
			radius * c,
			radius * s,
			height,
		);
		solid.normals.push(c, s, 0, c, s, 0);
	}
	for (let k = 0; k < sides; k += 1) {
		const a = 2 * k;
		solid.indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
	}
	// The caps: a center and a ring each.
	for (const [z, up] of [
		[0, -1],
		[height, 1],
	] as const) {
		const center = solid.positions.length / 3;
		solid.positions.push(0, 0, z);
		solid.normals.push(0, 0, up);
		for (let k = 0; k < sides; k += 1) {
			const [c, s] = ring(k);
			solid.positions.push(radius * c, radius * s, z);
			solid.normals.push(0, 0, up);
		}
		for (let k = 0; k < sides; k += 1) {
			const a = center + 1 + k;
			const b = center + 1 + ((k + 1) % sides);
			solid.indices.push(...(up > 0 ? [center, a, b] : [center, b, a]));
		}
	}
	return solid;
}

export function colorOf(name: string): Rgb {
	if (name.startsWith("level.")) {
		return LEVEL_COLORS[Number(name.slice(6))] as Rgb;
	}
	if (name.startsWith("path."))
		return PATH_COLORS[Number(name.slice(5))] as Rgb;
	return COLORS[name as keyof typeof COLORS];
}
