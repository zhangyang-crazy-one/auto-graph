import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../../src/dsl/index.js";
import { measureRouteReadability } from "../../src/quality/index.js";
import { DeterministicTextMeasurer } from "../../src/text/index.js";
import { generateSyntheticDsl } from "../support/synthetic.js";

/**
 * Route readability on random diagrams: no route end off its node's
 * outline, no label against a group title, and runs that read as one line
 * (collinear near-touches, near-parallel runs) or labels nearer another
 * route kept under the budgets measured when the tidy pass learned to
 * clear them.
 */
const KINDS = ["plain", "architecture", "process"] as const;
const DIRECTIONS = ["LR", "TB"] as const;
const SIZES = [20, 40];
const SEEDS = [1, 2, 3];

describe("route readability on random diagrams", () => {
	const totals = {
		collinearTouches: 0,
		nearParallelLength: 0,
		labelsNearerOtherRoute: 0,
	};
	for (const kind of KINDS) {
		for (const direction of DIRECTIONS) {
			for (const nodes of SIZES) {
				for (const seed of SEEDS) {
					it(`${kind} ${direction} ${nodes} nodes, seed ${seed}`, () => {
						const result = renderDiagramDsl(
							generateSyntheticDsl({
								seed,
								nodes,
								kind,
								direction,
								edgeLabelRate: 0.3,
							}),
							{ textMeasurer: new DeterministicTextMeasurer() },
						);
						expect(result.diagram).toBeDefined();
						const found = measureRouteReadability(
							result.diagram as NonNullable<typeof result.diagram>,
						);
						expect(found.endsOffOutline).toBe(0);
						expect(found.labelsBesideGroupTitles).toBe(0);
						totals.collinearTouches += found.collinearTouches;
						totals.nearParallelLength += found.nearParallelLength;
						totals.labelsNearerOtherRoute += found.labelsNearerOtherRoute;
					});
				}
			}
		}
	}
	it("stays within the corpus budgets", () => {
		expect(totals.collinearTouches).toBeLessThanOrEqual(
			BUDGET.collinearTouches,
		);
		expect(totals.nearParallelLength).toBeLessThanOrEqual(
			BUDGET.nearParallelLength,
		);
		expect(totals.labelsNearerOtherRoute).toBeLessThanOrEqual(
			BUDGET.labelsNearerOtherRoute,
		);
	});
});

/** Measured on main before the tidy pass: 38 touches, 1781 px, 6 labels. */
const BUDGET = {
	collinearTouches: 2,
	nearParallelLength: 1100,
	labelsNearerOtherRoute: 4,
};
