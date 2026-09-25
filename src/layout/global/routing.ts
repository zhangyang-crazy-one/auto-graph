import { shapeSideAttachRange } from "../../geometry/shapes.js";
import type { NodeShape } from "../../ir/elements.js";
import type { Box, DiagramDirection, Point } from "../../ir/geometry.js";
import type { Layering } from "./layering.js";

/**
 * Channel routing for the global layout (plan phase 2).
 *
 * The layering already gave every long edge a dummy vertex in each layer
 * it crosses, and ordering + coordinate assignment placed those vertices
 * so that edges cross as little as possible and never share a slot with a
 * node. So instead of searching a path per edge afterwards, an edge simply
 * follows its vertices: it runs straight through each layer at its
 * vertex's cross position and only turns in the channels between layers.
 *
 * - Ports: the edges leaving (entering) a node on its flow side are
 *   ordered by where their next (previous) vertex sits, and spread over
 *   the side, so they leave without crossing each other.
 * - Channels: in the gap between two layers every segment that changes
 *   cross position turns on a track. Two segments whose cross spans
 *   overlap take different tracks, in the order that crosses fewer runs
 *   (Sander's orthogonal edge routing); tracks are then numbered by
 *   longest path and spread evenly over the gap.
 * - Folded bands: a segment from the last layer of one band to the first
 *   of the next leaves past the band's end, runs back along a lane in the
 *   gap between the bands and enters from before the first layer; routes
 *   are nested so they do not cross each other.
 * - Two nodes of one layer next to each other are joined straight across.
 *
 * Everything is linear in the edges except track assignment, which is
 * quadratic in the segments of one channel only. Edges this cannot route
 * (self-loops, same-layer pairs with nodes between them) are left out;
 * the caller routes them individually.
 */
export interface ChannelRoutingBand {
	first: number;
	last: number;
	mainOffset: number;
	crossOffset: number;
}

export interface ChannelRoutingInput {
	direction: DiagramDirection;
	layering: Layering;
	/** Ordered vertex ids per layer. */
	layers: readonly (readonly string[])[];
	/** Cross coordinate of every vertex (before folding). */
	cross: ReadonlyMap<string, number>;
	starts: readonly number[];
	thickness: readonly number[];
	bands?: readonly ChannelRoutingBand[];
	/** Cross extent of the unfolded layout (for the gaps between bands). */
	crossExtent: readonly [number, number];
	/** Final node boxes (screen coordinates, after normalisation). */
	boxes: ReadonlyMap<string, Box>;
	/** Screen shift applied by normalisation. */
	shift: { x: number; y: number };
	shapes: ReadonlyMap<string, NodeShape>;
	edges: readonly { id: string; source: string; target: string }[];
	edgeSpacing: number;
	layerSpacing: number;
}

/**
 * Edges between two nodes of one layer with other vertices between them
 * detour through a neighbouring channel: out of both nodes' flow side,
 * across on a track next to the layer, back in. Uses the channel after the
 * layer, or before it for the last layer. Edge id → layer and side.
 */
export function sameLayerDetours(
	layering: Layering,
	layers: readonly (readonly string[])[],
	edges: readonly { id: string; source: string; target: string }[],
): Map<string, { layer: number; side: "after" | "before" }> {
	const position = new Map<string, number>();
	for (const layer of layers) {
		layer.forEach((vertex, index) => {
			position.set(vertex, index);
		});
	}
	const detours = new Map<
		string,
		{ layer: number; side: "after" | "before" }
	>();
	for (const edge of edges) {
		if (edge.source === edge.target) continue;
		const a = layering.vertices.get(edge.source);
		const b = layering.vertices.get(edge.target);
		if (a === undefined || b === undefined || a.layer !== b.layer) continue;
		const distance = Math.abs(
			(position.get(edge.source) ?? 0) - (position.get(edge.target) ?? 0),
		);
		if (distance <= 1) continue;
		if (a.layer + 1 < layers.length) {
			detours.set(edge.id, { layer: a.layer, side: "after" });
		} else if (a.layer > 0) {
			detours.set(edge.id, { layer: a.layer, side: "before" });
		}
	}
	return detours;
}

/** Gap between neighbouring ports on one node side (px). */
const PORT_SPACING = 14;

type FlowSide = "after" | "before";

export function routeLayeredEdges(
	input: ChannelRoutingInput,
): Map<string, Point[]> {
	const { layering, direction } = input;
	const horizontalFlow = direction === "LR" || direction === "RL";
	const flip = direction === "RL" || direction === "BT";
	const unfolded: ChannelRoutingBand = {
		first: 0,
		last: input.layers.length - 1,
		mainOffset: 0,
		crossOffset: 0,
	};
	const bandOf = (layer: number): ChannelRoutingBand =>
		input.bands?.find((band) => layer >= band.first && layer <= band.last) ??
		unfolded;
	const toScreen = (main: number, cross: number): Point => {
		const m = flip ? -main : main;
		return horizontalFlow
			? { x: m - input.shift.x, y: cross - input.shift.y }
			: { x: cross - input.shift.x, y: m - input.shift.y };
	};
	const layerEnd = (layer: number) =>
		(input.starts[layer] ?? 0) + (input.thickness[layer] ?? 0);
	const layerCenter = (layer: number) =>
		(input.starts[layer] ?? 0) + (input.thickness[layer] ?? 0) / 2;
	const mainSize = (box: Box) => (horizontalFlow ? box.width : box.height);
	const crossSize = (box: Box) => (horizontalFlow ? box.height : box.width);
	const screenSide = (side: FlowSide) => {
		const forward = side === "after" ? !flip : flip;
		return horizontalFlow
			? forward
				? "right"
				: "left"
			: forward
				? "bottom"
				: "top";
	};

	// Vertex chains per edge, upper layer first.
	const chains = new Map<string, string[]>();
	for (const segment of layering.segments) {
		const chain = chains.get(segment.edgeId);
		if (chain === undefined)
			chains.set(segment.edgeId, [segment.from, segment.to]);
		else chain.push(segment.to);
	}
	const crossOf = (vertex: string) => input.cross.get(vertex) ?? 0;
	const isReal = (vertex: string) =>
		layering.vertices.get(vertex)?.nodeId !== undefined;

	// Ports: per node side, ends ordered by the cross position of the vertex
	// at the other end of their segment.
	/** `from`: the real vertex at the other end, whose port this one faces. */
	const ends = new Map<
		string,
		{ edgeId: string; other: number; from?: string }[]
	>();
	const addEnd = (
		node: string,
		side: FlowSide,
		edgeId: string,
		other: number,
		from?: string,
	) => {
		const key = `${node}\u0000${side}`;
		const list = ends.get(key) ?? [];
		list.push({ edgeId, other, ...(from === undefined ? {} : { from }) });
		ends.set(key, list);
	};
	for (const [edgeId, chain] of chains) {
		const upper = chain[0] as string;
		const lower = chain[chain.length - 1] as string;
		addEnd(upper, "after", edgeId, crossOf(chain[1] as string));
		const previous = chain[chain.length - 2] as string;
		addEnd(
			lower,
			"before",
			edgeId,
			crossOf(previous),
			isReal(previous) ? previous : undefined,
		);
	}
	// Same-layer detours, kept only where their channel lies in the band.
	const detours = new Map<
		string,
		{ layer: number; side: FlowSide; source: string; target: string }
	>();
	for (const [edgeId, detour] of sameLayerDetours(
		layering,
		input.layers,
		input.edges,
	)) {
		const edge = input.edges.find((candidate) => candidate.id === edgeId);
		if (edge === undefined) continue;
		const other = detour.side === "after" ? detour.layer + 1 : detour.layer - 1;
		if (bandOf(other) !== bandOf(detour.layer)) continue;
		detours.set(edgeId, {
			...detour,
			source: edge.source,
			target: edge.target,
		});
		addEnd(edge.source, detour.side, edgeId, crossOf(edge.target));
		addEnd(edge.target, detour.side, edgeId, crossOf(edge.source));
	}
	// Ports face the other end of their segment where the side allows it,
	// so segments run straight; the rest keep an even spread around the
	// side's middle. Leaving sides first: an entering port then faces the
	// port its segment leaves from, not that node's centre.
	const ports = new Map<string, number>();
	const keys = [...ends.keys()].sort(
		(a, b) =>
			Number(a.endsWith("\u0000before")) - Number(b.endsWith("\u0000before")) ||
			a.localeCompare(b),
	);
	for (const key of keys) {
		const list = ends.get(key) ?? [];
		const [node, side] = key.split("\u0000") as [string, FlowSide];
		const box = input.boxes.get(node);
		const center = input.cross.get(node);
		if (box === undefined || center === undefined) continue;
		const size = crossSize(box);
		const [f0, f1] = shapeSideAttachRange(
			input.shapes.get(node) ?? "rectangle",
			box,
			screenSide(side),
		);
		const lo = center - size / 2 + f0 * size;
		const hi = center - size / 2 + f1 * size;
		for (const end of list) {
			if (end.from === undefined) continue;
			const facing = ports.get(`${end.edgeId}\u0000${end.from}\u0000after`);
			if (facing !== undefined) end.other = facing;
		}
		list.sort((a, b) => a.other - b.other || a.edgeId.localeCompare(b.edgeId));
		const middle = (lo + hi) / 2;
		const span = Math.min(
			Math.max(0, hi - lo),
			(list.length - 1) * PORT_SPACING,
		);
		const spread = list.map((_, index) =>
			list.length === 1
				? middle
				: middle - span / 2 + (index * span) / (list.length - 1),
		);
		const gap = list.length === 1 ? 0 : span / (list.length - 1);
		const placed = list.map((end, index) =>
			end.other >= lo && end.other <= hi
				? end.other
				: (spread[index] as number),
		);
		// Keep the order and the spacing: push right, then back from the end.
		for (let index = 1; index < placed.length; index += 1) {
			placed[index] = Math.max(
				placed[index] as number,
				(placed[index - 1] as number) + gap,
			);
		}
		for (let index = placed.length - 1; index >= 0; index -= 1) {
			const limit =
				index === placed.length - 1 ? hi : (placed[index + 1] as number) - gap;
			placed[index] = Math.min(placed[index] as number, limit);
		}
		list.forEach((end, index) => {
			ports.set(
				`${end.edgeId}\u0000${node}\u0000${side}`,
				Math.max(lo, placed[index] as number),
			);
		});
	}
	const portOf = (edgeId: string, vertex: string, side: FlowSide) =>
		ports.get(`${edgeId}\u0000${vertex}\u0000${side}`) ?? crossOf(vertex);

	// Channel segments.
	interface ChannelSegment {
		edgeId: string;
		index: number;
		upper: number;
		lower: number;
		track: number;
	}
	const channels = new Map<number, ChannelSegment[]>();
	const wraps = new Map<number, ChannelSegment[]>();
	for (const [edgeId, chain] of chains) {
		for (let index = 0; index + 1 < chain.length; index += 1) {
			const from = chain[index] as string;
			const to = chain[index + 1] as string;
			const layer = layering.vertices.get(from)?.layer ?? 0;
			const upper = isReal(from)
				? portOf(edgeId, from, "after")
				: crossOf(from);
			const lower = isReal(to) ? portOf(edgeId, to, "before") : crossOf(to);
			const segment = { edgeId, index, upper, lower, track: 0 };
			const target = bandOf(layer) === bandOf(layer + 1) ? channels : wraps;
			const list = target.get(layer) ?? [];
			list.push(segment);
			target.set(layer, list);
		}
	}
	const tracksOf = new Map<number, number>();
	for (const [layer, segments] of channels) {
		tracksOf.set(layer, assignTracks(segments));
	}
	// Detour tracks sit next to the layer they return to, shortest
	// innermost, so nested detours do not cross: channel → ordered ids.
	const detourAfter = new Map<number, string[]>();
	const detourBefore = new Map<number, string[]>();
	const spanOf = (id: string) => {
		const detour = detours.get(id);
		return detour === undefined
			? 0
			: Math.abs(crossOf(detour.source) - crossOf(detour.target));
	};
	for (const [id, detour] of detours) {
		const map = detour.side === "after" ? detourAfter : detourBefore;
		const channel = detour.side === "after" ? detour.layer : detour.layer - 1;
		const list = map.get(channel) ?? [];
		list.push(id);
		map.set(channel, list);
	}
	for (const list of [...detourAfter.values(), ...detourBefore.values()]) {
		list.sort((a, b) => spanOf(a) - spanOf(b) || a.localeCompare(b));
	}
	/** Main coordinate of track slot `slot` among `total` in `channel`. */
	const trackMain = (channel: number, slot: number, total: number) => {
		const gapStart = layerEnd(channel);
		const gap = (input.starts[channel + 1] ?? gapStart) - gapStart;
		return gapStart + ((slot + 1) * gap) / (total + 1);
	};
	const slotsOf = (channel: number) => {
		const after = detourAfter.get(channel)?.length ?? 0;
		const before = detourBefore.get(channel)?.length ?? 0;
		const tracks = tracksOf.get(channel) ?? 1;
		return { after, before, tracks, total: after + tracks + before };
	};
	for (const segments of wraps.values()) {
		// Nested: the segment starting nearest the gap runs innermost.
		segments.sort(
			(a, b) => b.upper - a.upper || a.edgeId.localeCompare(b.edgeId),
		);
		segments.forEach((segment, rank) => {
			segment.track = rank;
		});
	}
	const segmentOf = new Map<string, ChannelSegment>();
	for (const list of [...channels.values(), ...wraps.values()]) {
		for (const segment of list) {
			segmentOf.set(`${segment.edgeId}\u0000${segment.index}`, segment);
		}
	}

	const routes = new Map<string, Point[]>();
	for (const edge of input.edges) {
		const chain = chains.get(edge.id);
		if (chain === undefined) continue;
		const flow: [number, number][] = [];
		const upper = chain[0] as string;
		const upperLayer = layering.vertices.get(upper)?.layer ?? 0;
		const upperBox = input.boxes.get(upper);
		if (upperBox === undefined) continue;
		const firstBand = bandOf(upperLayer);
		flow.push([
			layerCenter(upperLayer) + mainSize(upperBox) / 2 - firstBand.mainOffset,
			portOf(edge.id, upper, "after") + firstBand.crossOffset,
		]);
		let ok = true;
		for (let index = 0; index + 1 < chain.length; index += 1) {
			const from = chain[index] as string;
			const layer = layering.vertices.get(from)?.layer ?? 0;
			const segment = segmentOf.get(`${edge.id}\u0000${index}`);
			if (segment === undefined) {
				ok = false;
				break;
			}
			const band = bandOf(layer);
			const next = bandOf(layer + 1);
			if (band === next) {
				if (Math.abs(segment.upper - segment.lower) > 0.5) {
					const slots = slotsOf(layer);
					const t = trackMain(layer, slots.after + segment.track, slots.total);
					flow.push([t - band.mainOffset, segment.upper + band.crossOffset]);
					flow.push([t - band.mainOffset, segment.lower + band.crossOffset]);
				}
			} else {
				const count = wraps.get(layer)?.length ?? 1;
				const rank = segment.track;
				const s = input.edgeSpacing;
				const exit = layerEnd(layer) - band.mainOffset + (rank + 1) * s;
				const lane =
					input.crossExtent[1] +
					band.crossOffset +
					input.layerSpacing / 2 +
					(rank + 1) * s;
				const entry = (input.starts[0] ?? 0) - (count - rank) * s;
				flow.push([exit, segment.upper + band.crossOffset]);
				flow.push([exit, lane]);
				flow.push([entry, lane]);
				flow.push([entry, segment.lower + next.crossOffset]);
			}
		}
		if (!ok) continue;
		const lower = chain[chain.length - 1] as string;
		const lowerLayer = layering.vertices.get(lower)?.layer ?? 0;
		const lowerBox = input.boxes.get(lower);
		if (lowerBox === undefined) continue;
		const lastBand = bandOf(lowerLayer);
		flow.push([
			layerCenter(lowerLayer) - mainSize(lowerBox) / 2 - lastBand.mainOffset,
			portOf(edge.id, lower, "before") + lastBand.crossOffset,
		]);
		let points = simplify(flow.map(([m, c]) => toScreen(m, c)));
		// Snap the ends onto the final (rounded) node boxes.
		points = snapEnd(points, upperBox, horizontalFlow, false);
		points = snapEnd(points, lowerBox, horizontalFlow, true);
		const forward = upper === edge.source;
		routes.set(edge.id, forward ? points : [...points].reverse());
	}

	for (const [edgeId, detour] of detours) {
		const sourceBox = input.boxes.get(detour.source);
		const targetBox = input.boxes.get(detour.target);
		if (sourceBox === undefined || targetBox === undefined) continue;
		const band = bandOf(detour.layer);
		const after = detour.side === "after";
		const channel = after ? detour.layer : detour.layer - 1;
		const slots = slotsOf(channel);
		const t = after
			? trackMain(
					channel,
					(detourAfter.get(channel) ?? []).indexOf(edgeId),
					slots.total,
				)
			: trackMain(
					channel,
					slots.total - 1 - (detourBefore.get(channel) ?? []).indexOf(edgeId),
					slots.total,
				);
		const sign = after ? 1 : -1;
		const center = layerCenter(detour.layer) - band.mainOffset;
		const a = portOf(edgeId, detour.source, detour.side) + band.crossOffset;
		const b = portOf(edgeId, detour.target, detour.side) + band.crossOffset;
		let points = simplify(
			[
				[center + (sign * mainSize(sourceBox)) / 2, a],
				[t - band.mainOffset, a],
				[t - band.mainOffset, b],
				[center + (sign * mainSize(targetBox)) / 2, b],
			].map(([m, c]) => toScreen(m as number, c as number)),
		);
		points = snapEnd(points, sourceBox, horizontalFlow, false);
		points = snapEnd(points, targetBox, horizontalFlow, true);
		routes.set(edgeId, points);
	}

	// Neighbours in one layer: straight across.
	const position = new Map<string, number>();
	for (const layer of input.layers) {
		layer.forEach((vertex, index) => {
			position.set(vertex, index);
		});
	}
	const crossSideUse = new Map<string, number>();
	for (const edge of input.edges) {
		if (chains.has(edge.id) || edge.source === edge.target) continue;
		const a = layering.vertices.get(edge.source);
		const b = layering.vertices.get(edge.target);
		const boxA = input.boxes.get(edge.source);
		const boxB = input.boxes.get(edge.target);
		if (a === undefined || b === undefined) continue;
		if (boxA === undefined || boxB === undefined) continue;
		if (a.layer !== b.layer) continue;
		const pa = position.get(edge.source) ?? 0;
		const pb = position.get(edge.target) ?? 0;
		if (Math.abs(pa - pb) !== 1) continue;
		const [first, second] =
			pa < pb ? [edge.source, edge.target] : [edge.target, edge.source];
		const keyA = `${first}\u0000+`;
		const keyB = `${second}\u0000-`;
		if (crossSideUse.has(keyA) || crossSideUse.has(keyB)) continue;
		crossSideUse.set(keyA, 1);
		crossSideUse.set(keyB, 1);
		const band = bandOf(a.layer);
		const main = layerCenter(a.layer) - band.mainOffset;
		const firstBox = input.boxes.get(first) as Box;
		const secondBox = input.boxes.get(second) as Box;
		const start = toScreen(main, crossOf(first) + band.crossOffset);
		const end = toScreen(main, crossOf(second) + band.crossOffset);
		let points: Point[];
		if (horizontalFlow) {
			points = [
				{ x: start.x, y: firstBox.y + firstBox.height },
				{ x: end.x, y: secondBox.y },
			];
			if (Math.abs(start.x - end.x) > 0.5) continue;
		} else {
			points = [
				{ x: firstBox.x + firstBox.width, y: start.y },
				{ x: secondBox.x, y: end.y },
			];
			if (Math.abs(start.y - end.y) > 0.5) continue;
		}
		routes.set(edge.id, first === edge.source ? points : [...points].reverse());
	}
	return routes;
}

/**
 * Tracks for the segments of one channel. Overlapping segments get
 * different tracks, ordered to cross fewer horizontal runs; returns the
 * number of tracks used.
 */
function assignTracks(
	segments: { upper: number; lower: number; track: number; edgeId: string }[],
): number {
	const bending = segments
		.filter((segment) => Math.abs(segment.upper - segment.lower) > 0.5)
		.sort(
			(a, b) =>
				Math.min(a.upper, a.lower) - Math.min(b.upper, b.lower) ||
				a.edgeId.localeCompare(b.edgeId),
		);
	const n = bending.length;
	if (n === 0) return 1;
	const lo = bending.map((s) => Math.min(s.upper, s.lower));
	const hi = bending.map((s) => Math.max(s.upper, s.lower));
	const inside = (value: number, k: number) =>
		value > (lo[k] as number) + 1e-6 && value < (hi[k] as number) - 1e-6;
	// Candidate orders for overlapping pairs, most decisive first.
	const arcs: { from: number; to: number; weight: number }[] = [];
	for (let i = 0; i < n; i += 1) {
		for (let j = i + 1; j < n; j += 1) {
			if ((lo[j] as number) > (hi[i] as number) + 1) continue;
			if ((lo[i] as number) > (hi[j] as number) + 1) continue;
			const a = bending[i] as (typeof bending)[number];
			const b = bending[j] as (typeof bending)[number];
			// a on an earlier track (nearer the upper layer) than b.
			const aFirst = Number(inside(b.upper, i)) + Number(inside(a.lower, j));
			const bFirst = Number(inside(a.upper, j)) + Number(inside(b.lower, i));
			if (aFirst <= bFirst) {
				arcs.push({ from: i, to: j, weight: bFirst - aFirst });
			} else {
				arcs.push({ from: j, to: i, weight: aFirst - bFirst });
			}
		}
	}
	arcs.sort((x, y) => y.weight - x.weight || x.from - y.from || x.to - y.to);
	const out: number[][] = Array.from({ length: n }, () => []);
	const reaches = (from: number, to: number): boolean => {
		const stack = [from];
		const seen = new Set<number>([from]);
		while (stack.length > 0) {
			const node = stack.pop() as number;
			if (node === to) return true;
			for (const next of out[node] as number[]) {
				if (!seen.has(next)) {
					seen.add(next);
					stack.push(next);
				}
			}
		}
		return false;
	};
	for (const arc of arcs) {
		// Keep the order acyclic: reverse an arc that would close a cycle.
		if (reaches(arc.to, arc.from)) (out[arc.to] as number[]).push(arc.from);
		else (out[arc.from] as number[]).push(arc.to);
	}
	// Longest path from the sources.
	const indegree = new Array<number>(n).fill(0);
	for (const list of out)
		for (const to of list) indegree[to] = (indegree[to] ?? 0) + 1;
	const track = new Array<number>(n).fill(0);
	const queue: number[] = [];
	for (let k = 0; k < n; k += 1) if (indegree[k] === 0) queue.push(k);
	while (queue.length > 0) {
		queue.sort((x, y) => x - y);
		const node = queue.shift() as number;
		for (const to of out[node] as number[]) {
			track[to] = Math.max(track[to] ?? 0, (track[node] ?? 0) + 1);
			indegree[to] = (indegree[to] ?? 0) - 1;
			if (indegree[to] === 0) queue.push(to);
		}
	}
	bending.forEach((segment, k) => {
		segment.track = track[k] ?? 0;
	});
	return Math.max(...track) + 1;
}

function simplify(points: readonly Point[]): Point[] {
	const result: Point[] = [];
	for (const point of points) {
		const last = result[result.length - 1];
		if (
			last !== undefined &&
			Math.abs(last.x - point.x) < 1e-6 &&
			Math.abs(last.y - point.y) < 1e-6
		) {
			continue;
		}
		const previous = result[result.length - 2];
		if (
			previous !== undefined &&
			last !== undefined &&
			((Math.abs(previous.x - last.x) < 1e-6 &&
				Math.abs(last.x - point.x) < 1e-6) ||
				(Math.abs(previous.y - last.y) < 1e-6 &&
					Math.abs(last.y - point.y) < 1e-6))
		) {
			result[result.length - 1] = point;
			continue;
		}
		result.push(point);
	}
	return result.map((point) => ({
		x: Math.round(point.x * 100) / 100,
		y: Math.round(point.y * 100) / 100,
	}));
}

/**
 * Put the first (or last) point on the side of `box` it leaves from; the
 * end segment runs along the flow, so only its flow coordinate changes.
 */
function snapEnd(
	points: Point[],
	box: Box,
	horizontalFlow: boolean,
	last: boolean,
): Point[] {
	if (points.length < 2) return points;
	const at = last ? points.length - 1 : 0;
	const end = points[at] as Point;
	const result = [...points];
	if (horizontalFlow) {
		const left = box.x;
		const right = box.x + box.width;
		const x = Math.abs(end.x - left) < Math.abs(end.x - right) ? left : right;
		result[at] = { x, y: end.y };
	} else {
		const top = box.y;
		const bottom = box.y + box.height;
		const y = Math.abs(end.y - top) < Math.abs(end.y - bottom) ? top : bottom;
		result[at] = { x: end.x, y };
	}
	return result;
}
