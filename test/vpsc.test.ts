import { describe, expect, it } from "vitest";
import {
	solveSeparationQp,
	solveVpsc,
	type VpscConstraint,
} from "../src/constraints/vpsc.js";

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/** Brute force: try every active set, keep the cheapest feasible solution. */
function bruteForce(
	desired: number[],
	weights: number[],
	constraints: VpscConstraint[],
): number {
	const n = desired.length;
	let best = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 1 << constraints.length; mask += 1) {
		const active = constraints.filter((_, i) => mask & (1 << i));
		// KKT system: [2W Aᵀ; A 0] [x; λ] = [2Wd; gap]
		const size = n + active.length;
		const m: number[][] = Array.from({ length: size }, () =>
			new Array(size + 1).fill(0),
		);
		for (let i = 0; i < n; i += 1) {
			(m[i] as number[])[i] = 2 * (weights[i] as number);
			(m[i] as number[])[size] =
				2 * (weights[i] as number) * (desired[i] as number);
		}
		active.forEach((c, k) => {
			const row = n + k;
			(m[row] as number[])[c.right] = 1;
			(m[row] as number[])[c.left] = -1;
			(m[row] as number[])[size] = c.gap;
			(m[c.right] as number[])[row] = 1;
			(m[c.left] as number[])[row] = -1;
		});
		const x = gauss(m);
		if (x === undefined) continue;
		const feasible = constraints.every(
			(c) => (x[c.right] as number) - (x[c.left] as number) >= c.gap - 1e-6,
		);
		if (!feasible) continue;
		let cost = 0;
		for (let i = 0; i < n; i += 1) {
			cost +=
				(weights[i] as number) *
				((x[i] as number) - (desired[i] as number)) ** 2;
		}
		best = Math.min(best, cost);
	}
	return best;
}

function gauss(m: number[][]): number[] | undefined {
	const size = m.length;
	for (let col = 0; col < size; col += 1) {
		let pivot = col;
		for (let row = col + 1; row < size; row += 1) {
			if (
				Math.abs((m[row] as number[])[col] as number) >
				Math.abs((m[pivot] as number[])[col] as number)
			)
				pivot = row;
		}
		if (Math.abs((m[pivot] as number[])[col] as number) < 1e-12)
			return undefined;
		[m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
		const p = m[col] as number[];
		for (let row = 0; row < size; row += 1) {
			if (row === col) continue;
			const r = m[row] as number[];
			const f = (r[col] as number) / (p[col] as number);
			for (let k = col; k <= size; k += 1)
				r[k] = (r[k] as number) - f * (p[k] as number);
		}
	}
	return m.map((row, i) => (row[size] as number) / (row[i] as number));
}

describe("solveVpsc", () => {
	it("leaves a feasible desired placement untouched", () => {
		const result = solveVpsc(
			[{ desired: 0 }, { desired: 10 }],
			[{ left: 0, right: 1, gap: 5 }],
		);
		expect(result.positions).toEqual([0, 10]);
	});

	it("splits a violated gap around the weighted mean", () => {
		const result = solveVpsc(
			[
				{ desired: 0, weight: 1 },
				{ desired: 0, weight: 3 },
			],
			[{ left: 0, right: 1, gap: 8 }],
		);
		expect(result.positions[0]).toBeCloseTo(-6, 9);
		expect(result.positions[1]).toBeCloseTo(2, 9);
	});

	it("honours equality constraints", () => {
		const result = solveVpsc(
			[{ desired: 0 }, { desired: 50 }],
			[{ left: 0, right: 1, gap: 10, equality: true }],
		);
		expect(
			(result.positions[1] as number) - (result.positions[0] as number),
		).toBeCloseTo(10, 9);
	});

	it("reports cyclic constraints as unsatisfiable instead of looping", () => {
		const result = solveVpsc(
			[{ desired: 0 }, { desired: 0 }],
			[
				{ left: 0, right: 1, gap: 5 },
				{ left: 1, right: 0, gap: 5 },
			],
		);
		expect(result.unsatisfiable.length).toBe(1);
	});

	it("matches a brute-force active-set solution on random problems", () => {
		const random = rng(7);
		for (let trial = 0; trial < 150; trial += 1) {
			const n = 2 + Math.floor(random() * 4);
			const desired = Array.from({ length: n }, () =>
				Math.round(random() * 40),
			);
			const weights = Array.from({ length: n }, () => 0.5 + random() * 3);
			const constraints: VpscConstraint[] = [];
			const count = 1 + Math.floor(random() * 5);
			for (let k = 0; k < count; k += 1) {
				const a = Math.floor(random() * n);
				const b = Math.floor(random() * n);
				if (a === b) continue;
				// Acyclic: always left < right by index.
				constraints.push({
					left: Math.min(a, b),
					right: Math.max(a, b),
					gap: Math.round(random() * 20),
				});
			}
			const result = solveVpsc(
				desired.map((d, i) => ({ desired: d, weight: weights[i] as number })),
				constraints,
			);
			for (const c of constraints) {
				expect(
					(result.positions[c.right] as number) -
						(result.positions[c.left] as number),
				).toBeGreaterThanOrEqual(c.gap - 1e-6);
			}
			const cost = result.positions.reduce(
				(sum, x, i) =>
					sum + (weights[i] as number) * (x - (desired[i] as number)) ** 2,
				0,
			);
			expect(cost, `trial ${trial}`).toBeCloseTo(
				bruteForce(desired, weights, constraints),
				4,
			);
		}
	});
});

describe("solveSeparationQp", () => {
	it("straightens a chain while keeping separation", () => {
		// a—b—c chain wants to align; d must stay 30 right of b.
		const result = solveSeparationQp({
			size: 4,
			pairs: [
				{ a: 0, b: 1, weight: 1 },
				{ a: 1, b: 2, weight: 1 },
			],
			anchors: [
				{ v: 0, target: 0, weight: 0.01 },
				{ v: 1, target: 40, weight: 0.01 },
				{ v: 2, target: 80, weight: 0.01 },
				{ v: 3, target: 40, weight: 0.01 },
			],
			constraints: [{ left: 1, right: 3, gap: 30 }],
			initial: [0, 40, 80, 40],
		});
		const [a, b, c, d] = result.positions as [number, number, number, number];
		expect(Math.abs(a - b)).toBeLessThan(2);
		expect(Math.abs(b - c)).toBeLessThan(2);
		expect(d - b).toBeGreaterThanOrEqual(30 - 1e-6);
	});

	it("is deterministic", () => {
		const qp = {
			size: 3,
			pairs: [
				{ a: 0, b: 2, weight: 2 },
				{ a: 1, b: 2, weight: 1 },
			],
			anchors: [0, 1, 2].map((v) => ({ v, target: v * 10, weight: 0.05 })),
			constraints: [{ left: 0, right: 1, gap: 50 }],
			initial: [0, 10, 20],
		};
		expect(solveSeparationQp(qp)).toEqual(solveSeparationQp(qp));
	});

	it("reaches the constrained optimum of a small convex problem", () => {
		// min (x0 - x1)² + 0.1(x0)² + 0.1(x1 - 100)²  s.t. x1 - x0 >= 60
		const result = solveSeparationQp({
			size: 2,
			pairs: [{ a: 0, b: 1, weight: 1 }],
			anchors: [
				{ v: 0, target: 0, weight: 0.1 },
				{ v: 1, target: 100, weight: 0.1 },
			],
			constraints: [{ left: 0, right: 1, gap: 60 }],
			initial: [0, 100],
		});
		// Active constraint: x1 = x0 + 60, minimise 0.1x0² + 0.1(x0 - 40)² → x0 = 20.
		expect(result.positions[0]).toBeCloseTo(20, 2);
		expect(result.positions[1]).toBeCloseTo(80, 2);
	});
});
