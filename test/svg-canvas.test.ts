import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import { exportSvg } from "../src/exporters/index.js";
import type { CoordinatedDiagram } from "../src/ir/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

const EXAMPLES = fileURLToPath(new URL("../examples/", import.meta.url));

interface Extent {
	element: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const attr = (element: string, name: string): number | undefined => {
	const match = element.match(new RegExp(`\\s${name}="([^"]*)"`));
	return match === null ? undefined : Number(match[1]);
};

/**
 * The painted extent of every rect, path, polygon and ellipse, half the
 * stroke included (strokes straddle their outline). Paths are measured by
 * their coordinates, which bound straight segments and the hop arcs' ends.
 */
function paintedExtents(svg: string): Extent[] {
	const extents: Extent[] = [];
	for (const match of svg.matchAll(/<(rect|path|polygon|ellipse)\s[^>]*>/g)) {
		const element = match[0];
		if (element.includes('class="background"')) continue;
		const stroked = /\sstroke="(?!none)/.test(element);
		const half = stroked ? (attr(element, "stroke-width") ?? 1) / 2 : 0;
		const add = (xs: number[], ys: number[]) =>
			extents.push({
				element: element.slice(0, 80),
				x0: Math.min(...xs) - half,
				y0: Math.min(...ys) - half,
				x1: Math.max(...xs) + half,
				y1: Math.max(...ys) + half,
			});
		if (match[1] === "rect") {
			const x = attr(element, "x") ?? 0;
			const y = attr(element, "y") ?? 0;
			add(
				[x, x + (attr(element, "width") ?? 0)],
				[y, y + (attr(element, "height") ?? 0)],
			);
		} else if (match[1] === "ellipse") {
			const cx = attr(element, "cx") ?? 0;
			const cy = attr(element, "cy") ?? 0;
			const rx = attr(element, "rx") ?? 0;
			const ry = attr(element, "ry") ?? 0;
			add([cx - rx, cx + rx], [cy - ry, cy + ry]);
		} else {
			const source =
				match[1] === "polygon"
					? (element.match(/\spoints="([^"]*)"/)?.[1] ?? "")
					: (element.match(/\sd="([^"]*)"/)?.[1] ?? "");
			// Arc flags and radii are not coordinates: keep M/L/A end points.
			const numbers =
				match[1] === "polygon"
					? source
							.split(/[\s,]+/)
							.filter(Boolean)
							.map(Number)
					: [...source.matchAll(/([MLA])([^MLAZ]*)/g)].flatMap(
							([, command, args]) => {
								const values = (args ?? "")
									.trim()
									.split(/[\s,]+/)
									.filter(Boolean)
									.map(Number);
								return command === "A" ? values.slice(5, 7) : values;
							},
						);
			const xs = numbers.filter((_, index) => index % 2 === 0);
			const ys = numbers.filter((_, index) => index % 2 === 1);
			if (xs.length > 0 && ys.length > 0) add(xs, ys);
		}
	}
	return extents;
}

describe("SVG canvas", () => {
	const examples = readdirSync(EXAMPLES).filter((name) =>
		name.endsWith(".yaml"),
	);

	it.each(examples)("draws nothing of %s outside the view box", (name) => {
		const path = join(EXAMPLES, name);
		const svg =
			renderDiagramDsl(readFileSync(path, "utf8"), {
				sourcePath: path,
				format: "svg",
				textMeasurer: new DeterministicTextMeasurer(),
			}).content ?? "";
		const [vx, vy, vw, vh] = (svg.match(/viewBox="([^"]*)"/)?.[1] ?? "")
			.split(" ")
			.map(Number) as [number, number, number, number];
		const outside = paintedExtents(svg).filter(
			(extent) =>
				extent.x0 < vx - 1e-6 ||
				extent.y0 < vy - 1e-6 ||
				extent.x1 > vx + vw + 1e-6 ||
				extent.y1 > vy + vh + 1e-6,
		);
		expect(outside).toEqual([]);
		// The white background fills the whole canvas.
		expect(svg).toContain(
			`<rect class="background" x="${vx}" y="${vy}" width="${vw}" height="${vh}"`,
		);
	});

	const viewBoxOf = (svg: string) =>
		(svg.match(/viewBox="([^"]*)"/)?.[1] ?? "").split(" ").map(Number) as [
			number,
			number,
			number,
			number,
		];
	const bare = (overrides: Partial<CoordinatedDiagram>): CoordinatedDiagram =>
		({
			id: "canvas",
			direction: "LR",
			nodes: [],
			edges: [],
			groups: [],
			constraints: [],
			diagnostics: [],
			bounds: { x: 0, y: 0, width: 100, height: 100 },
			...overrides,
		}) as CoordinatedDiagram;

	it("covers the mitred corner of a route on the bounds", () => {
		// A 1.5px route turning on the left bound: its miter reaches
		// 0.75 * sqrt(2) ≈ 1.06px past the corner, beyond a plain half stroke.
		const svg = exportSvg(
			bare({
				edges: [
					{
						id: "e",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						points: [
							{ x: 50, y: 20 },
							{ x: 0, y: 20 },
							{ x: 0, y: 80 },
							{ x: 50, y: 80 },
						],
					},
				] as never,
			}),
			{ viewportPadding: 0 },
		);
		expect(viewBoxOf(svg)[0]).toBeLessThanOrEqual(-0.75 * Math.SQRT2);
	});

	it("covers labels drawn without a solved box", () => {
		const svg = exportSvg(
			bare({
				nodes: [
					{
						id: "n",
						shape: "rectangle",
						box: { x: 20, y: 20, width: 60, height: 60 },
						ports: [
							{
								id: "p",
								side: "right",
								kind: "flow",
								box: { x: 76, y: 46, width: 8, height: 8 },
								anchor: { x: 80, y: 50 },
								label: { text: "A LONG PORT LABEL" },
							},
						],
					},
				] as never,
				edges: [
					{
						id: "e",
						source: { nodeId: "n" },
						target: { nodeId: "n" },
						label: { text: "an authored edge label" },
						points: [
							{ x: 50, y: 0 },
							{ x: 50, y: 20 },
						],
					},
				] as never,
			}),
			{ viewportPadding: 0 },
		);
		const [x, y, width] = viewBoxOf(svg);
		// The port label starts 8px right of the port and runs past x=100;
		// the edge label is centred on the route, above y=0.
		expect(x + width).toBeGreaterThan(88 + 17 * 6);
		expect(y).toBeLessThan(0);
		expect(x).toBeLessThan(50 - 60);
	});
});
