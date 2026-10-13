import { describe, expect, it } from "vitest";
import type { NormalizedEdge } from "../../src/ir/index.js";
import {
	partitionUnits,
	preparePartition,
	type SplitUnit,
} from "../../src/solver/page-split.js";
import { mulberry32 } from "../support/synthetic.js";

/**
 * Page-split partition benchmark (#106): wall time and heap of the
 * partition stage alone, for growing unit counts and every page count a
 * split tries. `DGE_PARTITION=1 npx vitest run test/benchmark/page-partition.test.ts`.
 */
const enabled = process.env.DGE_PARTITION === "1";

describe.skipIf(!enabled)("page-split partition benchmark", () => {
	it("stays bounded as units grow", () => {
		const rows: string[] = [];
		for (const n of [100, 500, 1000, 5000, 10000]) {
			const random = mulberry32(n);
			const units: SplitUnit[] = Array.from({ length: n }, (_, index) => ({
				nodeIds: [`u${index}`],
				groupIds: [],
				firstIndex: index,
			}));
			const edges = Array.from({ length: Math.round(n * 1.5) }, (_, k) => {
				const a = Math.floor(random() * n);
				const b = Math.min(n - 1, a + 1 + Math.floor(random() * 5));
				return {
					id: `e${k}`,
					source: { nodeId: `u${a}` },
					target: { nodeId: `u${b}` },
				};
			}) as NormalizedEdge[];
			const heapBefore = process.memoryUsage().heapUsed;
			const start = performance.now();
			const input = preparePartition(units, edges);
			let blocks: number | undefined;
			for (let pageCount = 2; pageCount <= 6; pageCount += 1) {
				blocks = partitionUnits(input, pageCount).blocks ?? blocks;
			}
			const ms = performance.now() - start;
			const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
			rows.push(
				`| ${n} | ${ms.toFixed(0)} | ${heapMb.toFixed(1)} | ${blocks ?? "exact"} |`,
			);
			expect(ms).toBeLessThan(60_000);
		}
		console.log(
			[
				"| units | ms (2–6 pages) | heap Δ MB | blocks |",
				"| ---: | ---: | ---: | ---: |",
				...rows,
			].join("\n"),
		);
	});
});
