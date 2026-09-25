import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../../src/dsl/index.js";
import {
	containmentRelations,
	LAYOUT_METRIC_HARD_KEYS,
	measureLayoutQuality,
} from "../../src/quality/index.js";
import { DeterministicTextMeasurer } from "../../src/text/index.js";
import { generateSyntheticDsl } from "../support/synthetic.js";

/**
 * Property check: random diagrams of every kind and direction solve with
 * no hard violation (overlaps, text overflow, edges through nodes, label
 * collisions, shared endpoints). The seeds are fixed so a failure is
 * reproducible with `generateSyntheticDsl`.
 */
const KINDS = ["plain", "architecture", "process"] as const;
const DIRECTIONS = ["LR", "TB"] as const;
const SIZES = [30, 60];
const SEEDS = [1, 2];

describe("hard metrics on random diagrams", () => {
	for (const kind of KINDS) {
		for (const direction of DIRECTIONS) {
			for (const nodes of SIZES) {
				for (const seed of SEEDS) {
					it(`${kind} ${direction} ${nodes} nodes, seed ${seed}`, () => {
						const result = renderDiagramDsl(
							generateSyntheticDsl({ seed, nodes, kind, direction }),
							{ textMeasurer: new DeterministicTextMeasurer() },
						);
						expect(result.diagram).toBeDefined();
						const metrics = measureLayoutQuality(
							result.diagram as NonNullable<typeof result.diagram>,
							{ containment: containmentRelations(result.constraints) },
						);
						const violations = Object.fromEntries(
							LAYOUT_METRIC_HARD_KEYS.filter((key) => metrics[key] > 0).map(
								(key) => [key, metrics[key]],
							),
						);
						expect(violations).toEqual({});
					});
				}
			}
		}
	}
});
