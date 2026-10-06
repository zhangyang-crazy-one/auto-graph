import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import {
	exportDrawio,
	exportExcalidraw,
	exportGeometry,
	exportSvg,
} from "../src/exporters/index.js";
import type { Box, CoordinatedDiagram } from "../src/ir/index.js";

/**
 * A layered architecture: three layers of different widths stacked in a
 * frameless group, and a cross-cutting column beside them, all inside the
 * platform frame.
 */
const ARCHITECTURE = `
layout: { direction: TB }
nodes:
  a1: { label: Mini program }
  a2: { label: Web console }
  b1: { label: Q&A }
  b2: { label: Reporting }
  b3: { label: Training }
  b4: { label: Feedback }
  c1: { label: Knowledge base }
  s1: { label: Identity }
  s2: { label: Permissions }
  s3: { label: Audit }
edges:
  - { source: a1, target: b1, label: ask }
  - { source: a2, target: b3, label: organise }
  - { source: b1, target: c1, label: retrieve }
  - { source: b2, target: c1, label: record }
groups:
  access: { label: Access, nodes: [a1, a2] }
  apply: { label: Application, nodes: [b1, b2, b3, b4] }
  data: { label: Data, nodes: [c1] }
  layers: { groups: [access, apply, data], direction: vertical, frame: false }
  support: { label: Support, nodes: [s1, s2, s3], direction: vertical }
  platform: { label: Platform, groups: [layers, support], direction: horizontal }
`;

function solve(source: string): CoordinatedDiagram {
	const result = renderDiagramDsl(source);
	if (result.diagram === undefined) throw new Error("did not solve");
	return result.diagram;
}

const boxOf = (diagram: CoordinatedDiagram, id: string): Box => {
	const box =
		diagram.groups.find((group) => group.id === id)?.box ??
		diagram.nodes.find((node) => node.id === id)?.box;
	if (box === undefined) throw new Error(`no ${id}`);
	return box;
};

describe("group bands", () => {
	const diagram = solve(ARCHITECTURE);

	it("runs stacked layers through at one width, in the listed order", () => {
		const layers = ["access", "apply", "data"].map((id) => boxOf(diagram, id));
		for (const layer of layers) {
			expect(layer.x).toBeCloseTo(layers[0]?.x ?? 0, 6);
			expect(layer.width).toBeCloseTo(layers[0]?.width ?? 0, 6);
		}
		for (let index = 1; index < layers.length; index += 1) {
			const above = layers[index - 1] as Box;
			expect(layers[index]?.y).toBeGreaterThan(above.y + above.height);
		}
	});

	it("spans a side column over the layers and spreads its nodes", () => {
		const layers = boxOf(diagram, "layers");
		const support = boxOf(diagram, "support");
		expect(support.x).toBeGreaterThan(layers.x + layers.width);
		// Unlinked to the layers: it follows them at the band gap.
		expect(support.x - (layers.x + layers.width)).toBeCloseTo(24, 6);
		expect(support.y).toBeCloseTo(layers.y, 6);
		expect(support.height).toBeCloseTo(layers.height, 6);
		const nodes = ["s1", "s2", "s3"].map((id) => boxOf(diagram, id));
		const centres = nodes.map((box) => box.x + box.width / 2);
		expect(new Set(centres.map((x) => x.toFixed(6))).size).toBe(1);
		const first = nodes[0] as Box;
		const last = nodes[2] as Box;
		// Spread from the column's top to its bottom, evenly.
		expect(last.y + last.height - first.y).toBeGreaterThan(
			support.height * 0.6,
		);
		const gaps = nodes.slice(1).map((box, index) => {
			const above = nodes[index] as Box;
			return box.y - (above.y + above.height);
		});
		expect(gaps[0]).toBeCloseTo(gaps[1] ?? 0, 6);
	});

	it("is byte-stable", () => {
		expect(exportSvg(solve(ARCHITECTURE))).toBe(exportSvg(diagram));
	});
});

describe("edge labels and group frames", () => {
	// Two layers in a platform frame: a label beside its route sat across
	// the platform's left side.
	const LAYERS = `
layout: { direction: TB }
nodes:
  a1: { label: Mini program }
  a2: { label: Web console }
  a3: { label: Business API }
  b1: { label: Q&A }
  b2: { label: Reporting }
  b3: { label: Training }
  b4: { label: Knowledge admin }
edges:
  - { source: a1, target: b1, label: field question }
  - { source: a1, target: b2, label: field report }
  - { source: a2, target: b4, label: governance }
  - { source: a2, target: b3, label: training plan }
  - { source: a3, target: b2, label: business data }
groups:
  access: { label: Access, nodes: [a1, a2, a3] }
  apply: { label: Application, nodes: [b1, b2, b3, b4] }
  layers: { label: Platform, groups: [access, apply], direction: vertical }
`;

	it("keep off the drawn frame lines", () => {
		const diagram = solve(LAYERS);
		const labels = (diagram.textAnnotations ?? []).filter(
			(annotation) => annotation.surfaceKind === "edge-label",
		);
		expect(labels.length).toBe(5);
		for (const group of diagram.groups) {
			const { x, y, width, height } = group.box;
			for (const label of labels) {
				const box = label.box;
				const acrossX = box.x < x + width && box.x + box.width > x;
				const acrossY = box.y < y + height && box.y + box.height > y;
				const onHorizontal = [y, y + height].some(
					(line) => acrossX && box.y < line && box.y + box.height > line,
				);
				const onVertical = [x, x + width].some(
					(line) => acrossY && box.x < line && box.x + box.width > line,
				);
				expect(onHorizontal || onVertical).toBe(false);
			}
		}
	});
});

describe("frameless groups", () => {
	const diagram = solve(ARCHITECTURE);

	it("lay out their members but are never drawn", () => {
		const svg = exportSvg(diagram);
		expect(svg).not.toContain('data-id="layers"');
		expect(svg).toContain('class="group" data-id="access"');
		// Nested frames still paint above the frame around them.
		expect(svg.indexOf('data-id="platform"')).toBeLessThan(
			svg.indexOf('class="group" data-id="access"'),
		);

		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: { id: string }[];
		};
		expect(
			scene.elements.some((element) => element.id.includes("layers")),
		).toBe(false);

		// draw.io keeps the container cell (its members' parent), unstyled.
		const drawio = exportDrawio(diagram);
		expect(drawio).toMatch(/style="group;"/);

		const geometry = exportGeometry(diagram);
		const layers = geometry.containers.find((item) => item.id === "layers");
		expect(layers?.frame).toBe(false);
		expect(
			geometry.zOrder.some(
				(paint) => paint.kind === "container" && paint.id === "layers",
			),
		).toBe(false);
	});

	it("take no padding unless asked for", () => {
		const layers = boxOf(diagram, "layers");
		const access = boxOf(diagram, "access");
		const data = boxOf(diagram, "data");
		expect(layers.x).toBeCloseTo(access.x, 6);
		expect(layers.y).toBeCloseTo(access.y, 6);
		expect(layers.y + layers.height).toBeCloseTo(data.y + data.height, 6);
	});
});
