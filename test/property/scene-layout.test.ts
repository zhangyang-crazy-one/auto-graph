import { describe, expect, it } from "vitest";
import {
	normalizeSceneDsl,
	type SolvedScene,
	solveScene,
} from "../../src/index.js";
import { randomScene } from "../support/scene.js";

/**
 * Property checks on random scenes (fixed seeds, so a failure reproduces
 * with `randomScene(seed)`):
 *
 * 1. Satisfiable scenes solve clean: loose objects, objects against walls
 *    (at most 40% of each wall taken), and one object in front of some of
 *    the wall objects, in a room at most 15% full. Every result must be
 *    valid: no interpenetration, nothing past the walls, nothing floating.
 * 2. Nothing bad is silent: on scenes with conflicting relations mixed
 *    in, an independent check of the output boxes finds an overlap or an
 *    object past the walls only when the solver also says `valid: false`.
 */
function solveRandom(seed: number, conflicts = false): SolvedScene {
	const normalized = normalizeSceneDsl(randomScene(seed, conflicts));
	if (normalized.scene === undefined) {
		throw new Error(JSON.stringify(normalized.diagnostics));
	}
	return solveScene(normalized.scene);
}

/** Overlaps and wall crossings found from the output boxes alone. */
function independentFaults(scene: SolvedScene): string[] {
	const faults: string[] = [];
	const { width, depth } = scene.bounds;
	for (const object of scene.objects) {
		const { min, max } = object.aabb;
		if (
			min[0] < -1e-3 ||
			min[1] < -1e-3 ||
			max[0] > width + 1e-3 ||
			max[1] > depth + 1e-3
		) {
			faults.push(`${object.id} past the walls`);
		}
	}
	// Turns are multiples of 90° here, so the boxes are the footprints.
	for (let i = 0; i < scene.objects.length; i += 1) {
		for (let j = i + 1; j < scene.objects.length; j += 1) {
			const a = scene.objects[i];
			const b = scene.objects[j];
			if (a === undefined || b === undefined) continue;
			const overlaps = [0, 1, 2].every(
				(k) =>
					Math.min(a.aabb.max[k] as number, b.aabb.max[k] as number) -
						Math.max(a.aabb.min[k] as number, b.aabb.min[k] as number) >
					1e-3,
			);
			if (overlaps) faults.push(`${a.id} overlaps ${b.id}`);
		}
	}
	return faults;
}

const SEEDS = Array.from({ length: 60 }, (_, k) => k + 1);

describe("random scenes", () => {
	it.each(SEEDS)("satisfiable scene %i solves clean", (seed) => {
		const scene = solveRandom(seed);
		const errors = scene.diagnostics
			.filter((diagnostic) => diagnostic.severity === "error")
			.map((diagnostic) => diagnostic.message);
		expect(errors).toEqual([]);
		expect(independentFaults(scene)).toEqual([]);
		expect(scene.valid).toBe(true);
	});

	it.each(SEEDS)("scene %i with conflicts is never silently bad", (seed) => {
		const scene = solveRandom(seed, true);
		if (independentFaults(scene).length > 0) {
			expect(scene.valid).toBe(false);
		}
	});

	it("is deterministic", () => {
		expect(JSON.stringify(solveRandom(7, true))).toBe(
			JSON.stringify(solveRandom(7, true)),
		);
	});
});
