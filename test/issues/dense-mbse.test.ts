import { describe, expect, it } from "vitest";
import { normalizeDiagramDsl, parseDiagramDsl } from "../../src/dsl/index.js";
import { exportDrawio, exportSvg } from "../../src/exporters/index.js";
import type {
	Box,
	CoordinatedDiagram,
	NormalizedDiagram,
	Point,
} from "../../src/ir/index.js";
import { measureLayoutQuality } from "../../src/quality/index.js";
import {
	type SolveDiagramOptions,
	solveDiagram,
} from "../../src/solver/index.js";
import { DeterministicTextMeasurer } from "../../src/text/index.js";

/**
 * Dense MBSE-like pages modelled on the pages issues #75–#95 describe
 * (SV-1 interface ports, AV-1 zones, OV-5b lanes), solved with the dense
 * downstream profiles those issues quote. The live DoDAF case lives
 * downstream; these pages reproduce its shapes, not its exact content.
 */
const PAGES: Record<string, string> = {
	"SV-1 ports": `
title: SV-1
layout: { direction: LR, mode: positions }
nodes:
  hn900:
    label: HN900 主控单元
    position: { x: 420, y: 140 }
    ports:
      CMD: { side: left, kind: flow, label: CMD }
      SEN: { side: left, kind: flow, label: SEN }
      DAT: { side: left, kind: flow, label: DAT }
      OUT: { side: right, kind: flow, label: OUT }
  b055: { label: 055A 传感器, position: { x: 60, y: 40 }, ports: { S1: { side: right, kind: flow } } }
  b056: { label: 056B 执行器, position: { x: 60, y: 160 }, ports: { S2: { side: right, kind: flow } } }
  b057: { label: 057C 数据链, position: { x: 60, y: 280 }, ports: { S3: { side: right, kind: flow } } }
  s1: { label: 雷达 A, position: { x: 60, y: 400 } }
  s2: { label: 雷达 B, position: { x: 200, y: 420 } }
  s3: { label: 光电 C, position: { x: 200, y: 20 } }
  s4: { label: 通信 D, position: { x: 60, y: 520 } }
  s5: { label: 导航 E, position: { x: 200, y: 520 } }
  sink: { label: 显控台, position: { x: 700, y: 160 } }
edges:
  - { source: { node: b055, port: S1 }, target: { node: hn900, port: CMD }, label: 指令 }
  - { source: { node: b056, port: S2 }, target: { node: hn900, port: SEN }, label: 传感 }
  - { source: { node: b057, port: S3 }, target: { node: hn900, port: DAT }, label: 数据 }
  - { source: s1, target: hn900, label: 回波 }
  - { source: s2, target: hn900, label: 回波 }
  - { source: s3, target: hn900, label: 图像 }
  - { source: s4, target: hn900, label: 话音 }
  - { source: s5, target: hn900, label: 定位 }
  - { source: { node: hn900, port: OUT }, target: sink, label: 态势 }
`,
	"AV-1 zones": `
title: AV-1
layout: { direction: LR, mode: positions }
groups:
  ctx: { label: 作战背景, nodes: [c1, c2, c3] }
  arch: { label: 体系结构, nodes: [a1, a2, a3, a4] }
  ev: { label: 评估证据, nodes: [e1, e2, e3] }
nodes:
  c1: { label: 任务背景, position: { x: 40, y: 80 } }
  c2: { label: 作战条令, position: { x: 40, y: 200 } }
  c3: { label: 威胁环境, position: { x: 40, y: 320 } }
  a1: { label: 指挥控制节点, position: { x: 320, y: 60 } }
  a2: { label: 情报侦察节点, position: { x: 320, y: 160 } }
  a3: { label: 火力打击节点, position: { x: 320, y: 260 } }
  a4: { label: 综合保障节点, position: { x: 320, y: 360 } }
  e1: { label: 效能指标, position: { x: 620, y: 80 } }
  e2: { label: 试验数据, position: { x: 620, y: 200 } }
  e3: { label: 仿真结果, position: { x: 620, y: 320 } }
edges:
  - { source: c1, target: a1, label: 约束 }
  - { source: c1, target: a4, label: 约束 }
  - { source: c2, target: a2, label: 指导 }
  - { source: c3, target: a3, label: 驱动 }
  - { source: c3, target: a1, label: 驱动 }
  - { source: a1, target: a4, label: 协同 }
  - { source: a4, target: a1, label: 反馈 }
  - { source: a1, target: e3, label: 验证 }
  - { source: a2, target: e1, label: 评估 }
  - { source: a3, target: e2, label: 评估 }
  - { source: a4, target: e1, label: 评估 }
  - { source: c2, target: e2, label: 引用 }
  - { source: c1, target: e3, label: 引用 }
  - { source: a2, target: a4, label: 支援 }
  - { source: e1, target: a3, label: 修正 }
`,
	"OV-5b lanes": `
title: OV-5b
layout: { direction: TB, mode: positions }
swimlanes:
  flow:
    orientation: vertical
    layout: contract
    lanes:
      eg: { label: 指挥组, children: [o1, o2, o5] }
      oa: { label: 作战单元, children: [o3, o4, o6] }
      sp: { label: 保障单元, children: [o7, o8] }
nodes:
  o1: { label: 接收任务, position: { x: 60, y: 60 } }
  o2: { label: 制定方案, position: { x: 60, y: 180 } }
  o3: { label: 机动部署, position: { x: 300, y: 120 } }
  o4: { label: 实施打击, position: { x: 300, y: 240 } }
  o5: { label: 效果评估, position: { x: 60, y: 360 } }
  o6: { label: 撤离, position: { x: 300, y: 380 } }
  o7: { label: 补给, position: { x: 540, y: 160 } }
  o8: { label: 维修, position: { x: 540, y: 300 } }
edges:
  - { source: o1, target: o2, label: 分析 }
  - { source: o2, target: o3, label: 下达 }
  - { source: o3, target: o4, label: 到位 }
  - { source: o4, target: o5, label: 回报 }
  - { source: o5, target: o2, label: 调整 }
  - { source: o4, target: o6, label: 完成 }
  - { source: o7, target: o3, label: 物资 }
  - { source: o8, target: o4, label: 抢修 }
  - { source: o2, target: o7, label: 申请 }
  - { source: o5, target: o8, label: 需求 }
`,
};

function load(source: string): NormalizedDiagram {
	const parsed = parseDiagramDsl(source);
	const normalized = normalizeDiagramDsl(parsed.value as never, {
		textMeasurer: new DeterministicTextMeasurer(),
	});
	if (normalized.diagram === undefined) {
		throw new Error(
			JSON.stringify(parsed.diagnostics.concat(normalized.diagnostics)),
		);
	}
	return normalized.diagram;
}

const RSOP: SolveDiagramOptions = {
	initialLayout: "positions",
	routeKind: "short-orthogonal-jumps",
	maxDetourRatio: 3,
	maxAttachPointsPerSide: 3,
	externalLabels: true,
	remediationPolicy: { externalLabels: "auto" },
	deliverabilityMode: "degraded-ok",
	pageBounds: { width: 900, height: 700 },
	textMeasurer: new DeterministicTextMeasurer(),
};

function crosses(points: readonly Point[], box: Box): boolean {
	for (let i = 0; i + 1 < points.length; i += 1) {
		const a = points[i] as Point;
		const b = points[i + 1] as Point;
		if (
			Math.max(a.x, b.x) > box.x &&
			Math.min(a.x, b.x) < box.x + box.width &&
			Math.max(a.y, b.y) > box.y &&
			Math.min(a.y, b.y) < box.y + box.height
		)
			return true;
	}
	return false;
}
const inset = (b: Box, d: number): Box => ({
	x: b.x + d,
	y: b.y + d,
	width: Math.max(0, b.width - 2 * d),
	height: Math.max(0, b.height - 2 * d),
});
const overlap = (a: Box, b: Box) =>
	a.x < b.x + b.width &&
	b.x < a.x + a.width &&
	a.y < b.y + b.height &&
	b.y < a.y + a.height;

interface Seg {
	edgeId: string;
	a: Point;
	b: Point;
	/** Horizontal (fixed y) or vertical (fixed x). */
	horizontal: boolean;
	at: number;
	lo: number;
	hi: number;
}

function segmentsOf(d: CoordinatedDiagram): Seg[] {
	const segs: Seg[] = [];
	for (const e of d.edges) {
		for (let i = 0; i + 1 < e.points.length; i += 1) {
			const a = e.points[i] as Point;
			const b = e.points[i + 1] as Point;
			const horizontal = Math.abs(a.y - b.y) < 0.01;
			if (!horizontal && Math.abs(a.x - b.x) >= 0.01) continue;
			segs.push({
				edgeId: e.id,
				a,
				b,
				horizontal,
				at: horizontal ? a.y : a.x,
				lo: horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
				hi: horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
			});
		}
	}
	return segs;
}

/** Box sides as axis-aligned lines: [horizontal, at, lo, hi]. */
function boxSides(b: Box): [boolean, number, number, number][] {
	return [
		[true, b.y, b.x, b.x + b.width],
		[true, b.y + b.height, b.x, b.x + b.width],
		[false, b.x, b.y, b.y + b.height],
		[false, b.x + b.width, b.y, b.y + b.height],
	];
}

/**
 * Defects that only show once the page is drawn (render check on #98):
 * lines 0.5–6px apart that read as one thick line, routes drawn on a node
 * side / group frame / lane divider, ends entering along their own side,
 * arrowheads on a stub shorter than the head, port labels struck through,
 * and sub-2px jogs.
 */
function renderDefects(d: CoordinatedDiagram) {
	const segs = segmentsOf(d);
	let nearParallel = 0;
	for (let i = 0; i < segs.length; i += 1) {
		const s = segs[i] as Seg;
		for (const t of segs.slice(i + 1)) {
			if (t.edgeId === s.edgeId || t.horizontal !== s.horizontal) continue;
			const gap = Math.abs(t.at - s.at);
			if (gap < 0.5 || gap >= 6) continue;
			nearParallel += Math.max(0, Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo));
		}
	}
	const lines: [boolean, number, number, number][] = [
		...d.nodes.flatMap((n) => boxSides(n.box)),
		...d.groups.flatMap((g) => boxSides(g.box)),
		...(d.swimlanes ?? []).flatMap((sw) =>
			sw.lanes.flatMap((lane) =>
				lane.box === undefined ? [] : boxSides(lane.box),
			),
		),
	];
	let borderRun = 0;
	for (const s of segs) {
		let worst = 0;
		for (const [horizontal, at, lo, hi] of lines) {
			if (horizontal !== s.horizontal || Math.abs(at - s.at) > 3) continue;
			worst = Math.max(worst, Math.min(s.hi, hi) - Math.max(s.lo, lo));
		}
		borderRun += worst > 1 ? worst : 0;
	}
	let alongBorderEnds = 0;
	let shortArrowEnds = 0;
	for (const e of d.edges) {
		const ends: [Point, Point, string][] = [
			[e.points[0] as Point, e.points[1] as Point, e.source.nodeId],
			[e.points.at(-1) as Point, e.points.at(-2) as Point, e.target.nodeId],
		];
		for (const [end, next, nodeId] of ends) {
			const box = d.nodes.find((n) => n.id === nodeId)?.box;
			if (box === undefined || next === undefined) continue;
			const onVertical =
				Math.abs(end.x - box.x) < 1 || Math.abs(end.x - box.x - box.width) < 1;
			const onHorizontal =
				Math.abs(end.y - box.y) < 1 || Math.abs(end.y - box.y - box.height) < 1;
			const vertical = Math.abs(end.x - next.x) < 0.01;
			if (
				(onVertical && !onHorizontal && vertical) ||
				(onHorizontal && !onVertical && !vertical)
			)
				alongBorderEnds += 1;
		}
		const last = e.points.at(-1) as Point;
		const prev = e.points.at(-2) as Point;
		if (Math.abs(last.x - prev.x) + Math.abs(last.y - prev.y) < 12)
			shortArrowEnds += 1;
	}
	let portLabelHits = 0;
	for (const e of d.edges) {
		for (const t of d.textAnnotations ?? []) {
			if (t.surfaceKind !== "port-label") continue;
			if (crosses(e.points, inset(t.box, 1))) portLabelHits += 1;
		}
	}
	// Inline labels and callout keys more than 30px from their own line
	// read as some other edge's label.
	let strayLabels = 0;
	for (const t of d.textAnnotations ?? []) {
		if (t.surfaceKind !== "edge-label" || t.placementDetail?.role === "callout")
			continue;
		const own = d.edges.find((e) => e.id === t.ownerId);
		if (own === undefined) continue;
		let nearest = Number.POSITIVE_INFINITY;
		for (let i = 0; i + 1 < own.points.length; i += 1) {
			const a = own.points[i] as Point;
			const b = own.points[i + 1] as Point;
			const dx = Math.max(
				0,
				t.box.x - Math.max(a.x, b.x),
				Math.min(a.x, b.x) - (t.box.x + t.box.width),
			);
			const dy = Math.max(
				0,
				t.box.y - Math.max(a.y, b.y),
				Math.min(a.y, b.y) - (t.box.y + t.box.height),
			);
			nearest = Math.min(nearest, Math.hypot(dx, dy));
		}
		if (nearest > 30) strayLabels += 1;
	}
	// Swimlanes: every child inside its own lane's content, no node on a
	// lane header, no edge label straddling a lane border.
	let laneMisplaced = 0;
	let headerCovered = 0;
	let labelOnLaneBorder = 0;
	for (const sw of d.swimlanes ?? []) {
		for (const lane of sw.lanes) {
			const content = lane.contentBox ?? lane.box;
			for (const child of lane.children) {
				const box = d.nodes.find((n) => n.id === child)?.box;
				if (box === undefined || content === undefined) continue;
				const inside =
					box.x >= content.x - 0.5 &&
					box.y >= content.y - 0.5 &&
					box.x + box.width <= content.x + content.width + 0.5 &&
					box.y + box.height <= content.y + content.height + 0.5;
				if (!inside) laneMisplaced += 1;
			}
			if (lane.headerBox !== undefined) {
				for (const n of d.nodes)
					if (overlap(inset(n.box, 0.5), lane.headerBox)) headerCovered += 1;
			}
			if (lane.box !== undefined) {
				for (const [horizontal, at, lo, hi] of boxSides(lane.box)) {
					for (const t of d.textAnnotations ?? []) {
						if (t.surfaceKind !== "edge-label") continue;
						const b = t.box;
						const across = horizontal
							? b.y < at &&
								b.y + b.height > at &&
								b.x < hi &&
								b.x + b.width > lo
							: b.x < at &&
								b.x + b.width > at &&
								b.y < hi &&
								b.y + b.height > lo;
						if (across) labelOnLaneBorder += 1;
					}
				}
			}
		}
	}
	let microJogs = 0;
	for (const e of d.edges) {
		for (let i = 1; i + 2 < e.points.length; i += 1) {
			const a = e.points[i] as Point;
			const b = e.points[i + 1] as Point;
			const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
			if (len > 0 && len < 2) microJogs += 1;
		}
	}
	return {
		nearParallel: Math.round(nearParallel),
		borderRun: Math.round(borderRun),
		alongBorderEnds,
		shortArrowEnds,
		portLabelHits,
		microJogs,
		strayLabels,
		laneMisplaced,
		headerCovered,
		labelOnLaneBorder,
	};
}

function evidence(d: CoordinatedDiagram) {
	const texts = d.textAnnotations ?? [];
	let nodePierce = 0;
	let hardText = 0;
	for (const e of d.edges) {
		for (const n of d.nodes) {
			if (n.id === e.source.nodeId || n.id === e.target.nodeId) continue;
			if (crosses(e.points, inset(n.box, 1))) nodePierce += 1;
		}
		for (const t of texts) {
			if (t.surfaceKind !== "node-label" && t.surfaceKind !== "group-label")
				continue;
			if (t.ownerId === e.source.nodeId || t.ownerId === e.target.nodeId)
				continue;
			if (crosses(e.points, inset(t.box, 1))) hardText += 1;
		}
	}
	// other edges' labels and callout keys (#87)
	let edgeLabelHits = 0;
	for (const e of d.edges) {
		for (const t of texts) {
			if (t.surfaceKind !== "edge-label" || t.ownerId === e.id) continue;
			if (
				t.placement === "external-callout" &&
				t.placementDetail?.role === "callout"
			)
				continue;
			if (crosses(e.points, inset(t.box, 1))) edgeLabelHits += 1;
		}
	}
	// foreign group / lane header interiors (#95)
	let groupPierce = 0;
	for (const e of d.edges) {
		for (const g of d.groups) {
			if (
				g.nodeIds.includes(e.source.nodeId) ||
				g.nodeIds.includes(e.target.nodeId)
			)
				continue;
			if (crosses(e.points, inset(g.box, 1))) groupPierce += 1;
		}
		for (const sw of d.swimlanes ?? []) {
			for (const lane of sw.lanes) {
				if (
					lane.headerBox !== undefined &&
					crosses(e.points, inset(lane.headerBox, 1))
				)
					groupPierce += 1;
			}
		}
	}
	// same-side attach collisions (#92/#94)
	const ends = new Map<string, number[]>();
	for (const e of d.edges) {
		for (const [end, nodeId] of [
			[e.points[0], e.source.nodeId],
			[e.points.at(-1), e.target.nodeId],
		] as const) {
			const n = d.nodes.find((node) => node.id === nodeId);
			if (end === undefined || n === undefined) continue;
			const b = n.box;
			const side =
				Math.abs(end.x - b.x) < 1
					? "L"
					: Math.abs(end.x - b.x - b.width) < 1
						? "R"
						: Math.abs(end.y - b.y) < 1
							? "T"
							: "B";
			const key = `${nodeId}:${side}`;
			const list = ends.get(key) ?? [];
			list.push(side === "L" || side === "R" ? end.y : end.x);
			ends.set(key, list);
		}
	}
	let slotCollisions = 0;
	for (const list of ends.values()) {
		const sorted = [...list].sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i += 1) {
			if ((sorted[i] as number) - (sorted[i - 1] as number) < 4)
				slotCollisions += 1;
		}
	}
	// named ports on 25/50/75 (#91)
	const portFractions: string[] = [];
	for (const n of d.nodes) {
		for (const p of n.ports ?? []) {
			const c =
				p.side === "left" || p.side === "right"
					? (p.anchor.y - n.box.y) / n.box.height
					: (p.anchor.x - n.box.x) / n.box.width;
			portFractions.push(`${n.id}.${p.id}:${c.toFixed(2)}`);
		}
	}
	// external callouts (#93)
	const callouts = texts.filter((t) => t.placement === "external-callout");
	let calloutOverlap = 0;
	let calloutOnObstacle = 0;
	let calloutOffPage = 0;
	callouts.forEach((c, i) => {
		for (const o of callouts.slice(i + 1))
			if (overlap(inset(c.box, 0.5), inset(o.box, 0.5))) calloutOverlap += 1;
		for (const n of d.nodes) if (overlap(c.box, n.box)) calloutOnObstacle += 1;
		const page = RSOP.pageBounds;
		if (
			page &&
			(c.box.x < 0 ||
				c.box.y < 0 ||
				c.box.x + c.box.width > page.width ||
				c.box.y + c.box.height > page.height)
		)
			calloutOffPage += 1;
	});
	// detour (#76/#84)
	const detours = d.edges
		.map((e) => {
			let len = 0;
			for (let i = 0; i + 1 < e.points.length; i += 1) {
				const a = e.points[i] as Point;
				const b = e.points[i + 1] as Point;
				len += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
			}
			const a = e.points[0] as Point;
			const b = e.points.at(-1) as Point;
			return len / Math.max(1, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
		})
		.sort((x, y) => x - y);
	const q = measureLayoutQuality(d);
	const svg = exportSvg(d);
	const hops = (svg.match(/ A /g) ?? []).length;
	return {
		nodePierce,
		hardText,
		groupPierce,
		edgeLabelHits,
		overlapLen: Math.round(q.overlappingSegmentLength),
		shared: q.sharedEndpoints,
		slotCollisions,
		maxBends: Math.max(...d.edges.map((e) => e.points.length - 2)),
		detourP95: +(detours[Math.floor(detours.length * 0.95)] ?? 1).toFixed(2),
		detourMax: +(detours.at(-1) ?? 1).toFixed(2),
		callouts: callouts.length,
		calloutOverlap,
		calloutOnObstacle,
		calloutOffPage,
		edgeCrossings: d.edgeCrossings?.length ?? 0,
		svgHops: hops,
		deliverability: d.deliverability?.status,
		codes: [
			...new Set(
				d.diagnostics.filter((x) => x.severity !== "info").map((x) => x.code),
			),
		].join(","),
		ports: portFractions.join(" "),
		...renderDefects(d),
	};
}

const LEGACY: SolveDiagramOptions = {
	initialLayout: "positions",
	routeKind: "obstacle-avoiding",
	railRouting: "auto",
	externalLabels: true,
	remediationPolicy: { externalLabels: "auto" },
	distributeContainedChildren: false,
	deliverabilityMode: "degraded-ok",
	textMeasurer: new DeterministicTextMeasurer(),
};

describe("dense MBSE issue regressions", { timeout: 120_000 }, () => {
	it("#84: short-orthogonal routes stay short and every crossing is drawn as a hop", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const found = evidence(solveDiagram(load(source), RSOP));
			expect(found.detourMax, name).toBeLessThanOrEqual(3);
			expect(found.nodePierce, name).toBe(0);
			expect(found.svgHops, name).toBe(found.edgeCrossings);
		}
	});

	it("#87: short-orthogonal routes keep off other edges' labels and node text", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const found = evidence(solveDiagram(load(source), RSOP));
			expect(found.edgeLabelHits, name).toBe(0);
			expect(found.hardText, name).toBe(0);
		}
	});

	it("#88/#92/#94: parallel routes and same-side ends never coincide", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const found = evidence(solveDiagram(load(source), RSOP));
			expect(found.overlapLen, name).toBe(0);
			expect(found.shared, name).toBe(0);
			expect(found.slotCollisions, name).toBe(0);
		}
	});

	it("#91: named ports dock at equal divisions of their side", () => {
		const found = evidence(
			solveDiagram(load(PAGES["SV-1 ports"] as string), RSOP),
		);
		expect(found.ports).toContain("hn900.CMD:0.25");
		expect(found.ports).toContain("hn900.DAT:0.50");
		expect(found.ports).toContain("hn900.SEN:0.75");
	});

	it("#95: accepted short-orthogonal geometry enters no foreign node, zone or hard text", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const solved = solveDiagram(load(source), RSOP);
			const found = evidence(solved);
			expect(found.nodePierce, name).toBe(0);
			expect(found.hardText, name).toBe(0);
			expect(found.groupPierce, name).toBe(0);
			expect(
				solved.diagnostics.map((diagnostic) => diagnostic.code),
				name,
			).not.toContain("routing.obstacle.unavoidable");
		}
	});

	it("#93: shelf callouts on a small page never overlap each other or the diagram", () => {
		for (const size of [
			{ width: 760, height: 260 },
			{ width: 500, height: 200 },
		]) {
			for (const [name, source] of Object.entries(PAGES)) {
				const solved = solveDiagram(load(source), {
					...RSOP,
					pageBounds: size,
				});
				const callouts = (solved.textAnnotations ?? []).filter(
					(text) => text.placementDetail?.role === "callout",
				);
				const obstacles = [
					...solved.nodes.map((node) => node.box),
					...solved.groups.map((group) => group.box),
				];
				callouts.forEach((callout, index) => {
					for (const other of callouts.slice(index + 1)) {
						expect(overlap(callout.box, other.box), name).toBe(false);
					}
					for (const box of obstacles) {
						expect(overlap(callout.box, box), name).toBe(false);
					}
					expect(callout.box.x + callout.box.width).toBeLessThanOrEqual(
						size.width,
					);
					expect(callout.box.y + callout.box.height).toBeLessThanOrEqual(
						size.height,
					);
				});
				const required = (solved.textAnnotations ?? []).filter(
					(text) => text.placement === "external-callout-required",
				);
				if (required.length > 0) {
					expect(
						solved.diagnostics.map((diagnostic) => diagnostic.code),
						name,
					).toContain("routing.label-shelf.capacity_exhausted");
				}
			}
		}
	});

	it("#93: a page with room for no callout still reports shelf capacity in the plan", () => {
		const solved = solveDiagram(load(PAGES["AV-1 zones"] as string), {
			...RSOP,
			pageBounds: { width: 40, height: 40 },
		});
		expect(
			(solved.textAnnotations ?? []).filter(
				(text) => text.placementDetail?.role === "callout",
			),
		).toEqual([]);
		const plan = (solved.deliverability?.remediationPlans ?? []).find(
			(candidate) => candidate.type === "external-label",
		);
		expect(plan?.status).toBe("blocked");
		expect(plan?.diagnosticCodes).toContain(
			"routing.label-shelf.capacity_exhausted",
		);
		expect(
			(plan?.detail as { unplacedCount?: number } | undefined)?.unplacedCount,
		).toBeGreaterThan(0);
	});

	it("#98 render check: short-orthogonal pages draw nothing that only shows once rendered", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const defects = renderDefects(solveDiagram(load(source), RSOP));
			expect(defects, name).toEqual({
				nearParallel: 0,
				borderRun: 0,
				alongBorderEnds: 0,
				shortArrowEnds: 0,
				portLabelHits: 0,
				microJogs: 0,
				strayLabels: 0,
				laneMisplaced: 0,
				headerCovered: 0,
				labelOnLaneBorder: 0,
			});
		}
	});

	it("#76: obstacle-avoiding routes stay orthogonal and short (no zigzag fallback)", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const solved = solveDiagram(load(source), LEGACY);
			const found = evidence(solved);
			expect(found.maxBends, name).toBeLessThanOrEqual(10);
			expect(found.detourMax, name).toBeLessThanOrEqual(5);
			for (const edge of solved.edges) {
				for (let index = 1; index < edge.points.length; index += 1) {
					const a = edge.points[index - 1] as Point;
					const b = edge.points[index] as Point;
					expect(
						Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5,
						`${name} ${edge.id}`,
					).toBe(true);
				}
			}
		}
	});

	it("#76: obstacle-avoiding ends do not share points and every crossing is drawn", () => {
		for (const name of ["AV-1 zones", "OV-5b lanes"]) {
			const found = evidence(solveDiagram(load(PAGES[name] as string), LEGACY));
			expect(found.shared, name).toBe(0);
			expect(found.slotCollisions, name).toBe(0);
			expect(found.svgHops, name).toBe(found.edgeCrossings);
		}
	});

	it("#89: draw.io export carries every crossing as a jump", () => {
		for (const [name, source] of Object.entries(PAGES)) {
			const solved = solveDiagram(load(source), RSOP);
			const xml = exportDrawio(solved);
			expect(xml, name).toContain(
				(solved.edgeCrossings?.length ?? 0) > 0
					? "jumpStyle=arc"
					: "jumpStyle=none",
			);
			expect((xml.match(/as="dgeJump"/g) ?? []).length, name).toBe(
				solved.edgeCrossings?.length ?? 0,
			);
		}
	});
});

/**
 * Evidence for the open dense-MBSE issues (opt-in):
 * DGE_ISSUES=1 npx vitest run test/issues
 */
it.skipIf(process.env.DGE_ISSUES !== "1")(
	"dense MBSE issue evidence",
	{ timeout: 300_000 },
	() => {
		for (const [name, source] of Object.entries(PAGES)) {
			const rsop = solveDiagram(load(source), RSOP);
			console.log("RSOP", name, JSON.stringify(evidence(rsop)));
			console.log(
				"PLANS",
				name,
				JSON.stringify(
					(rsop.deliverability?.remediationPlans ?? []).map(
						(plan) => `${plan.type}:${plan.status}`,
					),
				),
			);
			console.log(
				"LEGACY",
				name,
				JSON.stringify(evidence(solveDiagram(load(source), LEGACY))),
			);
		}
		const small = { ...RSOP, pageBounds: { width: 760, height: 260 } };
		const shelf = solveDiagram(load(PAGES["AV-1 zones"] as string), small);
		const callouts = (shelf.textAnnotations ?? []).filter(
			(t) =>
				t.placement === "external-callout" &&
				t.placementDetail?.role === "callout",
		);
		console.log(
			"SHELF",
			JSON.stringify({
				callouts: callouts.length,
				offPage: callouts.filter(
					(c) => c.box.x + c.box.width > 760 || c.box.y + c.box.height > 260,
				).length,
				diagnostics: [...new Set(shelf.diagnostics.map((x) => x.code))].filter(
					(c) => /page|callout|capacity/.test(c),
				),
			}),
		);
	},
);
