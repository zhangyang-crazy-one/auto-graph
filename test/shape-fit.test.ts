import { describe, expect, it } from "vitest";
import type { NodeShape } from "../src/ir/index.js";
import { fitLabelToShape, shapeSizeForText } from "../src/labels/index.js";
import { boxInsideShape } from "../src/quality/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

const measurer = new DeterministicTextMeasurer();
const baseOptions = {
	font: { fontFamily: "Arial", fontSize: 14, lineHeight: 18 },
	padding: { top: 12, right: 16, bottom: 12, left: 16 },
	minSize: { width: 80, height: 40 },
	maxWidth: 160,
	overflow: "diagnose" as const,
};
const SHAPES: NodeShape[] = [
	"rectangle",
	"rounded-rectangle",
	"diamond",
	"ellipse",
	"hexagon",
	"parallelogram",
	"cylinder",
];
const LABELS = [
	"Start",
	"Approved?",
	"审核订单并确认客户信用额度",
	"库存可用性检查 Stock Check",
	"MySQL 主从集群",
	"评估业务价值与优先级 Priority",
];

/** Text extent the exporters draw (single line centred, lines from boxes). */
function renderedText(result: ReturnType<typeof fitLabelToShape>) {
	const { layout } = result;
	const lines = layout.lines;
	const [line] = lines;
	if (lines.length === 1 && line !== undefined) {
		return {
			x: layout.box.x + layout.box.width / 2 - line.width / 2,
			y: layout.box.y + layout.box.height / 2 - line.box.height / 2,
			width: line.width,
			height: line.box.height,
		};
	}
	// LabelLayout lines are owner-local (same frame as layout.box).
	const xs = lines.map((line) => line.box.x);
	const top = Math.min(...lines.map((line) => line.box.y));
	const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height));
	const left = Math.min(...xs);
	const right = Math.max(...lines.map((line, i) => (xs[i] ?? 0) + line.width));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

describe("fitLabelToShape", () => {
	for (const shape of SHAPES) {
		it.each(LABELS)(`keeps "%s" inside a ${shape}`, (label) => {
			const result = fitLabelToShape(
				label,
				{ ...baseOptions, shape },
				measurer,
			);
			const nodeBox = { x: 0, y: 0, ...result.size };
			expect(boxInsideShape(renderedText(result), shape, nodeBox)).toBe(true);
			expect(result.size.width).toBeGreaterThanOrEqual(80);
			expect(result.size.height).toBeGreaterThanOrEqual(40);
		});
	}

	it("balances CJK lines instead of leaving an orphan character", () => {
		const result = fitLabelToShape(
			"审核订单并确认客户信用额度",
			{ ...baseOptions, shape: "rectangle", maxWidth: 140 },
			measurer,
		);
		const lengths = result.layout.lines.map((line) => [...line.text].length);
		expect(lengths.length).toBeGreaterThan(1);
		expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
	});

	it("centres each wrapped line inside the content box", () => {
		const result = fitLabelToShape(
			"评估业务价值与优先级 Priority",
			{ ...baseOptions, shape: "diamond" },
			measurer,
		);
		const { contentBox, lines } = result.layout;
		for (const line of lines) {
			const center = line.box.x + line.width / 2;
			// Owner-local frame: line boxes and the content box share origin.
			expect(center).toBeCloseTo(contentBox.x + contentBox.width / 2, 5);
		}
	});

	it("keeps ellipses circular and diamonds within a readable aspect", () => {
		const circle = fitLabelToShape(
			"Start",
			{ ...baseOptions, shape: "ellipse" },
			measurer,
		);
		expect(circle.size.width).toBeCloseTo(circle.size.height, 6);
		const diamond = fitLabelToShape(
			"审核订单并确认客户信用额度",
			{ ...baseOptions, shape: "diamond" },
			measurer,
		);
		expect(diamond.size.width / diamond.size.height).toBeLessThanOrEqual(2.7);
	});

	it("is deterministic", () => {
		const options = { ...baseOptions, shape: "hexagon" as const };
		expect(fitLabelToShape("API 网关 Gateway", options, measurer)).toEqual(
			fitLabelToShape("API 网关 Gateway", options, measurer),
		);
	});
});

describe("shapeSizeForText containment contract", () => {
	const padding = { top: 10, right: 10, bottom: 10, left: 10 };
	it.each([
		[40, 20],
		[120, 18],
		[60, 54],
	])("diamond contains the margin-grown %dx%d text box", (w, h) => {
		const size = shapeSizeForText("diamond", { width: w, height: h }, padding);
		// OUTLINE_MARGIN = 6 on every side.
		const mw = w + 12;
		const mh = h + 12;
		expect(mw / size.width + mh / size.height).toBeLessThanOrEqual(1 + 1e-9);
	});

	it("circle diameter covers the margin-grown diagonal", () => {
		const size = shapeSizeForText(
			"ellipse",
			{ width: 40, height: 20 },
			padding,
		);
		expect(size.width).toBeCloseTo(Math.hypot(52, 32), 9);
		expect(size.height).toBeCloseTo(size.width, 9);
	});

	it("rectangles keep the full padding", () => {
		expect(
			shapeSizeForText("rectangle", { width: 40, height: 20 }, padding),
		).toEqual({ width: 60, height: 40, labelOffsetY: 0 });
	});
});
