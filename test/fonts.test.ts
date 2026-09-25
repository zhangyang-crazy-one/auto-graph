import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import {
	fontFileFamilies,
	installNodeCanvasRuntime,
	PretextTextMeasurer,
	registerFonts,
} from "../src/text/index.js";

const LIBERATION =
	"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";
const WENQUANYI = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

describe("font files", () => {
	it.skipIf(!existsSync(LIBERATION))("reads family names from a TTF", () => {
		expect(fontFileFamilies(LIBERATION)).toEqual(["Liberation Sans"]);
	});

	it.skipIf(!existsSync(WENQUANYI))(
		"reads every family of a collection",
		() => {
			expect(fontFileFamilies(WENQUANYI)[0]).toBe("WenQuanYi Zen Hei");
		},
	);

	it("returns no family for unreadable files", () => {
		expect(fontFileFamilies("/does/not/exist.ttf")).toEqual([]);
	});

	it("throws for a file the canvas cannot load", () => {
		expect(() => registerFonts(["/does/not/exist.ttf"])).toThrow(
			/Cannot load font file/,
		);
	});

	it.skipIf(!existsSync(WENQUANYI))(
		"measures with a registered CJK font exactly",
		() => {
			const [font] = registerFonts([WENQUANYI]);
			expect(font?.cjk).toBe(true);
			installNodeCanvasRuntime();
			const measurer = new PretextTextMeasurer();
			const style = { fontFamily: "'WenQuanYi Zen Hei'", fontSize: 14 };
			expect(measurer.naturalWidth(measurer.prepare("订单服务", style))).toBe(
				56,
			);
		},
	);

	it.skipIf(!existsSync(WENQUANYI))(
		"puts a registered CJK family first in the output font stack",
		() => {
			const result = renderDiagramDsl(
				"nodes:\n  a: { label: 订单服务 }\n  b: { label: 支付 }\nedges:\n  - a -> b\n",
				{ fonts: [WENQUANYI] },
			);
			expect(result.content).toContain("font-family=\"'WenQuanYi Zen Hei', ");
		},
	);

	it("reports an unreadable font as an io diagnostic", () => {
		const result = renderDiagramDsl("nodes:\n  a: { label: A }\n", {
			fonts: ["/does/not/exist.ttf"],
		});
		expect(result.content).toBeUndefined();
		expect(result.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "io.font.unreadable",
		});
	});
});
