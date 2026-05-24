import { describe, expect, it } from "vitest";
import {
	DeterministicTextMeasurer,
	PretextTextMeasurer,
	isPretextRuntimeAvailable,
} from "../src/text/index.js";
import type { TextStyleOptions } from "../src/text/index.js";

const style: TextStyleOptions = {
	fontFamily: "Inter",
	fontSize: 16,
	fontWeight: 400,
};

describe("text measurement", () => {
	it("prepares deterministic text with a stable font string", () => {
		const measurer = new DeterministicTextMeasurer();
		const prepared = measurer.prepare("Hello", style);

		expect(prepared).toMatchObject({
			text: "Hello",
			style,
			backend: "deterministic",
			font: "400 16px Inter",
		});
	});

	it("lays out deterministic text repeatably", () => {
		const measurer = new DeterministicTextMeasurer();
		const prepared = measurer.prepare("Hello world from DGE", style);

		const first = measurer.layout(prepared, 60, 20);
		const second = measurer.layout(prepared, 60, 20);

		expect(first).toEqual(second);
		expect(Number.isFinite(first.width)).toBe(true);
		expect(Number.isFinite(first.height)).toBe(true);
		expect(first.width).toBeGreaterThan(0);
		expect(first.width).toBeLessThanOrEqual(60);
		expect(first.height).toBeGreaterThan(0);
		expect(first.lineHeight).toBe(20);
		expect(first.lineCount).toBeGreaterThan(0);
		expect(first.lines[0]).toMatchObject({
			text: expect.any(String),
			width: expect.any(Number),
			start: expect.objectContaining({
				segmentIndex: expect.any(Number),
				graphemeIndex: expect.any(Number),
			}),
			end: expect.objectContaining({
				segmentIndex: expect.any(Number),
				graphemeIndex: expect.any(Number),
			}),
		});
	});

	it("rejects invalid numeric text inputs", () => {
		const measurer = new DeterministicTextMeasurer();

		expect(() => measurer.prepare("x", { ...style, fontSize: Number.NaN })).toThrow(
			/finite|positive|width/i,
		);
		expect(() =>
			measurer.prepare("x", {
				...style,
				fontSize: Number.POSITIVE_INFINITY,
			}),
		).toThrow(/finite|positive|width/i);
		expect(() => measurer.prepare("x", { ...style, fontSize: -1 })).toThrow(
			/finite|positive|width/i,
		);

		const prepared = measurer.prepare("x", style);

		expect(() => measurer.layout(prepared, Number.NaN)).toThrow(
			/finite|positive|width/i,
		);
		expect(() => measurer.layout(prepared, Number.POSITIVE_INFINITY)).toThrow(
			/finite|positive|width/i,
		);
		expect(() => measurer.layout(prepared, -1)).toThrow(
			/finite|positive|width/i,
		);
		expect(() => measurer.layout(prepared, 10, 0)).toThrow(
			/finite|positive|width/i,
		);
	});

	it("guards the Pretext runtime path", () => {
		expect(typeof isPretextRuntimeAvailable()).toBe("boolean");

		if (!isPretextRuntimeAvailable()) {
			expect(() => new PretextTextMeasurer().prepare("Hello", style)).toThrow(
				/text\.pretext\.runtime-unavailable/,
			);
			return;
		}

		const prepared = new PretextTextMeasurer().prepare("Hello", style);

		expect(prepared.backend).toBe("pretext");
	});
});
