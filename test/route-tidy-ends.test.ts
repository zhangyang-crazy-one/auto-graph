import { expect, it } from "vitest";
import { computeShapeGeometry } from "../src/geometry/shapes.js";
import type { Point } from "../src/ir/geometry.js";
import { routeEdge } from "../src/routing/routes.js";
import {
	segmentIntersectsBox,
	tidyRouteEnds,
} from "../src/solver/route-edges.js";

// #118: the near-parallel move must not push a middle segment through the
// edge's own source (its end nodes are not in its obstacle list).
const rectangle = (x: number, y: number, width: number, height: number) =>
	computeShapeGeometry({ shape: "rectangle", box: { x, y, width, height } });

function scene(mirror: boolean) {
	const flip = (x: number, width: number) => (mirror ? -x - width : x);
	const box = (x: number, y: number, width: number, height: number) =>
		rectangle(flip(x, width), y, width, height);
	const s = box(0, 0, 80, 48);
	const t = box(0, 80, 80, 48);
	const u = box(-34, 14, 20, 20);
	const v = box(129, 14, 20, 20);
	const wall = { x: flip(45, 70), y: 64, width: 70, height: 12 };
	const side = mirror ? "left" : "right";
	const ar = routeEdge({
		source: s,
		target: t,
		sourceAnchor: side,
		targetAnchor: "top",
		direction: "TB",
		obstacles: [wall, u.box, v.box],
		blockingObstacles: [wall, u.box, v.box],
	});
	const br = routeEdge({
		source: u,
		target: v,
		sourceAnchor: "bottom",
		targetAnchor: "bottom",
		direction: "TB",
		obstacles: [wall, s.box, t.box],
		blockingObstacles: [wall, s.box, t.box],
	});
	return { s, t, u, v, wall, side, ar, br };
}

const enters = (
	points: readonly Point[],
	box: Parameters<typeof segmentIntersectsBox>[2],
) =>
	points
		.slice(1)
		.some((point, at) => segmentIntersectsBox(points[at] as Point, point, box));

it.each([
	false,
	true,
])("near-parallel tidying does not re-enter its own source (mirrored: %s)", (mirror) => {
	const { s, t, u, v, wall, side, ar, br } = scene(mirror);
	expect(ar.diagnostics).toEqual([]);
	expect(br.diagnostics).toEqual([]);
	expect(enters(ar.points, s.box)).toBe(false);
	const a = {
		id: "a",
		source: { nodeId: "s", anchor: side },
		target: { nodeId: "t", anchor: "top" },
		points: ar.points,
	};
	const b = {
		id: "b",
		source: { nodeId: "u", anchor: "bottom" },
		target: { nodeId: "v", anchor: "bottom" },
		points: br.points,
	};
	const nodes = new Map([
		["s", s],
		["t", t],
		["u", u],
		["v", v],
	]);
	const obstacles = [
		{ box: s.box, ownerId: "s" },
		{ box: t.box, ownerId: "t" },
		{ box: u.box, ownerId: "u" },
		{ box: v.box, ownerId: "v" },
		{ box: wall },
	];
	const [tidied] = tidyRouteEnds(
		[a, b] as never,
		nodes,
		obstacles,
		new Set<string>(),
	);
	expect(tidied).toBeDefined();
	expect(enters(tidied?.points ?? [], s.box)).toBe(false);
	expect(enters(tidied?.points ?? [], t.box)).toBe(false);
});
