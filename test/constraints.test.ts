import { describe, expect, it } from "vitest";
import { applyLayoutConstraints } from "../src/constraints/index.js";
import type { Box, NormalizedNode } from "../src/ir/index.js";

describe("layout constraints", () => {
	it("keeps fixed node positions as hard locks", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			boxes: boxMap([
				["fixed", { x: 0, y: 0, width: 80, height: 40 }],
				["other", { x: 200, y: 80, width: 80, height: 40 }],
			]),
			nodes: [node("fixed", { x: 40, y: 50 }), node("other")],
			groups: [],
			constraints: [
				{ kind: "align", axis: "x", targetIds: ["other", "fixed"] },
			],
		});

		expect(result.boxes.get("fixed")).toMatchObject({ x: 40, y: 50 });
		expect(result.locks.get("fixed")).toEqual({
			nodeId: "fixed",
			source: "fixed-position",
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.locked-target-not-moved",
			}),
		);
	});

	it("lets exact-position lock beat weaker align and distribute constraints", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			boxes: boxMap([
				["a", { x: 0, y: 0, width: 40, height: 20 }],
				["b", { x: 100, y: 100, width: 40, height: 20 }],
				["c", { x: 200, y: 200, width: 40, height: 20 }],
			]),
			nodes: [node("a"), node("b"), node("c")],
			groups: [],
			constraints: [
				{
					kind: "exact-position",
					targetId: "b",
					position: { x: 32, y: 48 },
				},
				{ kind: "align", axis: "y", targetIds: ["a", "b", "c"] },
				{
					kind: "distribute",
					axis: "horizontal",
					targetIds: ["a", "b", "c"],
					spacing: 20,
				},
			],
		});

		expect(result.boxes.get("b")).toMatchObject({ x: 32, y: 48 });
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.locked-target-not-moved",
			}),
		);
	});

	it("emits missing-reference diagnostics", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			boxes: boxMap([["a", { x: 0, y: 0, width: 40, height: 20 }]]),
			nodes: [node("a")],
			groups: [],
			constraints: [{ kind: "align", axis: "x", targetIds: ["missing"] }],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "constraints.reference.missing",
			}),
		);
	});

	it.each([
		["LR", "x", 90],
		["RL", "x", 90],
		["TB", "y", 70],
		["BT", "y", 70],
	] as const)("repairs overlap along primary axis for %s using default spacing 40", (direction, axis, expected) => {
		const result = applyLayoutConstraints({
			direction,
			boxes: boxMap([
				["locked", { x: 0, y: 0, width: 50, height: 30 }],
				["free", { x: 20, y: 10, width: 50, height: 30 }],
			]),
			nodes: [node("locked", { x: 0, y: 0 }), node("free")],
			groups: [],
			constraints: [],
		});

		expect(result.boxes.get("locked")).toMatchObject({ x: 0, y: 0 });
		expect(result.boxes.get("free")?.[axis]).toBe(expected);
	});

	it("uses configured spacing and never moves fixed or exact boxes", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			overlapSpacing: 10,
			boxes: boxMap([
				["fixed", { x: 0, y: 0, width: 50, height: 30 }],
				["free", { x: 20, y: 0, width: 50, height: 30 }],
				["exact", { x: 120, y: 0, width: 50, height: 30 }],
			]),
			nodes: [node("fixed", { x: 0, y: 0 }), node("free"), node("exact")],
			groups: [],
			constraints: [
				{
					kind: "exact-position",
					targetId: "exact",
					position: { x: 120, y: 0 },
				},
			],
		});

		expect(result.boxes.get("fixed")).toMatchObject({ x: 0, y: 0 });
		expect(result.boxes.get("exact")).toMatchObject({ x: 120, y: 0 });
		expect(result.boxes.get("free")?.x).toBe(60);
	});

	it("deterministically repairs unlocked overlaps on the secondary axis", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			overlapSpacing: 12,
			boxes: boxMap([
				["a", { x: 0, y: 0, width: 50, height: 30 }],
				["b", { x: 20, y: 10, width: 50, height: 30 }],
				["c", { x: 120, y: 0, width: 50, height: 30 }],
			]),
			nodes: [node("a"), node("b"), node("c")],
			groups: [],
			constraints: [],
		});

		expect(result.boxes.get("a")).toMatchObject({ x: 0, y: 0 });
		expect(result.boxes.get("b")).toMatchObject({ x: 20, y: 42 });
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "constraints.overlap.unresolved",
			}),
		);
	});

	it("reports invalid and conflicting positions plus unresolved overlaps", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			boxes: boxMap([
				["a", { x: 0, y: 0, width: 50, height: 30 }],
				["b", { x: 10, y: 10, width: 50, height: 30 }],
			]),
			nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 10, y: 10 })],
			groups: [],
			constraints: [
				{
					kind: "exact-position",
					targetId: "a",
					position: { x: Number.NaN, y: 0 },
				},
				{
					kind: "exact-position",
					targetId: "b",
					position: { x: 40, y: 40 },
				},
				{
					kind: "containment",
					containerId: "a",
					childIds: ["b"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining([
				"constraints.position.invalid",
				"constraints.conflict.exact-position",
				"constraints.containment.impossible",
				"constraints.overlap.unresolved",
			]),
		);
	});
});

function node(
	id: string,
	position?: NormalizedNode["position"],
): NormalizedNode {
	return {
		id,
		shape: "rectangle",
		size: { width: 40, height: 20 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		...(position === undefined ? {} : { position }),
	};
}

function boxMap(
	entries: ConstructorParameters<typeof Map<string, Box>>[0],
): Map<string, Box> {
	return new Map(entries);
}
