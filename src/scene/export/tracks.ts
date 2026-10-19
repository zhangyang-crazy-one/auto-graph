import type { SolvedScene } from "../ir.js";
import { positionAfter, sampleElapsed, timePath } from "../path-timing.js";
import type { GridTerrain } from "../terrain/index.js";

/**
 * What the 3D exporters share: path and line polylines laid on the
 * ground, and each agent's position over time for keyframes.
 */

/** Seconds between the keyframes of an agent walking its path. */
const TRACK_STEP = 0.1;

/** Each path's polyline, along the ground between corners on terrain. */
export function pathLines(
	scene: SolvedScene,
	ground: GridTerrain | undefined,
): Record<string, number[][]> {
	return Object.fromEntries(
		scene.paths.map((path) => [path.id, onGround(path.points, ground)]),
	);
}

/**
 * A polyline on the ground: on terrain, points between its corners every
 * quarter of a grid cell, at the ground's height.
 */
export function onGround(
	points: readonly (readonly [number, number, number])[],
	ground: GridTerrain | undefined,
): number[][] {
	if (ground === undefined) return points.map((point) => [...point]);
	const step = Math.min(ground.grid.spacing.x, ground.grid.spacing.y) / 4;
	const line: number[][] = [];
	points.forEach(([x, y, z], k) => {
		if (k > 0) {
			const [px, py] = points[k - 1] as [number, number, number];
			const count = Math.min(
				1000,
				Math.ceil(Math.hypot(x - px, y - py) / step),
			);
			for (let n = 1; n < count; n += 1) {
				const t = n / count;
				const at = [px + (x - px) * t, py + (y - py) * t];
				line.push([
					round(at[0] as number),
					round(at[1] as number),
					round(ground.heightNear(at[0] as number, at[1] as number)),
				]);
			}
		}
		line.push([x, y, z]);
	});
	return line;
}

/** Each path's agent sampled over time, for keyframes. */
export function agentTracks(
	scene: SolvedScene,
	ground: GridTerrain | undefined,
): Record<string, number[][]> {
	const tracks: Record<string, number[][]> = {};
	for (const path of scene.paths) {
		const agent = scene.agents.find((item) => item.id === path.agent);
		if (agent === undefined) continue;
		const corners = path.points.map(([x, y]) => ({ x, y }));
		const timing = timePath(corners, agent.speed, agent.accel, path.start);
		// Sampled on time since setting off and rounded only when written,
		// so the first key is the start and the last the end.
		tracks[path.id] = sampleElapsed(timing, TRACK_STEP).map((since) => {
			const at = positionAfter(corners, timing, since);
			const z = ground === undefined ? 0 : ground.heightNear(at.x, at.y);
			return [round(path.start + since), round(at.x), round(at.y), round(z)];
		});
	}
	return tracks;
}

export function round(value: number): number {
	const rounded = Math.round(value * 1e4) / 1e4;
	return Object.is(rounded, -0) ? 0 : rounded;
}
