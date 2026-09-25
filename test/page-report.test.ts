import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import { buildAgentReport } from "../src/report/index.js";
import { resolvePage } from "../src/solver/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";
import { generateSyntheticDsl } from "./support/synthetic.js";

const LONG_FLOW = readFileSync(
	new URL("fixtures/benchmark/cn-long-flow.yaml", import.meta.url),
	"utf8",
);

function render(source: string, page?: Parameters<typeof resolvePage>[0]) {
	return renderDiagramDsl(source, {
		format: "svg",
		textMeasurer: new DeterministicTextMeasurer(),
		...(page === undefined ? {} : { page }),
	});
}

describe("page sizes", () => {
	it("reads presets, orientations and custom sizes", () => {
		expect(resolvePage("A4")).toEqual({
			page: {
				name: "a4",
				width: 794,
				height: 1123,
				orientation: "auto",
				margin: 24,
				direction: "keep",
			},
		});
		expect(resolvePage("a3-landscape")).toMatchObject({
			page: { name: "a3", orientation: "landscape" },
		});
		expect(resolvePage("A4 portrait")).toMatchObject({
			page: { orientation: "portrait" },
		});
		expect(resolvePage("slide")).toMatchObject({
			page: { width: 1280, height: 720, orientation: "landscape" },
		});
		expect(resolvePage("1200x800")).toMatchObject({
			page: { width: 1200, height: 800, orientation: "landscape" },
		});
		expect(
			resolvePage({ size: "letter", margin: 10, direction: "auto" }),
		).toMatchObject({ page: { margin: 10, direction: "auto" } });
	});

	it("rejects unknown sizes and margins that leave no room", () => {
		expect(resolvePage("B7")).toMatchObject({
			error: expect.stringContaining("Unknown page size"),
		});
		expect(resolvePage({ size: "A5", margin: 400 })).toMatchObject({
			error: expect.stringContaining("no room"),
		});
		expect(resolvePage({})).toMatchObject({
			error: expect.stringContaining("needs a size"),
		});
	});
});

describe("page fitting", () => {
	it("folds a long flow to the page's shape", () => {
		const loose = render(LONG_FLOW);
		const fitted = render(LONG_FLOW, "A4");
		const page = fitted.page;
		expect(page).toBeDefined();
		if (page === undefined || loose.diagram === undefined) return;
		// Folded for the page: drawn much larger than the loose layout would be.
		const looseScale = Math.min(
			(page.width - 48) / loose.diagram.bounds.width,
			(page.height - 48) / loose.diagram.bounds.height,
		);
		expect(page.scale).toBeGreaterThan(looseScale * 1.2);
		expect(page.readable).toBe(true);
		expect(page.candidates).toHaveLength(2);
		expect(fitted.content).toContain(`width="${page.width}"`);
		expect(fitted.content).toContain(`height="${page.height}"`);
	});

	it("tries both flow directions with direction: auto", () => {
		const fitted = render(LONG_FLOW, { size: "A4", direction: "auto" });
		const directions = new Set(
			fitted.page?.candidates.map((candidate) => candidate.direction),
		);
		expect([...directions].sort()).toEqual(["LR", "TB"]);
	});

	it("keeps a small diagram at its natural size", () => {
		const fitted = render(
			"nodes: { a: { label: A }, b: { label: B } }\nedges: [a -> b]\n",
			"A4",
		);
		expect(fitted.page?.scale).toBe(1);
		expect(fitted.page?.comfortable).toBe(true);
	});

	it("takes the page from the document, also through a view", () => {
		const document = render(
			"view: tree\npage: slide\nroot: { 公司: [财务, 技术] }\n",
		);
		expect(document.page?.name).toBe("slide");
		const invalid = render("nodes: { a: { label: A } }\npage: B7\n");
		expect(invalid.diagnostics.map((d) => d.code)).toContain(
			"validate.page.invalid",
		);
	});
});

describe("agent report", () => {
	it("says ok for a clean diagram and leaves out informational noise", () => {
		const result = render(
			"view: flowchart\nflow:\n  - 开始 -> 提交 -> 结束\n",
			"A4",
		);
		expect(
			result.diagnostics.some((diagnostic) => diagnostic.severity === "info"),
		).toBe(true);
		const report = buildAgentReport({
			diagram: result.diagram,
			diagnostics: result.diagnostics,
			page: result.page,
		});
		expect(report.verdict).toBe("ok");
		expect(report.issues).toEqual([]);
		expect(report.summary).toMatch(/^Ready: 3 nodes, 2 edges/);
		expect(report.page).toMatchObject({ size: "A4", readable: true });
	});

	it("fails with located fixes when the source is wrong", () => {
		const result = render(
			"view: flowchart\nsteps: { review: 审核 }\nflow:\n  - reveiw -> 结束\n",
		);
		const report = buildAgentReport({
			diagram: result.diagram,
			diagnostics: result.diagnostics,
		});
		expect(report.verdict).toBe("fail");
		expect(report.issues[0]).toMatchObject({
			severity: "error",
			code: "view.flowchart.unknown-node",
			where: "flow.0",
			fix: expect.stringContaining('"review"'),
		});
		expect(report.metrics).toBeUndefined();
	});

	it("reports layout defects as issues", () => {
		const result = render(
			"layout: { mode: positions }\nnodes:\n  a: { label: A, position: { x: 0, y: 0 } }\n  b: { label: B, position: { x: 10, y: 5 } }\n",
		);
		const report = buildAgentReport({
			diagram: result.diagram,
			diagnostics: result.diagnostics,
		});
		expect(report.metrics?.defects.nodeOverlaps).toBeGreaterThan(0);
		expect(report.issues.map((issue) => issue.code)).toContain(
			"quality.node-overlap",
		);
		expect(report.verdict).toBe("fail");
	});

	it("flags an unreadable page and suggests how to split", () => {
		const source = generateSyntheticDsl({
			seed: 3,
			nodes: 120,
			kind: "architecture",
		});
		const result = render(source, "A5");
		const report = buildAgentReport({
			diagram: result.diagram,
			diagnostics: result.diagnostics,
			page: result.page,
		});
		expect(report.page?.readable).toBe(false);
		expect(report.verdict).toBe("fail");
		expect(report.issues.map((issue) => issue.code)).toContain(
			"page.unreadable",
		);
		expect(report.suggestions[0]).toMatch(/^Split into about \d+ page\(s\)/);
	});
});
