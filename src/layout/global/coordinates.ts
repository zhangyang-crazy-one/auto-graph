import {
	solveSeparationQp,
	type VpscConstraint,
} from "../../constraints/vpsc.js";
import type { Diagnostic } from "../../ir/diagnostics.js";
import type { NodeShape } from "../../ir/elements.js";
import type {
	Box,
	DiagramDirection,
	Insets,
	Point,
	PreviousLayout,
	Size,
} from "../../ir/geometry.js";
import {
	buildContainerHierarchy,
	type ContainerHierarchy,
	containerId,
	containerPath,
	ROOT_CONTAINER_ID,
} from "./hierarchy.js";
import { assignLayers, type Layering } from "./layering.js";
import { orderLayers } from "./ordering.js";
import { type PreviousHint, previousHint } from "./previous.js";
import { routeLayeredEdges, sameLayerDetours } from "./routing.js";
import { seedOrderByDepthFirst, seedOrderFromBoxes } from "./seed.js";

/**
 * Global coordinate assignment (plan P3).
 *
 * Works in flow coordinates: the *main* axis runs along the layers (y for
 * TB/BT, x for LR/RL) and the *cross* axis runs along each layer.
 *
 * Cross axis — one convex quadratic program solved with VPSC projection:
 *
 *   minimise  Σ_segments ω (x_u − x_v)²          (straight edges; ω = 1, 2, 8
 *                                                 for real–real, real–dummy,
 *                                                 dummy–dummy segments)
 *           + Σ_containers κ (r_C − l_C)²         (tight containers)
 *           + Σ_vars ε (x − x⁰)²                  (stay near the ordering)
 *   subject to
 *     neighbours in a layer:   right(A) + gap ≤ left(B)   where A, B are the
 *                              sibling subtrees (vertex or container) that
 *                              separate u and v under their lowest common
 *                              container
 *     containment:             l_C + pad ≤ x_v − w_v/2,  x_v + w_v/2 + pad ≤ r_C
 *     nesting:                 l_C + pad ≤ l_D,  r_D + pad ≤ r_C
 *     lanes of one swimlane:   r_k = l_{k+1}, and every lane equally thick
 *
 * so every container is one rectangle that never interleaves with a sibling.
 *
 * Main axis — layers are stacked; the gap after layer ℓ is sized from what
 * has to fit between it and the next layer: orthogonal edge tracks
 * ((k+1)·s for k bending segments), edge labels, and the padding/header of
 * every container that closes after ℓ or opens before ℓ+1.
 */
export interface GlobalLayoutNode {
	id: string;
	size: Size;
	/** Outline, so ports stay on the drawn side (default rectangle). */
	shape?: NodeShape;
}

export interface GlobalLayoutEdge {
	id: string;
	source: string;
	target: string;
	/** Size of the edge label, if any, to reserve room between layers. */
	labelSize?: Size;
}

export interface GlobalLayoutGroup {
	id: string;
	nodeIds: readonly string[];
	groupIds: readonly string[];
	/** Padding around members; the header sits on top. */
	padding: Insets;
	headerHeight: number;
	/** Width the group title needs (content width, without padding). */
	labelWidth: number;
}

export interface GlobalLayoutSwimlane {
	id: string;
	orientation: "horizontal" | "vertical";
	lanes: readonly { id: string; children: readonly string[] }[];
	headerHeight: number;
	padding: number;
}

export interface GlobalLayoutOptions {
	/** Gap between two nodes of one layer (default 48). */
	nodeSpacing?: number;
	/** Gap between parallel edge tracks (default 12). */
	edgeSpacing?: number;
	/** Minimum gap between consecutive layers (default 56). */
	layerSpacing?: number;
	/** Gap between a container border and a neighbour outside it (default 24). */
	containerSpacing?: number;
	/**
	 * Width / height the canvas should approach (default 1.6). A layout
	 * whose flow runs much longer than this is folded into bands.
	 */
	targetAspectRatio?: number;
	/** Fold long flows into bands (default true). */
	fold?: boolean;
}

export interface GlobalLayoutInput {
	direction: DiagramDirection;
	nodes: readonly GlobalLayoutNode[];
	edges: readonly GlobalLayoutEdge[];
	groups?: readonly GlobalLayoutGroup[];
	swimlanes?: readonly GlobalLayoutSwimlane[];
	/** An existing layout (e.g. Dagre) used as an extra ordering start. */
	seedBoxes?: ReadonlyMap<string, Box>;
	/** Without seed boxes: add a depth-first order as an extra start. */
	depthFirstSeed?: boolean;
	/**
	 * A previous version of this diagram (stability hint). The ordering
	 * starts from the previous order and pays for every pair of surviving
	 * vertices it puts the other way round, so a small edit changes the
	 * picture locally instead of reshuffling it.
	 */
	previous?: PreviousLayout;
	/**
	 * With `previous`: crossings one reordered pair of surviving nodes is
	 * worth (default 1). Higher keeps more of the previous picture at the
	 * cost of crossings.
	 */
	stabilityWeight?: number;
	options?: GlobalLayoutOptions;
}

export interface GlobalLayoutResult {
	boxes: Map<string, Box>;
	/**
	 * Outer box of every lane (header and padding included), per swimlane id,
	 * in lane order. Lanes of one swimlane abut and never overlap.
	 */
	laneBoxes: Map<string, Box[]>;
	/**
	 * Solved outer box of every group (padding and header included). It can
	 * be wider than members + padding, e.g. to fit a long title.
	 */
	groupBoxes: Map<string, Box>;
	diagnostics: Diagnostic[];
	crossings: number;
	layerCount: number;
	/**
	 * Orthogonal route of every edge the layering could route through its
	 * vertices (see `routeLayeredEdges`), source to target.
	 */
	routes: Map<string, Point[]>;
}

interface AxisInsets {
	crossBefore: number;
	crossAfter: number;
	mainBefore: number;
	mainAfter: number;
}

const ZERO_INSETS: AxisInsets = {
	crossBefore: 0,
	crossAfter: 0,
	mainBefore: 0,
	mainAfter: 0,
};

const SEGMENT_WEIGHT_REAL = 1;
const SEGMENT_WEIGHT_MIXED = 2;
const SEGMENT_WEIGHT_DUMMY = 8;
const CONTAINER_TIGHTNESS = 0.05;
const ORDER_ANCHOR = 0.001;
/**
 * Pull of a surviving node towards its previous cross position, against
 * edge terms of weight 1–8: enough to keep untouched parts in place, too
 * weak to hold a node away from edges that now pull elsewhere.
 */
const PREVIOUS_ANCHOR = 2;
const EDGE_LABEL_MARGIN = 8;
const MIN_EMPTY_LANE = 24;

export function runGlobalLayout(input: GlobalLayoutInput): GlobalLayoutResult {
	const nodeSpacing = input.options?.nodeSpacing ?? 48;
	const edgeSpacing = input.options?.edgeSpacing ?? 12;
	const layerSpacing = input.options?.layerSpacing ?? 56;
	const containerSpacing = input.options?.containerSpacing ?? 24;
	const direction = input.direction;
	const horizontalFlow = direction === "LR" || direction === "RL";
	const nodeIds = input.nodes.map((node) => node.id);
	const nodeSet = new Set(nodeIds);
	const sizeOf = new Map(input.nodes.map((node) => [node.id, node.size]));
	const mainSize = (size: Size) => (horizontalFlow ? size.width : size.height);
	const crossSize = (size: Size) => (horizontalFlow ? size.height : size.width);

	const hierarchy = buildContainerHierarchy({
		direction,
		nodeIds,
		groups: (input.groups ?? []).map((group) => ({
			id: group.id,
			nodeIds: group.nodeIds,
			groupIds: group.groupIds,
		})),
		swimlanes: (input.swimlanes ?? []).map((swimlane) => ({
			id: swimlane.id,
			orientation: swimlane.orientation,
			lanes: swimlane.lanes,
		})),
	});
	const diagnostics: Diagnostic[] = [...hierarchy.diagnostics];
	const edges = input.edges.filter(
		(edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target),
	);
	const layering = assignLayers(nodeIds, edges, hierarchy);
	const edgeEndpoints = new Map(
		edges.map((edge) => [
			edge.id,
			{ source: edge.source, target: edge.target },
		]),
	);
	const previous =
		input.previous === undefined
			? undefined
			: previousHint(input.previous, layering, edgeEndpoints, direction);
	// The previous order goes first (it wins ties); the usual starts stay,
	// so a warm solve never scores worse than a cold one.
	const seeds = [
		...(previous === undefined ? [] : [previous.seed]),
		...(input.seedBoxes !== undefined
			? [
					seedOrderFromBoxes(
						layering,
						input.seedBoxes,
						direction,
						edgeEndpoints,
					),
				]
			: input.depthFirstSeed === true
				? [seedOrderByDepthFirst(layering)]
				: []),
	];
	const ordering = orderLayers(layering, hierarchy, {
		seeds,
		...(previous === undefined ? {} : { reference: previous.reference }),
		...(input.stabilityWeight === undefined
			? {}
			: { stabilityWeight: input.stabilityWeight }),
	});

	const insets = containerInsets(input, hierarchy, direction);
	const minCross = containerMinCross(input, hierarchy, insets, horizontalFlow);
	const vertexCross = (id: string): number => {
		const nodeId = layering.vertices.get(id)?.nodeId;
		const size = nodeId === undefined ? undefined : sizeOf.get(nodeId);
		return size === undefined ? 0 : crossSize(size);
	};

	// A labelled edge between two nodes of one layer is drawn across the gap
	// between them: that gap must hold the label.
	const labelGaps = new Map<string, number>();
	for (const edge of edges) {
		if (edge.labelSize === undefined) continue;
		const a = layering.layerOfNode.get(edge.source);
		if (a === undefined || a !== layering.layerOfNode.get(edge.target)) {
			continue;
		}
		const key = [edge.source, edge.target].sort().join("\u0000");
		const need = crossSize(edge.labelSize) + 2 * EDGE_LABEL_MARGIN;
		labelGaps.set(key, Math.max(labelGaps.get(key) ?? 0, need));
	}
	const crossInput = {
		layering,
		layers: ordering.layers,
		hierarchy,
		insets,
		minCross,
		vertexCross,
		nodeSpacing,
		edgeSpacing,
		containerSpacing,
		labelGap: (u: string, v: string) =>
			labelGaps.get([u, v].sort().join("\u0000")) ?? 0,
	};
	let cross = solveCrossAxis(crossInput);
	if (previous !== undefined) {
		// Second pass: pull surviving nodes back to where they were. The
		// layout's frame is free (and a folded previous layout has one per
		// band), so targets are the old positions shifted by the median
		// offset of each old band.
		const targets = previousTargets(previous, layering, cross.positions);
		if (targets.size > 0) {
			cross = solveCrossAxis({ ...crossInput, targets });
		}
	}
	if (cross.unsatisfiable > 0) {
		diagnostics.push({
			severity: "warning",
			code: "layout.global.unsatisfiable-separation",
			message: `${cross.unsatisfiable} cross-axis separation constraint(s) could not be satisfied; some containers may overlap.`,
			detail: { count: cross.unsatisfiable },
		});
	}

	const detourTracks = new Map<number, number>();
	for (const detour of sameLayerDetours(
		layering,
		ordering.layers,
		edges,
	).values()) {
		const channel = detour.side === "after" ? detour.layer : detour.layer - 1;
		detourTracks.set(channel, (detourTracks.get(channel) ?? 0) + 1);
	}
	const layerStarts = solveMainAxis({
		detourTracks,
		layering,
		layers: ordering.layers,
		hierarchy,
		insets,
		crossOf: cross.positions,
		mainSizeOf: (nodeId) => {
			const size = sizeOf.get(nodeId);
			return size === undefined ? 0 : mainSize(size);
		},
		edges,
		mainLabelSize: (size) => mainSize(size),
		layerSpacing,
		edgeSpacing,
		containerSpacing,
		swimlanePadding: new Map(
			(input.swimlanes ?? []).map((swimlane) => [
				swimlane.id,
				swimlane.padding,
			]),
		),
	});

	const fold =
		input.options?.fold === false
			? undefined
			: planFold({
					layering,
					hierarchy,
					starts: layerStarts.starts,
					thickness: layerStarts.thickness,
					crossExtent: crossExtentOf(
						nodeIds,
						cross.positions,
						cross.bounds,
						(id) => {
							const size = sizeOf.get(id);
							return size === undefined ? 0 : crossSize(size);
						},
					),
					horizontalFlow,
					targetAspectRatio: input.options?.targetAspectRatio ?? 1.6,
					layerSpacing,
					edgeSpacing,
				});
	if (fold !== undefined) {
		diagnostics.push({
			severity: "info",
			code: "layout.global.folded",
			message: `Folded ${ordering.layers.length} layers into ${fold.bands.length} bands to approach aspect ratio ${input.options?.targetAspectRatio ?? 1.6}.`,
			detail: {
				bands: fold.bands.length,
				cuts: fold.bands
					.slice(0, -1)
					.map((band) => band.last)
					.join(","),
			},
		});
	}

	const boxes = new Map<string, Box>();
	for (const nodeId of nodeIds) {
		const size = sizeOf.get(nodeId);
		const layer = layering.layerOfNode.get(nodeId);
		let crossCenter = cross.positions.get(nodeId);
		if (
			size === undefined ||
			layer === undefined ||
			crossCenter === undefined
		) {
			continue;
		}
		const start = layerStarts.starts[layer] ?? 0;
		const thickness = layerStarts.thickness[layer] ?? 0;
		let mainCenter = start + thickness / 2;
		if (fold !== undefined) {
			const band = fold.bands.find(
				(candidate) => layer >= candidate.first && layer <= candidate.last,
			);
			if (band !== undefined) {
				mainCenter -= band.mainOffset;
				crossCenter += band.crossOffset;
			}
		}
		boxes.set(
			nodeId,
			toScreenBox(direction, mainCenter, crossCenter, size, horizontalFlow),
		);
	}
	const laneBoxes = computeLaneBoxes({
		input,
		hierarchy,
		layering,
		insets,
		crossBounds: cross.bounds,
		starts: layerStarts.starts,
		thickness: layerStarts.thickness,
		sizeOf,
		mainSize,
		crossSize,
		crossOf: cross.positions,
	});
	const groupBoxes = new Map<string, Box>();
	if (fold === undefined) {
		for (const group of input.groups ?? []) {
			const id = containerId("group", group.id);
			const bounds = cross.bounds.get(id);
			const inset = insets.get(id) ?? ZERO_INSETS;
			const members = nodeIds.filter((nodeId) =>
				containerPath(
					hierarchy,
					hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId,
				).includes(id),
			);
			let lo = Number.POSITIVE_INFINITY;
			let hi = Number.NEGATIVE_INFINITY;
			for (const nodeId of members) {
				const layer = layering.layerOfNode.get(nodeId);
				const size = sizeOf.get(nodeId);
				if (layer === undefined || size === undefined) continue;
				const center =
					(layerStarts.starts[layer] ?? 0) +
					(layerStarts.thickness[layer] ?? 0) / 2;
				lo = Math.min(lo, center - mainSize(size) / 2);
				hi = Math.max(hi, center + mainSize(size) / 2);
			}
			if (bounds === undefined || !Number.isFinite(lo)) continue;
			groupBoxes.set(
				group.id,
				toScreenRect(
					direction,
					[lo - inset.mainBefore, hi + inset.mainAfter],
					bounds,
				),
			);
		}
	}
	const shift = normalizeBoxes(boxes);
	const routes = routeLayeredEdges({
		direction,
		layering,
		layers: ordering.layers,
		cross: cross.positions,
		starts: layerStarts.starts,
		thickness: layerStarts.thickness,
		labelRoom: layerStarts.labelRoom,
		...(fold === undefined ? {} : { bands: fold.bands }),
		crossExtent: crossExtentOf(nodeIds, cross.positions, cross.bounds, (id) => {
			const size = sizeOf.get(id);
			return size === undefined ? 0 : crossSize(size);
		}),
		boxes,
		shift,
		shapes: new Map(
			input.nodes.map((node) => [node.id, node.shape ?? "rectangle"]),
		),
		edges,
		edgeSpacing,
		layerSpacing,
	});
	for (const [id, box] of groupBoxes) {
		groupBoxes.set(id, {
			x: round(box.x - shift.x),
			y: round(box.y - shift.y),
			width: round(box.width),
			height: round(box.height),
		});
	}
	for (const [id, lanes] of laneBoxes) {
		laneBoxes.set(
			id,
			lanes.map((box) => ({
				x: round(box.x - shift.x),
				y: round(box.y - shift.y),
				width: round(box.width),
				height: round(box.height),
			})),
		);
	}
	return {
		boxes,
		laneBoxes,
		groupBoxes,
		diagnostics,
		crossings: ordering.crossings,
		layerCount: ordering.layers.length,
		routes,
	};
}

const MIN_FOLD_LAYERS = 6;
const MIN_FOLD_WIDTH = 1200;
const MIN_FOLD_HEIGHT = 900;

interface FoldBand {
	first: number;
	last: number;
	/** Subtracted from main coordinates of the band's layers. */
	mainOffset: number;
	/** Added to cross coordinates of the band's layers. */
	crossOffset: number;
}

interface FoldInput {
	layering: Layering;
	hierarchy: ContainerHierarchy;
	starts: readonly number[];
	thickness: readonly number[];
	crossExtent: readonly [number, number];
	horizontalFlow: boolean;
	targetAspectRatio: number;
	layerSpacing: number;
	edgeSpacing: number;
}

/** Cross-axis extent of all nodes and container rectangles. */
function crossExtentOf(
	nodeIds: readonly string[],
	positions: ReadonlyMap<string, number>,
	bounds: ReadonlyMap<string, readonly [number, number]>,
	crossSizeOf: (nodeId: string) => number,
): [number, number] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const id of nodeIds) {
		const center = positions.get(id);
		if (center === undefined) continue;
		const half = crossSizeOf(id) / 2;
		lo = Math.min(lo, center - half);
		hi = Math.max(hi, center + half);
	}
	for (const [left, right] of bounds.values()) {
		lo = Math.min(lo, left);
		hi = Math.max(hi, right);
	}
	return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}

/**
 * Consecutive dummy vertices of long edges that the coordinates keep on
 * one line (vertical alignment, as in Brandes–Köpf). A pair joins when it
 * stays in one container and crosses no pair already joined between the
 * same two layers; longest edges go first. Alignments that never cross
 * cannot contradict the in-layer order, so they are always satisfiable
 * alongside the separation constraints.
 */
function alignLongEdges(
	layering: Layering,
	layers: readonly (readonly string[])[],
): [string, string][] {
	const position = new Map<string, number>();
	for (const layer of layers) {
		layer.forEach((id, at) => {
			position.set(id, at);
		});
	}
	const isDummy = (id: string) =>
		layering.vertices.get(id)?.nodeId === undefined &&
		layering.vertices.get(id)?.edgeId !== undefined;
	const byEdge = new Map<string, [string, string][]>();
	for (const segment of layering.segments) {
		if (!isDummy(segment.from) || !isDummy(segment.to)) continue;
		const list = byEdge.get(segment.edgeId) ?? [];
		list.push([segment.from, segment.to]);
		byEdge.set(segment.edgeId, list);
	}
	const chains = [...byEdge].sort(
		(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
	);
	/** Joined pairs per upper layer, as (upper position, lower position). */
	const joined = new Map<number, [number, number][]>();
	const result: [string, string][] = [];
	for (const [, pairs] of chains) {
		for (const [upper, lower] of pairs) {
			const top = layering.vertices.get(upper);
			const bottom = layering.vertices.get(lower);
			if (top === undefined || bottom === undefined) continue;
			if (top.containerId !== bottom.containerId) continue;
			const a = position.get(upper);
			const b = position.get(lower);
			if (a === undefined || b === undefined) continue;
			const existing = joined.get(top.layer) ?? [];
			if (existing.some(([c, d]) => a < c !== b < d)) continue;
			existing.push([a, b]);
			joined.set(top.layer, existing);
			result.push([upper, lower]);
		}
	}
	return result;
}

/** Cross-axis growth of a swimlane diagram that straight edges may cost. */
const ALIGNED_LANE_GROWTH = 1.1;

/** Share of a node's cross size its straight edge ends may use. */
const STRAIGHT_END_SHARE = 0.6;

/**
 * Put the dummy vertices of every long edge on one line where the layout
 * leaves room, so the edge runs straight instead of stepping at each
 * layer (what Brandes–Köpf alignment achieves in other layered engines).
 * The quadratic program only pulls chains straight with a finite weight,
 * so a chain whose neighbours pull slightly different ways jogs by a few
 * pixels in every channel it crosses.
 *
 * For each chain (longest first), every dummy's feasible interval comes
 * from the same separation constraints the program solved, against the
 * current positions of everything else. A greedy walk cuts the chain into
 * the fewest runs whose intervals intersect, and each run goes to the
 * point of its intersection nearest the run's median — preferring a point
 * within the end node's cross extent, where its port can meet the line
 * head-on. Dummies only move inside their intervals, so no constraint is
 * violated and no order changes.
 */
function straightenLongEdges(
	x: number[],
	constraints: readonly VpscConstraint[],
	layering: Layering,
	index: ReadonlyMap<string, number>,
	vertexCross: (vertexId: string) => number,
): number[] {
	const lowerOf = new Map<number, VpscConstraint[]>();
	const upperOf = new Map<number, VpscConstraint[]>();
	for (const constraint of constraints) {
		const lower = lowerOf.get(constraint.right) ?? [];
		lower.push(constraint);
		lowerOf.set(constraint.right, lower);
		const upper = upperOf.get(constraint.left) ?? [];
		upper.push(constraint);
		upperOf.set(constraint.left, upper);
	}
	const interval = (v: number): [number, number] => {
		let lo = Number.NEGATIVE_INFINITY;
		let hi = Number.POSITIVE_INFINITY;
		for (const c of lowerOf.get(v) ?? []) {
			lo = Math.max(lo, (x[c.left] as number) + c.gap);
			if (c.equality === true) hi = Math.min(hi, (x[c.left] as number) + c.gap);
		}
		for (const c of upperOf.get(v) ?? []) {
			hi = Math.min(hi, (x[c.right] as number) - c.gap);
			if (c.equality === true)
				lo = Math.max(lo, (x[c.right] as number) - c.gap);
		}
		return [lo, hi];
	};
	const endRange = (vertex: string): [number, number] | undefined => {
		const v = index.get(vertex);
		if (v === undefined) return undefined;
		const half = (vertexCross(vertex) * STRAIGHT_END_SHARE) / 2;
		return [(x[v] as number) - half, (x[v] as number) + half];
	};
	const intersect = (
		a: [number, number],
		b: [number, number] | undefined,
	): [number, number] | undefined => {
		if (b === undefined) return undefined;
		const lo = Math.max(a[0], b[0]);
		const hi = Math.min(a[1], b[1]);
		return lo <= hi + 1e-9 ? [lo, Math.max(lo, hi)] : undefined;
	};

	const byEdge = new Map<string, { from: string; to: string }[]>();
	for (const segment of layering.segments) {
		const list = byEdge.get(segment.edgeId) ?? [];
		list.push(segment);
		byEdge.set(segment.edgeId, list);
	}
	const chains: { upper: string; lower: string; dummies: number[] }[] = [];
	for (const segments of byEdge.values()) {
		if (segments.length < 2) continue;
		const layerOf = (id: string) => layering.vertices.get(id)?.layer ?? 0;
		const ordered = [...segments].sort(
			(a, b) => layerOf(a.from) - layerOf(b.from),
		);
		const dummies = ordered
			.slice(1)
			.map((segment) => index.get(segment.from))
			.filter((v): v is number => v !== undefined);
		if (dummies.length === 0) continue;
		chains.push({
			upper: (ordered[0] as { from: string }).from,
			lower: (ordered.at(-1) as { to: string }).to,
			dummies,
		});
	}
	chains.sort(
		(a, b) =>
			b.dummies.length - a.dummies.length ||
			a.upper.localeCompare(b.upper) ||
			a.lower.localeCompare(b.lower),
	);

	for (const chain of chains) {
		const { dummies } = chain;
		let start = 0;
		while (start < dummies.length) {
			let run = interval(dummies[start] as number);
			let end = start;
			while (end + 1 < dummies.length) {
				const next = intersect(run, interval(dummies[end + 1] as number));
				if (next === undefined) break;
				run = next;
				end += 1;
			}
			if (run[0] > run[1] + 1e-9) {
				start = end + 1;
				continue;
			}
			let preferred = run;
			if (start === 0) {
				preferred = intersect(preferred, endRange(chain.upper)) ?? preferred;
			}
			if (end === dummies.length - 1) {
				preferred = intersect(preferred, endRange(chain.lower)) ?? preferred;
			}
			const current = dummies
				.slice(start, end + 1)
				.map((v) => x[v] as number)
				.sort((a, b) => a - b);
			const middle = current[Math.floor(current.length / 2)] as number;
			const target = Math.min(preferred[1], Math.max(preferred[0], middle));
			for (let k = start; k <= end; k += 1) x[dummies[k] as number] = target;
			start = end + 1;
		}
	}
	return x;
}

function previousTargets(
	previous: PreviousHint,
	layering: Layering,
	positions: ReadonlyMap<string, number>,
): Map<string, number> {
	const offsets = new Map<number, number[]>();
	for (const [id, value] of previous.reference) {
		const vertex = layering.vertices.get(id);
		const now = positions.get(vertex?.nodeId ?? id);
		if (vertex === undefined || now === undefined) continue;
		const band = previous.bandOfLayer[vertex.layer] ?? 0;
		const list = offsets.get(band) ?? [];
		list.push(now - value);
		offsets.set(band, list);
	}
	const shift = new Map<number, number>();
	for (const [band, list] of offsets) {
		const sorted = [...list].sort((a, b) => a - b);
		const middle = Math.floor(sorted.length / 2);
		shift.set(
			band,
			sorted.length % 2 === 1
				? (sorted[middle] as number)
				: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
		);
	}
	const targets = new Map<string, number>();
	for (const [id, value] of previous.reference) {
		const vertex = layering.vertices.get(id);
		if (vertex === undefined) continue;
		const band = previous.bandOfLayer[vertex.layer] ?? 0;
		targets.set(id, value + (shift.get(band) ?? 0));
	}
	return targets;
}

/**
 * Fold a flow that runs much longer than the target aspect ratio (plan P4).
 *
 * The layer sequence is cut into k contiguous bands, stacked across the
 * flow in reading order (like wrapped text). Cuts are only allowed where no
 * container spans the boundary, so groups stay single rectangles and
 * swimlane bands (which span every layer) are never folded. For each k the
 * cuts minimise Σ (band length − L/k)² plus a penalty per edge crossing a
 * cut; the k whose canvas aspect lies closest to the target wins. Returns
 * undefined when folding would not help.
 */
function planFold(input: FoldInput): { bands: FoldBand[] } | undefined {
	const layerCount = input.starts.length;
	if (layerCount < MIN_FOLD_LAYERS) return undefined;
	const end = (layer: number) =>
		(input.starts[layer] ?? 0) + (input.thickness[layer] ?? 0);
	const mainLength = end(layerCount - 1) - (input.starts[0] ?? 0);
	const crossLength = input.crossExtent[1] - input.crossExtent[0];
	if (mainLength <= 0 || crossLength <= 0) return undefined;
	const aspectOf = (main: number, cross: number) =>
		input.horizontalFlow ? main / cross : cross / main;
	const target = input.targetAspectRatio;
	const distance = (aspect: number) => Math.abs(Math.log(aspect / target));
	const unfolded = aspectOf(mainLength, crossLength);
	// Only fold when the flow axis is the long one and clearly too long.
	// A short row reads fine even when its aspect is extreme: fold only
	// flows longer than about one page along the flow axis.
	const flowTooLong = input.horizontalFlow
		? unfolded > target * 2 && mainLength > MIN_FOLD_WIDTH
		: unfolded < target / 2 && mainLength > MIN_FOLD_HEIGHT;
	if (!flowTooLong) return undefined;

	// Valid cut after layer l: no container spans l → l+1.
	const spans = new Map<string, { min: number; max: number }>();
	for (const vertex of input.layering.vertices.values()) {
		let cursor: string | undefined = vertex.containerId;
		while (cursor !== undefined && cursor !== input.hierarchy.rootId) {
			const span = spans.get(cursor);
			spans.set(cursor, {
				min: Math.min(span?.min ?? vertex.layer, vertex.layer),
				max: Math.max(span?.max ?? vertex.layer, vertex.layer),
			});
			cursor = input.hierarchy.containers.get(cursor)?.parentId;
		}
	}
	const mainLaneLayers = new Set<number>();
	for (const [nodeId] of input.hierarchy.mainAxisLaneOfNode) {
		const layer = input.layering.layerOfNode.get(nodeId);
		if (layer !== undefined) mainLaneLayers.add(layer);
	}
	const mainLaneSpan =
		mainLaneLayers.size === 0
			? undefined
			: { min: Math.min(...mainLaneLayers), max: Math.max(...mainLaneLayers) };
	const crossingAt = new Array<number>(layerCount).fill(0);
	for (const segment of input.layering.segments) {
		const layer = input.layering.vertices.get(segment.from)?.layer;
		if (layer !== undefined) crossingAt[layer] = (crossingAt[layer] ?? 0) + 1;
	}
	const validCut = (layer: number) =>
		layer >= 0 &&
		layer < layerCount - 1 &&
		![...spans.values()].some(
			(span) => span.min <= layer && layer < span.max,
		) &&
		(mainLaneSpan === undefined ||
			layer < mainLaneSpan.min ||
			layer >= mainLaneSpan.max);

	let best:
		| { cuts: number[]; score: number; aspect: number; length: number }
		| undefined;
	const maxBands = Math.min(8, Math.floor(layerCount / 2));
	for (let k = 2; k <= maxBands; k += 1) {
		const ideal = mainLength / k;
		// One edge across a cut weighs like a band ~30% off its ideal length.
		const penalty = ideal * ideal * 0.1;
		// dp[j][l]: best cost of splitting layers 0..l into j bands.
		const dp: number[][] = Array.from({ length: k + 1 }, () =>
			new Array<number>(layerCount).fill(Number.POSITIVE_INFINITY),
		);
		const from: number[][] = Array.from({ length: k + 1 }, () =>
			new Array<number>(layerCount).fill(-1),
		);
		const bandCost = (first: number, last: number) => {
			const length = end(last) - (input.starts[first] ?? 0);
			return (length - ideal) ** 2;
		};
		for (let last = 0; last < layerCount; last += 1) {
			(dp[1] as number[])[last] = bandCost(0, last);
		}
		for (let j = 2; j <= k; j += 1) {
			for (let last = j - 1; last < layerCount; last += 1) {
				for (let cut = j - 2; cut < last; cut += 1) {
					if (!validCut(cut)) continue;
					const previous = dp[j - 1]?.[cut] ?? Number.POSITIVE_INFINITY;
					if (!Number.isFinite(previous)) continue;
					const cost =
						previous +
						bandCost(cut + 1, last) +
						penalty * (crossingAt[cut] ?? 0);
					if (cost < (dp[j]?.[last] ?? Number.POSITIVE_INFINITY)) {
						(dp[j] as number[])[last] = cost;
						(from[j] as number[])[last] = cut;
					}
				}
			}
		}
		if (!Number.isFinite(dp[k]?.[layerCount - 1] ?? Number.POSITIVE_INFINITY)) {
			continue;
		}
		const cuts: number[] = [];
		let last = layerCount - 1;
		for (let j = k; j >= 2; j -= 1) {
			const cut = from[j]?.[last] ?? -1;
			cuts.unshift(cut);
			last = cut;
		}
		const bands = bandRanges(cuts, layerCount);
		const longest = Math.max(
			...bands.map(
				([first, lastLayer]) => end(lastLayer) - (input.starts[first] ?? 0),
			),
		);
		const gapTotal = cuts.reduce(
			(sum, cut) => sum + bandGap(input, crossingAt[cut] ?? 0),
			0,
		);
		const aspect = aspectOf(longest, k * crossLength + gapTotal);
		const score = distance(aspect);
		if (best === undefined || score < best.score - 1e-9) {
			best = { cuts, score, aspect, length: longest };
		}
	}
	if (best === undefined || best.score >= distance(unfolded) - 1e-9) {
		return undefined;
	}
	const bands: FoldBand[] = [];
	let crossOffset = 0;
	bandRanges(best.cuts, layerCount).forEach(([first, last], index) => {
		bands.push({
			first,
			last,
			mainOffset: (input.starts[first] ?? 0) - (input.starts[0] ?? 0),
			crossOffset,
		});
		const cut = best?.cuts[index];
		if (cut !== undefined) {
			crossOffset += crossLength + bandGap(input, crossingAt[cut] ?? 0);
		}
	});
	return { bands };
}

/** Gap between two folded bands: layer spacing plus a track per edge. */
function bandGap(input: FoldInput, crossingEdges: number): number {
	return input.layerSpacing + (crossingEdges + 1) * input.edgeSpacing;
}

function bandRanges(
	cuts: readonly number[],
	layerCount: number,
): [number, number][] {
	const ranges: [number, number][] = [];
	let first = 0;
	for (const cut of cuts) {
		ranges.push([first, cut]);
		first = cut + 1;
	}
	ranges.push([first, layerCount - 1]);
	return ranges;
}

/** Screen box of a flow-coordinate rectangle. */
function toScreenRect(
	direction: DiagramDirection,
	main: readonly [number, number],
	cross: readonly [number, number],
): Box {
	const flip = direction === "BT" || direction === "RL";
	const m0 = flip ? -main[1] : main[0];
	const m1 = flip ? -main[0] : main[1];
	const horizontalFlow = direction === "LR" || direction === "RL";
	return horizontalFlow
		? { x: m0, y: cross[0], width: m1 - m0, height: cross[1] - cross[0] }
		: { x: cross[0], y: m0, width: cross[1] - cross[0], height: m1 - m0 };
}

interface LaneBoxInput {
	input: GlobalLayoutInput;
	hierarchy: ContainerHierarchy;
	layering: Layering;
	insets: ReadonlyMap<string, AxisInsets>;
	crossBounds: ReadonlyMap<string, readonly [number, number]>;
	starts: readonly number[];
	thickness: readonly number[];
	sizeOf: ReadonlyMap<string, Size>;
	mainSize: (size: Size) => number;
	crossSize: (size: Size) => number;
	crossOf: ReadonlyMap<string, number>;
}

/**
 * Lane rectangles in screen space. Lanes across the flow take their cross
 * extent from the QP bounds and share the swimlane's main extent; lanes
 * along the flow take the main extent of their layer block (meeting in the
 * middle of the gap between blocks) and share the swimlane's cross extent.
 */
function computeLaneBoxes(context: LaneBoxInput): Map<string, Box[]> {
	const { input, hierarchy, layering, starts, thickness, sizeOf } = context;
	const direction = input.direction;
	const result = new Map<string, Box[]>();
	const mainRange = (nodeId: string): [number, number] | undefined => {
		const layer = layering.layerOfNode.get(nodeId);
		const size = sizeOf.get(nodeId);
		if (layer === undefined || size === undefined) return undefined;
		const center = (starts[layer] ?? 0) + (thickness[layer] ?? 0) / 2;
		const half = context.mainSize(size) / 2;
		return [center - half, center + half];
	};
	const crossRange = (nodeId: string): [number, number] | undefined => {
		const center = context.crossOf.get(nodeId);
		const size = sizeOf.get(nodeId);
		if (center === undefined || size === undefined) return undefined;
		const half = context.crossSize(size) / 2;
		return [center - half, center + half];
	};
	const extent = (
		ids: readonly string[],
		range: (id: string) => [number, number] | undefined,
	): [number, number] | undefined => {
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		for (const id of ids) {
			const r = range(id);
			if (r === undefined) continue;
			lo = Math.min(lo, r[0]);
			hi = Math.max(hi, r[1]);
		}
		return Number.isFinite(lo) ? [lo, hi] : undefined;
	};
	for (const swimlane of input.swimlanes ?? []) {
		const members = swimlane.lanes.flatMap((lane) => [...lane.children]);
		const laneIds = swimlane.lanes.map((lane) =>
			containerId("lane", `${swimlane.id}/${lane.id}`),
		);
		const header = swimlane.headerHeight;
		const pad = swimlane.padding;
		const laneInsets = toAxisInsets(
			{
				top: pad + (swimlane.orientation === "vertical" ? header : 0),
				right: pad,
				bottom: pad,
				left: pad + (swimlane.orientation === "horizontal" ? header : 0),
			},
			direction,
		);
		const axis = hierarchy.laneAxis.get(swimlane.id);
		const main = extent(members, mainRange);
		const cross = extent(members, crossRange);
		if (main === undefined || cross === undefined) continue;
		if (axis === "cross") {
			const mainSpan: [number, number] = [
				main[0] - laneInsets.mainBefore,
				main[1] + laneInsets.mainAfter,
			];
			const lanes = laneIds.map((id) => {
				const bounds = context.crossBounds.get(id);
				return bounds === undefined
					? undefined
					: toScreenRect(direction, mainSpan, bounds);
			});
			if (lanes.every((box) => box !== undefined)) {
				result.set(swimlane.id, lanes as Box[]);
			}
			continue;
		}
		// Lanes along the flow: one block of layers each, sharing the
		// swimlane container's solved cross extent.
		const solved = context.crossBounds.get(
			containerId("swimlane", swimlane.id),
		);
		const crossSpan: [number, number] = solved
			? [solved[0], solved[1]]
			: [cross[0] - laneInsets.crossBefore, cross[1] + laneInsets.crossAfter];
		// Natural main range per lane. Layering reserves one empty layer for
		// an empty lane (after the previous lane's last layer), so empty
		// lanes get a slot of their own instead of covering a neighbour.
		let lastLayer = -1;
		let lastEnd = main[0];
		const natural = swimlane.lanes.map((lane): [number, number] => {
			const members = lane.children.filter((id) =>
				layering.layerOfNode.has(id),
			);
			const range = extent(members, mainRange);
			if (range !== undefined) {
				lastLayer = Math.max(
					lastLayer,
					...members.map((id) => layering.layerOfNode.get(id) ?? 0),
				);
				lastEnd = range[1];
				return range;
			}
			lastLayer += 1;
			const reserved = starts[lastLayer];
			const at =
				reserved === undefined
					? lastEnd + laneInsets.mainBefore + laneInsets.mainAfter
					: reserved + (thickness[lastLayer] ?? 0) / 2;
			lastEnd = at;
			return [at, at];
		});
		const ranges = natural.map(([lo, hi]): [number, number] => [
			lo - laneInsets.mainBefore,
			hi + laneInsets.mainAfter,
		]);
		// Consecutive lanes meet in the middle of the gap between them.
		for (let index = 1; index < ranges.length; index += 1) {
			const previous = ranges[index - 1] as [number, number];
			const current = ranges[index] as [number, number];
			const border =
				previous[1] <= current[0]
					? (previous[1] + current[0]) / 2
					: previous[1];
			previous[1] = border;
			current[0] = border;
			if (current[1] < current[0]) current[1] = current[0];
		}
		result.set(
			swimlane.id,
			ranges.map((range) => toScreenRect(direction, range, crossSpan)),
		);
	}
	return result;
}

function toScreenBox(
	direction: DiagramDirection,
	mainCenter: number,
	crossCenter: number,
	size: Size,
	horizontalFlow: boolean,
): Box {
	const main =
		direction === "BT" || direction === "RL" ? -mainCenter : mainCenter;
	const cx = horizontalFlow ? main : crossCenter;
	const cy = horizontalFlow ? crossCenter : main;
	return {
		x: round(cx - size.width / 2),
		y: round(cy - size.height / 2),
		width: size.width,
		height: size.height,
	};
}

/** Shift boxes so the top-left one sits at the origin; returns the shift. */
function normalizeBoxes(boxes: Map<string, Box>): { x: number; y: number } {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	for (const box of boxes.values()) {
		minX = Math.min(minX, box.x);
		minY = Math.min(minY, box.y);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0 };
	for (const [id, box] of boxes) {
		boxes.set(id, { ...box, x: round(box.x - minX), y: round(box.y - minY) });
	}
	return { x: minX, y: minY };
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Screen-space insets of every container, mapped onto flow axes. */
function containerInsets(
	input: GlobalLayoutInput,
	hierarchy: ContainerHierarchy,
	direction: DiagramDirection,
): Map<string, AxisInsets> {
	const result = new Map<string, AxisInsets>();
	for (const group of input.groups ?? []) {
		const id = containerId("group", group.id);
		if (!hierarchy.containers.has(id)) continue;
		result.set(
			id,
			toAxisInsets(
				{
					top: group.padding.top + group.headerHeight,
					right: group.padding.right,
					bottom: group.padding.bottom,
					left: group.padding.left,
				},
				direction,
			),
		);
	}
	for (const swimlane of input.swimlanes ?? []) {
		const header = swimlane.headerHeight;
		const pad = swimlane.padding;
		const laneInsets = toAxisInsets(
			{
				top: pad + (swimlane.orientation === "vertical" ? header : 0),
				right: pad,
				bottom: pad,
				left: pad + (swimlane.orientation === "horizontal" ? header : 0),
			},
			direction,
		);
		for (const lane of swimlane.lanes) {
			const id = containerId("lane", `${swimlane.id}/${lane.id}`);
			if (hierarchy.containers.has(id)) result.set(id, laneInsets);
		}
		// Lanes along the flow have no containers of their own: the swimlane
		// carries their header and padding across the flow.
		if (hierarchy.laneAxis.get(swimlane.id) === "main") {
			const id = containerId("swimlane", swimlane.id);
			if (hierarchy.containers.has(id)) result.set(id, laneInsets);
		}
	}
	return result;
}

function toAxisInsets(insets: Insets, direction: DiagramDirection): AxisInsets {
	switch (direction) {
		case "BT":
			return {
				crossBefore: insets.left,
				crossAfter: insets.right,
				mainBefore: insets.bottom,
				mainAfter: insets.top,
			};
		case "LR":
			return {
				crossBefore: insets.top,
				crossAfter: insets.bottom,
				mainBefore: insets.left,
				mainAfter: insets.right,
			};
		case "RL":
			return {
				crossBefore: insets.top,
				crossAfter: insets.bottom,
				mainBefore: insets.right,
				mainAfter: insets.left,
			};
		default:
			return {
				crossBefore: insets.left,
				crossAfter: insets.right,
				mainBefore: insets.top,
				mainAfter: insets.bottom,
			};
	}
}

function containerMinCross(
	input: GlobalLayoutInput,
	hierarchy: ContainerHierarchy,
	insets: ReadonlyMap<string, AxisInsets>,
	horizontalFlow: boolean,
): Map<string, number> {
	const result = new Map<string, number>();
	for (const [id, container] of hierarchy.containers) {
		if (id === ROOT_CONTAINER_ID || container.kind === "swimlane") continue;
		const inset = insets.get(id) ?? ZERO_INSETS;
		const padding = inset.crossBefore + inset.crossAfter;
		result.set(
			id,
			container.kind === "lane" ? padding + MIN_EMPTY_LANE : padding,
		);
	}
	if (!horizontalFlow) {
		// Group titles run along x, which is the cross axis in TB/BT flows.
		for (const group of input.groups ?? []) {
			const id = containerId("group", group.id);
			if (!result.has(id)) continue;
			result.set(
				id,
				Math.max(
					result.get(id) ?? 0,
					group.labelWidth + group.padding.left + group.padding.right,
				),
			);
		}
	}
	return result;
}

interface CrossAxisInput {
	layering: Layering;
	layers: readonly (readonly string[])[];
	hierarchy: ContainerHierarchy;
	insets: ReadonlyMap<string, AxisInsets>;
	minCross: ReadonlyMap<string, number>;
	vertexCross: (vertexId: string) => number;
	nodeSpacing: number;
	edgeSpacing: number;
	containerSpacing: number;
	/** Room a label on an edge between two nodes of one layer needs. */
	labelGap?: (u: string, v: string) => number;
	/** Cross position each vertex is pulled towards (stability hint). */
	targets?: ReadonlyMap<string, number>;
}

function solveCrossAxis(input: CrossAxisInput): {
	positions: Map<string, number>;
	/** Cross-axis [left, right] of every container. */
	bounds: Map<string, readonly [number, number]>;
	unsatisfiable: number;
} {
	const { layering, layers, hierarchy, insets } = input;
	const vertexIds = layers.flat();
	const index = new Map<string, number>();
	vertexIds.forEach((id, i) => {
		index.set(id, i);
	});
	const containers = [...hierarchy.containers.keys()]
		.filter((id) => id !== ROOT_CONTAINER_ID)
		.sort();
	const leftVar = new Map<string, number>();
	const rightVar = new Map<string, number>();
	let size = vertexIds.length;
	for (const id of containers) {
		leftVar.set(id, size);
		rightVar.set(id, size + 1);
		size += 2;
	}
	const inset = (id: string) => insets.get(id) ?? ZERO_INSETS;
	const isDummy = (id: string) =>
		layering.vertices.get(id)?.nodeId === undefined;
	const pathOf = new Map<string, string[]>();
	const path = (vertexId: string): string[] => {
		let cached = pathOf.get(vertexId);
		if (cached === undefined) {
			const vertex = layering.vertices.get(vertexId);
			cached = containerPath(
				hierarchy,
				vertex?.containerId ?? hierarchy.rootId,
			);
			pathOf.set(vertexId, cached);
		}
		return cached;
	};

	// Separation constraints, deduplicated per variable pair (largest gap).
	const separation = new Map<string, VpscConstraint>();
	const addConstraint = (left: number, right: number, gap: number) => {
		const key = `${left}>${right}`;
		const existing = separation.get(key);
		if (existing === undefined || existing.gap < gap) {
			separation.set(key, { left, right, gap });
		}
	};
	const equalities: VpscConstraint[] = [];

	for (const layer of layers) {
		for (let k = 1; k < layer.length; k += 1) {
			const u = layer[k - 1] as string;
			const v = layer[k] as string;
			const pu = path(u);
			const pv = path(v);
			let depth = 0;
			while (
				depth < pu.length &&
				depth < pv.length &&
				pu[depth] === pv[depth]
			) {
				depth += 1;
			}
			const a = pu[depth];
			const b = pv[depth];
			const aIsVertex = a === undefined;
			const bIsVertex = b === undefined;
			let gap: number;
			if (aIsVertex && bIsVertex) {
				const dummies = Number(isDummy(u)) + Number(isDummy(v));
				gap =
					dummies === 0
						? input.nodeSpacing
						: dummies === 1
							? Math.max(input.edgeSpacing, input.nodeSpacing / 2)
							: input.edgeSpacing;
			} else if (
				!aIsVertex &&
				!bIsVertex &&
				hierarchy.containers.get(a)?.kind === "lane" &&
				hierarchy.containers.get(b)?.kind === "lane"
			) {
				gap = 0;
			} else if ((aIsVertex && isDummy(u)) || (bIsVertex && isDummy(v))) {
				gap = input.edgeSpacing;
			} else {
				gap = input.containerSpacing;
			}
			const leftIndex = aIsVertex
				? (index.get(u) as number)
				: (rightVar.get(a) as number);
			const rightIndex = bIsVertex
				? (index.get(v) as number)
				: (leftVar.get(b) as number);
			const leftHalf = aIsVertex ? input.vertexCross(u) / 2 : 0;
			const rightHalf = bIsVertex ? input.vertexCross(v) / 2 : 0;
			addConstraint(leftIndex, rightIndex, leftHalf + gap + rightHalf);
			// Neighbours joined by a labelled edge, even across lane or group
			// borders: keep the label's room between the two nodes themselves.
			const labelGap = input.labelGap?.(u, v) ?? 0;
			if (labelGap > 0) {
				addConstraint(
					index.get(u) as number,
					index.get(v) as number,
					input.vertexCross(u) / 2 + labelGap + input.vertexCross(v) / 2,
				);
			}
		}
	}

	// Containment of vertices and nested containers.
	for (const id of vertexIds) {
		const containerOf = layering.vertices.get(id)?.containerId;
		if (containerOf === undefined || containerOf === ROOT_CONTAINER_ID)
			continue;
		const l = leftVar.get(containerOf);
		const r = rightVar.get(containerOf);
		if (l === undefined || r === undefined) continue;
		const half = input.vertexCross(id) / 2;
		const vi = index.get(id) as number;
		addConstraint(l, vi, inset(containerOf).crossBefore + half);
		addConstraint(vi, r, half + inset(containerOf).crossAfter);
	}
	for (const id of containers) {
		const container = hierarchy.containers.get(id);
		const parent = container?.parentId;
		const l = leftVar.get(id) as number;
		const r = rightVar.get(id) as number;
		addConstraint(l, r, input.minCross.get(id) ?? 0);
		if (parent === undefined || parent === ROOT_CONTAINER_ID) continue;
		const pl = leftVar.get(parent);
		const pr = rightVar.get(parent);
		if (pl === undefined || pr === undefined) continue;
		addConstraint(pl, l, inset(parent).crossBefore);
		addConstraint(r, pr, inset(parent).crossAfter);
	}
	// Lanes of one swimlane abut in their fixed order.
	const lanesBySwimlane: string[][] = [];
	for (const id of containers) {
		const container = hierarchy.containers.get(id);
		if (container?.kind !== "swimlane") continue;
		const lanes = container.childIds.filter(
			(child) => hierarchy.containers.get(child)?.kind === "lane",
		);
		lanesBySwimlane.push(lanes);
		for (let k = 1; k < lanes.length; k += 1) {
			equalities.push({
				left: rightVar.get(lanes[k - 1] as string) as number,
				right: leftVar.get(lanes[k] as string) as number,
				gap: 0,
				equality: true,
			});
		}
	}

	const alignment = alignLongEdges(layering, layers).flatMap(([a, b]) => {
		const left = index.get(a);
		const right = index.get(b);
		return left === undefined || right === undefined
			? []
			: [{ left, right, gap: 0, equality: true }];
	});

	// Objective.
	const pairs: { a: number; b: number; weight: number }[] = [];
	for (const segment of layering.segments) {
		const a = index.get(segment.from);
		const b = index.get(segment.to);
		if (a === undefined || b === undefined) continue;
		const dummies = Number(isDummy(segment.from)) + Number(isDummy(segment.to));
		pairs.push({
			a,
			b,
			weight:
				dummies === 0
					? SEGMENT_WEIGHT_REAL
					: dummies === 1
						? SEGMENT_WEIGHT_MIXED
						: SEGMENT_WEIGHT_DUMMY,
		});
	}
	for (const id of containers) {
		pairs.push({
			a: leftVar.get(id) as number,
			b: rightVar.get(id) as number,
			weight: CONTAINER_TIGHTNESS,
		});
	}

	// Initial positions: pack every layer, centred on 0.
	const initial = new Array<number>(size).fill(0);
	for (const layer of layers) {
		let cursor = 0;
		const positions: number[] = [];
		layer.forEach((id, k) => {
			const half = input.vertexCross(id) / 2;
			if (k > 0) {
				const prev = layer[k - 1] as string;
				cursor +=
					input.vertexCross(prev) / 2 +
					(isDummy(prev) || isDummy(id)
						? input.edgeSpacing
						: input.nodeSpacing) +
					half;
			}
			positions.push(cursor);
		});
		const mean =
			positions.length === 0
				? 0
				: positions.reduce((sum, value) => sum + value, 0) / positions.length;
		layer.forEach((id, k) => {
			initial[index.get(id) as number] = (positions[k] as number) - mean;
		});
	}
	const subtreeVertices = new Map<string, number[]>();
	for (const id of vertexIds) {
		for (const container of path(id)) {
			const list = subtreeVertices.get(container) ?? [];
			list.push(index.get(id) as number);
			subtreeVertices.set(container, list);
		}
	}
	for (const id of containers) {
		const members = subtreeVertices.get(id) ?? [];
		const xs = members.map((i) => initial[i] as number);
		const lo = xs.length === 0 ? 0 : Math.min(...xs);
		const hi = xs.length === 0 ? 0 : Math.max(...xs);
		initial[leftVar.get(id) as number] = lo - inset(id).crossBefore;
		initial[rightVar.get(id) as number] = hi + inset(id).crossAfter;
	}
	const anchors = initial.map((target, v) => ({
		v,
		target,
		weight: ORDER_ANCHOR,
	}));
	for (const [id, target] of input.targets ?? []) {
		const v = index.get(id);
		if (v !== undefined) anchors.push({ v, target, weight: PREVIOUS_ANCHOR });
	}

	/** Program plus the equal-lane-thickness pass (warm start). */
	const solveWith = (base: readonly VpscConstraint[]) => {
		let result = solveSeparationQp({
			size,
			pairs,
			anchors,
			constraints: [...base],
			initial,
		});
		const uniform: VpscConstraint[] = [];
		for (const lanes of lanesBySwimlane) {
			if (lanes.length < 2) continue;
			const thickness = Math.max(
				...lanes.map(
					(lane) =>
						(result.positions[rightVar.get(lane) as number] as number) -
						(result.positions[leftVar.get(lane) as number] as number),
				),
			);
			for (const lane of lanes) {
				uniform.push({
					left: leftVar.get(lane) as number,
					right: rightVar.get(lane) as number,
					gap: thickness,
				});
			}
		}
		const unsatisfiable = result.unsatisfiable.length;
		const all = [...base, ...uniform];
		if (uniform.length > 0) {
			result = solveSeparationQp({
				size,
				pairs,
				anchors,
				constraints: all,
				initial: result.positions,
			});
		}
		const extent =
			Math.max(...result.positions) - Math.min(...result.positions);
		return { solved: result, constraints: all, unsatisfiable, extent };
	};
	const free = [...separation.values(), ...equalities];
	let chosen = solveWith(alignment.length > 0 ? [...free, ...alignment] : free);
	if (alignment.length > 0) {
		// Alignment is only a preference: never trade separation for it. With
		// lanes, a lane thickened by straight edges thickens every lane of
		// its swimlane, so keep the alignment only if it costs little room.
		const needsCheck = chosen.unsatisfiable > 0 || lanesBySwimlane.length > 0;
		if (needsCheck) {
			const plain = solveWith(free);
			if (
				chosen.unsatisfiable > 0 ||
				chosen.extent > plain.extent * ALIGNED_LANE_GROWTH
			) {
				chosen = plain;
			}
		}
	}
	const solved = chosen.solved;

	const straightened = straightenLongEdges(
		[...solved.positions],
		chosen.constraints,
		layering,
		index,
		input.vertexCross,
	);
	const positions = new Map<string, number>();
	for (const id of vertexIds) {
		const vertex = layering.vertices.get(id);
		const value = straightened[index.get(id) as number] as number;
		positions.set(vertex?.nodeId ?? id, value);
	}
	const bounds = new Map<string, readonly [number, number]>();
	for (const id of containers) {
		bounds.set(id, [
			solved.positions[leftVar.get(id) as number] as number,
			solved.positions[rightVar.get(id) as number] as number,
		]);
	}
	return { positions, bounds, unsatisfiable: solved.unsatisfiable.length };
}

interface MainAxisInput {
	layering: Layering;
	layers: readonly (readonly string[])[];
	hierarchy: ContainerHierarchy;
	insets: ReadonlyMap<string, AxisInsets>;
	crossOf: ReadonlyMap<string, number>;
	mainSizeOf: (nodeId: string) => number;
	edges: readonly GlobalLayoutEdge[];
	mainLabelSize: (size: Size) => number;
	layerSpacing: number;
	edgeSpacing: number;
	containerSpacing: number;
	swimlanePadding: ReadonlyMap<string, number>;
	/** Same-layer detour tracks per channel (channel after layer ℓ = ℓ). */
	detourTracks?: ReadonlyMap<number, number>;
}

function solveMainAxis(input: MainAxisInput): {
	starts: number[];
	thickness: number[];
	/** Room kept free for edge labels in each channel (after layer ℓ). */
	labelRoom: number[];
} {
	const { layering, layers, hierarchy } = input;
	const layerCount = layers.length;
	const thickness = layers.map((layer) =>
		Math.max(
			0,
			...layer.map((id) => {
				const nodeId = layering.vertices.get(id)?.nodeId;
				return nodeId === undefined ? 0 : input.mainSizeOf(nodeId);
			}),
		),
	);
	const inset = (id: string) => input.insets.get(id) ?? ZERO_INSETS;

	// Layer span of every container (real members only).
	const span = new Map<string, { min: number; max: number }>();
	for (const [nodeId, layer] of layering.layerOfNode) {
		const deepest = hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId;
		for (const id of containerPath(hierarchy, deepest)) {
			const current = span.get(id);
			span.set(id, {
				min: Math.min(current?.min ?? layer, layer),
				max: Math.max(current?.max ?? layer, layer),
			});
		}
	}

	const gaps: number[] = [];
	const trackRoom: number[] = [];
	for (let layer = 0; layer + 1 < layerCount; layer += 1) {
		// Orthogonal tracks for segments that change cross position.
		let bending = 0;
		for (const segment of layering.segments) {
			const from = layering.vertices.get(segment.from);
			if (from?.layer !== layer) continue;
			const a = input.crossOf.get(from.nodeId ?? from.id);
			const toVertex = layering.vertices.get(segment.to);
			const b = input.crossOf.get(toVertex?.nodeId ?? segment.to);
			if (a !== undefined && b !== undefined && Math.abs(a - b) > 1) {
				bending += 1;
			}
		}
		bending += input.detourTracks?.get(layer) ?? 0;
		const channel = (bending + 1) * input.edgeSpacing;

		// Container borders that close after `layer` or open before `layer+1`.
		const upper = new Set<string>();
		const lower = new Set<string>();
		for (const id of layers[layer] ?? []) {
			const nodeId = layering.vertices.get(id)?.nodeId;
			if (nodeId !== undefined) {
				upper.add(hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId);
			}
		}
		for (const id of layers[layer + 1] ?? []) {
			const nodeId = layering.vertices.get(id)?.nodeId;
			if (nodeId !== undefined) {
				lower.add(hierarchy.containerOfNode.get(nodeId) ?? hierarchy.rootId);
			}
		}
		let borders = 0;
		for (const a of upper) {
			const pa = containerPath(hierarchy, a);
			for (const b of lower) {
				const pb = containerPath(hierarchy, b);
				const closing = pa
					.filter((id) => !pb.includes(id) && span.get(id)?.max === layer)
					.reduce((sum, id) => sum + inset(id).mainAfter, 0);
				const opening = pb
					.filter((id) => !pa.includes(id) && span.get(id)?.min === layer + 1)
					.reduce((sum, id) => sum + inset(id).mainBefore, 0);
				if (closing + opening > 0) {
					borders = Math.max(
						borders,
						closing + opening + input.containerSpacing,
					);
				}
			}
		}

		// Lanes that run along the flow change between these layers.
		let laneBreak = 0;
		for (const id of layers[layer] ?? []) {
			const nodeId = layering.vertices.get(id)?.nodeId;
			const lane =
				nodeId === undefined
					? undefined
					: hierarchy.mainAxisLaneOfNode.get(nodeId);
			if (lane === undefined) continue;
			for (const other of layers[layer + 1] ?? []) {
				const otherNode = layering.vertices.get(other)?.nodeId;
				const next =
					otherNode === undefined
						? undefined
						: hierarchy.mainAxisLaneOfNode.get(otherNode);
				if (
					next !== undefined &&
					next.swimlaneId === lane.swimlaneId &&
					next.laneIndex !== lane.laneIndex
				) {
					laneBreak = Math.max(
						laneBreak,
						2 * (input.swimlanePadding.get(lane.swimlaneId) ?? 0),
					);
				}
			}
		}

		gaps.push(Math.max(input.layerSpacing, channel) + borders + laneBreak);
		trackRoom.push(bending > 0 ? channel : 0);
	}

	// Edge labels need room between the two layers they sit between, next
	// to the tracks of that channel (routing keeps the middle free for it).
	const labelRoom = new Array<number>(Math.max(0, layerCount - 1)).fill(0);
	for (const edge of input.edges) {
		if (edge.labelSize === undefined) continue;
		const a = layering.layerOfNode.get(edge.source);
		const b = layering.layerOfNode.get(edge.target);
		if (a === undefined || b === undefined || a === b) continue;
		const top = Math.min(a, b);
		const bottom = Math.max(a, b);
		const middle = top + Math.floor((bottom - top - 1) / 2);
		const need = input.mainLabelSize(edge.labelSize) + 2 * EDGE_LABEL_MARGIN;
		labelRoom[middle] = Math.max(labelRoom[middle] ?? 0, need);
		gaps[middle] = Math.max(gaps[middle] ?? 0, need + (trackRoom[middle] ?? 0));
	}

	const starts: number[] = [];
	let cursor = 0;
	for (let layer = 0; layer < layerCount; layer += 1) {
		starts.push(cursor);
		cursor += (thickness[layer] ?? 0) + (gaps[layer] ?? 0);
	}
	return { starts, thickness, labelRoom };
}
