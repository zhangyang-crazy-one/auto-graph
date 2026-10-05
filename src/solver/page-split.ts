import {
	DEFAULT_FONT,
	DEFAULT_NODE_MIN_SIZE,
	DEFAULT_NODE_PADDING,
} from "../dsl/normalize.js";
import {
	DELIVERABILITY_DIAGNOSTIC_CODES,
	type Diagnostic,
} from "../ir/diagnostics.js";
import type {
	CoordinatedDiagram,
	DeliverabilityReport,
	DeliverabilityStatus,
	NormalizedDiagram,
	PageSplitRemediationDetail,
	RemediationPlan,
} from "../ir/diagram.js";
import type {
	NormalizedEdge,
	NormalizedNode,
	Swimlane,
} from "../ir/elements.js";
import type { JsonValue } from "../ir/geometry.js";
import { fitLabelToShape } from "../labels/index.js";
import { createDefaultTextMeasurer, type TextMeasurer } from "../text/index.js";
import {
	resolveRemediationPolicy,
	type SolveDiagramOptions,
} from "./options.js";
import { buildRemediationPlan } from "./remediation.js";

/**
 * Executable page split (#75 / #86): when `remediationPolicy.pageSplit` is
 * `auto` and a solved page stays over capacity, cut it into pages along
 * the flow and solve every page on its own. Edges cut at a page boundary
 * end at an off-page connector naming the page and node on the other side.
 *
 * Nodes that belong together never part: a group with everything nested
 * in it, and a node with its children, go to one page. Pages are runs of
 * these units in flow order (the order the unsplit solve placed them),
 * chosen to cut as few edges as possible while keeping pages even.
 */

type SolvePage = (
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions,
) => CoordinatedDiagram;

/** More pages than this stop being one diagram. */
const MAX_PAGES = 6;
/** Page counts tried after the first (2 pages). */
const MAX_ATTEMPTS = 2;
/** One unit of imbalance (a page twice its share) is worth this many cut edges. */
const BALANCE_WEIGHT = 2;
/** A page may hold at most this share of the even split before it is penalised hard. */
const MAX_PAGE_SHARE = 1.5;
/** …and at least this share. */
const MIN_PAGE_SHARE = 0.4;
/** Off-page connectors sit this far beyond the page content. */
const CONNECTOR_GAP = 48;
const CONNECTOR_SPACING = 12;
const CONNECTOR_PREFIX = "__offpage__";
const CONNECTOR_STYLE = { fill: "#eef2ff", stroke: "#4f46e5" } as const;

export function splitOverCapacityPage(
	diagram: NormalizedDiagram,
	options: SolveDiagramOptions,
	solved: CoordinatedDiagram,
	solvePage: SolvePage,
): CoordinatedDiagram {
	const report = solved.deliverability;
	if (report === undefined || report.status === "clean") return solved;
	// Any page that is not clean may split, whichever remediation the
	// residual conflicts asked for first.
	const plan =
		report.remediationPlans.find(
			(candidate) => candidate.type === "page-split",
		) ?? synthesizedPlan(solved, report, options);
	const splitter = createPageSplitter(diagram, solved, options);
	if (splitter.maxPages < 2) {
		return withBlockedSplit(
			solved,
			plan,
			"Everything on the page is one group or nested node; there is nothing to split along.",
		);
	}
	const unsplitBlocking = blockingCount(solved);
	let best: (PageSplitAttempt & { blocking: number }) | undefined;
	for (
		let pageCount = 2;
		pageCount <= Math.min(splitter.maxPages, 1 + MAX_ATTEMPTS);
		pageCount += 1
	) {
		const attempt = splitter.split(pageCount, solvePage);
		const blocking = attempt.pages.reduce(
			(sum, page) => sum + blockingCount(page),
			0,
		);
		if (best === undefined || blocking < best.blocking) {
			best = { ...attempt, blocking };
		}
		if (blocking === 0) break;
	}
	if (best === undefined || best.blocking >= unsplitBlocking) {
		return withBlockedSplit(
			solved,
			plan,
			`Splitting into pages left ${best?.blocking ?? unsplitBlocking} conflict(s), no fewer than the single page's ${unsplitBlocking}.`,
		);
	}
	return assemblePages(solved, plan, best);
}

export interface PageSplitAttempt {
	split: PageSplit;
	/** Every page, solved. */
	pages: CoordinatedDiagram[];
}

/**
 * Splits `diagram` into a given number of pages: units in the order
 * `solved` placed them, cut where the fewest edges cross. `maxPages` is
 * how many pages the units allow (at most MAX_PAGES).
 */
export function createPageSplitter(
	diagram: NormalizedDiagram,
	solved: CoordinatedDiagram,
	options: SolveDiagramOptions,
): {
	maxPages: number;
	split(pageCount: number, solvePage: SolvePage): PageSplitAttempt;
} {
	const units = splitUnits(diagram);
	// Along the flow first; across it when that cuts fewer edges.
	const orders = [false, true].map((across) =>
		orderUnits(units, diagram, solved, across),
	);
	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
	// Pages never split again.
	const pageOptions: SolveDiagramOptions = {
		...options,
		remediationPolicy: {
			...resolveRemediationPolicy(options.remediationPolicy),
			pageSplit: "suggest",
		},
	};
	return {
		maxPages: Math.min(units.length, MAX_PAGES),
		split(pageCount, solvePage) {
			const { order, pageOfUnit } = orders
				.map((candidate) => ({
					order: candidate,
					...partitionUnits(candidate, diagram.edges, pageCount),
				}))
				.reduce((a, b) => (b.cost < a.cost - 1e-9 ? b : a));
			const split = buildPages(diagram, order, pageOfUnit, pageCount, measurer);
			return {
				split,
				pages: split.pages.map((page) => solvePage(page.diagram, pageOptions)),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Units and their order
// ---------------------------------------------------------------------------

interface SplitUnit {
	nodeIds: string[];
	groupIds: string[];
	/** Position of the unit's first node in the input. */
	firstIndex: number;
}

/** Nodes that must stay together: a top-level group tree, a node with its children. */
function splitUnits(diagram: NormalizedDiagram): SplitUnit[] {
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.has(root) && parent.get(root) !== root) {
			root = parent.get(root) as string;
		}
		return root;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) return;
		// The lexically smaller root wins: deterministic whatever the order.
		if (ra < rb) parent.set(rb, ra);
		else parent.set(ra, rb);
	};
	const nodeIds = new Set(diagram.nodes.map((node) => node.id));
	for (const node of diagram.nodes) {
		parent.set(`n:${node.id}`, `n:${node.id}`);
	}
	for (const node of diagram.nodes) {
		if (node.parentId !== undefined && nodeIds.has(node.parentId)) {
			union(`n:${node.id}`, `n:${node.parentId}`);
		}
	}
	for (const group of diagram.groups) {
		if (!parent.has(`g:${group.id}`))
			parent.set(`g:${group.id}`, `g:${group.id}`);
		for (const id of group.nodeIds) {
			if (nodeIds.has(id)) union(`g:${group.id}`, `n:${id}`);
		}
		for (const id of group.groupIds) {
			if (!parent.has(`g:${id}`)) parent.set(`g:${id}`, `g:${id}`);
			union(`g:${group.id}`, `g:${id}`);
		}
	}
	const byRoot = new Map<string, SplitUnit>();
	diagram.nodes.forEach((node, index) => {
		const root = find(`n:${node.id}`);
		const unit = byRoot.get(root);
		if (unit === undefined) {
			byRoot.set(root, { nodeIds: [node.id], groupIds: [], firstIndex: index });
		} else {
			unit.nodeIds.push(node.id);
		}
	});
	for (const group of diagram.groups) {
		byRoot.get(find(`g:${group.id}`))?.groupIds.push(group.id);
	}
	return [...byRoot.values()];
}

/**
 * Units in the order the unsplit solve placed them, along the flow (or
 * across it). Connected units stay together, so a page boundary between
 * unconnected parts cuts nothing.
 */
function orderUnits(
	units: readonly SplitUnit[],
	diagram: NormalizedDiagram,
	solved: CoordinatedDiagram,
	across: boolean,
): SplitUnit[] {
	const boxes = new Map(solved.nodes.map((node) => [node.id, node.box]));
	const sign =
		diagram.direction === "RL" || diagram.direction === "BT" ? -1 : 1;
	const horizontal =
		(diagram.direction === "LR" || diagram.direction === "RL") !== across;
	const key = (unit: SplitUnit) => {
		let primary = 0;
		let secondary = 0;
		let count = 0;
		for (const id of unit.nodeIds) {
			const box = boxes.get(id);
			if (box === undefined) continue;
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			primary += horizontal ? x : y;
			secondary += horizontal ? y : x;
			count += 1;
		}
		return count === 0
			? { primary: Number.POSITIVE_INFINITY, secondary: 0 }
			: {
					primary: ((across ? 1 : sign) * primary) / count,
					secondary: secondary / count,
				};
	};
	const keys = new Map(units.map((unit) => [unit, key(unit)]));
	const compare = (a: SplitUnit, b: SplitUnit) => {
		const ka = keys.get(a) as { primary: number; secondary: number };
		const kb = keys.get(b) as { primary: number; secondary: number };
		return (
			ka.primary - kb.primary ||
			ka.secondary - kb.secondary ||
			a.firstIndex - b.firstIndex
		);
	};
	// Connected components, each in order, ordered by their first unit.
	const unitOf = new Map<string, number>();
	units.forEach((unit, index) => {
		for (const id of unit.nodeIds) unitOf.set(id, index);
	});
	const root = units.map((_, index) => index);
	const find = (index: number): number => {
		let at = index;
		while (root[at] !== at) at = root[at] as number;
		return at;
	};
	for (const edge of diagram.edges) {
		const a = unitOf.get(edge.source.nodeId);
		const b = unitOf.get(edge.target.nodeId);
		if (a === undefined || b === undefined) continue;
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) root[Math.max(ra, rb)] = Math.min(ra, rb);
	}
	const components = new Map<number, SplitUnit[]>();
	units.forEach((unit, index) => {
		const component = find(index);
		components.set(component, [...(components.get(component) ?? []), unit]);
	});
	return [...components.values()]
		.map((members) => [...members].sort(compare))
		.sort((a, b) => compare(a[0] as SplitUnit, b[0] as SplitUnit))
		.flat();
}

/**
 * Cut the ordered units into `pageCount` runs: fewest cut edges first,
 * then the most even pages. Returns the 1-based page of every unit.
 */
function partitionUnits(
	units: readonly SplitUnit[],
	edges: readonly NormalizedEdge[],
	pageCount: number,
): { pageOfUnit: number[]; cost: number } {
	const n = units.length;
	const position = new Map<string, number>();
	units.forEach((unit, index) => {
		for (const id of unit.nodeIds) position.set(id, index);
	});
	const weight = units.map((unit) => unit.nodeIds.length);
	const byLo: number[][] = Array.from({ length: n }, () => []);
	const byHi: number[][] = Array.from({ length: n }, () => []);
	for (const edge of edges) {
		const a = position.get(edge.source.nodeId);
		const b = position.get(edge.target.nodeId);
		if (a === undefined || b === undefined) continue;
		weight[a] = (weight[a] as number) + 0.5;
		weight[b] = (weight[b] as number) + 0.5;
		if (a === b) continue;
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);
		(byLo[lo] as number[]).push(hi);
		(byHi[hi] as number[]).push(lo);
	}
	const prefix = [0];
	for (const value of weight) prefix.push((prefix.at(-1) as number) + value);
	const total = prefix.at(-1) as number;
	const target = total / pageCount;
	// cut[a][b]: edges leaving the run a..b towards later units.
	const cut: number[][] = [];
	for (let a = 0; a < n; a += 1) {
		const row: number[] = [];
		let count = 0;
		for (let b = a; b < n; b += 1) {
			for (const hi of byLo[b] as number[]) if (hi > b) count += 1;
			for (const lo of byHi[b] as number[]) if (lo >= a) count -= 1;
			row[b] = count;
		}
		cut.push(row);
	}
	const segmentCost = (a: number, b: number, last: boolean) => {
		const share = ((prefix[b + 1] as number) - (prefix[a] as number)) / target;
		return (
			(last ? 0 : ((cut[a] as number[])[b] as number)) +
			BALANCE_WEIGHT * Math.abs(share - 1) +
			(share > MAX_PAGE_SHARE ? 1000 * (share - MAX_PAGE_SHARE) : 0) +
			(share < MIN_PAGE_SHARE ? 1000 * (MIN_PAGE_SHARE - share) : 0)
		);
	};
	// best[p][b]: cheapest way to put units 0..b on p+1 pages.
	const best: number[][] = Array.from({ length: pageCount }, () =>
		new Array<number>(n).fill(Number.POSITIVE_INFINITY),
	);
	const from: number[][] = Array.from({ length: pageCount }, () =>
		new Array<number>(n).fill(-1),
	);
	for (let b = 0; b < n; b += 1) {
		(best[0] as number[])[b] = segmentCost(
			0,
			b,
			pageCount === 1 && b === n - 1,
		);
	}
	for (let p = 1; p < pageCount; p += 1) {
		for (let b = p; b < n; b += 1) {
			for (let a = p; a <= b; a += 1) {
				const before = (best[p - 1] as number[])[a - 1] as number;
				if (!Number.isFinite(before)) continue;
				const cost =
					before + segmentCost(a, b, p === pageCount - 1 && b === n - 1);
				if (cost < ((best[p] as number[])[b] as number) - 1e-9) {
					(best[p] as number[])[b] = cost;
					(from[p] as number[])[b] = a;
				}
			}
		}
	}
	const pageOfUnit = new Array<number>(n).fill(1);
	let end = n - 1;
	for (let p = pageCount - 1; p >= 0; p -= 1) {
		const start = p === 0 ? 0 : ((from[p] as number[])[end] as number);
		for (let index = start; index <= end; index += 1) pageOfUnit[index] = p + 1;
		end = start - 1;
	}
	return {
		pageOfUnit,
		cost: (best[pageCount - 1] as number[])[n - 1] as number,
	};
}

// ---------------------------------------------------------------------------
// Page diagrams
// ---------------------------------------------------------------------------

export interface PageSplit {
	pageCount: number;
	pages: Array<{
		diagram: NormalizedDiagram;
		nodeIds: string[];
		edgeIds: string[];
	}>;
	crossPageEdgeIds: string[];
}

interface Connector {
	id: string;
	remoteId: string;
	remotePage: number;
	internalIds: string[];
	outgoing: boolean;
	incoming: boolean;
}

function buildPages(
	diagram: NormalizedDiagram,
	units: readonly SplitUnit[],
	pageOfUnit: readonly number[],
	pageCount: number,
	measurer: TextMeasurer,
): PageSplit {
	const nodePage = new Map<string, number>();
	const groupPage = new Map<string, number>();
	units.forEach((unit, index) => {
		const page = pageOfUnit[index] as number;
		for (const id of unit.nodeIds) nodePage.set(id, page);
		for (const id of unit.groupIds) groupPage.set(id, page);
	});
	const pageOfEnd = (id: string) => nodePage.get(id) ?? groupPage.get(id);
	const nodesById = new Map(diagram.nodes.map((node) => [node.id, node]));
	const positioned = diagram.nodes.some((node) => node.position !== undefined);
	const crossPageEdgeIds: string[] = [];

	const pages: PageSplit["pages"] = [];
	for (let page = 1; page <= pageCount; page += 1) {
		const nodes = diagram.nodes.filter(
			(node) => nodePage.get(node.id) === page,
		);
		const connectors = new Map<string, Connector>();
		const connect = (
			remoteId: string,
			internalId: string,
			outgoing: boolean,
		) => {
			const id = `${CONNECTOR_PREFIX}${remoteId}`;
			const existing = connectors.get(id) ?? {
				id,
				remoteId,
				remotePage: pageOfEnd(remoteId) ?? 1,
				internalIds: [],
				outgoing: false,
				incoming: false,
			};
			if (!existing.internalIds.includes(internalId)) {
				existing.internalIds.push(internalId);
			}
			if (outgoing) existing.outgoing = true;
			else existing.incoming = true;
			connectors.set(id, existing);
			return id;
		};
		const edges: NormalizedEdge[] = [];
		const wholeEdgeIds: string[] = [];
		for (const edge of diagram.edges) {
			const sourcePage = pageOfEnd(edge.source.nodeId);
			const targetPage = pageOfEnd(edge.target.nodeId);
			const home = sourcePage ?? targetPage ?? 1;
			if (
				sourcePage === targetPage ||
				sourcePage === undefined ||
				targetPage === undefined
			) {
				if (home === page) {
					edges.push(edge);
					wholeEdgeIds.push(edge.id);
				}
				continue;
			}
			if (sourcePage === page) {
				if (!crossPageEdgeIds.includes(edge.id)) crossPageEdgeIds.push(edge.id);
				edges.push({
					...edge,
					target: {
						nodeId: connect(edge.target.nodeId, edge.source.nodeId, true),
					},
				});
			} else if (targetPage === page) {
				edges.push({
					...edge,
					source: {
						nodeId: connect(edge.source.nodeId, edge.target.nodeId, false),
					},
				});
			}
		}
		const connectorNodes = [...connectors.values()].map((connector) =>
			connectorNode(connector, nodesById, measurer),
		);
		if (positioned)
			placeConnectors(
				connectorNodes,
				connectors,
				nodes,
				page,
				diagram.direction,
			);
		const onPage = (id: string) =>
			nodePage.get(id) === page || groupPage.get(id) === page;
		const groups = diagram.groups.filter(
			(group) => (groupPage.get(group.id) ?? 1) === page,
		);
		const swimlanes = pageSwimlanes(
			diagram.swimlanes,
			onPage,
			positioned ? new Map() : laneAdditions(connectors, diagram.swimlanes),
		);
		const suffix = ` (${page}/${pageCount})`;
		const pageDiagram: NormalizedDiagram = {
			id: diagram.id,
			...(diagram.title === undefined
				? {}
				: { title: `${diagram.title}${suffix}` }),
			direction: diagram.direction,
			nodes: [...nodes, ...connectorNodes],
			edges,
			groups,
			...(swimlanes === undefined ? {} : { swimlanes }),
			...(page === 1 && diagram.matrices !== undefined
				? { matrices: diagram.matrices }
				: {}),
			...(page === 1 && diagram.tables !== undefined
				? { tables: diagram.tables }
				: {}),
			...(page === 1 && diagram.evidencePanels !== undefined
				? { evidencePanels: diagram.evidencePanels }
				: {}),
			constraints: diagram.constraints.filter((constraint) =>
				referencedIds(constraint, nodePage, groupPage).every(onPage),
			),
			diagnostics: page === 1 ? diagram.diagnostics : [],
			...(diagram.frame === undefined
				? {}
				: {
						frame: {
							...diagram.frame,
							titleTab: `${diagram.frame.titleTab}${suffix}`,
						},
					}),
			...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
		};
		pages.push({
			diagram: pageDiagram,
			nodeIds: nodes.map((node) => node.id),
			edgeIds: wholeEdgeIds,
		});
	}
	return { pageCount, pages, crossPageEdgeIds };
}

function connectorNode(
	connector: Connector,
	nodesById: ReadonlyMap<string, NormalizedNode>,
	measurer: TextMeasurer,
): NormalizedNode {
	const remote = nodesById.get(connector.remoteId);
	const name = remote?.label?.text ?? connector.remoteId;
	const text =
		connector.outgoing && connector.incoming
			? `↔ P${connector.remotePage} · ${name}`
			: connector.outgoing
				? `→ P${connector.remotePage} · ${name}`
				: `P${connector.remotePage} · ${name} →`;
	const fit = fitLabelToShape(
		text,
		{
			shape: "rounded-rectangle",
			font: DEFAULT_FONT,
			padding: DEFAULT_NODE_PADDING,
			minSize: DEFAULT_NODE_MIN_SIZE,
			maxWidth: 160,
			overflow: "diagnose",
		},
		measurer,
	);
	return {
		id: connector.id,
		label: { text },
		shape: "rounded-rectangle",
		style: { ...CONNECTOR_STYLE },
		size: {
			width: Math.max(DEFAULT_NODE_MIN_SIZE.width, fit.size.width),
			height: Math.max(DEFAULT_NODE_MIN_SIZE.height, fit.size.height),
		},
		padding: { ...DEFAULT_NODE_PADDING },
		labelLayout: fit.layout,
		metadata: {
			offPageConnector: true,
			remoteNodeId: connector.remoteId,
			remotePage: connector.remotePage,
		},
	};
}

/**
 * Seeded-position pages: connectors line up beyond the page content on
 * the side facing their page (later pages downstream), each level with
 * the node it serves, pushed apart where they would touch.
 */
function placeConnectors(
	connectorNodes: NormalizedNode[],
	connectors: ReadonlyMap<string, Connector>,
	nodes: readonly NormalizedNode[],
	page: number,
	direction: NormalizedDiagram["direction"],
): void {
	const placed = nodes.filter((node) => node.position !== undefined);
	if (placed.length === 0) return;
	const horizontal = direction === "LR" || direction === "RL";
	const reversed = direction === "RL" || direction === "BT";
	const minFlow = Math.min(
		...placed.map(
			(node) => (horizontal ? node.position?.x : node.position?.y) as number,
		),
	);
	const maxFlow = Math.max(
		...placed.map(
			(node) =>
				((horizontal ? node.position?.x : node.position?.y) as number) +
				(horizontal ? node.size.width : node.size.height),
		),
	);
	const centres = new Map(
		placed.map((node) => [
			node.id,
			horizontal
				? (node.position?.y as number) + node.size.height / 2
				: (node.position?.x as number) + node.size.width / 2,
		]),
	);
	for (const after of [false, true]) {
		const column = connectorNodes
			.filter((node) => {
				const connector = connectors.get(node.id) as Connector;
				return connector.remotePage > page === after;
			})
			.map((node) => {
				const connector = connectors.get(node.id) as Connector;
				const levels = connector.internalIds
					.map((id) => centres.get(id))
					.filter((value): value is number => value !== undefined);
				const centre =
					levels.length === 0
						? 0
						: levels.reduce((sum, value) => sum + value, 0) / levels.length;
				return { node, centre };
			})
			.sort((a, b) => a.centre - b.centre || (a.node.id < b.node.id ? -1 : 1));
		const downstream = after !== reversed;
		let next = Number.NEGATIVE_INFINITY;
		for (const { node, centre } of column) {
			const along = horizontal ? node.size.height : node.size.width;
			const start = Math.max(centre - along / 2, next);
			next = start + along + CONNECTOR_SPACING;
			const across = horizontal ? node.size.width : node.size.height;
			const flow = downstream
				? maxFlow + CONNECTOR_GAP
				: minFlow - CONNECTOR_GAP - across;
			node.position = horizontal
				? { x: flow, y: start }
				: { x: start, y: flow };
		}
	}
}

/** Lane of each connector on auto-laid pages: its first node's lane. */
function laneAdditions(
	connectors: ReadonlyMap<string, Connector>,
	swimlanes: readonly Swimlane[] | undefined,
): Map<string, string[]> {
	const additions = new Map<string, string[]>();
	if (swimlanes === undefined) return additions;
	const laneOf = new Map<string, string>();
	for (const swimlane of swimlanes) {
		for (const lane of swimlane.lanes) {
			for (const child of lane.children) {
				if (!laneOf.has(child))
					laneOf.set(child, `${swimlane.id}\u0000${lane.id}`);
			}
		}
	}
	for (const connector of connectors.values()) {
		const lane = connector.internalIds
			.map((id) => laneOf.get(id))
			.find((value) => value !== undefined);
		if (lane === undefined) continue;
		additions.set(lane, [...(additions.get(lane) ?? []), connector.id]);
	}
	return additions;
}

/** Pools with nodes on this page keep every lane (empty ones too), with this page's children. */
function pageSwimlanes(
	swimlanes: readonly Swimlane[] | undefined,
	onPage: (id: string) => boolean,
	additions: ReadonlyMap<string, string[]>,
): Swimlane[] | undefined {
	if (swimlanes === undefined) return undefined;
	const kept = swimlanes.flatMap((swimlane) => {
		const lanes = swimlane.lanes.map((lane) => ({
			...lane,
			children: [
				...lane.children.filter(onPage),
				...(additions.get(`${swimlane.id}\u0000${lane.id}`) ?? []),
			],
		}));
		return lanes.some((lane) => lane.children.length > 0)
			? [{ ...swimlane, lanes }]
			: [];
	});
	return kept.length === 0 ? undefined : kept;
}

/** Node and group ids a constraint names. */
function referencedIds(
	value: unknown,
	nodePage: ReadonlyMap<string, number>,
	groupPage: ReadonlyMap<string, number>,
): string[] {
	const ids: string[] = [];
	const walk = (item: unknown) => {
		if (typeof item === "string") {
			if (nodePage.has(item) || groupPage.has(item)) ids.push(item);
		} else if (Array.isArray(item)) {
			for (const entry of item) walk(entry);
		} else if (item !== null && typeof item === "object") {
			for (const entry of Object.values(item as Record<string, JsonValue>))
				walk(entry);
		}
	};
	walk(value);
	return ids;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A page-split plan for a page whose conflicts asked for other remedies. */
function synthesizedPlan(
	solved: CoordinatedDiagram,
	report: DeliverabilityReport,
	options: SolveDiagramOptions,
): RemediationPlan {
	const blocking = solved.diagnostics.filter(
		(diagnostic) =>
			DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code) &&
			diagnostic.code !== "routing.deliverability.unsatisfiable",
	);
	return {
		...buildRemediationPlan(
			"page-split",
			blocking,
			resolveRemediationPolicy(options.remediationPolicy),
		),
		id: `remediation-${String(report.remediationPlans.length + 1).padStart(2, "0")}-page-split`,
	};
}

function blockingCount(diagram: CoordinatedDiagram): number {
	return diagram.diagnostics.filter(
		(diagnostic) =>
			DELIVERABILITY_DIAGNOSTIC_CODES.has(diagnostic.code) &&
			diagnostic.code !== "routing.deliverability.unsatisfiable",
	).length;
}

function withBlockedSplit(
	solved: CoordinatedDiagram,
	plan: RemediationPlan,
	why: string,
): CoordinatedDiagram {
	const deliverability = solved.deliverability as DeliverabilityReport;
	const blocked: RemediationPlan = {
		...plan,
		status: "blocked",
		reason: `${plan.reason} Auto page split was not applied: ${why}`,
		detail: { ...(plan.detail as PageSplitRemediationDetail), policy: "auto" },
	};
	return {
		...solved,
		diagnostics: [
			...solved.diagnostics,
			{
				severity: "warning",
				code: "remediation.page-split.blocked",
				message: `The page stays over capacity and was not split: ${why}`,
				path: ["routing", "remediationPolicy", "pageSplit"],
				detail: { pageId: solved.id },
			},
		],
		deliverability: {
			...deliverability,
			remediationPlans: deliverability.remediationPlans.includes(plan)
				? deliverability.remediationPlans.map((candidate) =>
						candidate === plan ? blocked : candidate,
					)
				: [...deliverability.remediationPlans, blocked],
		},
	};
}

const STATUS_RANK: Record<DeliverabilityStatus, number> = {
	clean: 0,
	degraded: 1,
	unsatisfiable: 2,
};

/** The split result: page 1, with every page and the merged report. */
export function assemblePages(
	solved: CoordinatedDiagram,
	plan: RemediationPlan,
	{ split, pages }: PageSplitAttempt,
): CoordinatedDiagram {
	const first = pages[0] as CoordinatedDiagram;
	const detail: PageSplitRemediationDetail = {
		...(plan.detail as PageSplitRemediationDetail),
		policy: "auto",
		pages: split.pages.map((page, index) => ({
			page: index + 1,
			nodeIds: [...page.nodeIds],
			edgeIds: [...page.edgeIds],
		})),
		crossPageEdgeIds: [...split.crossPageEdgeIds],
	};
	const applied: RemediationPlan = {
		...plan,
		status: "applied",
		reason: `Split the over-capacity page into ${split.pageCount} pages; ${split.crossPageEdgeIds.length} edge(s) continue across pages through off-page connectors.`,
		detail,
	};
	const reports = pages.map((page) => page.deliverability);
	const status = reports.reduce<DeliverabilityStatus>(
		(worst, report) =>
			report !== undefined && STATUS_RANK[report.status] > STATUS_RANK[worst]
				? report.status
				: worst,
		"clean",
	);
	const union = (pick: (report: DeliverabilityReport) => string[]) =>
		[
			...new Set(
				reports.flatMap((report) => (report === undefined ? [] : pick(report))),
			),
		].sort();
	const deliverability: DeliverabilityReport = {
		status,
		strict: solved.deliverability?.strict ?? false,
		degraded: reports.some((report) => report?.degraded === true),
		diagnosticCodes: union((report) => report.diagnosticCodes),
		remediationTypes: union((report) => report.remediationTypes),
		remediationPlans: [
			applied,
			...pages.flatMap((page, index) =>
				(page.deliverability?.remediationPlans ?? []).map((candidate) => ({
					...candidate,
					id: `page-${index + 1}-${candidate.id}`,
				})),
			),
		],
	};
	const diagnostics: Diagnostic[] = [
		{
			severity: "info",
			code: "remediation.page-split.applied",
			message: applied.reason,
			path: ["routing", "remediationPolicy", "pageSplit"],
			detail: {
				pageId: solved.id,
				pageCount: split.pageCount,
				crossPageEdgeIds: split.crossPageEdgeIds.join(","),
			},
		},
		...pages.flatMap((page, index) =>
			page.diagnostics.map((diagnostic) => ({
				...diagnostic,
				detail: { ...diagnostic.detail, page: index + 1 },
			})),
		),
	];
	return {
		...first,
		diagnostics,
		degraded: deliverability.degraded,
		deliverability,
		pages,
	};
}
