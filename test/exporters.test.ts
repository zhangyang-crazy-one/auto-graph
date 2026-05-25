import { describe, expect, it } from "vitest";
import { computeArrowhead, exportSvg } from "../src/exporters/index.js";
import type { CoordinatedDiagram, LabelLayout } from "../src/index.js";

describe("exporters", () => {
	it("computes arrowhead geometry from the final non-zero segment", () => {
		const arrowhead = computeArrowhead([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 20 },
		]);

		expect(arrowhead.tip).toEqual({ x: 10, y: 20 });
		expect(arrowhead.direction).toEqual({ x: 0, y: 1 });
		expect(arrowhead.left).toEqual({ x: 6, y: 10 });
		expect(arrowhead.right).toEqual({ x: 14, y: 10 });
	});

	it("throws when no non-zero segment exists", () => {
		expect(() =>
			computeArrowhead([
				{ x: 2, y: 3 },
				{ x: 2, y: 3 },
			]),
		).toThrow("Arrowhead requires at least one non-zero segment");
	});

	it("exports standalone SVG shapes, labels, groups, edges, and arrowhead polygons", () => {
		const diagram = createCoordinatedDiagram();
		const svg = exportSvg(diagram, { title: "Export <Check>" });

		expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('role="img"');
		expect(svg).toContain('viewBox="0 0 520 360"');
		expect(svg).toContain("<title>Export &lt;Check&gt;</title>");
		expect(svg).toContain('class="group"');
		expect(svg).toContain('class="node node-rectangle"');
		expect(svg).toContain("node-rounded-rectangle");
		expect(svg).toContain("node-ellipse");
		expect(svg).toContain("node-diamond");
		expect(svg).toContain("node-parallelogram");
		expect(svg).toContain("node-hexagon");
		expect(svg).toContain("node-cylinder");
		expect(svg).toContain("<tspan");
		expect(svg).toContain("Alpha &amp; Beta");
		expect(svg).toContain('d="M 80 60 L 180 60 L 180 130"');
		expect(svg).toContain('class="edge-arrowhead"');
		expect(svg).toContain('points="180,130 176,120 184,120"');
	});
});

function createCoordinatedDiagram(): CoordinatedDiagram {
	const labelLayout = createLabelLayout("Alpha & Beta", {
		x: 12,
		y: 24,
		width: 96,
		height: 20,
	});

	return {
		id: "svg-export",
		direction: "LR",
		nodes: [
			{
				id: "rectangle",
				shape: "rectangle",
				label: { text: "Alpha & Beta" },
				labelLayout,
				box: { x: 10, y: 20, width: 120, height: 60 },
				anchors: [],
			},
			{
				id: "rounded",
				shape: "rounded-rectangle",
				label: { text: "Rounded" },
				box: { x: 170, y: 20, width: 120, height: 60 },
				anchors: [],
			},
			{
				id: "ellipse",
				shape: "ellipse",
				label: { text: "Ellipse" },
				box: { x: 330, y: 20, width: 120, height: 60 },
				anchors: [],
			},
			{
				id: "diamond",
				shape: "diamond",
				label: { text: "Diamond" },
				box: { x: 10, y: 130, width: 120, height: 70 },
				anchors: [],
			},
			{
				id: "parallelogram",
				shape: "parallelogram",
				label: { text: "Para" },
				box: { x: 170, y: 130, width: 120, height: 70 },
				anchors: [],
			},
			{
				id: "hexagon",
				shape: "hexagon",
				label: { text: "Hex" },
				box: { x: 330, y: 130, width: 120, height: 70 },
				anchors: [],
			},
			{
				id: "cylinder",
				shape: "cylinder",
				label: { text: "DB" },
				box: { x: 170, y: 250, width: 120, height: 70 },
				anchors: [],
			},
		],
		edges: [
			{
				id: "edge-a-b",
				source: { nodeId: "rectangle" },
				target: { nodeId: "parallelogram" },
				points: [
					{ x: 80, y: 60 },
					{ x: 180, y: 60 },
					{ x: 180, y: 130 },
				],
			},
		],
		groups: [
			{
				id: "group-a",
				label: { text: "Group" },
				nodeIds: ["rectangle", "rounded", "ellipse"],
				groupIds: [],
				padding: { top: 12, right: 12, bottom: 12, left: 12 },
				box: { x: 0, y: 0, width: 470, height: 110 },
			},
		],
		diagnostics: [],
		bounds: { x: 0, y: 0, width: 520, height: 360 },
	};
}

function createLabelLayout(text: string, box: LabelLayout["box"]): LabelLayout {
	return {
		text,
		box,
		contentBox: box,
		naturalSize: { width: box.width, height: box.height },
		fittedSize: { width: box.width, height: box.height },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		font: { fontFamily: "Arial", fontSize: 14, lineHeight: 18 },
		lineHeight: 18,
		lines: [
			{
				text,
				box,
				baselineY: box.y + 15,
				width: box.width,
				lineIndex: 0,
			},
		],
		overflow: { horizontal: false, vertical: false, truncated: false },
		diagnostics: [],
	};
}
