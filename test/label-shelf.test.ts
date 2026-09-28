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
});
