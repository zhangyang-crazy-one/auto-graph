import { describe, expect, it } from "vitest";
import {
	isSceneDocument,
	normalizeSceneDsl,
	parseDiagramDsl,
	parseSceneDsl,
} from "../src/index.js";

const STUDY = `
scene: study
units: m
bounds: { width: 4, depth: 5, height: 2.8 }
objects:
  desk:  { size: [1.4, 0.7, 0.75], front: -y }
  chair: { size: [0.5, 0.5, 0.9],  front: -y }
  lamp:  { size: [0.2, 0.2, 0.5] }
  table: { size: [1.2, 1.2, 0.75] }
  seat:  { size: [0.45, 0.45, 0.9], front: -y, count: 4 }
relations:
  - desk against wall north
  - chair in-front-of desk, facing desk, gap 0.1
  - lamp on desk, at right-back
  - table center-of room
  - seat around table, radius 0.9, evenly
  - keep clear 0.8 between desk and table
`;

const base = {
	scene: "test",
	bounds: { width: 4, depth: 5 },
	objects: {
		a: { size: [1, 1, 1] },
		b: { size: [1, 1, 1] },
		c: { size: [1, 1, 1] },
		seat: { size: [0.5, 0.5, 0.9], count: 3 },
	},
};

function relations(...lines: string[]): unknown[] {
	const result = normalizeSceneDsl({ ...base, relations: lines });
	expect(result.diagnostics).toEqual([]);
	return (result.scene?.relations ?? []).map(
		({ path: _path, ...rest }) => rest,
	);
}

function failure(...lines: string[]) {
	const result = normalizeSceneDsl({ ...base, relations: lines });
	expect(result.scene).toBeUndefined();
	const [first] = result.diagnostics;
	return first;
}

describe("scene DSL", () => {
	it("parses the issue #119 study scene", () => {
		const result = parseSceneDsl(STUDY);
		expect(result.diagnostics).toEqual([]);
		const scene = result.scene;
		expect(scene?.name).toBe("study");
		expect(scene?.bounds).toEqual({ width: 4, depth: 5, height: 2.8 });
		expect(scene?.objects.map((object) => object.id)).toEqual([
			"desk",
			"chair",
			"lamp",
			"table",
			"seat1",
			"seat2",
			"seat3",
			"seat4",
		]);
		expect(scene?.groups).toEqual({
			seat: ["seat1", "seat2", "seat3", "seat4"],
		});
		expect(scene?.objects.find((o) => o.id === "lamp")?.front).toBe("-y");
		expect(scene?.objects.find((o) => o.id === "seat3")).toMatchObject({
			group: "seat",
			path: ["objects", "seat"],
		});
		expect(scene?.relations.map((relation) => relation.kind)).toEqual([
			"against-wall",
			"beside",
			"facing",
			"on",
			"center-of",
			"around",
			"keep-clear",
		]);
		expect(scene?.relations[1]).toEqual({
			kind: "beside",
			subject: "chair",
			side: "front",
			reference: "desk",
			gap: 0.1,
			path: ["relations", 1],
		});
		expect(scene?.relations[3]).toMatchObject({ at: "back-right" });
		expect(scene?.relations[5]).toMatchObject({
			subjects: ["seat1", "seat2", "seat3", "seat4"],
			center: "table",
			radius: 0.9,
			faceCenter: true,
		});
	});

	it("is deterministic", () => {
		expect(JSON.stringify(parseSceneDsl(STUDY))).toBe(
			JSON.stringify(parseSceneDsl(STUDY)),
		);
	});

	it("detects scene documents without touching the diagram DSL", () => {
		expect(isSceneDocument({ scene: "x" })).toBe(true);
		expect(isSceneDocument({ nodes: {} })).toBe(false);
		expect(parseDiagramDsl("nodes:\n  a: { label: A }\n").diagnostics).toEqual(
			[],
		);
	});

	it("converts lengths to meters", () => {
		const result = normalizeSceneDsl({
			scene: "cm",
			units: "cm",
			bounds: { width: 400, depth: 500, height: 280 },
			minGap: 5,
			objects: { a: { size: [100, 50, 75] }, b: { size: [10, 10, 10] } },
			relations: ["a against wall north, gap 10", "b behind a, gap 0.2m"],
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.scene?.bounds).toEqual({ width: 4, depth: 5, height: 2.8 });
		expect(result.scene?.minGap).toBe(0.05);
		expect(result.scene?.objects[0]?.size).toEqual([1, 0.5, 0.75]);
		expect(result.scene?.relations[0]).toMatchObject({ gap: 0.1 });
		expect(result.scene?.relations[1]).toMatchObject({ gap: 0.2 });
	});

	it("reads every relation", () => {
		expect(
			relations(
				"a behind b, distance 2",
				"a left-of b",
				"a right-of b, rotate 90",
				"a against north wall",
				"a against wall e, gap 5cm",
				"a corner sw, gap 0.1",
				"a center-of b",
				"a on b, at left-front",
				"a facing east",
				"a facing b",
				"a rotate -45deg",
				"a and b align x with c",
				"seat distribute evenly along wall south, gap 0.2",
				"seat distribute along y",
				"seat grid 2x2, gap 0.3",
				"seat around c, radius 1, start 90, facing east",
				"a and b symmetric about room, axis x",
				"a and b symmetric about c",
			),
		).toEqual([
			{
				kind: "beside",
				subject: "a",
				side: "back",
				reference: "b",
				distance: 2,
			},
			{ kind: "beside", subject: "a", side: "left", reference: "b" },
			{ kind: "beside", subject: "a", side: "right", reference: "b" },
			{ kind: "rotate", subject: "a", degrees: 90 },
			{ kind: "against-wall", subject: "a", wall: "north", gap: 0 },
			{ kind: "against-wall", subject: "a", wall: "east", gap: 0.05 },
			{ kind: "corner", subject: "a", corner: "sw", gap: 0.1 },
			{ kind: "center-of", subject: "a", reference: "b" },
			{ kind: "on", subject: "a", support: "b", at: "front-left" },
			{ kind: "facing", subject: "a", target: { direction: "east" } },
			{ kind: "facing", subject: "a", target: { object: "b" } },
			{ kind: "rotate", subject: "a", degrees: -45 },
			{ kind: "align", subjects: ["a", "b"], axis: "x", reference: "c" },
			{
				kind: "distribute",
				subjects: ["seat1", "seat2", "seat3"],
				along: "south",
				gap: 0.2,
			},
			{ kind: "distribute", subjects: ["seat1", "seat2", "seat3"], along: "y" },
			{
				kind: "grid",
				subjects: ["seat1", "seat2", "seat3"],
				rows: 2,
				columns: 2,
				gap: 0.3,
			},
			{
				kind: "around",
				subjects: ["seat1", "seat2", "seat3"],
				center: "c",
				radius: 1,
				start: 90,
				faceCenter: false,
			},
			{ kind: "facing", subject: "seat1", target: { direction: "east" } },
			{ kind: "facing", subject: "seat2", target: { direction: "east" } },
			{ kind: "facing", subject: "seat3", target: { direction: "east" } },
			{ kind: "symmetric", subjects: ["a", "b"], about: "room", axis: "x" },
			{ kind: "symmetric", subjects: ["a", "b"], about: "c" },
		]);
	});

	it("applies single-subject relations to each member of a group", () => {
		expect(relations("seat against wall west, facing east")).toEqual([
			{ kind: "against-wall", subject: "seat1", wall: "west", gap: 0 },
			{ kind: "facing", subject: "seat1", target: { direction: "east" } },
			{ kind: "against-wall", subject: "seat2", wall: "west", gap: 0 },
			{ kind: "facing", subject: "seat2", target: { direction: "east" } },
			{ kind: "against-wall", subject: "seat3", wall: "west", gap: 0 },
			{ kind: "facing", subject: "seat3", target: { direction: "east" } },
		]);
	});

	it("suggests a known object for a typo", () => {
		expect(failure("a on tabel")).toMatchObject({
			code: "validate.scene.unknown-object",
			path: ["relations", 0],
			detail: { relation: "a on tabel" },
		});
		const result = parseSceneDsl(STUDY.replace("lamp on desk", "lamp on dsk"));
		expect(result.diagnostics[0]).toMatchObject({
			code: "validate.scene.unknown-object",
			path: ["relations", 2],
		});
		expect(result.diagnostics[0]?.hint).toContain('"desk"');
	});

	it("suggests a known verb", () => {
		const diagnostic = failure("a infront-of b");
		expect(diagnostic?.code).toBe("validate.scene.unknown-verb");
		expect(diagnostic?.hint).toContain('"in-front-of"');
	});

	it.each([
		["a on b, radius 1", "validate.scene.relation-modifier"],
		["a in-front-of b, gap 1, distance 2", "validate.scene.relation-conflict"],
		[
			"a in-front-of b, facing b, rotate 10",
			"validate.scene.relation-conflict",
		],
		["a facing b, rotate 10", "validate.scene.relation-modifier"],
		["a on a", "validate.scene.self-reference"],
		["a on seat", "validate.scene.group-reference"],
		["a against wall up", "validate.scene.relation-value"],
		["a corner north", "validate.scene.relation-value"],
		["a on b, at middle", "validate.scene.relation-value"],
		["a on b, at front-back", "validate.scene.relation-value"],
		["a in-front-of b, gap -1", "validate.scene.relation-value"],
		["seat grid 1x2", "validate.scene.relation-value"],
		["seat grid 2", "validate.scene.relation-value"],
		["seat around c", "validate.scene.relation-syntax"],
		["a symmetric about c", "validate.scene.relation-value"],
		["a distribute along x", "validate.scene.relation-value"],
		["keep clear 1 between a", "validate.scene.relation-syntax"],
		["keep clear 1 between a and a", "validate.scene.self-reference"],
		["a", "validate.scene.relation-syntax"],
		["a on b,, at center", "validate.scene.relation-syntax"],
		["a and a on b", "validate.scene.relation-syntax"],
		["a on b, at center, at back", "validate.scene.relation-syntax"],
	])("rejects %s", (line, code) => {
		expect(failure(line)?.code).toBe(code);
	});

	it("reports schema errors at their path", () => {
		const result = normalizeSceneDsl({
			scene: "x",
			bounds: { width: 4, depth: -1 },
			objects: { a: { size: [1, 1] } },
		});
		expect(result.scene).toBeUndefined();
		expect(result.diagnostics.map((d) => d.path)).toEqual([
			["bounds", "depth"],
			["objects", "a", "size"],
		]);
	});

	it("rejects reserved ids and count expansions that clash", () => {
		expect(
			normalizeSceneDsl({
				scene: "x",
				bounds: { width: 4, depth: 4 },
				objects: { room: { size: [1, 1, 1] } },
			}).diagnostics[0],
		).toMatchObject({
			code: "validate.scene.reserved-id",
			path: ["objects", "room"],
		});
		expect(
			normalizeSceneDsl({
				scene: "x",
				bounds: { width: 4, depth: 4 },
				objects: {
					seat2: { size: [1, 1, 1] },
					seat: { size: [1, 1, 1], count: 2 },
				},
			}).diagnostics[0],
		).toMatchObject({
			code: "validate.scene.count-id-conflict",
			path: ["objects", "seat"],
		});
	});

	it("separates member numbers from a group id ending in a digit", () => {
		const result = normalizeSceneDsl({
			scene: "x",
			bounds: { width: 4, depth: 4 },
			objects: { row1: { size: [1, 1, 1], count: 2 } },
		});
		expect(result.scene?.groups).toEqual({ row1: ["row1-1", "row1-2"] });
	});

	it("pins positions in document units, but not for groups", () => {
		const result = normalizeSceneDsl({
			scene: "x",
			units: "cm",
			bounds: { width: 400, depth: 400 },
			objects: { a: { size: [10, 10, 10], position: [150, 20], yaw: 45 } },
		});
		expect(result.scene?.objects[0]).toMatchObject({
			position: [1.5, 0.2],
			yaw: 45,
		});
		expect(
			normalizeSceneDsl({
				scene: "x",
				bounds: { width: 4, depth: 4 },
				objects: { seat: { size: [1, 1, 1], count: 2, position: [1, 1] } },
			}).diagnostics[0],
		).toMatchObject({
			code: "validate.scene.group-position",
			path: ["objects", "seat", "position"],
		});
	});
});
