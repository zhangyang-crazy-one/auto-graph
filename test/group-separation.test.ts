import { describe, expect, it } from "vitest";
import { separateGroups } from "../src/constraints/group-separation.js";
import type { Box, Diagnostic, NormalizedGroup } from "../src/ir/index.js";

const PAD = { top: 10, right: 10, bottom: 10, left: 10 };

function group(id: string, nodeIds: string[]): NormalizedGroup {
	return { id, nodeIds, groupIds: [], padding: PAD };
}

function box(x: number, y: number, width = 40, height = 20): Box {
	return { x, y, width, height };
}

function envelope(boxes: Map<string, Box>, ids: string[]): Box {
	const members = ids.map((id) => boxes.get(id) as Box);
	const x = Math.min(...members.map((b) => b.x)) - PAD.left;
	const y = Math.min(...members.map((b) => b.y)) - PAD.top;
	const right = Math.max(...members.map((b) => b.x + b.width)) + PAD.right;
	const bottom = Math.max(...members.map((b) => b.y + b.height)) + PAD.bottom;
	return { x, y, width: right - x, height: bottom - y };
}

function apart(a: Box, b: Box, gap: number): boolean {
	return (
		a.x + a.width + gap <= b.x + 1e-9 ||
		b.x + b.width + gap <= a.x + 1e-9 ||
		a.y + a.height + gap <= b.y + 1e-9 ||
		b.y + b.height + gap <= a.y + 1e-9
	);
}

describe("separateGroups", () => {
	it("leaves a narrower gap alone when only true overlaps count", () => {
		// Groups 12 px apart (the layout's own container spacing).
		const run = (detectionGap?: number) => {
			const boxes = new Map([
				["a", box(0, 0)],
				["b", box(72, 0)],
			]);
			separateGroups({
				groups: [group("A", ["a"]), group("B", ["b"])],
				constraints: [],
				boxes,
				locks: new Map(),
				spacing: 40,
				...(detectionGap === undefined ? {} : { detectionGap }),
				diagnostics: [],
			});
			return boxes;
		};
		expect(run(0).get("b")).toEqual(box(72, 0));
		const spaced = run();
		expect(apart(envelope(spaced, ["a"]), envelope(spaced, ["b"]), 40)).toBe(
			true,
		);
	});

	it("moves the free group off a group pinned by constraints", () => {
		const boxes = new Map([
			["s1", box(0, 0)],
			["s2", box(100, 0)],
			["d1", box(60, 10)],
			["d2", box(60, 60)],
		]);
		const diagnostics: Diagnostic[] = [];
		separateGroups({
			groups: [group("svc", ["s1", "s2"]), group("data", ["d1", "d2"])],
			constraints: [
				{
					kind: "relative-position",
					sourceId: "s2",
					referenceId: "s1",
					relation: "right-of",
					offset: { x: 60, y: 0 },
				},
			],
			boxes,
			locks: new Map(),
			spacing: 20,
			diagnostics,
		});
		// The pinned services did not move; the data group cleared them.
		expect(boxes.get("s1")).toEqual(box(0, 0));
		expect(boxes.get("s2")).toEqual(box(100, 0));
		expect(
			apart(envelope(boxes, ["s1", "s2"]), envelope(boxes, ["d1", "d2"]), 20),
		).toBe(true);
		expect(diagnostics.map((d) => d.code)).toContain(
			"constraints.groups-separated",
		);
	});

	it("moves a free foreign node out of a group", () => {
		const boxes = new Map([
			["a", box(0, 0)],
			["b", box(100, 0)],
			["stray", box(50, 0)],
		]);
		separateGroups({
			groups: [group("g", ["a", "b"])],
			constraints: [],
			boxes,
			locks: new Map(),
			spacing: 20,
			diagnostics: [],
		});
		expect(
			apart(boxes.get("stray") as Box, envelope(boxes, ["a", "b"]), 10),
		).toBe(true);
	});

	it("leaves conflicts between pinned sides alone", () => {
		const boxes = new Map([
			["a", box(0, 0)],
			["b", box(10, 0)],
		]);
		separateGroups({
			groups: [group("g1", ["a"]), group("g2", ["b"])],
			constraints: [],
			boxes,
			locks: new Map([
				["a", { nodeId: "a", source: "exact-position" as const }],
				["b", { nodeId: "b", source: "exact-position" as const }],
			]),
			spacing: 20,
			diagnostics: [],
		});
		expect(boxes.get("a")).toEqual(box(0, 0));
		expect(boxes.get("b")).toEqual(box(10, 0));
	});

	it("does not separate nested groups", () => {
		const boxes = new Map([
			["a", box(0, 0)],
			["b", box(60, 0)],
		]);
		separateGroups({
			groups: [
				{ ...group("outer", ["a"]), groupIds: ["inner"] },
				group("inner", ["b"]),
			],
			constraints: [],
			boxes,
			locks: new Map(),
			spacing: 20,
			diagnostics: [],
		});
		expect(boxes.get("b")).toEqual(box(60, 0));
	});
});
