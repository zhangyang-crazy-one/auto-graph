import type { PlacedSceneObject, SceneAxis, SolvedScene } from "../ir.js";
import { type GridTerrain, sceneTerrain } from "../terrain/index.js";
import { agentTracks, onGround, pathLines } from "./tracks.js";

/**
 * glTF 2.0 export of a solved scene: a `.gltf` (JSON, its buffer inlined
 * as a data URI) or a `.glb` (one binary file).
 *
 * glTF is y-up, the scene z-up: every point (x, y, z) is written as
 * (x, z, -y) and every rotation [x, y, z, w] as [x, z, -y, w], so an
 * object's translation is its `position` and its rotation its
 * `quaternion` in glTF's axes. Importers that convert y-up back to z-up
 * (Blender's does) give the scene's numbers again, rotations included.
 *
 * Each object is a box with its origin at the bottom center and a flat
 * triangle on top marking its front, colored by how high it stacks (as
 * the Blender script does). Its id, front, size, support, asset, group,
 * label and WGS84 position are in the node's `extras` as `dge_*` keys,
 * which importers keep as custom properties; an `asset` is a name to swap
 * the placeholder box for (the box's origin is the asset's bottom center
 * and its front the declared `front`).
 *
 * The floor is a 5 cm slab with its top at z = 0, or on terrain the
 * ground: each grid cell cut into k × k quads on the bilinear surface.
 * Openings are strips across the wall line; paths, lines and waypoint
 * flight lines are line strips (on terrain along the ground between
 * corners); waypoints are also points; landmarks are pins. Each path's
 * agent is a cylinder animated along it: one animation, `agents`, with a
 * key every 0.1 s and at every corner, its time 0 when the first agent
 * sets off (`dge_time_origin` on the root gives that in scene seconds).
 */
export function sceneToGltf(scene: SolvedScene): string {
	const { json, bin } = buildGltf(scene);
	json.buffers = [
		{
			byteLength: bin.length,
			uri: `data:application/octet-stream;base64,${base64(bin)}`,
		},
	];
	return `${JSON.stringify(json)}\n`;
}

/** The solved scene as one binary glTF (`.glb`) file. */
export function sceneToGlb(scene: SolvedScene): Uint8Array {
	const { json, bin } = buildGltf(scene);
	json.buffers = [{ byteLength: bin.length }];
	const text = new TextEncoder().encode(JSON.stringify(json));
	const jsonLength = pad4(text.length);
	const binLength = pad4(bin.length);
	const total = 12 + 8 + jsonLength + 8 + binLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x46546c67, true); // "glTF"
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonLength, true);
	view.setUint32(16, 0x4e4f534a, true); // "JSON"
	out.set(text, 20);
	// The JSON chunk is padded with spaces, the binary one with zeros.
	out.fill(0x20, 20 + text.length, 20 + jsonLength);
	const at = 20 + jsonLength;
	view.setUint32(at, binLength, true);
	view.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
	out.set(bin, at + 8);
	return out;
}

const LEVEL_COLORS: Rgb[] = [
	[0.36, 0.55, 0.9],
	[0.98, 0.76, 0.22],
	[0.93, 0.45, 0.66],
	[0.52, 0.8, 0.3],
];
const PATH_COLORS: Rgb[] = [
	[0.05, 0.58, 0.53],
	[0.76, 0.25, 0.05],
	[0.49, 0.23, 0.93],
	[0.01, 0.41, 0.63],
	[0.75, 0.07, 0.24],
];
const COLORS = {
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

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const POINTS = 0;
const LINE_STRIP = 3;

type Rgb = [number, number, number];
type Json = Record<string, unknown>;

/** Vertices with normals and triangle indices, in a node's own frame. */
interface Solid {
	positions: number[];
	normals: number[];
	indices: number[];
}

interface Gltf {
	json: Json;
	bin: Uint8Array;
}

function buildGltf(scene: SolvedScene): Gltf {
	const out = new Writer();
	const ground = sceneTerrain(scene);
	const { width, depth } = scene.bounds;
	const span = Math.max(width, depth);
	const children: number[] = [];

	if (ground === undefined) {
		const mesh = out.solidMesh("floor", box(width, depth, 0.05), "floor");
		children.push(
			out.node({
				name: "floor",
				mesh,
				translation: [width / 2, depth / 2, -0.05],
			}),
		);
	} else {
		children.push(terrainNode(out, ground));
	}

	const byId = new Map(scene.objects.map((item) => [item.id, item]));
	for (const item of scene.objects) children.push(objectNode(out, item, byId));

	for (const opening of scene.openings) {
		const along = opening.wall === "south" || opening.wall === "north";
		const center: [number, number, number] = along
			? [opening.at, opening.wall === "south" ? 0 : depth, 0]
			: [opening.wall === "west" ? 0 : width, opening.at, 0];
		const size = along ? [opening.width, 0.12] : [0.12, opening.width];
		const mesh = out.solidMesh(
			`opening.${opening.id}`,
			box(size[0] as number, size[1] as number, 0.01),
			"opening",
		);
		children.push(
			out.node({
				name: `opening.${opening.id}`,
				mesh,
				translation: center,
				extras: { dge_opening: opening.id, dge_wall: opening.wall },
			}),
		);
	}

	const lines = pathLines(scene, ground);
	scene.paths.forEach((path, k) => {
		const color = `path.${k % PATH_COLORS.length}`;
		const node = polylineNode(
			out,
			`path.${path.id}`,
			lines[path.id] ?? [],
			color,
			{
				dge_path: path.id,
			},
		);
		if (node !== undefined) children.push(node);
	});
	children.push(...agentNodes(out, scene, ground));

	for (const landmark of scene.landmarks ?? []) {
		const [x, y] = landmark.position;
		const z = ground === undefined ? 0 : ground.heightNear(x, y);
		const radius = Math.max(0.03, span * 0.004);
		const height = Math.max(0.4, span * 0.03);
		const mesh = out.solidMesh(
			`landmark.${landmark.id}`,
			cylinder(radius, height, 12),
			"landmark",
		);
		children.push(
			out.node({
				name: `landmark.${landmark.id}`,
				mesh,
				translation: [x, y, z],
				extras: {
					dge_landmark: landmark.id,
					dge_geo: [landmark.geo.lat, landmark.geo.lon, landmark.geo.alt],
				},
			}),
		);
	}

	for (const line of scene.lines ?? []) {
		const node = polylineNode(
			out,
			`line.${line.id}`,
			onGround(line.points, ground),
			"line",
			{ dge_line: line.id },
		);
		if (node !== undefined) children.push(node);
	}

	for (const item of scene.waypoints ?? []) {
		const node = polylineNode(
			out,
			`waypoints.${item.id}`,
			item.points,
			"waypoint",
			{
				dge_waypoints: item.id,
				dge_height: item.height,
			},
			true,
		);
		if (node !== undefined) children.push(node);
	}

	const rootExtras: Json = {
		dge_format: "dge-scene",
		dge_version: 1,
		dge_valid: scene.valid,
	};
	if (scene.geo !== undefined) {
		const { origin } = scene.geo;
		rootExtras.dge_geo_origin = [origin.lat, origin.lon, origin.alt];
		rootExtras.dge_geo_heading = scene.geo.heading;
	}
	if (out.timeOrigin !== undefined) rootExtras.dge_time_origin = out.timeOrigin;
	const root = out.node({
		name: `DGE ${scene.name}`,
		children,
		extras: rootExtras,
	});
	return out.finish(root);
}

function objectNode(
	out: Writer,
	item: PlacedSceneObject,
	byId: ReadonlyMap<string, PlacedSceneObject>,
): number {
	const level = levelOf(item, byId);
	const [w, d, h] = item.size;
	const key = `${w},${d},${h},${item.front},${level % LEVEL_COLORS.length}`;
	const mesh = out.cached(key, () =>
		out.mesh(`box.${item.id}`, [
			out.solidPrimitive(box(w, d, h), `level.${level % LEVEL_COLORS.length}`),
			out.solidPrimitive(frontMarker(w, d, h, item.front), "front"),
		]),
	);
	const extras: Json = {
		dge_id: item.id,
		dge_front: item.front,
		dge_size: item.size,
	};
	if (item.supportedBy !== undefined)
		extras.dge_supported_by = item.supportedBy;
	if (item.asset !== undefined) extras.dge_asset = item.asset;
	if (item.group !== undefined) extras.dge_group = item.group;
	if (item.label !== undefined) extras.dge_label = item.label;
	if (item.geo !== undefined) {
		extras.dge_geo = [item.geo.lat, item.geo.lon, item.geo.alt];
	}
	const [qx, qy, qz, qw] = item.quaternion;
	const norm = Math.hypot(qx, qy, qz, qw);
	return out.node({
		name: item.id,
		mesh,
		translation: item.position,
		rotation: [qx / norm, qy / norm, qz / norm, qw / norm],
		extras,
	});
}

/** How many objects down to the floor (0 on the floor). */
function levelOf(
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
function terrainNode(out: Writer, ground: GridTerrain): number {
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
	const mesh = out.solidMesh("terrain", solid, "ground");
	return out.node({
		name: "terrain",
		mesh,
		translation: [origin.x, origin.y, 0],
		extras: { dge_terrain_subdivision: k },
	});
}

/**
 * A line strip through `points`, its node at the first point (so the
 * vertices stay small on a large site). With `markers`, also a point at
 * each vertex.
 */
function polylineNode(
	out: Writer,
	name: string,
	points: readonly (readonly number[])[],
	material: string,
	extras: Json,
	markers = false,
): number | undefined {
	if (points.length < 2) return undefined;
	const [ox, oy, oz] = points[0] as [number, number, number];
	const positions = points.flatMap(([x, y, z]) => [
		(x as number) - ox,
		(y as number) - oy,
		(z as number) - oz,
	]);
	const position = out.vec3(positions);
	const primitives: Json[] = [
		{
			attributes: { POSITION: position },
			mode: LINE_STRIP,
			material: out.material(material),
		},
	];
	if (markers) {
		primitives.push({
			attributes: { POSITION: position },
			mode: POINTS,
			material: out.material(material),
		});
	}
	return out.node({
		name,
		mesh: out.mesh(name, primitives),
		translation: [ox, oy, oz],
		extras,
	});
}

/** Each path's agent, a cylinder keyed along its track. */
function agentNodes(
	out: Writer,
	scene: SolvedScene,
	ground: GridTerrain | undefined,
): number[] {
	const tracks = agentTracks(scene, ground);
	const keyed = scene.paths.filter(
		(path) => (tracks[path.id]?.length ?? 0) > 0,
	);
	if (keyed.length === 0) return [];
	const origin = Math.min(
		...keyed.map((path) => tracks[path.id]?.[0]?.[0] ?? 0),
	);
	out.timeOrigin = origin;
	const nodes: number[] = [];
	for (const path of keyed) {
		const agent = scene.agents.find((item) => item.id === path.agent);
		const track = tracks[path.id] as number[][];
		if (agent === undefined) continue;
		const k = scene.paths.indexOf(path);
		const mesh = out.cached(
			`agent:${agent.radius},${agent.height},${k % PATH_COLORS.length}`,
			() =>
				out.solidMesh(
					`agent.${agent.id}`,
					cylinder(agent.radius, agent.height, 24),
					`path.${k % PATH_COLORS.length}`,
				),
		);
		const first = track[0] as number[];
		const node = out.node({
			name: `agent.${path.id}`,
			mesh,
			translation: first.slice(1),
			extras: { dge_path: path.id, dge_agent: agent.id },
		});
		// Times as float32 must keep increasing; drop a key that would not.
		const times: number[] = [];
		const positions: number[] = [];
		for (const [t, x, y, z] of track) {
			const time = Math.fround((t as number) - origin);
			if (times.length > 0 && time <= (times.at(-1) as number)) continue;
			times.push(time);
			positions.push(x as number, y as number, z as number);
		}
		out.animate(node, times, positions);
		nodes.push(node);
	}
	return nodes;
}

/** A box with its origin at the bottom center. */
function box(width: number, depth: number, height: number): Solid {
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
function frontMarker(
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
function cylinder(radius: number, height: number, sides: number): Solid {
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

/** Collects the glTF JSON and its binary buffer. */
class Writer {
	readonly nodes: Json[] = [];
	readonly meshes: Json[] = [];
	readonly accessors: Json[] = [];
	readonly bufferViews: Json[] = [];
	readonly materials: Json[] = [];
	readonly channels: Json[] = [];
	readonly samplers: Json[] = [];
	timeOrigin: number | undefined;
	private readonly materialIndex = new Map<string, number>();
	private readonly cache = new Map<string, number>();
	private readonly chunks: Uint8Array[] = [];
	private length = 0;

	cached(key: string, make: () => number): number {
		let index = this.cache.get(key);
		if (index === undefined) {
			index = make();
			this.cache.set(key, index);
		}
		return index;
	}

	material(name: string): number {
		let index = this.materialIndex.get(name);
		if (index === undefined) {
			index = this.materials.length;
			this.materials.push({
				name: `dge.${name}`,
				pbrMetallicRoughness: {
					baseColorFactor: [...colorOf(name), 1],
					metallicFactor: 0,
					roughnessFactor: 0.8,
				},
			});
			this.materialIndex.set(name, index);
		}
		return index;
	}

	/** A node, its translation and rotation given in the scene frame. */
	node(node: Json): number {
		const { translation, rotation } = node as {
			translation?: number[];
			rotation?: number[];
		};
		if (translation !== undefined) node.translation = yUp(translation);
		if (rotation !== undefined) {
			// The same turn about the y-up axes: [x, z, -y, w].
			const [x, y, z, w] = rotation as [number, number, number, number];
			node.rotation = [x, z, zero(-y), w];
		}
		this.nodes.push(node);
		return this.nodes.length - 1;
	}

	mesh(name: string, primitives: Json[]): number {
		this.meshes.push({ name, primitives });
		return this.meshes.length - 1;
	}

	solidMesh(name: string, solid: Solid, material: string): number {
		return this.mesh(name, [this.solidPrimitive(solid, material)]);
	}

	solidPrimitive(solid: Solid, material: string): Json {
		const count = solid.positions.length / 3;
		return {
			attributes: {
				POSITION: this.vec3(solid.positions),
				NORMAL: this.vec3(solid.normals, false),
			},
			indices: this.indices(solid.indices, count),
			material: this.material(material),
		};
	}

	/**
	 * A float VEC3 vertex accessor from scene-frame values (with its
	 * bounds, for positions).
	 */
	vec3(values: number[], bounds = true): number {
		const data = new Float32Array(yUp(values));
		const accessor: Json = {
			bufferView: this.view(new Uint8Array(data.buffer), ARRAY_BUFFER),
			componentType: FLOAT,
			count: values.length / 3,
			type: "VEC3",
		};
		if (bounds) Object.assign(accessor, extent(data, 3));
		return this.accessor(accessor);
	}

	/** Triangle indices, 16-bit while they fit. */
	indices(values: number[], vertices: number): number {
		const small = vertices < 0xffff;
		const data = small ? new Uint16Array(values) : new Uint32Array(values);
		return this.accessor({
			bufferView: this.view(new Uint8Array(data.buffer), ELEMENT_ARRAY_BUFFER),
			componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT,
			count: values.length,
			type: "SCALAR",
		});
	}

	/** A linear translation track for a node: times (seconds) and positions. */
	animate(node: number, times: number[], positions: number[]): void {
		const input = new Float32Array(times);
		const output = new Float32Array(yUp(positions));
		const sampler = this.samplers.length;
		this.samplers.push({
			input: this.accessor({
				bufferView: this.view(new Uint8Array(input.buffer)),
				componentType: FLOAT,
				count: times.length,
				type: "SCALAR",
				...extent(input, 1),
			}),
			output: this.accessor({
				bufferView: this.view(new Uint8Array(output.buffer)),
				componentType: FLOAT,
				count: times.length,
				type: "VEC3",
			}),
			interpolation: "LINEAR",
		});
		this.channels.push({ sampler, target: { node, path: "translation" } });
	}

	finish(root: number): Gltf {
		const json: Json = {
			asset: { version: "2.0", generator: "auto-graph (dge-scene v1)" },
			scene: 0,
			scenes: [{ name: "dge", nodes: [root] }],
			nodes: this.nodes,
			meshes: this.meshes,
			materials: this.materials,
		};
		if (this.channels.length > 0) {
			json.animations = [
				{ name: "agents", channels: this.channels, samplers: this.samplers },
			];
		}
		json.accessors = this.accessors;
		json.bufferViews = this.bufferViews;
		const bin = new Uint8Array(this.length);
		let at = 0;
		for (const chunk of this.chunks) {
			bin.set(chunk, at);
			at += chunk.length;
		}
		return { json, bin };
	}

	private accessor(accessor: Json): number {
		this.accessors.push(accessor);
		return this.accessors.length - 1;
	}

	/** A buffer view on `bytes`, starting on a 4-byte boundary. */
	private view(bytes: Uint8Array, target?: number): number {
		const offset = this.length;
		this.chunks.push(bytes);
		this.length += bytes.length;
		const gap = pad4(this.length) - this.length;
		if (gap > 0) {
			this.chunks.push(new Uint8Array(gap));
			this.length += gap;
		}
		this.bufferViews.push({
			buffer: 0,
			byteOffset: offset,
			byteLength: bytes.length,
			...(target === undefined ? {} : { target }),
		});
		return this.bufferViews.length - 1;
	}
}

/** Scene-frame (z-up) triples as glTF's y-up: (x, y, z) to (x, z, -y). */
function yUp(values: readonly number[]): number[] {
	const out = new Array<number>(values.length);
	for (let k = 0; k < values.length; k += 3) {
		out[k] = values[k] as number;
		out[k + 1] = values[k + 2] as number;
		out[k + 2] = zero(-(values[k + 1] as number));
	}
	return out;
}

function zero(value: number): number {
	return Object.is(value, -0) ? 0 : value;
}

function colorOf(name: string): Rgb {
	if (name.startsWith("level.")) {
		return LEVEL_COLORS[Number(name.slice(6))] as Rgb;
	}
	if (name.startsWith("path."))
		return PATH_COLORS[Number(name.slice(5))] as Rgb;
	return COLORS[name as keyof typeof COLORS];
}

/** Per-component min and max of float32 data (exact float32 values). */
function extent(
	data: Float32Array,
	size: number,
): { min: number[]; max: number[] } {
	const min = Array.from({ length: size }, () => Number.POSITIVE_INFINITY);
	const max = Array.from({ length: size }, () => Number.NEGATIVE_INFINITY);
	for (let k = 0; k < data.length; k += 1) {
		const value = data[k] as number;
		const c = k % size;
		if (value < (min[c] as number)) min[c] = value;
		if (value > (max[c] as number)) max[c] = value;
	}
	return { min, max };
}

function pad4(length: number): number {
	return Math.ceil(length / 4) * 4;
}

const BASE64 =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
	const parts: string[] = [];
	for (let k = 0; k < bytes.length; k += 3) {
		const a = bytes[k] as number;
		const b = bytes[k + 1];
		const c = bytes[k + 2];
		const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
		parts.push(
			(BASE64[(n >> 18) & 63] as string) +
				(BASE64[(n >> 12) & 63] as string) +
				(b === undefined ? "=" : (BASE64[(n >> 6) & 63] as string)) +
				(c === undefined ? "=" : (BASE64[n & 63] as string)),
		);
	}
	return parts.join("");
}
