import {
	axisAngle,
	corners,
	direction,
	footprint,
	halfExtent,
	type Vec2,
} from "./geometry.js";
import type { PlacedSceneObject, SolvedScene } from "./ir.js";
import { positionAt, timePath } from "./path-timing.js";
import { contourSegments, sceneTerrain } from "./terrain/index.js";

export interface SceneTopViewOptions {
	/** Pixels per meter (default 100). */
	scale?: number;
}

const MARGIN = 48;
const LEVEL_FILLS = ["#dbeafe", "#fde68a", "#fbcfe8", "#d9f99d"];
const STROKE = "#1e3a8a";
const PATH_COLORS = ["#0d9488", "#c2410c", "#7c3aed", "#0369a1", "#be123c"];
const FAULT = "#dc2626";
/** The smallest of 1, 2, 5 × 10ⁿ (and `least`) at least `want`. */
function niceStep(want: number, least: number): number {
	let step = least;
	for (let k = 0; step < want && k < 60; k += 1) {
		step = ([1, 2, 5][k % 3] as number) * 10 ** Math.floor(k / 3) * least;
	}
	return step;
}

/** Most time ticks drawn along one path. */
const MAX_TICKS = 200;
const WARNING = "#b45309";
/** Diagnostics that mark an object as wrong in the drawing. */
const FAULT_CODES = new Set([
	"scene.collision",
	"scene.out-of-bounds",
	"scene.above-ceiling",
	"scene.support.unstable",
	"scene.keep-clear",
	"scene.yaw.conflict",
	"scene.terrain.slope",
	"scene.terrain.elevation",
	"scene.terrain.outside",
	"scene.terrain.leaning-support",
]);

/**
 * A plan view of a solved scene for checking it by eye: the room with a
 * 0.5 m grid (north up), every footprint filled by how high it is stacked,
 * a triangle on each front, objects in a failed check outlined red, and
 * the unplaced objects listed underneath.
 */
export function sceneTopViewSvg(
	scene: SolvedScene,
	options: SceneTopViewOptions = {},
): string {
	const { width, depth } = scene.bounds;
	// 100 px a metre for a room; a larger site is drawn about 1000 px wide.
	const scale = options.scale ?? Math.min(100, 1000 / Math.max(width, depth));
	// Grid lines and axis numbers far enough apart to read.
	const grid_ = niceStep(25 / scale, 0.5);
	const tickStep = niceStep(30 / scale, 1);
	const roomWidth = width * scale;
	const roomDepth = depth * scale;
	const notes = footerLines(scene);
	const svgWidth = roomWidth + MARGIN * 2;
	const svgHeight = roomDepth + MARGIN * 2 + notes.length * 16;
	const px = (x: number) => fmt(MARGIN + x * scale);
	const py = (y: number) => fmt(MARGIN + (depth - y) * scale);
	const point = (p: Vec2) => `${px(p.x)},${py(p.y)}`;

	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(svgWidth)}" height="${fmt(svgHeight)}" viewBox="0 0 ${fmt(svgWidth)} ${fmt(svgHeight)}" font-family="sans-serif">`,
		`<rect width="100%" height="100%" fill="#ffffff"/>`,
	];

	const grid: string[] = [];
	for (let k = 1; k * grid_ < width - 1e-9; k += 1) {
		grid.push(`M${px(k * grid_)} ${py(0)}V${py(depth)}`);
	}
	for (let k = 1; k * grid_ < depth - 1e-9; k += 1) {
		grid.push(`M${px(0)} ${py(k * grid_)}H${px(width)}`);
	}
	if (grid.length > 0) {
		out.push(
			`<path d="${grid.join("")}" stroke="#e2e8f0" stroke-width="1" fill="none"/>`,
		);
	}
	// Terrain: contour lines (every fifth one darker, with its elevation).
	const ground = sceneTerrain(scene);
	if (ground !== undefined) {
		const all = ground.grid.heights.flat();
		const low = Math.min(...all);
		const high = Math.max(...all);
		if (high > low) {
			const interval = niceStep((high - low) / 12, 0.1);
			const thin: string[] = [];
			const thick: string[] = [];
			const labels: string[] = [];
			for (
				let k = Math.ceil(low / interval);
				k * interval <= high + 1e-9;
				k += 1
			) {
				const level = k * interval;
				const segments = contourSegments(ground.grid, level);
				const index = k % 5 === 0;
				const into = index ? thick : thin;
				for (const [a, b] of segments) into.push(`M${point(a)}L${point(b)}`);
				const longest = segments.reduce<[Vec2, Vec2] | undefined>(
					(best, segment) =>
						best === undefined ||
						Math.hypot(
							segment[1].x - segment[0].x,
							segment[1].y - segment[0].y,
						) > Math.hypot(best[1].x - best[0].x, best[1].y - best[0].y)
							? segment
							: best,
					undefined,
				);
				if (index && longest !== undefined) {
					const at = {
						x: (longest[0].x + longest[1].x) / 2,
						y: (longest[0].y + longest[1].y) / 2,
					};
					labels.push(
						`<text x="${px(at.x)}" y="${fmt(Number(py(at.y)) + 3)}" font-size="9" fill="#78716c" text-anchor="middle" stroke="#ffffff" stroke-width="3" paint-order="stroke">${fmt(level)}</text>`,
					);
				}
			}
			if (thin.length > 0) {
				out.push(
					`<path d="${thin.join("")}" stroke="#d6c7a8" stroke-width="0.8" fill="none"/>`,
				);
			}
			if (thick.length > 0) {
				out.push(
					`<path d="${thick.join("")}" stroke="#a8956d" stroke-width="1.4" fill="none"/>`,
				);
			}
			out.push(...labels);
		}
	}
	out.push(
		`<rect x="${px(0)}" y="${py(depth)}" width="${fmt(roomWidth)}" height="${fmt(roomDepth)}" fill="none" stroke="#334155" stroke-width="2"/>`,
	);
	// Lines (roads, fences, flight lines): dashed, named at their start.
	for (const line of scene.lines ?? []) {
		const d = line.points
			.map(([x, y], k) => `${k === 0 ? "M" : "L"}${px(x)} ${py(y)}`)
			.join("");
		const [x0 = 0, y0 = 0] = line.points[0] ?? [];
		out.push(
			`<path d="${d}" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="6 4" stroke-linejoin="round"/>`,
			`<text x="${px(x0)}" y="${fmt(Number(py(y0)) - 6)}" font-size="10" fill="#475569" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(line.id)}</text>`,
		);
	}
	// Openings: a gap in the wall with a tick at each jamb and the name
	// just outside.
	for (const opening of scene.openings) {
		const horizontal = opening.wall === "north" || opening.wall === "south";
		const along = (t: number): Vec2 =>
			horizontal
				? { x: t, y: opening.wall === "north" ? depth : 0 }
				: { x: opening.wall === "east" ? width : 0, y: t };
		const a = along(opening.at - opening.width / 2);
		const b = along(opening.at + opening.width / 2);
		const inward =
			opening.wall === "south"
				? { x: 0, y: 1 }
				: opening.wall === "north"
					? { x: 0, y: -1 }
					: opening.wall === "west"
						? { x: 1, y: 0 }
						: { x: -1, y: 0 };
		const tick = 8 / scale;
		const label = along(opening.at);
		out.push(
			`<line x1="${px(a.x)}" y1="${py(a.y)}" x2="${px(b.x)}" y2="${py(b.y)}" stroke="#ffffff" stroke-width="4"/>`,
			...[a, b].map(
				(jamb) =>
					`<line x1="${px(jamb.x)}" y1="${py(jamb.y)}" x2="${px(jamb.x + inward.x * tick)}" y2="${py(jamb.y + inward.y * tick)}" stroke="#334155" stroke-width="2"/>`,
			),
			`<text x="${px(label.x - inward.x * (14 / scale))}" y="${fmt(Number(py(label.y - inward.y * (14 / scale))) + 4)}" font-size="10" fill="#334155" text-anchor="middle">${escapeXml(opening.id)}</text>`,
		);
	}
	for (let k = 0; k * tickStep <= width + 1e-9; k += 1) {
		const x = k * tickStep;
		out.push(
			`<text x="${px(x)}" y="${fmt(MARGIN + roomDepth + 16)}" font-size="10" fill="#64748b" text-anchor="middle">${fmt(x)}</text>`,
		);
	}
	for (let k = 0; k * tickStep <= depth + 1e-9; k += 1) {
		const y = k * tickStep;
		out.push(
			`<text x="${fmt(MARGIN - 8)}" y="${fmt(Number(py(y)) + 3)}" font-size="10" fill="#64748b" text-anchor="end">${fmt(y)}</text>`,
		);
	}
	// The north arrow points to true north in a scene placed on the Earth
	// (turned by the frame's heading), to the scene's north otherwise.
	const nx = MARGIN + roomWidth + 24;
	const heading = scene.geo?.heading ?? 0;
	out.push(
		`<path d="M${fmt(nx)} 14l-5 12h10z" fill="#334155"${heading === 0 ? "" : ` transform="rotate(${fmt(-heading)} ${fmt(nx)} 20)"`}/>`,
		`<text x="${fmt(nx)}" y="38" font-size="10" fill="#334155" text-anchor="middle">N</text>`,
	);

	const faulty = new Set(
		scene.diagnostics
			.filter((diagnostic) => FAULT_CODES.has(diagnostic.code))
			.flatMap((diagnostic) => diagnostic.objects ?? []),
	);
	const level = stackLevels(scene.objects);
	const drawOrder = scene.objects
		.map((object, index) => ({ object, index }))
		.sort(
			(a, b) =>
				a.object.position[2] - b.object.position[2] || a.index - b.index,
		)
		.map(({ object }) => object);
	const labels: { text: string; x: number; y: number }[] = [];
	for (const object of drawOrder) {
		const shape = footprint(
			{ x: object.position[0], y: object.position[1] },
			object.size,
			object.yaw,
		);
		const fault = faulty.has(object.id);
		const fill = LEVEL_FILLS[(level.get(object.id) ?? 0) % LEVEL_FILLS.length];
		out.push(
			`<polygon points="${corners(shape).map(point).join(" ")}" fill="${fill}" fill-opacity="0.9" stroke="${fault ? FAULT : STROKE}" stroke-width="${fault ? 2.5 : 1.25}"${fault ? ' stroke-dasharray="6 3"' : ""}/>`,
		);
		const forward = direction(object.yaw + axisAngle(object.front));
		const reach = halfExtent(shape, forward);
		const edge = {
			x: shape.center.x + forward.x * reach,
			y: shape.center.y + forward.y * reach,
		};
		const tip = 7 / scale;
		const wing = 5 / scale;
		const side = { x: -forward.y, y: forward.x };
		out.push(
			`<polygon points="${[
				{ x: edge.x + forward.x * tip, y: edge.y + forward.y * tip },
				{ x: edge.x + side.x * wing, y: edge.y + side.y * wing },
				{ x: edge.x - side.x * wing, y: edge.y - side.y * wing },
			]
				.map(point)
				.join(" ")}" fill="${fault ? FAULT : STROKE}"/>`,
		);
		labels.push({
			text: object.label ?? object.id,
			x: Number(px(shape.center.x)),
			y: Number(py(shape.center.y)) + 4,
		});
	}
	// Paths: a band as wide as the agent, its center line, a dot where it
	// starts, a tick for every second on the way and an arrowhead where it
	// ends.
	scene.paths.forEach((path, index) => {
		const color = PATH_COLORS[index % PATH_COLORS.length] as string;
		const line = path.points
			.map(([x, y], k) => `${k === 0 ? "M" : "L"}${px(x)} ${py(y)}`)
			.join("");
		out.push(
			`<path d="${line}" fill="none" stroke="${color}" stroke-opacity="0.16" stroke-width="${fmt(path.width * scale)}" stroke-linecap="round" stroke-linejoin="round"/>`,
			`<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`,
		);
		const [sx = 0, sy = 0] = path.points[0] ?? [];
		out.push(`<circle cx="${px(sx)}" cy="${py(sy)}" r="4" fill="${color}"/>`);
		const agent = scene.agents.find((item) => item.id === path.agent);
		if (agent !== undefined) {
			const corners = path.points.map(([x, y]) => ({ x, y }));
			const timing = timePath(corners, agent.speed, agent.accel, path.start);
			// A tick every second, or every 2, 5, 10 … s on a long walk, so
			// there are never more than MAX_TICKS.
			let every = 1;
			for (let k = 0; timing.duration / every > MAX_TICKS; k += 1) {
				every = ([2, 5, 10][k % 3] as number) * 10 ** Math.floor(k / 3);
			}
			const first = Math.floor(path.start / every) + 1;
			const count =
				Math.floor((path.start + timing.duration - 0.05) / every) - first + 1;
			for (let k = 0; k < count; k += 1) {
				const at = positionAt(corners, timing, (first + k) * every);
				if (at === undefined) continue;
				out.push(
					`<circle cx="${px(at.x)}" cy="${py(at.y)}" r="2.5" fill="#ffffff" stroke="${color}" stroke-width="1.5"/>`,
				);
			}
		}
		const end = path.points.at(-1);
		const before = path.points.at(-2);
		if (end !== undefined && before !== undefined) {
			const dx = end[0] - before[0];
			const dy = end[1] - before[1];
			const length = Math.hypot(dx, dy) || 1;
			const forward = { x: dx / length, y: dy / length };
			const side = { x: -forward.y, y: forward.x };
			const tip = { x: end[0], y: end[1] };
			const back = 9 / scale;
			const wing = 5 / scale;
			out.push(
				`<polygon points="${[
					tip,
					{
						x: tip.x - forward.x * back + side.x * wing,
						y: tip.y - forward.y * back + side.y * wing,
					},
					{
						x: tip.x - forward.x * back - side.x * wing,
						y: tip.y - forward.y * back - side.y * wing,
					},
				]
					.map(point)
					.join(" ")}" fill="${color}"/>`,
			);
		}
	});

	// Landmarks: a small diamond and the name.
	for (const landmark of scene.landmarks ?? []) {
		const [x, y] = landmark.position;
		if (x < 0 || y < 0 || x > width || y > depth) continue;
		const cx = Number(px(x));
		const cy = Number(py(y));
		out.push(
			`<path d="M${fmt(cx)} ${fmt(cy - 6)}l6 6l-6 6l-6 -6z" fill="#fef3c7" stroke="#b45309" stroke-width="1.5"/>`,
			`<text x="${fmt(cx)}" y="${fmt(cy - 9)}" font-size="10" fill="#b45309" text-anchor="middle" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(landmark.id)}</text>`,
		);
	}
	// Waypoints: the legs and a ring at each, with the height above ground.
	for (const set of scene.waypoints ?? []) {
		const d = set.points
			.map(([x, y], k) => `${k === 0 ? "M" : "L"}${px(x)} ${py(y)}`)
			.join("");
		out.push(
			`<path d="${d}" fill="none" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3 3"/>`,
			...set.points.map(
				([x, y]) =>
					`<circle cx="${px(x)}" cy="${py(y)}" r="3" fill="#ffffff" stroke="#7c3aed" stroke-width="1.5"/>`,
			),
		);
		const [x0 = 0, y0 = 0] = set.points[0] ?? [];
		out.push(
			`<text x="${fmt(Number(px(x0)) + 6)}" y="${fmt(Number(py(y0)) + 12)}" font-size="10" fill="#6d28d9" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(`${set.id} · ${fmt(set.height)} m`)}</text>`,
		);
	}
	// Labels go on top of every footprint; one that would cover an earlier
	// label (a lamp centered on its desk) moves down a line.
	const taken: { x: number; y: number; half: number }[] = [];
	for (const label of labels) {
		const half = label.text.length * 3.3 + 2;
		let y = label.y;
		while (
			taken.some(
				(other) =>
					Math.abs(other.y - y) < 12 &&
					Math.abs(other.x - label.x) < other.half + half,
			)
		) {
			y += 13;
		}
		taken.push({ x: label.x, y, half });
		out.push(
			`<text x="${fmt(label.x)}" y="${fmt(y)}" font-size="11" fill="#0f172a" text-anchor="middle" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(label.text)}</text>`,
		);
	}

	notes.forEach((line, index) => {
		out.push(
			`<text x="${fmt(MARGIN)}" y="${fmt(MARGIN + roomDepth + 36 + index * 16)}" font-size="11" fill="${line.color}">${escapeXml(line.text)}</text>`,
		);
	});
	out.push("</svg>");
	return `${out.join("\n")}\n`;
}

function footerLines(scene: SolvedScene): { text: string; color: string }[] {
	const lines: { text: string; color: string }[] = [];
	for (const diagnostic of scene.diagnostics) {
		if (diagnostic.severity === "error") {
			lines.push({ text: `✗ ${diagnostic.message}`, color: FAULT });
		} else if (diagnostic.severity === "warning") {
			lines.push({ text: `! ${diagnostic.message}`, color: WARNING });
		}
	}
	if (scene.unplaced.length > 0) {
		lines.push({
			text: `unplaced: ${scene.unplaced.join(", ")}`,
			color: "#475569",
		});
	}
	return lines;
}

/** 0 on the floor, 1 on something on the floor, and so on. */
function stackLevels(
	objects: readonly PlacedSceneObject[],
): Map<string, number> {
	const support = new Map(
		objects.map((object) => [object.id, object.supportedBy]),
	);
	const levels = new Map<string, number>();
	for (const object of objects) {
		let count = 0;
		const seen = new Set<string>();
		for (
			let at = object.supportedBy;
			at !== undefined && !seen.has(at);
			at = support.get(at)
		) {
			seen.add(at);
			count += 1;
		}
		levels.set(object.id, count);
	}
	return levels;
}

function fmt(value: number): string {
	const rounded = Math.round(value * 100) / 100;
	return String(rounded === 0 ? 0 : rounded);
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
