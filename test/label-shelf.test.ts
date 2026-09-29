import { describe, expect, it } from "vitest";
import type { SolvedTextAnnotation } from "../src/ir/index.js";
import { buildExternalLabelCallouts } from "../src/solver/labels.js";
import { withKeyBlocked } from "../src/solver/remediation.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

function required(
	ownerId: string,
	text: string,
	box: SolvedTextAnnotation["box"],
): SolvedTextAnnotation {
	return {
		text,
		ownerId,
		surfaceKind: "edge-label",
		placement: "external-callout-required",
		box,
		anchor: { x: box.x, y: box.y },
		paddings: { top: 0, right: 0, bottom: 0, left: 0 },
		lines: [],
		fontFamily: "Arial",
		fontSize: 12,
	};
}

describe("label shelf packing (#93)", () => {
	it("keeps callouts off inline labels that find no shelf spot", () => {
		const stays = required(
			"b",
			Array.from({ length: 40 }, () => "long").join(" "),
			// Wide inline label: its key (at the centre, x≈120) is left of
			// the shelf column, the label itself reaches into it.
			{ x: 60, y: 8, width: 120, height: 14 },
		);
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 }), stays],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 400, height: 60 },
			},
			{ diagnostics },
		);
		// "b" is too tall for the page: it stays inline at full size.
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["a"]);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"routing.label-shelf.capacity_exhausted",
		);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		if (callout === undefined) return;
		const overlaps =
			callout.x < stays.box.x + stays.box.width &&
			stays.box.x < callout.x + callout.width &&
			callout.y < stays.box.y + stays.box.height &&
			stays.box.y < callout.y + callout.height;
		expect(overlaps).toBe(false);
	});

	it("keeps a label inline when no key spot clears the obstacles", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const node = { x: 0, y: 0, width: 100, height: 60 };
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 30, y: 20, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				keyObstacles: [node],
				// Its whole route lies inside the node.
				routes: new Map([
					[
						"a",
						[
							{ x: 10, y: 30 },
							{ x: 90, y: 30 },
						],
					],
				]),
			},
		);
		expect(built).toEqual([]);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-shelf.key_blocked",
				detail: expect.objectContaining({ edgeIds: ["a"] }),
			}),
		);
	});

	it("returns no callouts on a bounded page when every key is blocked", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 30, y: 20, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 400, height: 200 },
			},
			{
				diagnostics,
				keyObstacles: [{ x: 0, y: 0, width: 100, height: 60 }],
				routes: new Map([
					[
						"a",
						[
							{ x: 10, y: 30 },
							{ x: 90, y: 30 },
						],
					],
				]),
			},
		);
		expect(built).toEqual([]);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"routing.label-shelf.key_blocked",
		]);
	});

	it("folds blocked keys into the external-label plan", () => {
		const plan = withKeyBlocked(
			{
				type: "external-label",
				status: "blocked",
				reason: "Labels need callouts.",
				diagnosticCodes: ["routing.label-externalization.required"],
				detail: { strategy: "keyed-callouts", policy: "auto", labelCount: 1 },
			} as never,
			{
				severity: "warning",
				code: "routing.label-shelf.key_blocked",
				message: "1 external label key(s) have no spot.",
				detail: { edgeIds: ["a"] },
			},
		) as unknown as {
			reason: string;
			diagnosticCodes: string[];
			detail: { blockedKeyEdgeIds?: string[] };
		};
		expect(plan.diagnosticCodes).toContain("routing.label-shelf.key_blocked");
		expect(plan.detail.blockedKeyEdgeIds).toEqual(["a"]);
		expect(plan.reason).toContain("have no spot");
	});

	it("puts a key on another route only when nothing else is clear", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 30, y: 20, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				routes: new Map([
					[
						"a",
						[
							{ x: 10, y: 30 },
							{ x: 90, y: 30 },
						],
					],
					// Runs along the whole of "a": every key spot crosses it.
					[
						"b",
						[
							{ x: 0, y: 30 },
							{ x: 100, y: 30 },
						],
					],
				]),
			},
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["a"]);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-shelf.key_on_route",
				detail: expect.objectContaining({ edgeIds: ["a"] }),
			}),
		);
	});

	it("keeps a label inline when every key spot is on another key", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const route = [
			{ x: 10, y: 30 },
			{ x: 14, y: 30 },
		];
		const built = buildExternalLabelCallouts(
			[
				required("a", "first", { x: 0, y: 20, width: 24, height: 14 }),
				required("b", "second", { x: 0, y: 20, width: 24, height: 14 }),
			],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				// Both routes are a few px long at the same spot: "b"'s key has
				// nowhere to go but on top of "a"'s.
				routes: new Map([
					["a", route],
					["b", route],
				]),
			},
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["a"]);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-shelf.key_blocked",
				detail: expect.objectContaining({ edgeIds: ["b"] }),
			}),
		);
	});

	it("packs callouts clear of labels whose keys were blocked", () => {
		const blockedLabel = { x: 120, y: 8, width: 240, height: 40 };
		const built = buildExternalLabelCallouts(
			[
				required("a", "short", { x: 20, y: 40, width: 40, height: 14 }),
				required("b", "blocked label", blockedLabel),
			],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 400, height: 120 },
			},
			{
				// "b"'s key sits in the node and its route stays inside it.
				keyObstacles: [{ x: 110, y: 0, width: 260, height: 60 }],
				routes: new Map([
					[
						"b",
						[
							{ x: 200, y: 30 },
							{ x: 260, y: 30 },
						],
					],
				]),
			},
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["a"]);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		if (callout === undefined) return;
		const overlaps =
			callout.x < blockedLabel.x + blockedLabel.width &&
			blockedLabel.x < callout.x + callout.width &&
			callout.y < blockedLabel.y + blockedLabel.height &&
			blockedLabel.y < callout.y + callout.height;
		expect(overlaps).toBe(false);
	});

	it("keeps a key beside a diagonal route that misses it", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 30, y: 20, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 100 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				routes: new Map([
					[
						"a",
						[
							{ x: 10, y: 27 },
							{ x: 90, y: 27 },
						],
					],
					// Its bounds cover the key, the line itself passes below it.
					[
						"b",
						[
							{ x: 0, y: 100 },
							{ x: 100, y: 0 },
						],
					],
				]),
			},
		);
		const key = built[0]?.callout.keyBox;
		expect(key).toBeDefined();
		if (key === undefined) return;
		expect(key.x + key.width / 2).toBeCloseTo(50, 6);
		expect(key.y + key.height / 2).toBeCloseTo(27, 6);
		// Not reported as sitting on "b".
		expect(diagnostics).toEqual([]);
	});

	it("packs callouts clear of ordinary inline edge labels", () => {
		const inline: SolvedTextAnnotation = {
			...required("c", "inline label", {
				x: 120,
				y: 8,
				width: 240,
				height: 40,
			}),
		};
		delete (inline as { placement?: string }).placement;
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 }), inline],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 400, height: 120 },
			},
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["a"]);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		if (callout === undefined) return;
		const box = inline.box;
		const overlaps =
			callout.x < box.x + box.width &&
			box.x < callout.x + callout.width &&
			callout.y < box.y + box.height &&
			box.y < callout.y + callout.height;
		expect(overlaps).toBe(false);
	});

	it("starts an unbounded shelf right of protruding inline labels", () => {
		const inline: SolvedTextAnnotation = {
			...required("c", "inline label", { x: 90, y: 0, width: 160, height: 20 }),
		};
		delete (inline as { placement?: string }).placement;
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 }), inline],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
		);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		expect(callout?.x ?? 0).toBeGreaterThanOrEqual(250);
	});

	it("keeps a key off the inline label that forced its callout", () => {
		const inline: SolvedTextAnnotation = {
			...required("c", "inline label", { x: 36, y: 20, width: 40, height: 14 }),
		};
		delete (inline as { placement?: string }).placement;
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 30, y: 20, width: 40, height: 14 }), inline],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				routes: new Map([
					[
						"a",
						[
							{ x: 10, y: 27 },
							{ x: 200, y: 27 },
						],
					],
				]),
			},
		);
		const key = built[0]?.callout.keyBox;
		expect(key).toBeDefined();
		if (key === undefined) return;
		const box = inline.box;
		const overlaps =
			key.x < box.x + box.width &&
			box.x < key.x + key.width &&
			key.y < box.y + box.height &&
			box.y < key.y + key.height;
		expect(overlaps).toBe(false);
	});

	it("starts an unbounded shelf right of protruding obstacles", () => {
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{ obstacles: [{ x: 95, y: 20, width: 60, height: 12 }] },
		);
		expect(built[0]?.callout.calloutBox.x ?? 0).toBeGreaterThanOrEqual(155);
	});
});
