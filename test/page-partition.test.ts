import { describe, expect, it } from "vitest";
import type { NormalizedEdge } from "../src/ir/index.js";
import {
	partitionUnits,
	preparePartition,
	type SplitUnit,
} from "../src/solver/page-split.js";
import { mulberry32 } from "./support/synthetic.js";

/**
 * The page-split partition (#106): linear memory instead of a U² cut
 * table, the same pages as the table version, and a bounded coarse
 * partition when the exact one would exceed its work budget.
 */

function unitsAndEdges(n: number, edgeCount: number, seed: number) {
	const random = mulberry32(seed);
	const units: SplitUnit[] = Array.from({ length: n }, (_, index) => ({
		nodeIds: Array.from(
			{ length: 1 + Math.floor(random() * 3) },
			(_, k) => `u${index}n${k}`,
		),
		groupIds: [],
		firstIndex: index,
	}));
	const edges: NormalizedEdge[] = Array.from({ length: edgeCount }, (_, k) => {
		const a = Math.floor(random() * n);
		// Mostly local edges, some long ones.
		const span =
			random() < 0.8 ? 1 + Math.floor(random() * 4) : Math.floor(random() * n);
		const b = Math.min(n - 1, a + span);
		return {
			id: `e${k}`,
			source: { nodeId: `u${a}n0` },
			target: { nodeId: `u${b}n0` },
		} as NormalizedEdge;
	});
	return { units, edges };
}

/** The partition as it was with the full cut table (reference). */
function tablePartition(
	units: readonly SplitUnit[],
	edges: readonly NormalizedEdge[],
	pageCount: number,
): number[] {
	const n = units.length;
	const position = new Map<string, number>();
	units.forEach((unit, index) => {
		for (const id of unit.nodeIds) position.set(id, index);
	});
	const weight = units.map((unit) => unit.nodeIds.length);
	const byLo: number[][] = Array.from({ length: n }, () => []);
	const byHi: number[][] = Array.from({ length: n }, () => []);
	for (const edge of edges) {
		const a = position.get(edge.source.nodeId) as number;
		const b = position.get(edge.target.nodeId) as number;
		weight[a] = (weight[a] as number) + 0.5;
		weight[b] = (weight[b] as number) + 0.5;
		if (a === b) continue;
		(byLo[Math.min(a, b)] as number[]).push(Math.max(a, b));
		(byHi[Math.max(a, b)] as number[]).push(Math.min(a, b));
	}
	const prefix = [0];
	for (const value of weight) prefix.push((prefix.at(-1) as number) + value);
	const target = (prefix.at(-1) as number) / pageCount;
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
	const cost = (a: number, b: number, last: boolean) => {
		const share = ((prefix[b + 1] as number) - (prefix[a] as number)) / target;
		return (
			(last ? 0 : ((cut[a] as number[])[b] as number)) +
			2 * Math.abs(share - 1) +
			(share > 1.5 ? 1000 * (share - 1.5) : 0) +
			(share < 0.4 ? 1000 * (0.4 - share) : 0)
		);
	};
	const best = Array.from({ length: pageCount }, () =>
		new Array<number>(n).fill(Number.POSITIVE_INFINITY),
	);
	const from = Array.from({ length: pageCount }, () =>
		new Array<number>(n).fill(-1),
	);
	for (let b = 0; b < n; b += 1) {
		(best[0] as number[])[b] = cost(0, b, pageCount === 1 && b === n - 1);
	}
	for (let p = 1; p < pageCount; p += 1) {
		for (let b = p; b < n; b += 1) {
			for (let a = p; a <= b; a += 1) {
				const before = (best[p - 1] as number[])[a - 1] as number;
				if (!Number.isFinite(before)) continue;
				const value = before + cost(a, b, p === pageCount - 1 && b === n - 1);
				if (value < ((best[p] as number[])[b] as number) - 1e-9) {
					(best[p] as number[])[b] = value;
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
	return pageOfUnit;
}

describe("page-split partition", () => {
	it("cuts the same pages as the cut-table version", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			for (const [n, edgeCount] of [
				[12, 15],
				[40, 70],
				[120, 200],
			] as const) {
				const { units, edges } = unitsAndEdges(n, edgeCount, seed);
				const input = preparePartition(units, edges);
				for (const pageCount of [2, 3, 4, 6]) {
					if (pageCount > n) continue;
					const result = partitionUnits(input, pageCount);
					expect(result.blocks).toBeUndefined();
					expect(result.pageOfUnit).toEqual(
						tablePartition(units, edges, pageCount),
					);
				}
			}
		}
	});

	it("coarsens past the work budget and still places every unit", () => {
		const n = 6000;
		const { units, edges } = unitsAndEdges(n, 9000, 7);
		const input = preparePartition(units, edges);
		const result = partitionUnits(input, 6);
		expect(result.blocks).toBeDefined();
		expect(result.blocks as number).toBeLessThan(n);
		expect(result.pageOfUnit).toHaveLength(n);
		// Contiguous runs, every page used, in order.
		for (let index = 1; index < n; index += 1) {
			const step =
				(result.pageOfUnit[index] as number) -
				(result.pageOfUnit[index - 1] as number);
			expect(step === 0 || step === 1).toBe(true);
		}
		expect(result.pageOfUnit[0]).toBe(1);
		expect(result.pageOfUnit[n - 1]).toBe(6);
		expect(Number.isFinite(result.cost)).toBe(true);
	});
});
