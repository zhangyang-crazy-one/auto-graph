import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../../src/dsl/index.js";
import {
	containmentRelations,
	measureLayoutQuality,
} from "../../src/quality/index.js";
import { DeterministicTextMeasurer } from "../../src/text/index.js";
import { generateSyntheticDsl } from "../support/synthetic.js";

/**
 * Scale benchmark (opt-in: DGE_SCALE=1 npx vitest run test/scale).
 * Prints solve time and hard metrics for growing synthetic diagrams.
 */
const enabled = process.env.DGE_SCALE === "1";
const sizes = (process.env.DGE_SCALE_SIZES ?? "50,100,200,300")
	.split(",")
	.map(Number);
const kinds = (
	process.env.DGE_SCALE_KINDS ?? "plain,architecture,process"
).split(",") as ("plain" | "architecture" | "process")[];

describe.skipIf(!enabled)("scale benchmark", () => {
	for (const kind of kinds) {
		for (const nodes of sizes) {
			it(`${kind} ${nodes} nodes`, { timeout: 600_000 }, () => {
				const source = generateSyntheticDsl({ seed: 42, nodes, kind });
				const started = performance.now();
				const result = renderDiagramDsl(source, {
					textMeasurer: new DeterministicTextMeasurer(),
				});
				const elapsed = performance.now() - started;
				expect(result.diagram).toBeDefined();
				const metrics = measureLayoutQuality(
					result.diagram as NonNullable<typeof result.diagram>,
					{ containment: containmentRelations(result.constraints) },
				);
				console.log(
					[
						kind.padEnd(12),
						String(nodes).padStart(5),
						`${Math.round(elapsed)}ms`.padStart(9),
						`edges=${result.diagram?.edges.length}`,
						`nodeOverlaps=${metrics.nodeOverlaps}`,
						`groupOverlaps=${metrics.groupOverlaps}`,
						`foreign=${metrics.foreignNodesInGroups}`,
						`labelOverflow=${metrics.labelOverflows}`,
						`throughNodes=${metrics.edgesThroughNodes}`,
						`labelCollisions=${metrics.edgeLabelCollisions}`,
						`sharedEnds=${metrics.sharedEndpoints}`,
						`crossings=${metrics.crossings}`,
						`aspect=${metrics.aspectRatio}`,
					].join(" "),
				);
			});
		}
	}
});
