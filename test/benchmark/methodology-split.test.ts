import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../../src/dsl/index.js";
import type { Box } from "../../src/ir/index.js";

const FIXTURE_DIR = new URL("../fixtures/evidence-blocks/", import.meta.url);
const BASELINE_DIR = new URL(
	"../../.planning/phases/07-add-evidence-blocks-for-matrices-tables-and-panels/review-evidence/methodology-split-svg/",
	import.meta.url,
);

describe("methodology-split benchmark", () => {
	it.each([
		"01-method-chain.yaml",
		"04-traceability-spine.yaml",
		"05-structure-parameter-extraction.yaml",
	])("renders %s end-to-end with zero diagnostics", (name) => {
		const result = renderFixture(name);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain("<svg");
		expect(result.diagram).toBeDefined();
		expect(
			result.diagnostics.map((diagnostic) => diagnostic.code),
		).not.toContain("routing.evidence.crossing_forbidden");
	});

	it("acceptance 1: matrix regions are not crossed by routed edges", () => {
		const result = renderFixture("04-traceability-spine.yaml");
		const matrices = (result.diagram?.matrices ?? []) as unknown as Array<{
			box: Box;
		}>;
		const edgeSegments = result.diagram?.edges.flatMap((edge) =>
			segments(edge.points ?? []),
		);

		expect(result.diagnostics).toEqual([]);
		expect(matrices).toHaveLength(2);
		for (const segment of edgeSegments ?? []) {
			for (const matrix of matrices) {
				expect(segmentIntersectsBox(segment, matrix.box)).toBe(false);
			}
		}
	});

	it("acceptance 2: table column alignment is stable and rendered from solver offsets", () => {
		const result = renderFixture("05-structure-parameter-extraction.yaml");
		const table = result.diagram?.tables?.find(
			(block) => block.id === "block-value-properties-table",
		) as { columnXOffsets?: number[] } | undefined;
		const svg = result.content ?? "";
		const renderedOffsets = extractTableHeaderOffsets(
			svg,
			"block-value-properties-table",
		);

		expect(result.diagnostics).toEqual([]);
		expect(table?.columnXOffsets).toEqual(renderedOffsets);
	});

	it("acceptance 3: evidence panels occupy distinct left and bottom page regions", () => {
		const result = renderFixture("01-method-chain.yaml");
		const panels = (result.diagram?.evidencePanels ?? []) as unknown as Array<{
			id: string;
			box: Box;
		}>;
		const left = panels.find(
			(panel) => panel.id === "left-classification-legend",
		);
		const bottom = panels.find((panel) => panel.id === "behavior-triad-note");
		const gridLeft = Math.min(
			...(result.diagram?.nodes ?? []).map((node) => node.box.x),
		);
		const gridBottom = Math.max(
			...(result.diagram?.nodes ?? []).map(
				(node) => node.box.y + node.box.height,
			),
		);

		expect(result.diagnostics).toEqual([]);
		expect(left?.box.x).toBeLessThan(gridLeft);
		expect(bottom?.box.y).toBeGreaterThan(gridBottom);
	});

	it.each([
		{
			name: "01-method-chain.yaml",
			matrixCount: 0,
			tableCount: 0,
			panelCount: 3,
		},
		{
			name: "04-traceability-spine.yaml",
			matrixCount: 2,
			tableCount: 0,
			panelCount: 1,
		},
		{
			name: "05-structure-parameter-extraction.yaml",
			matrixCount: 2,
			tableCount: 2,
			panelCount: 1,
		},
	])("acceptance 4: $name renders non-stub PR-B structure", ({
		name,
		matrixCount,
		tableCount,
		panelCount,
	}) => {
		const result = renderFixture(name);
		const svg = result.content ?? "";

		expect(result.diagnostics).toEqual([]);
		expect(svgGroupClassCount(svg, "matrix-block")).toBe(matrixCount);
		expect(svgGroupClassCount(svg, "table-block")).toBe(tableCount);
		expect(svgGroupClassCount(svg, "evidence-panel")).toBe(panelCount);
		for (const matrix of result.diagram?.matrices ?? []) {
			const matrixSvg = svgGroupByDataId(svg, matrix.id);
			expect(svgClassCount(matrixSvg, "matrix-cell")).toBe(
				matrix.rows.length * matrix.cols.length,
			);
			expect(matrixSvg).toMatch(
				/<text class="matrix-cell-label"[^>]*>[^<]+<\/text>/,
			);
		}
		for (const table of result.diagram?.tables ?? []) {
			const tableSvg = svgGroupByDataId(svg, table.id);
			expect(tableSvg).toContain(`data-column-count="${table.columns.length}"`);
			expect(svgClassCount(tableSvg, "table-header-cell")).toBe(
				table.columns.length,
			);
		}
	});

	it.each([
		["01-method-chain.yaml", "01-method-chain.svg"],
		["04-traceability-spine.yaml", "04-traceability-spine.svg"],
		[
			"05-structure-parameter-extraction.yaml",
			"05-structure-parameter-extraction.svg",
		],
	])("baseline SVG for %s is byte-stable", (fixtureName, baselineName) => {
		const result = renderFixture(fixtureName);
		const baseline = readFileSync(
			join(BASELINE_DIR.pathname, baselineName),
			"utf8",
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toBe(baseline);
	});
});

function renderFixture(name: string): ReturnType<typeof renderDiagramDsl> {
	return renderDiagramDsl(readFixture(name), {
		sourcePath: fixturePath(name),
		format: "svg",
	});
}

function readFixture(name: string): string {
	return readFileSync(fixturePath(name), "utf8");
}

function fixturePath(name: string): string {
	return join(FIXTURE_DIR.pathname, name);
}

function segments(points: readonly { x: number; y: number }[]): Array<{
	start: { x: number; y: number };
	end: { x: number; y: number };
}> {
	const result: Array<{
		start: { x: number; y: number };
		end: { x: number; y: number };
	}> = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		if (start === undefined || end === undefined) {
			continue;
		}
		result.push({ start, end });
	}
	return result;
}

function segmentIntersectsBox(
	segment: { start: { x: number; y: number }; end: { x: number; y: number } },
	box: { x: number; y: number; width: number; height: number },
): boolean {
	const left = box.x;
	const right = box.x + box.width;
	const top = box.y;
	const bottom = box.y + box.height;

	if (pointInsideBox(segment.start, box) || pointInsideBox(segment.end, box)) {
		return true;
	}
	if (segment.start.x === segment.end.x) {
		return (
			segment.start.x > left &&
			segment.start.x < right &&
			rangesOverlap(segment.start.y, segment.end.y, top, bottom)
		);
	}
	if (segment.start.y === segment.end.y) {
		return (
			segment.start.y > top &&
			segment.start.y < bottom &&
			rangesOverlap(segment.start.x, segment.end.x, left, right)
		);
	}
	return false;
}

function pointInsideBox(
	point: { x: number; y: number },
	box: { x: number; y: number; width: number; height: number },
): boolean {
	return (
		point.x > box.x &&
		point.x < box.x + box.width &&
		point.y > box.y &&
		point.y < box.y + box.height
	);
}

function rangesOverlap(
	a: number,
	b: number,
	min: number,
	max: number,
): boolean {
	const low = Math.min(a, b);
	const high = Math.max(a, b);
	return high > min && low < max;
}

function svgGroupClassCount(value: string, className: string): number {
	return [...value.matchAll(/<g class="([^"]+)"/g)].filter((match) =>
		(match[1] ?? "").split(" ").includes(className),
	).length;
}

function svgClassCount(value: string, className: string): number {
	return [...value.matchAll(/class="([^"]+)"/g)].filter((match) =>
		(match[1] ?? "").split(" ").includes(className),
	).length;
}

function extractTableHeaderOffsets(svg: string, tableId: string): number[] {
	const tableMatch = new RegExp(
		`<g class="table-block" data-id="${tableId}"[\\s\\S]*?<g class="table-header"[^>]*>([\\s\\S]*?)</g>`,
	).exec(svg);
	if (tableMatch === null) {
		return [];
	}
	const header = tableMatch[1] ?? "";
	return [...header.matchAll(/class="table-header-cell"[^>]* x="([^"]+)"/g)]
		.map((match) => Number(match[1]))
		.filter((value) => Number.isFinite(value));
}

function svgGroupByDataId(value: string, id: string): string {
	const start = value.indexOf(`data-id="${id}"`);
	if (start < 0) {
		return "";
	}
	const groupStart = value.lastIndexOf("<g", start);
	const nextGroupStart = value.indexOf("\n  <g ", start);
	const groupEnd =
		nextGroupStart < 0 ? value.indexOf("</svg>", start) : nextGroupStart;
	return value.slice(groupStart, groupEnd);
}
