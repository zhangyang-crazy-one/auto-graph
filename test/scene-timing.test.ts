import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	type SceneSpec,
	type SolvedScene,
	sceneTopViewSvg,
	solveScene,
} from "../src/index.js";
import { sceneToBlenderScript } from "../src/scene/export/blender.js";
import {
	findMeetings,
	positionAt,
	sampleElapsed,
	timePath,
} from "../src/scene/path-timing.js";

function solve(value: Record<string, unknown>): SolvedScene {
	const result = normalizeSceneDsl({
		scene: "t",
		bounds: { width: 8, depth: 4, height: 2.5 },
		...value,
	});
	expect(result.diagnostics).toEqual([]);
	return solveScene(result.scene as SceneSpec);
}

describe("path timing", () => {
	it("speeds up, cruises and brakes on a straight", () => {
		// 6 m at 1.2 m/s, 1 m/s²: 1.2 s and 0.72 m each way, 4.56 m at
		// full speed in 3.8 s.
		const timing = timePath(
			[
				{ x: 0, y: 0 },
				{ x: 6, y: 0 },
			],
			1.2,
			1,
			2,
		);
		expect(timing.duration).toBeCloseTo(1.2 + 3.8 + 1.2, 9);
		expect(timing.times).toEqual([2, 2 + timing.duration]);
		expect(
			positionAt(
				[
					{ x: 0, y: 0 },
					{ x: 6, y: 0 },
				],
				timing,
				2 + 1.2,
			)?.x,
		).toBeCloseTo(0.72, 9);
		expect(
			positionAt(
				[
					{ x: 0, y: 0 },
					{ x: 6, y: 0 },
				],
				timing,
				1,
			),
		).toBeUndefined();
	});

	it("never reaches full speed on a short hop", () => {
		// 0.5 m: speeds up for half, brakes for half; peak √0.5 m/s.
		const timing = timePath(
			[
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0 },
			],
			1.2,
			1,
			0,
		);
		expect(timing.duration).toBeCloseTo(2 * Math.sqrt(0.5), 9);
	});

	it("slows for corners: half speed round a right angle, a stop to turn back", () => {
		const corner = timePath(
			[
				{ x: 0, y: 0 },
				{ x: 5, y: 0 },
				{ x: 5, y: 5 },
			],
			1.2,
			1,
			0,
		);
		expect(corner.speeds[1]).toBeCloseTo(0.6, 9);
		const back = timePath(
			[
				{ x: 0, y: 0 },
				{ x: 5, y: 0 },
				{ x: 2, y: 0 },
			],
			1.2,
			1,
			0,
		);
		expect(back.speeds[1]).toBeCloseTo(0, 9);
		const points = [
			{ x: 0, y: 0 },
			{ x: 5, y: 0 },
			{ x: 5, y: 5 },
		];
		// The agent is on each corner at its time, and the samples include
		// every corner.
		corner.times.forEach((t, k) => {
			const at = positionAt(points, corner, t);
			expect(at?.x).toBeCloseTo(points[k]?.x ?? 0, 9);
			expect(at?.y).toBeCloseTo(points[k]?.y ?? 0, 9);
		});
		const samples = sampleElapsed(corner, 0.1);
		for (const e of corner.elapsed) expect(samples).toContain(e);
	});

	it("puts times, start and duration on planned paths", () => {
		const scene = solve({
			agents: { robot: { radius: 0.2, height: 0.2, speed: 0.5, accel: 0.25 } },
			objects: {
				a: { size: [0.3, 0.3, 1], position: [0.5, 2], front: "+x" },
				b: { size: [0.3, 0.3, 1], position: [7.5, 2], front: "-x" },
			},
			paths: ["robot from a to b, start 3s"],
		});
		const path = scene.paths[0];
		expect(path?.start).toBe(3);
		expect(path?.times[0]).toBe(3);
		// 6.4 m less 2 × 0.203 m stand-off at 0.5 m/s, 2 s to speed up and
		// to stop.
		const length = path?.length ?? 0;
		expect(path?.duration).toBeCloseTo(2 + 2 + (length - 1) / 0.5, 3);
		expect(path?.times.at(-1)).toBeCloseTo(3 + (path?.duration ?? 0), 3);
		expect(scene.agents.find((agent) => agent.id === "robot")).toMatchObject({
			speed: 0.5,
			accel: 0.25,
		});
	});
});

describe("agents meeting on the way", () => {
	const corridor = (starts: [string, string]) =>
		solve({
			bounds: { width: 8, depth: 0.9, height: 2.5 },
			objects: {
				a: { size: [0.3, 0.3, 1], position: [0.5, 0.45], front: "+x" },
				b: { size: [0.3, 0.3, 1], position: [7.5, 0.45], front: "-x" },
			},
			paths: [
				`person from a to b${starts[0]}`,
				`person from b to a${starts[1]}`,
			],
		});

	it("reports two scheduled agents meeting head-on, with a start that avoids it", () => {
		const scene = corridor([", start 0", ", start 0"]);
		const meet = scene.diagnostics.find((d) => d.code === "scene.path.meet");
		expect(meet?.severity).toBe("warning");
		expect(meet?.message).toContain('"person:a->b" and "person:b->a"');
		// They meet in the middle, about half way through.
		expect(Number(meet?.detail?.at)).toBeGreaterThan(2);
		const delay = Number(meet?.detail?.delay);
		expect(delay).toBeGreaterThan(0);
		// Taking the hint clears it.
		const later = corridor([", start 0", `, start ${delay}`]);
		expect(later.diagnostics.some((d) => d.code === "scene.path.meet")).toBe(
			false,
		);
		expect(scene.valid).toBe(true);
	});

	it("only checks paths that give a start", () => {
		const scene = corridor(["", ""]);
		expect(scene.diagnostics.some((d) => d.code === "scene.path.meet")).toBe(
			false,
		);
	});

	it("finds no meeting for agents that keep apart", () => {
		const line = (y: number) => [
			{ x: 0, y },
			{ x: 5, y },
		];
		const timing = timePath(line(0), 1, 1, 0);
		expect(
			findMeetings([
				{ id: "p", points: line(0), timing, radius: 0.25 },
				{ id: "q", points: line(0.5), timing, radius: 0.25 },
			]),
		).toEqual([]);
	});

	it("rejects a start that is not a time", () => {
		const result = normalizeSceneDsl({
			scene: "t",
			bounds: { width: 4, depth: 4 },
			objects: { a: { size: [1, 1, 1] } },
			openings: { d: { wall: "south", at: 2, width: 1 } },
			paths: ["person from d to a, start soon"],
		});
		expect(result.diagnostics[0]?.message).toContain("`start` needs a time");
	});
});

describe("review findings on #135", () => {
	// #139: a huge start is refused, and long walks sample within bounds.
	it("refuses a start too late to keep time precisely", () => {
		const result = normalizeSceneDsl({
			scene: "t",
			bounds: { width: 8, depth: 4 },
			objects: {},
			openings: {
				w: { wall: "west", at: 1, width: 1 },
				e: { wall: "east", at: 1, width: 1 },
			},
			paths: ["person from w to e, start 10000000000000000"],
		});
		expect(result.diagnostics[0]?.message).toContain("latest start supported");
	});

	it("finishes for the latest start and for a very slow agent", () => {
		const started = performance.now();
		const scene = solve({
			agents: {
				snail: { radius: 0.05, height: 0.05, speed: 1e-6, accel: 1e-6 },
			},
			objects: {},
			openings: {
				w1: { wall: "west", at: 1, width: 1 },
				e1: { wall: "east", at: 1, width: 1 },
				w2: { wall: "west", at: 3, width: 1 },
				e2: { wall: "east", at: 3, width: 1 },
			},
			paths: [
				"person from w1 to e1, start 1000000",
				"snail from w2 to e2, start 1000000",
			],
		});
		expect(scene.paths).toHaveLength(2);
		const snail = scene.paths[1];
		const timing = timePath(
			(snail?.points ?? []).map(([x, y]) => ({ x, y })),
			1e-6,
			1e-6,
			1_000_000,
		);
		expect(sampleElapsed(timing, 0.1).length).toBeLessThanOrEqual(20_005);
		sceneTopViewSvg(scene);
		sceneToBlenderScript(scene);
		expect(performance.now() - started).toBeLessThan(20_000);
	});

	// #140: the meeting check is continuous, not sampled.
	it("finds agents crossing between samples", () => {
		const scene = solve({
			bounds: { width: 6.086, depth: 6.086, height: 2.5 },
			objects: {},
			openings: {
				w: { wall: "west", at: 3.043, width: 1 },
				e: { wall: "east", at: 3.043, width: 1 },
				s: { wall: "south", at: 3.043, width: 1 },
				n: { wall: "north", at: 3.043, width: 1 },
			},
			agents: { bot: { radius: 0.01, height: 0.01, speed: 1.2, accel: 1 } },
			paths: ["bot from w to e, start 0", "bot from s to n, start 0"],
		});
		const meet = scene.diagnostics.find((d) => d.code === "scene.path.meet");
		expect(meet).toBeDefined();
		expect(Number(meet?.detail?.at)).toBeCloseTo(3.125, 1);
	});

	// #141: the first key is where the agent sets off, whatever the start.
	it.each([
		1 / 3,
		2 / 3,
		2,
	])("keys the agent at its start first (start %s)", (start) => {
		const scene = solve({
			objects: {},
			openings: {
				w: { wall: "west", at: 1, width: 1 },
				e: { wall: "east", at: 1, width: 1 },
			},
			paths: [`person from w to e, start ${start}`],
		});
		const script = sceneToBlenderScript(scene);
		const line = script
			.split("\n")
			.find((text) => text.startsWith("TRACKS = "));
		const literal = (line ?? "").slice("TRACKS = json.loads(".length, -1);
		const tracks = JSON.parse(JSON.parse(literal)) as Record<
			string,
			number[][]
		>;
		const track = tracks[scene.paths[0]?.id ?? ""] ?? [];
		expect(track[0]).toEqual([Math.round(start * 1e4) / 1e4, 0.253, 1]);
		expect(track.at(-1)?.slice(1)).toEqual([7.747, 1]);
		// Never more than a step's worth of walking between keys.
		for (let k = 1; k < track.length; k += 1) {
			const [, x0 = 0] = track[k - 1] ?? [];
			const [, x1 = 0] = track[k] ?? [];
			expect(x1 - x0).toBeGreaterThanOrEqual(0);
			expect(x1 - x0).toBeLessThanOrEqual(1.2 * 0.1 + 1e-3);
		}
	});
});
