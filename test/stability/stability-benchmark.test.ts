import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../../src/dsl/index.js";
import type { CoordinatedDiagram } from "../../src/ir/index.js";
import { previousLayoutOf } from "../../src/layout/index.js";
import {
	LAYOUT_METRIC_HARD_KEYS,
	measureLayoutQuality,
	measureLayoutStability,
} from "../../src/quality/index.js";
import { DeterministicTextMeasurer } from "../../src/text/index.js";
import { applyEdit, baseDocument, EDIT_KINDS, toDsl } from "./edits.js";

/**
 * Stability benchmark (opt-in: DGE_STABILITY=1 npx vitest run test/stability).
 * Solves a synthetic diagram, applies one small edit, solves again cold
 * and with the previous layout as a hint, and prints how far the nodes
 * that exist in both versions moved.
 */
const enabled = process.env.DGE_STABILITY === "1";
const sizes = (process.env.DGE_STABILITY_SIZES ?? "40,120")
	.split(",")
	.map(Number);
const kinds = (
	process.env.DGE_STABILITY_KINDS ?? "plain,architecture,process"
).split(",") as ("plain" | "architecture" | "process")[];

function solve(source: string, previous?: CoordinatedDiagram) {
	const result = renderDiagramDsl(source, {
		textMeasurer: new DeterministicTextMeasurer(),
		...(previous === undefined
			? {}
			: { previousLayout: previousLayoutOf(previous) }),
	});
	expect(result.diagram).toBeDefined();
	return result.diagram as CoordinatedDiagram;
}

function boxes(diagram: CoordinatedDiagram) {
	return new Map(diagram.nodes.map((node) => [node.id, node.box] as const));
}

describe.skipIf(!enabled)("stability benchmark", () => {
	for (const kind of kinds) {
		for (const size of sizes) {
			it(`${kind} ${size}`, { timeout: 600_000 }, () => {
				const base = baseDocument(kind, size);
				const first = solve(toDsl(base));
				const before = boxes(first);
				for (const edit of EDIT_KINDS) {
					const source = toDsl(applyEdit(base, edit));
					const coldDiagram = solve(source);
					const warmDiagram = solve(source, first);
					const cold = measureLayoutStability(before, boxes(coldDiagram));
					const warm = measureLayoutStability(before, boxes(warmDiagram));
					const quality = (diagram: CoordinatedDiagram) => {
						const metrics = measureLayoutQuality(diagram);
						const hard = LAYOUT_METRIC_HARD_KEYS.reduce(
							(sum, key) => sum + Number(metrics[key]),
							0,
						);
						return { crossings: metrics.crossings, hard };
					};
					const row = (
						label: string,
						m: typeof cold,
						diagram: CoordinatedDiagram,
					) => {
						const q = quality(diagram);
						return `${label} shift=${m.meanShift.toFixed(1)}/${m.maxShift.toFixed(0)} moved=${(m.movedShare * 100).toFixed(0)}% order=${(m.orderPreserved * 100).toFixed(1)}% x=${q.crossings} hard=${q.hard}`;
					};
					console.log(
						`${kind.padEnd(12)} ${String(size).padStart(4)} ${edit.padEnd(11)} ${row("cold", cold, coldDiagram)} | ${row("warm", warm, warmDiagram)}`,
					);
				}
			});
		}
	}
});
