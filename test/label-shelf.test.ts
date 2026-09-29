import { describe, expect, it } from "vitest";
import type { SolvedTextAnnotation } from "../src/ir/index.js";
import { solveDiagram } from "../src/solver/index.js";
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
				// "b"'s label sits clear below: only its key is crowded out.
				required("b", "second", { x: 60, y: 44, width: 24, height: 14 }),
			],
			{ x: 0, y: 0, width: 100, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				// A node covers "b"'s own spot.
				keyObstacles: [{ x: 55, y: 40, width: 40, height: 25 }],
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

	it("keeps later keys off a label whose key was blocked", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		// "a"'s key is blocked (its short route lies inside a node), so its
		// label stays inline; "b"'s key starts on that label and must move.
		const built = buildExternalLabelCallouts(
			[
				required("a", "first", { x: 100, y: 20, width: 60, height: 14 }),
				required("b", "second", { x: 110, y: 20, width: 40, height: 14 }),
			],
			{ x: 0, y: 0, width: 300, height: 60 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				keyObstacles: [{ x: 120, y: 0, width: 20, height: 60 }],
				routes: new Map([
					[
						"a",
						[
							{ x: 128, y: 27 },
							{ x: 132, y: 27 },
						],
					],
					[
						"b",
						[
							{ x: 60, y: 27 },
							{ x: 240, y: 27 },
						],
					],
				]),
			},
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["b"]);
		const key = built[0]?.callout.keyBox;
		expect(key).toBeDefined();
		if (key === undefined) return;
		const label = { x: 100, y: 20, width: 60, height: 14 };
		const overlaps =
			key.x < label.x + label.width &&
			label.x < key.x + key.width &&
			key.y < label.y + label.height &&
			label.y < key.y + key.height;
		expect(overlaps).toBe(false);
	});

	it("tries the free page to the right before columns across the drawing", () => {
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 800, height: 120 },
			},
			// The column right beside the content is taken.
			{ obstacles: [{ x: 100, y: 0, width: 120, height: 120 }] },
		);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		expect(callout?.x ?? 0).toBeGreaterThanOrEqual(220);
	});

	it("does not place a callout wider than the usable page", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[
				required("a", Array.from({ length: 30 }, () => "wide").join(" "), {
					x: 20,
					y: 40,
					width: 40,
					height: 14,
				}),
			],
			{ x: 0, y: 0, width: 60, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 80, height: 400 },
			},
			{ diagnostics },
		);
		expect(built).toEqual([]);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"routing.label-shelf.capacity_exhausted",
		);
	});

	it("keeps room on the page for the frame drawn around the callouts", () => {
		// The frame wraps every callout in its padding and title bar, so a
		// callout at the usual page inset would push the frame off the page.
		const node = (id: string, x: number, y: number) => ({
			id,
			shape: "rectangle" as const,
			size: { width: 80, height: 40 },
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			position: { x, y },
			label: { text: id },
		});
		const nodes = Array.from({ length: 5 }, (_, index) => [
			node(`s${index}`, 200, 200 + index * 70),
			node(`t${index}`, 500, 200 + index * 70),
		]).flat();
		const result = solveDiagram(
			{
				id: "framed-shelf",
				direction: "LR",
				nodes,
				edges: Array.from({ length: 20 }, (_, index) => ({
					id: `e${index}`,
					source: { nodeId: `s${index % 5}` },
					target: {
						nodeId: `t${(index * 2 + Math.floor(index / 5)) % 5}`,
					},
					label: { text: `capability dependency ${index}` },
				})),
				groups: [],
				constraints: [],
				diagnostics: [],
				frame: { kind: "sysml", titleTab: "CV-1 capability dependency view" },
			} as never,
			{
				initialLayout: "positions",
				textMeasurer: new DeterministicTextMeasurer(),
				externalLabels: true,
				remediationPolicy: { externalLabels: "auto" },
				pageBounds: { width: 1000, height: 700 },
			},
		);
		const callouts = (result.textAnnotations ?? []).filter(
			(annotation) =>
				annotation.placement === "external-callout" &&
				annotation.placementDetail?.role !== "key",
		);
		expect(callouts.length).toBeGreaterThan(0);
		expect(
			result.diagnostics.map((diagnostic) => diagnostic.code),
		).not.toContain("page_overflow");
		const frame = result.frame?.box;
		expect(frame).toBeDefined();
		if (frame === undefined) return;
		expect(frame.y).toBeGreaterThanOrEqual(0);
		expect(frame.y + frame.height).toBeLessThanOrEqual(700);
	});

	it("packs a bounded shelf inside the requested page insets", () => {
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 120, y: 140, width: 40, height: 14 })],
			{ x: 100, y: 100, width: 100, height: 100 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 400, height: 300 },
			},
			{ pageInsets: { top: 60, right: 32, bottom: 32, left: 32 } },
		);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		if (callout === undefined) return;
		expect(callout.y).toBeGreaterThanOrEqual(60);
		expect(callout.x + callout.width).toBeLessThanOrEqual(400 - 32);
		expect(callout.y + callout.height).toBeLessThanOrEqual(300 - 32);
	});

	it("moves a key out of the frame insets of a bounded page", () => {
		// The label (and so its key) starts in the top inset a frame's title
		// bar needs; its route runs down into the usable page.
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 100, y: 30, width: 40, height: 14 })],
			{ x: 60, y: 20, width: 200, height: 200 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 600, height: 400 },
			},
			{
				pageInsets: { top: 60, right: 32, bottom: 32, left: 32 },
				routes: new Map([
					[
						"a",
						[
							{ x: 120, y: 20 },
							{ x: 120, y: 220 },
						],
					],
				]),
			},
		);
		const key = built[0]?.callout.keyBox;
		expect(key).toBeDefined();
		expect(key?.y ?? 0).toBeGreaterThanOrEqual(60);
	});

	it("prefers a key spot on an unframed bounded page", () => {
		// The label sits across the top page edge; its route runs down onto
		// the page, so the key moves there.
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 100, y: -10, width: 40, height: 14 })],
			{ x: 60, y: -10, width: 200, height: 220 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 600, height: 400 },
			},
			{
				routes: new Map([
					[
						"a",
						[
							{ x: 120, y: -3 },
							{ x: 120, y: 210 },
						],
					],
				]),
			},
		);
		const key = built[0]?.callout.keyBox;
		expect(key).toBeDefined();
		expect(key?.y ?? -1).toBeGreaterThanOrEqual(0);
	});

	it("keeps a bounded callout off connector routes", () => {
		// The column beside the content is taken and an unrelated route runs
		// down through the next free one.
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 800, height: 120 },
			},
			{
				obstacles: [{ x: 100, y: 0, width: 120, height: 120 }],
				routes: new Map([
					[
						"z",
						[
							{ x: 240, y: 0 },
							{ x: 240, y: 120 },
						],
					],
				]),
			},
		);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		if (callout === undefined) return;
		const crossesRoute = callout.x < 240 && callout.x + callout.width > 240;
		expect(crossesRoute).toBe(false);
	});

	it("keeps a key's backdrop, not only its text, off a node", () => {
		const label = required("a", "short", {
			x: 100,
			y: 100,
			width: 40,
			height: 14,
		});
		const routes = new Map([
			[
				"a",
				[
					{ x: 20, y: 107 },
					{ x: 220, y: 107 },
				],
			],
		]);
		const options = { textMeasurer: new DeterministicTextMeasurer() };
		const bounds = { x: 0, y: 0, width: 240, height: 220 };
		const free = buildExternalLabelCallouts([label], bounds, options, {
			routes,
		})[0]?.callout.keyBox;
		expect(free).toBeDefined();
		if (free === undefined) return;
		// A node 1px right of the key's text box: inside its backdrop.
		const node = {
			x: free.x + free.width + 1,
			y: free.y - 20,
			width: 30,
			height: free.height + 40,
		};
		const key = buildExternalLabelCallouts([label], bounds, options, {
			routes,
			keyObstacles: [node],
		})[0]?.callout.keyBox;
		expect(key).toBeDefined();
		if (key === undefined) return;
		const backdrop = {
			x: key.x - 4,
			y: key.y - 2,
			width: key.width + 8,
			height: key.height + 4,
		};
		const overlaps =
			backdrop.x < node.x + node.width &&
			node.x < backdrop.x + backdrop.width &&
			backdrop.y < node.y + node.height &&
			node.y < backdrop.y + backdrop.height;
		expect(overlaps).toBe(false);
	});

	it("packs beside a diagonal route rather than off its bounding box", () => {
		// The column beside the content is taken, and a diagonal route's
		// bounding box covers every other column; the line itself leaves
		// room above it further right.
		const diagonal = [
			{ x: 230, y: 0 },
			{ x: 790, y: 120 },
		];
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[required("a", "short", { x: 20, y: 40, width: 40, height: 14 })],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 800, height: 120 },
			},
			{
				diagnostics,
				obstacles: [{ x: 100, y: 0, width: 120, height: 120 }],
				routes: new Map([["z", diagonal]]),
			},
		);
		const callout = built[0]?.callout.calloutBox;
		expect(callout).toBeDefined();
		expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
			"routing.label-shelf.capacity_exhausted",
		);
		if (callout === undefined) return;
		// It stays clear of the line on one side: the line's height across
		// the callout lies wholly above or wholly below it.
		const lineY = (x: number) => ((x - 230) / (790 - 230)) * 120;
		const ys = [lineY(callout.x), lineY(callout.x + callout.width)];
		const above = ys.every((y) => y < callout.y);
		const below = ys.every((y) => y > callout.y + callout.height);
		expect(above || below).toBe(true);
	});

	it("still shelves a narrow callout beside one wider than the page", () => {
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[
				required("wide", Array.from({ length: 30 }, () => "wide").join(" "), {
					x: 20,
					y: 40,
					width: 40,
					height: 14,
				}),
				required("narrow", "ok", { x: 20, y: 80, width: 20, height: 14 }),
			],
			{ x: 0, y: 0, width: 20, height: 120 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 120, height: 400 },
			},
			{ diagnostics },
		);
		// The wide one stays inline (reported); the narrow one is shelved.
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["narrow"]);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"routing.label-shelf.capacity_exhausted",
		);
	});

	it("moves an earlier key off a label that stays inline later", () => {
		// "a"'s key would sit where "b"'s label is; "b"'s key is crowded out
		// onto "a"'s key, so "b" stays inline and "a"'s key must move off it.
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const tiny = [
			{ x: 10, y: 30 },
			{ x: 14, y: 30 },
		];
		const built = buildExternalLabelCallouts(
			[
				required("a", "first", { x: 0, y: 23, width: 24, height: 14 }),
				required("b", "second", { x: 0, y: 23, width: 24, height: 14 }),
			],
			{ x: 0, y: 0, width: 200, height: 120 },
			{ textMeasurer: new DeterministicTextMeasurer() },
			{
				diagnostics,
				routes: new Map([
					[
						"a",
						[
							{ x: 12, y: 30 },
							{ x: 12, y: 110 },
						],
					],
					["b", tiny],
				]),
			},
		);
		const bLabel = { x: 0, y: 23, width: 24, height: 14 };
		const aKey = built.find((entry) => entry.callout.edgeId === "a")?.callout
			.keyBox;
		expect(aKey).toBeDefined();
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				code: "routing.label-shelf.key_blocked",
				detail: expect.objectContaining({ edgeIds: ["b"] }),
			}),
		);
		if (aKey === undefined) return;
		const overlaps =
			aKey.x < bLabel.x + bLabel.width &&
			bLabel.x < aKey.x + aKey.width &&
			aKey.y < bLabel.y + bLabel.height &&
			bLabel.y < aKey.y + aKey.height;
		expect(overlaps).toBe(false);
	});

	it("moves a key off a label the shelf had no room for", () => {
		// "b" gets a key but is too tall for the page, so it stays inline;
		// "a"'s key starts on "b"'s label and must move along "a"'s route,
		// off it.
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const bLabel = { x: 0, y: 20, width: 60, height: 14 };
		const built = buildExternalLabelCallouts(
			[
				required("a", "short", { x: 20, y: 20, width: 20, height: 14 }),
				required(
					"b",
					Array.from({ length: 40 }, () => "long").join(" "),
					bLabel,
				),
			],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 400, height: 60 },
			},
			{
				diagnostics,
				routes: new Map([
					[
						"a",
						[
							{ x: 30, y: 20 },
							{ x: 30, y: 58 },
						],
					],
					// "b"'s key finds a spot clear of "a"'s key.
					[
						"b",
						[
							{ x: 80, y: 10 },
							{ x: 80, y: 50 },
						],
					],
				]),
			},
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["a"]);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"routing.label-shelf.capacity_exhausted",
		);
		const aKey = built[0]?.callout.keyBox;
		expect(aKey).toBeDefined();
		if (aKey === undefined) return;
		const overlaps =
			aKey.x < bLabel.x + bLabel.width &&
			bLabel.x < aKey.x + aKey.width &&
			aKey.y < bLabel.y + bLabel.height &&
			bLabel.y < aKey.y + aKey.height;
		expect(overlaps).toBe(false);
	});

	it("re-spaces columns once the widest callout drops out", () => {
		// The wide callout fits the page width but is too tall for it; the
		// narrow one fits beside the content once columns stop being spaced
		// for the wide one (its single column would sit on the drawing).
		const diagnostics: import("../src/ir/index.js").Diagnostic[] = [];
		const built = buildExternalLabelCallouts(
			[
				required("wide", Array.from({ length: 40 }, () => "wide").join(" "), {
					x: 20,
					y: 20,
					width: 40,
					height: 14,
				}),
				required("narrow", "ok", { x: 20, y: 40, width: 20, height: 14 }),
			],
			{ x: 0, y: 0, width: 100, height: 60 },
			{
				textMeasurer: new DeterministicTextMeasurer(),
				pageBounds: { width: 200, height: 60 },
			},
			{ diagnostics, obstacles: [{ x: 0, y: 0, width: 100, height: 60 }] },
		);
		expect(built.map((entry) => entry.callout.edgeId)).toEqual(["narrow"]);
		expect(built[0]?.callout.calloutBox.x ?? 0).toBeGreaterThanOrEqual(100);
	});
});
