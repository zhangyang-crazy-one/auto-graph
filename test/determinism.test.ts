import { describe, expect, it } from "vitest";
import type { NormalizedDiagram } from "../src/ir/index.js";
import { stringifyCanonical } from "../src/serialization/index.js";
import { solveDiagram } from "../src/solver/index.js";

describe("solver determinism", () => {
	it("serializes repeated solveDiagram output byte-identically", () => {
		const input: NormalizedDiagram = {
			id: "deterministic",
			direction: "TB",
			nodes: [node("b"), node("a", { x: 0, y: 0 }), node("c")],
			edges: [
				{ id: "a-b", source: { nodeId: "a" }, target: { nodeId: "b" } },
				{ id: "b-c", source: { nodeId: "b" }, target: { nodeId: "c" } },
			],
			groups: [],
			constraints: [
				{
					kind: "relative-position",
					sourceId: "b",
					referenceId: "a",
					relation: "below",
					offset: { x: 0, y: 80 },
				},
				{
					kind: "relative-position",
					sourceId: "c",
					referenceId: "b",
					relation: "below",
					offset: { x: 0, y: 80 },
				},
			],
			diagnostics: [],
		};

		expect(stringifyCanonical(solveDiagram(input))).toBe(
			stringifyCanonical(solveDiagram(input)),
		);
	});
});

function node(id: string, position?: { x: number; y: number }) {
	return {
		id,
		shape: "rectangle" as const,
		size: { width: 80, height: 40 },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		...(position === undefined ? {} : { position }),
	};
}
