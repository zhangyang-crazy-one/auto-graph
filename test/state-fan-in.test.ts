import { describe, expect, it } from "vitest";
import { normalizeDiagramDsl, parseDiagramDsl } from "../src/dsl/index.js";
import type { CoordinatedDiagram, Point } from "../src/ir/index.js";
import { solveDiagram } from "../src/solver/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";

/**
 * Issue #99: a state page where four states fan in to one "canceled" state
 * placed beside the main chain. The fan-in edges used to cross each other
 * and run along a node's border, with a 1px jog and a sub-arrowhead end.
 */
const STATE_PAGE = `
title: ST-5
layout: { direction: TB, mode: positions }
nodes:
  s_pending: { label: 待支付核销, shape: rounded-rectangle, position: { x: 300.5, y: 124 }, size: { width: 112, height: 56 } }
  s_reviewing: { label: 风控合规审核中, shape: rounded-rectangle, position: { x: 349, y: 266 }, size: { width: 136, height: 56 } }
  s_clearing: { label: 已出库海关申报, shape: rounded-rectangle, position: { x: 411.5, y: 408 }, size: { width: 136, height: 56 } }
  s_shipping: { label: 国际干线运输中, shape: rounded-rectangle, position: { x: 474, y: 550 }, size: { width: 136, height: 56 } }
  s_completed: { label: 买家签收归档, shape: rounded-rectangle, position: { x: 501, y: 692 }, size: { width: 124, height: 56 } }
  s_canceled: { label: 订单已取消撤单, shape: rounded-rectangle, position: { x: 225, y: 692 }, size: { width: 136, height: 56 } }
edges:
  - { id: t01, source: s_pending, target: s_reviewing, label: 买家支付到账 }
  - { id: t02, source: s_reviewing, target: s_clearing, label: 风控门禁通过+无违禁品 }
  - { id: t03, source: s_clearing, target: s_shipping, label: 海关查验放行 }
  - { id: t04, source: s_shipping, target: s_completed, label: 尾程签收凭证回传 }
  - { id: t10, source: s_pending, target: s_canceled, label: 买家主动撤单 }
  - { id: t11, source: s_reviewing, target: s_canceled, label: 欺诈高危熔断拦截 }
  - { id: t12, source: s_clearing, target: s_canceled, label: 查验不符没收退运 }
  - { id: t13, source: s_shipping, target: s_canceled, label: 承运人丢件理赔注销 }
`;

function solve(): CoordinatedDiagram {
	const parsed = parseDiagramDsl(STATE_PAGE);
	const normalized = normalizeDiagramDsl(parsed.value as never, {
		textMeasurer: new DeterministicTextMeasurer(),
	});
	if (normalized.diagram === undefined) {
		throw new Error(JSON.stringify(normalized.diagnostics));
	}
	return solveDiagram(normalized.diagram, {
		textMeasurer: new DeterministicTextMeasurer(),
	});
}

type Segment = { horizontal: boolean; at: number; lo: number; hi: number };

function segments(points: readonly Point[]): Segment[] {
	const out: Segment[] = [];
	for (let i = 0; i + 1 < points.length; i += 1) {
		const a = points[i] as Point;
		const b = points[i + 1] as Point;
		const horizontal = Math.abs(a.y - b.y) < 1e-6;
		out.push(
			horizontal
				? {
						horizontal,
						at: a.y,
						lo: Math.min(a.x, b.x),
						hi: Math.max(a.x, b.x),
					}
				: {
						horizontal,
						at: a.x,
						lo: Math.min(a.y, b.y),
						hi: Math.max(a.y, b.y),
					},
		);
	}
	return out;
}

function crosses(s: Segment, t: Segment): boolean {
	if (s.horizontal === t.horizontal) return false;
	return t.at > s.lo && t.at < s.hi && s.at > t.lo && s.at < t.hi;
}

describe("issue #99 state page", () => {
	it("honours the authored node size as a minimum", () => {
		const diagram = solve();
		const pending = diagram.nodes.find((node) => node.id === "s_pending");
		expect(pending?.box.width).toBeGreaterThanOrEqual(112);
		expect(pending?.box.height).toBeGreaterThanOrEqual(56);
	});

	it("nests the fan-in edges without crossings, border runs, jogs or short ends", () => {
		const diagram = solve();
		const routes = diagram.edges.map((edge) => ({
			id: edge.id,
			points: edge.points,
			segments: segments(edge.points),
		}));
		const crossings: string[] = [];
		for (const [index, route] of routes.entries()) {
			for (const other of routes.slice(index + 1)) {
				for (const s of route.segments) {
					for (const t of other.segments) {
						if (crosses(s, t)) crossings.push(`${route.id}×${other.id}`);
					}
				}
			}
		}
		expect(crossings).toEqual([]);

		const sides = diagram.nodes.flatMap(({ box }) => [
			{ horizontal: true, at: box.y, lo: box.x, hi: box.x + box.width },
			{
				horizontal: true,
				at: box.y + box.height,
				lo: box.x,
				hi: box.x + box.width,
			},
			{ horizontal: false, at: box.x, lo: box.y, hi: box.y + box.height },
			{
				horizontal: false,
				at: box.x + box.width,
				lo: box.y,
				hi: box.y + box.height,
			},
		]);
		for (const route of routes) {
			for (const s of route.segments) {
				for (const side of sides) {
					if (side.horizontal !== s.horizontal) continue;
					if (Math.abs(side.at - s.at) > 3) continue;
					const run = Math.min(s.hi, side.hi) - Math.max(s.lo, side.lo);
					expect(
						run,
						`${route.id} runs along a node border`,
					).toBeLessThanOrEqual(1);
				}
			}
			for (const s of route.segments.slice(1, -1)) {
				expect(
					s.hi - s.lo,
					`${route.id} has a micro jog`,
				).toBeGreaterThanOrEqual(2);
			}
			const last = route.segments.at(-1) as Segment;
			expect(last.hi - last.lo, `${route.id} end stub`).toBeGreaterThanOrEqual(
				12,
			);
		}
	});
});
