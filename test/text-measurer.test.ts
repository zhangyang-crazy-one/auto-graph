import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import type { TextStyleOptions } from "../src/text/index.js";
import {
	createDefaultTextMeasurer,
	DeterministicTextMeasurer,
	installNodeCanvasRuntime,
	isPretextRuntimeAvailable,
	PretextTextMeasurer,
} from "../src/text/index.js";

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

		expect(() =>
			measurer.prepare("x", { ...style, fontSize: Number.NaN }),
		).toThrow(/finite|positive|width/i);
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

	it("uses Pretext as the default text measurer when the runtime supports it", () => {
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		class TestOffscreenCanvas {
			getContext(contextId: string) {
				return contextId === "2d"
					? {
							measureText: (text: string) => ({
								width: text.length * style.fontSize * 0.5,
							}),
						}
					: null;
			}
		}
		globalThis.OffscreenCanvas =
			TestOffscreenCanvas as unknown as typeof globalThis.OffscreenCanvas;

		try {
			const prepared = createDefaultTextMeasurer().prepare("Hello", style);

			expect(prepared.backend).toBe("pretext");
			expect(globalThis.OffscreenCanvas).toBe(TestOffscreenCanvas);
		} finally {
			globalThis.OffscreenCanvas = originalOffscreenCanvas;
		}
	});

	it("uses Pretext as the default text measurer in a normal Node CLI runtime", () => {
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		globalThis.OffscreenCanvas =
			undefined as unknown as typeof globalThis.OffscreenCanvas;

		try {
			expect(typeof globalThis.OffscreenCanvas).toBe("undefined");

			const prepared = createDefaultTextMeasurer().prepare("Hello", style);

			expect(prepared.backend).toBe("pretext");
		} finally {
			globalThis.OffscreenCanvas = originalOffscreenCanvas;
		}
	});

	it("ends a line at an authored line break", () => {
		installNodeCanvasRuntime();
		const measurer = createDefaultTextMeasurer();
		const prepared = measurer.prepare("核验来源\n版本与授权", style);
		// Wide enough for both lines on one: the break still ends the first.
		const layout = measurer.layout(prepared, 1000, 20);
		expect(layout.lines.map((line) => line.text.trim())).toEqual([
			"核验来源",
			"版本与授权",
		]);
	});

	it("draws authored line breaks as lines in every format", () => {
		const source = `nodes:
  a: { label: "核验来源\\n版本与授权" }
  b: { label: B }
edges:
  - a -> b
`;
		const svg = renderDiagramDsl(source, { format: "svg" }).content ?? "";
		expect(svg).toMatch(/<tspan[^>]*>核验来源<\/tspan>/);
		expect(svg).toMatch(/<tspan[^>]*>版本与授权<\/tspan>/);
		const drawio = renderDiagramDsl(source, { format: "drawio" }).content;
		expect(drawio).toContain('value="核验来源&lt;br&gt;版本与授权"');
	});

	it("preserves deterministic fallback when Node canvas installation fails", () => {
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		globalThis.OffscreenCanvas =
			undefined as unknown as typeof globalThis.OffscreenCanvas;

		try {
			const installed = installNodeCanvasRuntime(() => {
				throw new Error("canvas unavailable");
			});
			const prepared = createDefaultTextMeasurer({
				installNodeCanvasRuntime: () => installed,
			}).prepare("Hello", style);

			expect(installed).toBe(false);
			expect(prepared.backend).toBe("deterministic");
		} finally {
			globalThis.OffscreenCanvas = originalOffscreenCanvas;
		}
	});
});

describe("Pretext line breaks", () => {
	it("keep a Latin word after an opening bracket whole", () => {
		const measurer = createDefaultTextMeasurer();
		const prepared = measurer.prepare("求人员明确确认已阅（FUN-144/BR-19）。", {
			fontFamily: '"Noto Sans CJK SC", sans-serif',
			fontSize: 13,
			lineHeight: 18,
		});
		for (let width = 100; width <= 200; width += 5) {
			const lines = measurer.layout(prepared, width, 18).lines;
			lines.slice(1).forEach((line, index) => {
				const before = lines[index]?.text.at(-1) ?? "";
				expect(`${before}|${line.text[0]}`).not.toMatch(
					/[A-Za-z0-9]\|[A-Za-z0-9]/,
				);
				expect(line.text[0]).not.toMatch(/[）。]/);
			});
		}
	});
});

describe("Pretext authored line breaks", () => {
	const measurer = createDefaultTextMeasurer();
	const style = { fontFamily: "Arial", fontSize: 16, lineHeight: 20 };
	const lines = (text: string) =>
		measurer
			.layout(measurer.prepare(text, style), 1000, 20)
			.lines.map((line) => line.text.trim());

	it("keep the author's lines when the width is ample", () => {
		expect(lines("Hello world\nNext line")).toEqual([
			"Hello world",
			"Next line",
		]);
		expect(lines("你好\n）test")).toEqual(["你好", "）test"]);
		expect(lines("Alpha\r\nBeta")).toEqual(["Alpha", "Beta"]);
		expect(lines("One\n\nThree")).toEqual(["One", "", "Three"]);
	});
});
