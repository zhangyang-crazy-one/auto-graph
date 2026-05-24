import { describe, expect, it } from "vitest";
import { DeterministicTextMeasurer } from "../src/text/index.js";
import {
	LabelFitter,
	fitLabel,
	type LabelLayout,
} from "../src/labels/index.js";

const measurer = new DeterministicTextMeasurer();
const font = {
	fontFamily: "Inter",
	fontSize: 16,
	fontWeight: 400,
	lineHeight: 20,
};

describe("label fitting", () => {
	it("fits padding and minimum size into local label geometry", () => {
		const layout = fitLabel(
			"Deploy API",
			{
				font,
				padding: 8,
				minSize: { width: 80, height: 40 },
			},
			measurer,
		);

		expect(layout.box).toEqual({ x: 0, y: 0, width: 112, height: 40 });
		expect(layout.contentBox).toEqual({ x: 8, y: 8, width: 96, height: 24 });
		expect(layout.fittedSize).toEqual({ width: 112, height: 40 });
		expect(layout.naturalSize).toEqual({ width: 96, height: 20 });
		expect(layout.lines[0]?.box).toEqual({ x: 8, y: 8, width: 96, height: 20 });
	});

	it("wraps long labels within maxWidth", () => {
		const layout = new LabelFitter(measurer).fit(
			"Long deployment status message",
			{
				font,
				padding: 8,
				maxWidth: 120,
			},
		);

		expect(layout.box.width).toBeLessThanOrEqual(120);
		expect(layout.lines.length).toBeGreaterThan(1);
		for (const line of layout.lines) {
			expect(line.box.width).toBeLessThanOrEqual(layout.contentBox.width);
		}
	});

	it("keeps multiline and non-English labels as finite line records", () => {
		const layout = fitLabel(
			"服务入口\nمرحبا",
			{
				font,
				padding: { top: 4, right: 6, bottom: 4, left: 6 },
				maxWidth: 120,
			},
			measurer,
		);

		expect(layout.lines.length).toBeGreaterThanOrEqual(2);
		expect(layout.diagnostics).toEqual([]);
		for (const line of layout.lines) {
			expect(Number.isFinite(line.width)).toBe(true);
			expect(line.sourceStart).toEqual(
				expect.objectContaining({
					segmentIndex: expect.any(Number),
					graphemeIndex: expect.any(Number),
				}),
			);
			expect(line.sourceEnd).toEqual(
				expect.objectContaining({
					segmentIndex: expect.any(Number),
					graphemeIndex: expect.any(Number),
				}),
			);
		}
	});

	it("rejects invalid numeric fitting options", () => {
		expect(() => fitLabel("x", { font, padding: -1 }, measurer)).toThrow(
			TypeError,
		);
		expect(() =>
			fitLabel(
				"x",
				{ font, padding: 0, minSize: { width: Number.NaN } },
				measurer,
			),
		).toThrow(TypeError);
		expect(() =>
			fitLabel("x", { font, padding: 0, maxWidth: -1 }, measurer),
		).toThrow(TypeError);
		expect(() =>
			fitLabel(
				"x",
				{ font: { ...font, lineHeight: 0 }, padding: 0 },
				measurer,
			),
		).toThrow(TypeError);
	});

	it("diagnoses overflow when constraints cannot be satisfied", () => {
		const layout = fitLabel(
			"Overflow",
			{
				font,
				padding: 8,
				minSize: { width: 20, height: 10 },
				maxWidth: 20,
				overflow: "diagnose",
			},
			measurer,
		);

		expect(layout.overflow.horizontal).toBe(true);
		expect(layout.overflow.vertical).toBe(true);
		expect(layout.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining([
				"label.overflow.horizontal",
				"label.overflow.vertical",
			]),
		);
	});

	it("returns renderer-neutral records", () => {
		const layout = fitLabel("Neutral", { font, padding: 2 }, measurer);
		const forbidden = new Set([
			["s", "vg"].join(""),
			["ht", "ml"].join(""),
			["c", "ss"].join(""),
			["can", "vas"].join(""),
			["excali", "draw"].join(""),
			["mer", "maid"].join(""),
			["draw", "io"].join(""),
		]);

		expect(hasForbiddenKeys(layout, forbidden)).toBe(false);
	});
});

function hasForbiddenKeys(layout: LabelLayout, forbidden: Set<string>): boolean {
	const keys = [
		...Object.keys(layout),
		...layout.lines.flatMap((line) => Object.keys(line)),
	];

	return keys.some((key) => forbidden.has(key.toLowerCase()));
}
