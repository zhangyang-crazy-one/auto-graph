import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	parseSceneDsl,
	type SceneSpec,
	type SolvedScene,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";
import { corners, footprint } from "../src/scene/geometry.js";
import { sceneSource } from "./support/scene-files.js";
import { mulberry32 } from "./support/synthetic.js";

function parse(value: Record<string, unknown>) {
	return normalizeSceneDsl({
		scene: "t",
		bounds: { width: 4, depth: 4, height: 2.5 },
		...value,
	});
}

function solve(value: Record<string, unknown>): SolvedScene {
	const result = parse(value);
	expect(result.diagnostics).toEqual([]);
	return solveScene(result.scene as SceneSpec);
}

/**
 * Independent of the planner: walk every path in 1 cm steps and measure
 * the distance from each step to every object footprint that is in the
 * agent's way and to the walls.
 */
function clearanceFaults(scene: SolvedScene, spec: SceneSpec): string[] {
	const faults: string[] = [];
	for (const path of scene.paths) {
		const agent = spec.agents.find((item) => item.id === path.agent);
		const want = spec.paths.find((item) => item.id === path.id);
		if (agent === undefined || want === undefined) continue;
		const need = agent.radius + want.clearance - 1e-3;
		const shapes = scene.objects
			.filter((object) => object.position[2] < agent.height)
			.map((object) => ({
				id: object.id,
				polygon: corners(
					footprint(
						{ x: object.position[0], y: object.position[1] },
						object.size,
						object.yaw,
					),
				),
			}));
		for (let k = 0; k + 1 < path.points.length; k += 1) {
			const [ax = 0, ay = 0] = path.points[k] ?? [];
			const [bx = 0, by = 0] = path.points[k + 1] ?? [];
			const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.01));
			for (let s = 0; s <= steps; s += 1) {
				const x = ax + ((bx - ax) * s) / steps;
				const y = ay + ((by - ay) * s) / steps;
				const walls = Math.min(
					x,
					y,
					scene.bounds.width - x,
					scene.bounds.depth - y,
				);
				if (walls < need)
					faults.push(`${path.id}: ${walls} from a wall at ${x},${y}`);
				for (const shape of shapes) {
					const gap = pointPolygon({ x, y }, shape.polygon);
					if (gap < need) {
						faults.push(`${path.id}: ${gap} from ${shape.id} at ${x},${y}`);
					}
				}
			}
		}
	}
	return faults;
}

function pointPolygon(
	p: { x: number; y: number },
	polygon: readonly { x: number; y: number }[],
): number {
	let inside = true;
	let best = Number.POSITIVE_INFINITY;
	for (let k = 0; k < polygon.length; k += 1) {
		const a = polygon[k] as { x: number; y: number };
		const b = polygon[(k + 1) % polygon.length] as { x: number; y: number };
		const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		if (cross < 0) inside = false;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const t = Math.max(
			0,
			Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)),
		);
		best = Math.min(
			best,
			Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)),
		);
	}
	return inside ? 0 : best;
}

describe("scene path DSL", () => {
	it("reads openings, agents and paths in document units", () => {
		const result = parse({
			units: "cm",
			bounds: { width: 400, depth: 400 },
			openings: { door: { wall: "south", at: 60, width: 90 } },
			agents: { robot: { radius: 18, height: 10 } },
			objects: { desk: { size: [140, 70, 75] }, bin: { size: [30, 30, 40] } },
			paths: [
				"person from door to desk",
				"robot from desk to door, via bin, clearance 5, orthogonal",
				"person from door to desk, comfort 0",
			],
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.scene?.openings).toEqual([
			{
				id: "door",
				wall: "south",
				at: 0.6,
				width: 0.9,
				path: ["openings", "door"],
			},
		]);
		expect(
			result.scene?.agents.map(({ path: _path, ...agent }) => agent),
		).toEqual([
			{ id: "person", radius: 0.25, height: 1.8 },
			{ id: "robot", radius: 0.18, height: 0.1 },
		]);
		expect(result.scene?.paths.map(({ path: _path, ...rest }) => rest)).toEqual(
			[
				{
					id: "person:door->desk",
					agent: "person",
					from: "door",
					to: "desk",
					via: [],
					clearance: 0,
					orthogonal: false,
					comfort: 0.15,
				},
				{
					id: "robot:desk->door",
					agent: "robot",
					from: "desk",
					to: "door",
					via: ["bin"],
					clearance: 0.05,
					orthogonal: true,
					comfort: 0.15,
				},
				{
					id: "person:door->desk#2",
					agent: "person",
					from: "door",
					to: "desk",
					via: [],
					clearance: 0,
					orthogonal: false,
					comfort: 0,
				},
			],
		);
	});

	it("lets a scene declare its own person", () => {
		const result = parse({
			objects: { a: { size: [1, 1, 1] } },
			agents: { person: { radius: 0.3, height: 1.7 } },
		});
		expect(result.scene?.agents[0]).toMatchObject({
			id: "person",
			radius: 0.3,
			height: 1.7,
		});
	});

	it.each([
		[
			{ paths: ["persn from door to desk"] },
			"validate.scene.unknown-agent",
			'"person"',
		],
		[
			{ paths: ["person from door to dsk"] },
			"validate.scene.unknown-place",
			'"desk"',
		],
		[
			{ paths: ["person from door to seat"] },
			"validate.scene.group-reference",
			"seat1",
		],
		[{ paths: ["person to desk"] }, "validate.scene.path-syntax", undefined],
		[
			{ paths: ["person from desk to desk"] },
			"validate.scene.path-syntax",
			undefined,
		],
		[
			{ paths: ["person from door to desk, fast"] },
			"validate.scene.path-syntax",
			undefined,
		],
		[
			{ paths: ["person from door to desk, orthogonal, orthogonal"] },
			"validate.scene.path-syntax",
			undefined,
		],
		[
			{ paths: [`person from door to desk, clearance ${"9".repeat(309)}`] },
			"validate.scene.relation-value",
			undefined,
		],
		[
			{ openings: { door: { wall: "south", at: 3.8, width: 0.9 } } },
			"validate.scene.opening-outside",
			undefined,
		],
		[
			{ openings: { desk: { wall: "south", at: 1, width: 0.9 } } },
			"validate.scene.duplicate-id",
			undefined,
		],
	])("rejects %j", (extra, code, hint) => {
		const result = parse({
			openings: { door: { wall: "south", at: 0.6, width: 0.9 } },
			objects: {
				desk: { size: [1, 1, 1] },
				seat: { size: [0.4, 0.4, 0.4], count: 2 },
			},
			...extra,
		});
		expect(result.scene).toBeUndefined();
		expect(result.diagnostics[0]?.code).toBe(code);
		if (hint !== undefined) expect(result.diagnostics[0]?.hint).toContain(hint);
	});
});

describe("scene paths", () => {
	const studyPaths = () => {
		const parsed = parseSceneDsl(sceneSource("study-paths"));
		expect(parsed.diagnostics).toEqual([]);
		const spec = parsed.scene as SceneSpec;
		return { spec, scene: solveScene(spec) };
	};

	it("plans every path in the study clear of everything", () => {
		const { spec, scene } = studyPaths();
		expect(scene.valid).toBe(true);
		expect(scene.paths.map((path) => path.id)).toEqual([
			"person:door->desk",
			"person:door->shelf",
			"robot:door->shelf",
		]);
		expect(clearanceFaults(scene, spec)).toEqual([]);
		for (const path of scene.paths) {
			expect(path.points[0]?.[0]).toBeCloseTo(0.6, 6);
			expect(path.clearance).toBeGreaterThanOrEqual(
				spec.paths.find((item) => item.id === path.id)?.clearance ?? 0,
			);
		}
	});

	it("reaches an object from a free side when its front is taken", () => {
		const { scene } = studyPaths();
		const desk = scene.objects.find((object) => object.id === "desk");
		// The chair stands at the desk's front, so the person comes up on its
		// west side.
		const end = scene.paths[0]?.points.at(-1) ?? [];
		expect(end[0]).toBeLessThan(desk?.aabb.min[0] ?? 0);
		expect(end[1]).toBeCloseTo(desk?.position[1] ?? 0, 6);
		// The shelf's front is too close to seat2: reached from its south end.
		const shelf = scene.objects.find((object) => object.id === "shelf");
		expect(scene.paths[1]?.points.at(-1)?.[1]).toBeLessThan(
			shelf?.aabb.min[1] ?? 0,
		);
	});

	it("turns only at right angles when orthogonal", () => {
		const robot = studyPaths().scene.paths[2];
		const points = robot?.points ?? [];
		for (let k = 0; k + 1 < points.length; k += 1) {
			const [ax, ay] = points[k] ?? [];
			const [bx, by] = points[k + 1] ?? [];
			expect(ax === bx || ay === by).toBe(true);
		}
	});

	it("draws paths and openings in the top view", () => {
		const svg = sceneTopViewSvg(studyPaths().scene);
		const golden = new URL(
			"./fixtures/scene/study-paths.top.svg",
			import.meta.url,
		);
		if (process.env.UPDATE_SCENE_GOLDEN === "1") writeFileSync(golden, svg);
		expect(svg).toBe(readFileSync(golden, "utf8"));
	});

	it("is deterministic", () => {
		expect(JSON.stringify(studyPaths().scene)).toBe(
			JSON.stringify(studyPaths().scene),
		);
	});

	it("names the bottleneck and how much width is missing", () => {
		const scene = solve({
			openings: { door: { wall: "south", at: 0.5, width: 0.9 } },
			objects: {
				desk: { size: [1.2, 0.6, 0.75], position: [2, 3.6] },
				cabinet: { size: [3.6, 0.5, 2], position: [2.2, 2] },
			},
			paths: ["person from door to desk"],
		});
		expect(scene.valid).toBe(false);
		expect(scene.paths).toEqual([]);
		expect(scene.diagnostics[0]).toMatchObject({
			code: "scene.path.blocked",
			objects: ["cabinet"],
			path: ["paths", 0],
			detail: { width: 0.4, needs: 0.5 },
		});
		expect(scene.diagnostics[0]?.message).toContain("the west wall");
	});

	it("passes under things above the agent", () => {
		// A top spanning the room on a slim pedestal: a person cannot get
		// past it, a 10 cm robot goes under it and only skirts the pedestal.
		const scene = solve({
			openings: { door: { wall: "south", at: 0.5, width: 0.9 } },
			agents: { robot: { radius: 0.15, height: 0.1 } },
			objects: {
				desk: { size: [1.2, 0.6, 0.75], position: [2, 3.6] },
				pedestal: { size: [0.2, 0.2, 0.7], position: [2, 2] },
				top: { size: [4, 0.5, 0.05] },
			},
			relations: ["top on pedestal"],
			paths: ["person from door to desk", "robot from door to desk"],
		});
		expect(scene.paths.map((path) => path.id)).toEqual(["robot:door->desk"]);
		expect(
			scene.diagnostics
				.filter((diagnostic) => diagnostic.code === "scene.path.blocked")
				.map((diagnostic) => diagnostic.path),
		).toEqual([["paths", 0]]);
	});

	it("reports an opening narrower than the agent and a shut-in end", () => {
		const narrow = solve({
			openings: { hatch: { wall: "south", at: 1, width: 0.4 } },
			objects: { desk: { size: [1, 0.6, 0.75], position: [2, 3] } },
			paths: ["person from hatch to desk"],
		});
		expect(narrow.diagnostics[0]).toMatchObject({
			code: "scene.path.opening-narrow",
			detail: { width: 0.4, needs: 0.5 },
		});
		const shut = solve({
			openings: { door: { wall: "south", at: 0.5, width: 0.9 } },
			objects: {
				desk: { size: [1, 0.6, 0.75], position: [2, 2] },
				a: { size: [2.4, 0.3, 1], position: [2, 2.75] },
				b: { size: [2.4, 0.3, 1], position: [2, 1.25] },
				c: { size: [0.3, 1.8, 1], position: [0.65, 2] },
				d: { size: [0.3, 1.8, 1], position: [3.35, 2] },
			},
			paths: ["person from door to desk"],
		});
		expect(shut.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"scene.path.blocked",
		]);
		expect(shut.diagnostics[0]?.message).toContain("at all");
	});
});

describe("random scene paths", () => {
	/**
	 * A found path is clear by the independent walk; a blocked one names a
	 * width, and an agent a little narrower than that width gets through.
	 */
	const SEEDS = Array.from(
		{ length: Number(process.env.DGE_PATH_SEEDS ?? 40) },
		(_, k) => k + 1,
	);
	it.each(SEEDS)("seed %i", (seed) => {
		const random = mulberry32(seed);
		const between = (low: number, high: number) =>
			Math.round((low + random() * (high - low)) * 20) / 20;
		const objects: Record<string, unknown> = {};
		const count = 4 + Math.floor(random() * 8);
		for (let k = 1; k <= count; k += 1) {
			objects[`o${k}`] = {
				size: [between(0.3, 1.6), between(0.3, 1.2), between(0.4, 1.5)],
			};
		}
		const value = {
			scene: `paths-${seed}`,
			bounds: { width: between(4, 7), depth: between(4, 7), height: 3 },
			minGap: 0.05,
			openings: { door: { wall: "south", at: 0.7, width: 0.9 } },
			objects,
			// Some come back the other way (lanes), some turn at right angles.
			paths: Object.keys(objects)
				.filter(() => random() < 0.5)
				.flatMap((id) => {
					const roll = random();
					if (roll < 0.25) {
						return [`person from door to ${id}`, `person from ${id} to door`];
					}
					if (roll < 0.4) return [`person from door to ${id}, orthogonal`];
					return [`person from door to ${id}`];
				}),
		};
		const normalized = normalizeSceneDsl(value);
		const spec = normalized.scene as SceneSpec;
		const scene = solveScene(spec);
		expect(clearanceFaults(scene, spec)).toEqual([]);
		for (const diagnostic of scene.diagnostics) {
			if (
				diagnostic.code !== "scene.path.blocked" ||
				diagnostic.detail?.width === undefined
			) {
				continue;
			}
			const width = Number(diagnostic.detail.width);
			const index = Number(diagnostic.path?.[1]);
			const thinner = solveScene({
				...spec,
				agents: spec.agents.map((agent) => ({
					...agent,
					radius: width / 2 - 0.002,
				})),
				paths: [spec.paths[index] as (typeof spec.paths)[number]],
			});
			expect(thinner.paths, `${diagnostic.message}`).toHaveLength(1);
		}
	});
});

describe("review findings on #129", () => {
	// #131: a path out to a via and back along the same line keeps the turn.
	it.each([
		false,
		true,
	])("keeps a u-turn at a via (orthogonal: %s)", (orthogonal) => {
		const scene = solve({
			openings: {
				a: { wall: "south", at: 1, width: 0.8 },
				b: { wall: "south", at: 3, width: 0.8 },
				c: { wall: "south", at: 2, width: 0.8 },
			},
			objects: {},
			paths: [`person from a to c, via b${orthogonal ? ", orthogonal" : ""}`],
		});
		expect(scene.valid).toBe(true);
		const path = scene.paths[0];
		expect(path?.points.map(([x]) => x)).toEqual([1, 3, 2]);
		expect(path?.length).toBeCloseTo(3, 6);
	});

	it("visits several vias in order", () => {
		const scene = solve({
			openings: {
				a: { wall: "south", at: 0.5, width: 0.8 },
				b: { wall: "south", at: 3.5, width: 0.8 },
				c: { wall: "south", at: 1.5, width: 0.8 },
				d: { wall: "south", at: 2.5, width: 0.8 },
			},
			objects: {},
			paths: ["person from a to d, via b and c"],
		});
		expect(scene.paths[0]?.points.map(([x]) => x)).toEqual([
			0.5, 3.5, 1.5, 2.5,
		]);
		expect(scene.paths[0]?.length).toBeCloseTo(6, 6);
	});

	// #132: right-angle routing costs nothing for floor nobody walks on.
	it("routes across a large empty hall at once", () => {
		const scene = solve({
			bounds: { width: 200, depth: 200, height: 3 },
			openings: {
				entry: { wall: "south", at: 100, width: 1 },
				exit: { wall: "north", at: 100, width: 1 },
			},
			objects: {},
			paths: ["person from entry to exit, orthogonal"],
		});
		expect(scene.paths[0]?.points).toEqual([
			[100, 0.253, 0],
			[100, 199.747, 0],
		]);
		// Before: the walls were boxes reaching far outside the room, indexed
		// in 128 mm buckets: a 40 m hall took about 0.7 s and 200 MB.
		const start = performance.now();
		solve({
			bounds: { width: 200, depth: 200, height: 3 },
			openings: {
				entry: { wall: "south", at: 100, width: 1 },
				exit: { wall: "north", at: 100, width: 1 },
			},
			objects: { baffle: { size: [199.4, 0.2, 2], position: [100, 100] } },
			paths: ["person from entry to exit, orthogonal"],
		});
		expect(performance.now() - start).toBeLessThan(2000);
	});
});

describe("refined paths (#128 T3)", () => {
	/** Least distance from a path's corners (not its ends) to any footprint. */
	const cornerRoom = (scene: SolvedScene, index: number) => {
		const points = scene.paths[index]?.points ?? [];
		let least = Number.POSITIVE_INFINITY;
		for (const [x = 0, y = 0] of points.slice(1, -1)) {
			for (const object of scene.objects) {
				const polygon = corners(
					footprint(
						{ x: object.position[0], y: object.position[1] },
						object.size,
						object.yaw,
					),
				);
				least = Math.min(least, pointPolygon({ x, y }, polygon));
			}
		}
		return least;
	};
	const study = (comfort?: string) => {
		const parsed = parseSceneDsl(
			comfort === undefined
				? sceneSource("study-paths")
				: sceneSource("study-paths").replace(/^(\s+- .+)$/gm, (line) =>
						line.includes(" from ") ? `${line}, comfort ${comfort}` : line,
					),
		);
		expect(parsed.diagnostics).toEqual([]);
		const spec = parsed.scene as SceneSpec;
		return { spec, scene: solveScene(spec) };
	};

	it("walks mid-aisle instead of skimming corners, within the length budget", () => {
		const tight = study("0").scene;
		const { spec, scene } = study();
		expect(scene.valid).toBe(true);
		expect(clearanceFaults(scene, spec)).toEqual([]);
		// The person's turn beside seat4 sat on the corner of its footprint
		// grown by the radius (0.25·√2 from the corner); now it keeps the
		// default comfort, 0.15 m, more to the side.
		expect(cornerRoom(tight, 0)).toBeCloseTo(0.25 * Math.SQRT2, 3);
		expect(cornerRoom(scene, 0)).toBeGreaterThan(0.45);
		// The robot's run past seat1 moves to the middle of the aisle south of
		// it, with no extra turn.
		expect(scene.paths[2]?.points).toHaveLength(
			tight.paths[2]?.points.length ?? 0,
		);
		expect(scene.paths[2]?.points[1]?.[1]).toBeCloseTo(0.6875, 3);
		scene.paths.forEach((path, index) => {
			expect(path.length).toBeLessThanOrEqual(
				1.15 * (tight.paths[index]?.length ?? 0) + 1e-6,
			);
		});
	});

	it("keeps right where two paths meet head-on", () => {
		const value = (depth: number) => ({
			bounds: { width: 8, depth, height: 2.5 },
			objects: {
				a: { size: [0.3, 0.3, 1], position: [0.5, depth / 2] },
				b: { size: [0.3, 0.3, 1], position: [7.5, depth / 2] },
			},
			paths: ["person from a to b, comfort 0", "person from b to a, comfort 0"],
		});
		const value2 = value(2);
		const scene = solve({
			...value2,
			objects: {
				a: { ...value2.objects.a, front: "+x" },
				b: { ...value2.objects.b, front: "-x" },
			},
		});
		expect(scene.valid).toBe(true);
		const [east, west] = scene.paths;
		// Ends stay at the stands; the second path steps to its right (north
		// when walking west) until the two bands just touch.
		expect(west?.points[0]).toEqual(east?.points.at(-1));
		const lane = (path: typeof east) => {
			const points = path?.points ?? [];
			for (let k = 0; k + 1 < points.length; k += 1) {
				const [ax = 0, ay = 0] = points[k] ?? [];
				const [bx = 0, by = 0] = points[k + 1] ?? [];
				if ((ax - 4) * (bx - 4) <= 0 && ax !== bx) {
					return ay + ((by - ay) * (4 - ax)) / (bx - ax);
				}
			}
			return Number.NaN;
		};
		expect(lane(west) - lane(east)).toBeGreaterThanOrEqual(0.5 - 1e-6);
		expect(
			scene.diagnostics.filter((d) => d.code === "scene.path.single-file"),
		).toEqual([]);

		// A corridor too narrow to pass: single file, said so.
		const narrow = solve({
			...value(0.9),
			objects: {
				a: { size: [0.3, 0.3, 1], position: [0.5, 0.45], front: "+x" },
				b: { size: [0.3, 0.3, 1], position: [7.5, 0.45], front: "-x" },
			},
		});
		expect(narrow.paths).toHaveLength(2);
		expect(narrow.diagnostics.map((d) => d.code)).toContain(
			"scene.path.single-file",
		);
	});

	it("leaves paths going the same way in one lane", () => {
		const scene = solve({
			bounds: { width: 8, depth: 2, height: 2.5 },
			openings: { door: { wall: "west", at: 1, width: 0.9 } },
			objects: {
				a: { size: [0.3, 0.3, 1], position: [7.5, 1], front: "-x" },
			},
			paths: ["person from door to a", "person from door to a"],
		});
		expect(scene.paths[1]?.points).toEqual(scene.paths[0]?.points);
	});

	it("says when a path goes far round", () => {
		const scene = solve({
			bounds: { width: 6, depth: 6, height: 2.5 },
			objects: {
				screen: { size: [5, 0.2, 2], position: [3.5, 3] },
				a: { size: [0.4, 0.4, 1], position: [5, 1.5], front: "+y" },
				b: { size: [0.4, 0.4, 1], position: [5, 4.5] },
			},
			paths: ["person from a to b"],
		});
		const detour = scene.diagnostics.find(
			(d) => d.code === "scene.path.detour",
		);
		expect(detour?.severity).toBe("info");
		expect(detour?.message).toContain('"person:a->b"');
		expect(scene.valid).toBe(true);
	});

	it("reads comfort and keeps the shortest route with comfort 0", () => {
		const { scene } = study("0");
		const { scene: before } = study("0");
		expect(scene.paths).toEqual(before.paths);
		expect(scene.paths[0]?.points[1]?.[0]).toBeCloseTo(0.625, 3);
		const bad = parse({
			objects: { a: { size: [1, 1, 1] } },
			openings: { d: { wall: "south", at: 2, width: 1 } },
			paths: ["person from d to a, comfort wide"],
		});
		expect(bad.diagnostics[0]?.message).toContain("`comfort` needs a length");
	});
});
