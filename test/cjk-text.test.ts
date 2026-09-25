import { describe, expect, it } from "vitest";
import {
	cjkAwareWidth,
	fontFamiliesOf,
	isCjkFontStack,
	LATIN_IN_CJK_SCALE,
} from "../src/text/cjk-width.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

const style = { fontFamily: "sans-serif", fontSize: 10 };

function lines(text: string, maxWidth: number): string[] {
	const measurer = new DeterministicTextMeasurer();
	return measurer
		.layout(measurer.prepare(text, style), maxWidth)
		.lines.map((line) => line.text);
}

describe("CJK-aware width", () => {
	it("counts full-width characters as 1 em without a real CJK font", () => {
		const options = {
			measure: () => {
				throw new Error("no Latin run expected");
			},
			trustFullWidth: false,
			latinScale: 1,
		};
		expect(cjkAwareWidth("订单服务", 14, options)).toBe(56);
		expect(cjkAwareWidth("カタカナ한국，。", 14, options)).toBe(112);
	});

	it("uses the backend for full-width runs when it has a real CJK font", () => {
		const measure = (run: string) => Array.from(run).length * 13;
		expect(
			cjkAwareWidth("订单", 14, {
				measure,
				trustFullWidth: true,
				latinScale: 1,
			}),
		).toBe(26);
	});

	it("measures Latin runs with the backend, scaled as asked", () => {
		const measure = (run: string) => run.length * 5;
		expect(
			cjkAwareWidth("订单 Order", 10, {
				measure,
				trustFullWidth: false,
				latinScale: 1,
			}),
		).toBe(20 + 30);
		expect(
			cjkAwareWidth("订单 Order", 10, {
				measure,
				trustFullWidth: false,
				latinScale: LATIN_IN_CJK_SCALE,
			}),
		).toBeCloseTo(20 + 30 * LATIN_IN_CJK_SCALE);
	});

	it("reads the family list of a CSS font", () => {
		expect(
			fontFamiliesOf("400 14px 'Microsoft YaHei', \"PingFang SC\", sans-serif"),
		).toEqual(["Microsoft YaHei", "PingFang SC", "sans-serif"]);
	});

	it("recognises CJK font stacks", () => {
		expect(isCjkFontStack("400 14px 'Microsoft YaHei', sans-serif")).toBe(true);
		expect(isCjkFontStack("400 14px 'Noto Sans CJK SC'")).toBe(true);
		expect(isCjkFontStack("400 14px Arial, sans-serif")).toBe(false);
	});
});

describe("deterministic line breaking", () => {
	it("measures CJK as 1 em", () => {
		const measurer = new DeterministicTextMeasurer();
		expect(measurer.naturalWidth(measurer.prepare("订单服务", style))).toBe(40);
		expect(measurer.naturalWidth(measurer.prepare("Order", style))).toBe(30);
	});

	it("never starts a line with closing punctuation", () => {
		for (const line of lines("订单服务，支付服务。退款（部分）完成", 45).slice(
			1,
		)) {
			expect("，。）」』】》".includes(line[0] as string)).toBe(false);
		}
	});

	it("never ends a line with opening punctuation", () => {
		for (const line of lines("进入（订单）与「支付」流程", 25)) {
			expect("（「『【《".includes(line.at(-1) as string)).toBe(false);
		}
	});

	it("keeps Latin words whole and breaks between CJK characters", () => {
		expect(lines("用户中心User Service", 45)).toEqual([
			"用户中心",
			"User",
			"Service",
		]);
		expect(lines("Order Service 订单服务", 90)).toEqual([
			"Order Service",
			"订单服务",
		]);
	});

	it("splits a word longer than the line by character", () => {
		expect(lines("Supercalifragilistic", 50)).toEqual([
			"Supercal",
			"ifragili",
			"stic",
		]);
	});
});
