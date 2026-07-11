import { describe, expect, it } from "vitest";
import { normalizeDiagramDsl } from "../src/dsl/index.js";
import {
	applyEllipseCircleSize,
	resolveNodeShape,
	shapeForSemanticRole,
} from "../src/ir/semantic-roles.js";
import { fitLabel } from "../src/labels/index.js";
import { solveDiagram } from "../src/solver/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

const measurer = new DeterministicTextMeasurer();
const font = {
	fontFamily: "Inter",
	fontSize: 16,
	fontWeight: 400,
	lineHeight: 20,
};

describe("pretext sizing contract (#84 §A)", () => {
	it("grows fitted box to wrapped text; never truncates under diagnose", () => {
		const layout = fitLabel(
			"这是一段很长的中文标签需要换行并且不能被截断显示",
			{
				font,
				padding: 8,
				maxWidth: 100,
				overflow: "diagnose",
			},
			measurer,
		);

		expect(layout.overflow.truncated).toBe(false);
		expect(layout.lines.length).toBeGreaterThan(1);
		expect(layout.fittedSize.width).toBeGreaterThanOrEqual(
			layout.contentBox.width + layout.padding.left + layout.padding.right - 1,
		);
		for (const line of layout.lines) {
			expect(line.box.width).toBeLessThanOrEqual(layout.contentBox.width + 1);
		}
	});

	it("treats authored node size as a floor under deliverability prefit", () => {
		const solved = solveDiagram(
			{
				id: "prefit-floor",
				direction: "TB",
				nodes: [
					{
						id: "n1",
						shape: "rectangle",
						label: { text: "Short" },
						size: { width: 200, height: 80 },
						padding: { top: 8, right: 8, bottom: 8, left: 8 },
						position: { x: 0, y: 0 },
					},
				],
				edges: [],
				groups: [],
				constraints: [],
				diagnostics: [],
			},
			{
				initialLayout: "positions",
				deliverabilityMode: "degraded-ok",
			},
		);

		const node = solved.nodes.find((entry) => entry.id === "n1");
		expect(node?.box.width).toBeGreaterThanOrEqual(200);
		expect(node?.box.height).toBeGreaterThanOrEqual(80);
	});

	it("applies circle diameter = max(textW, textH) for ellipses", () => {
		expect(applyEllipseCircleSize({ width: 120, height: 40 })).toEqual({
			width: 120,
			height: 120,
		});
		const normalized = normalizeDiagramDsl({
			direction: "TB",
			nodes: {
				start: {
					shape: "ellipse",
					label: "Go",
				},
			},
			edges: [],
		});
		expect(normalized.diagram).toBeDefined();
		const start = normalized.diagram?.nodes.find((node) => node.id === "start");
		expect(start?.shape).toBe("ellipse");
		expect(start?.size.width).toBe(start?.size.height);
	});
});

describe("semantic shape roles (#84 §D)", () => {
	it("maps roles to the fixed shape catalog", () => {
		expect(shapeForSemanticRole("start")).toBe("ellipse");
		expect(shapeForSemanticRole("end")).toBe("ellipse");
		expect(shapeForSemanticRole("decision")).toBe("diamond");
		expect(shapeForSemanticRole("process")).toBe("rounded-rectangle");
		expect(shapeForSemanticRole("data")).toBe("cylinder");
		expect(shapeForSemanticRole("concept")).toBe("rectangle");
		expect(resolveNodeShape({ role: "decision" })).toBe("diamond");
		expect(resolveNodeShape({ role: "start", shape: "rectangle" })).toBe(
			"rectangle",
		);
	});

	it("round-trips DSL roles into normalized shapes for activity fixtures", () => {
		const normalized = normalizeDiagramDsl({
			direction: "TB",
			nodes: {
				begin: { role: "start", label: "Start" },
				choice: { role: "decision", label: "OK?" },
				work: { role: "process", label: "Do work" },
				finish: { role: "end", label: "End" },
				block: { label: "SysML Block" },
			},
			edges: [
				{ sourceId: "begin", targetId: "choice" },
				{ sourceId: "choice", targetId: "work" },
				{ sourceId: "work", targetId: "finish" },
			],
		});

		expect(normalized.diagram).toBeDefined();
		const byId = new Map(
			(normalized.diagram?.nodes ?? []).map((node) => [node.id, node]),
		);
		expect(byId.get("begin")?.shape).toBe("ellipse");
		expect(byId.get("begin")?.role).toBe("start");
		expect(byId.get("choice")?.shape).toBe("diamond");
		expect(byId.get("work")?.shape).toBe("rounded-rectangle");
		expect(byId.get("finish")?.shape).toBe("ellipse");
		expect(byId.get("block")?.shape).toBe("rectangle");
		expect(byId.get("block")?.role).toBeUndefined();
	});
});
