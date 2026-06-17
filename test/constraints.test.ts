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
				["c", { x: 20, y: 20, width: 50, height: 30 }],
			]),
			nodes: [
				node("a", { x: 0, y: 0 }),
				node("b", { x: 10, y: 10 }),
				node("c", { x: 20, y: 20 }),
			],
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
					kind: "exact-position",
					targetId: "c",
					position: { x: 20, y: 20 },
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

	it("reports overlaps introduced by the final containment clamp", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 100, height: 100 }],
				["contained", { x: 180, y: 0, width: 70, height: 70 }],
				["sibling", { x: 30, y: 30, width: 70, height: 70 }],
			]),
			nodes: [
				node("container", { x: 0, y: 0 }),
				node("contained"),
				node("sibling", { x: 30, y: 30 }),
			],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["contained"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.boxes.get("contained")).toMatchObject({ x: 30, y: 0 });
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "containment_overflow",
				detail: expect.objectContaining({
					nodeId: "contained",
					containerId: "container",
				}),
			}),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "constraints.overlap.unresolved",
				detail: expect.objectContaining({
					firstId: "contained",
					secondId: "sibling",
				}),
			}),
		);
	});

	it("does not repair valid containment overlap between parent and child", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 160, height: 120 }],
				["child", { x: 40, y: 30, width: 60, height: 40 }],
				["sibling", { x: 220, y: 30, width: 60, height: 40 }],
			]),
			nodes: [
				node("container", { x: 0, y: 0 }),
				node("child"),
				node("sibling"),
			],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["child"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.boxes.get("child")).toMatchObject({ x: 40, y: 30 });
		expect(result.boxes.get("container")).toMatchObject({ x: 0, y: 0 });
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "containment_overflow" }),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "constraints.overlap.unresolved" }),
		);
	});

	it("does not report intra-container sibling issues when minSiblingGap is unset", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 200, height: 200 }],
				["c1", { x: 50, y: 50, width: 60, height: 60 }],
				["c2", { x: 50, y: 80, width: 60, height: 60 }],
			]),
			nodes: [
				node("container", { x: 0, y: 0 }),
				node("c1", { x: 50, y: 50 }),
				node("c2", { x: 50, y: 80 }),
			],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
				{ kind: "exact-position", targetId: "c1", position: { x: 50, y: 50 } },
				{ kind: "exact-position", targetId: "c2", position: { x: 50, y: 80 } },
			],
		});

		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "intra_container_overflow" }),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "intra_container_overflow_total" }),
		);
	});

	it("reports intra_container_overflow when siblings overlap with minSiblingGap set", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			minSiblingGap: 10,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 200, height: 200 }],
				["c1", { x: 50, y: 50, width: 60, height: 60 }],
				["c2", { x: 50, y: 80, width: 60, height: 60 }],
			]),
			nodes: [
				node("container", { x: 0, y: 0 }),
				node("c1", { x: 50, y: 50 }),
				node("c2", { x: 50, y: 80 }),
			],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
				{ kind: "exact-position", targetId: "c1", position: { x: 50, y: 50 } },
				{ kind: "exact-position", targetId: "c2", position: { x: 50, y: 80 } },
			],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "intra_container_overflow",
				detail: expect.objectContaining({
					containerId: "container",
					overlapPairs: 1,
				}),
			}),
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "intra_container_overflow_total" }),
		);
	});

	it("reports intra_container_overflow_total when stacked children exceed container", () => {
		// Container height 50 cannot hold two 60px-tall children even after
		// containment clamping, so the spatial extent must exceed the content.
		const result = applyLayoutConstraints({
			direction: "TB",
			minSiblingGap: 20,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 300, height: 50 }],
				["c1", { x: 50, y: 0, width: 60, height: 60 }],
				["c2", { x: 50, y: 30, width: 60, height: 60 }],
			]),
			nodes: [node("container", { x: 0, y: 0 }), node("c1"), node("c2")],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "intra_container_overflow_total",
				detail: expect.objectContaining({
					containerId: "container",
					axis: "y",
				}),
			}),
		);
	});

	it("repairs sibling overlap to satisfy minSiblingGap", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			minSiblingGap: 50,
			overlapSpacing: 40,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 200, height: 200 }],
				["c1", { x: 50, y: 50, width: 40, height: 40 }],
				["c2", { x: 50, y: 60, width: 40, height: 40 }],
			]),
			nodes: [node("container"), node("c1"), node("c2")],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		const c1 = result.boxes.get("c1");
		const c2 = result.boxes.get("c2");
		expect(c1).toBeDefined();
		expect(c2).toBeDefined();
		// Effective spacing = max(overlapSpacing=40, minSiblingGap=50) = 50.
		// In TB direction, pass 0 repairs on secondary (x) axis first.
		// c2 is pushed right by c1.width + effectiveSpacing = 40 + 50 = 90px.
		// So c2.x should be 50 + 40 + 50 = 140.
		expect(c2?.x).toBe(140);
		expect(c2?.y).toBe(60);
	});

	it("distributes contained children along main axis when enabled", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			overlapSpacing: 40,
			distributeContainedChildren: true,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 300, height: 200 }],
				["c1", { x: 50, y: 0, width: 40, height: 30 }],
				["c2", { x: 50, y: 0, width: 40, height: 30 }],
				["c3", { x: 50, y: 0, width: 40, height: 30 }],
			]),
			nodes: [node("container"), node("c1"), node("c2"), node("c3")],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2", "c3"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		const c1 = result.boxes.get("c1");
		const c2 = result.boxes.get("c2");
		const c3 = result.boxes.get("c3");
		expect(c1?.y).toBeLessThan(c2?.y ?? Infinity);
		expect(c2?.y).toBeLessThan(c3?.y ?? Infinity);
		expect(c1?.y).toBeGreaterThanOrEqual(0);
		expect(c3?.y).toBeLessThanOrEqual(200 - 30);
		expect(c1?.x).toBe(130);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "intra_container_distributed" }),
		);
	});

	it("does not distribute when disabled (default)", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			overlapSpacing: 40,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 300, height: 200 }],
				["c1", { x: 50, y: 0, width: 40, height: 30 }],
				["c2", { x: 50, y: 0, width: 40, height: 30 }],
			]),
			nodes: [node("container"), node("c1"), node("c2")],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.boxes.get("c1")?.y).toBe(0);
		expect(result.boxes.get("c2")?.y).toBe(0);
	});

	it("skips locked children during distribution", () => {
		const result = applyLayoutConstraints({
			direction: "TB",
			overlapSpacing: 40,
			distributeContainedChildren: true,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 300, height: 200 }],
				["c1", { x: 50, y: 0, width: 40, height: 30 }],
				["c2", { x: 50, y: 0, width: 40, height: 30 }],
				["c3", { x: 50, y: 0, width: 40, height: 30 }],
			]),
			nodes: [
				node("container"),
				node("c1", { x: 50, y: 0 }),
				node("c2"),
				node("c3"),
			],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2", "c3"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.boxes.get("c1")?.y).toBe(0);
		expect(result.boxes.get("c2")?.y).toBeGreaterThanOrEqual(0);
		expect(result.boxes.get("c3")?.y).toBeGreaterThan(
			result.boxes.get("c2")?.y ?? 0,
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "constraints.locked-target-not-moved" }),
		);
	});

	it("centers distributed children on the cross axis", () => {
		const result = applyLayoutConstraints({
			direction: "LR",
			overlapSpacing: 40,
			distributeContainedChildren: true,
			boxes: boxMap([
				["container", { x: 0, y: 0, width: 300, height: 200 }],
				["c1", { x: 0, y: 0, width: 40, height: 30 }],
				["c2", { x: 0, y: 0, width: 40, height: 50 }],
			]),
			nodes: [node("container"), node("c1"), node("c2")],
			groups: [],
			constraints: [
				{
					kind: "containment",
					containerId: "container",
					childIds: ["c1", "c2"],
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
				},
			],
		});

		expect(result.boxes.get("c1")?.y).toBe(85);
		expect(result.boxes.get("c2")?.y).toBe(75);
		expect(result.boxes.get("c1")?.x).toBeLessThan(
			result.boxes.get("c2")?.x ?? Infinity,
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
