import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import {
	exportGeometry,
	type GeometryDocument,
	geometryDocumentSchema,
	geometryJsonSchema,
	renderGeometrySvg,
} from "../src/exporters/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";
import { generateSyntheticDsl } from "./support/synthetic.js";

const EXAMPLES = [
	"examples/architecture.yaml",
	"examples/edge-labels.yaml",
	"examples/fan-out.yaml",
	"examples/flowchart.yaml",
	"examples/groups.yaml",
	"examples/swimlane.yaml",
	"test/fixtures/benchmark/cn-architecture.yaml",
];

function solve(source: string) {
	const result = renderDiagramDsl(source, {
		textMeasurer: new DeterministicTextMeasurer(),
	});
	if (result.diagram === undefined) throw new Error("did not solve");
	return result.diagram;
}

const documents: [string, GeometryDocument][] = [
	...EXAMPLES.map(
		(path) =>
			[path, exportGeometry(solve(readFileSync(path, "utf8")))] as [
				string,
				GeometryDocument,
			],
	),
	...(["architecture", "process"] as const).map(
		(kind) =>
			[
				`synthetic ${kind}`,
				exportGeometry(
					solve(generateSyntheticDsl({ seed: 3, nodes: 40, kind })),
				),
			] as [string, GeometryDocument],
	),
];

function inside(
	inner: { x: number; y: number; width: number; height: number },
	outer: { x: number; y: number; width: number; height: number },
	slack = 0.01,
): boolean {
	return (
		inner.x >= outer.x - slack &&
		inner.y >= outer.y - slack &&
		inner.x + inner.width <= outer.x + outer.width + slack &&
		inner.y + inner.height <= outer.y + outer.height + slack
	);
}

describe("geometry contract v1", () => {
	it("matches the published JSON Schema", () => {
		const published = JSON.parse(
			readFileSync("schema/dge-geometry.v1.schema.json", "utf8"),
		);
		expect(published).toEqual(geometryJsonSchema());
	});

	for (const [name, document] of documents) {
		describe(name, () => {
			it("validates against the contract schema", () => {
				expect(() => geometryDocumentSchema.parse(document)).not.toThrow();
			});

			it("paints every element exactly once and only known ids", () => {
				const ids = {
					container: new Set(document.containers.map((item) => item.id)),
					edge: new Set(document.edges.map((item) => item.id)),
					node: new Set(document.nodes.map((item) => item.id)),
					port: new Set(
						document.nodes.flatMap((node) =>
							node.ports.map((port) => `${node.id}.${port.id}`),
						),
					),
					text: new Set(document.texts.map((item) => item.id)),
					backdrop: new Set(
						document.texts
							.filter((item) => item.backdrop !== null)
							.map((item) => item.id),
					),
				};
				const seen = new Set<string>();
				for (const paint of document.zOrder) {
					expect(ids[paint.kind].has(paint.id)).toBe(true);
					const key = `${paint.kind}:${paint.id}`;
					expect(seen.has(key)).toBe(false);
					seen.add(key);
				}
				const expected = Object.values(ids).reduce(
					(sum, set) => sum + set.size,
					0,
				);
				expect(seen.size).toBe(expected);
			});

			it("keeps everything inside the bounds", () => {
				for (const node of document.nodes) {
					expect(inside(node.box, document.bounds)).toBe(true);
				}
				for (const edge of document.edges) {
					for (const point of edge.points) {
						expect(
							inside({ ...point, width: 0, height: 0 }, document.bounds),
						).toBe(true);
					}
				}
			});

			it("draws edges from their source to the arrowhead at the target", () => {
				for (const edge of document.edges) {
					expect(edge.path[0]).toMatchObject({
						op: "M",
						...edge.source.point,
					});
					const [head] = edge.arrowheads;
					expect(head?.tip).toEqual(edge.target.point);
					expect(head?.points).toHaveLength(3);
					expect(edge.points[0]).toEqual(edge.source.point);
				}
			});

			it("places text lines inside their text box", () => {
				for (const text of document.texts) {
					for (const line of text.lines) {
						expect(inside(line.box, text.box, 1)).toBe(true);
						expect(line.y).toBeGreaterThan(line.box.y);
						expect(line.y).toBeLessThanOrEqual(
							line.box.y + line.box.height + 0.01,
						);
					}
				}
			});

			it("renders from the document alone", () => {
				const svg = renderGeometrySvg(document);
				expect(svg.startsWith("<svg")).toBe(true);
				const paths = svg.match(/<path /g) ?? [];
				expect(paths.length).toBe(
					document.nodes.length + document.edges.length,
				);
			});
		});
	}

	it("is byte-stable", () => {
		const source = readFileSync("examples/swimlane.yaml", "utf8");
		expect(JSON.stringify(exportGeometry(solve(source)))).toBe(
			JSON.stringify(exportGeometry(solve(source))),
		);
	});

	it("rounds coordinates to three decimals", () => {
		const text = JSON.stringify(documents[0]?.[1]);
		expect(text).not.toMatch(/\d\.\d{4,}/);
	});
});
