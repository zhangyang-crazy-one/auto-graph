import { describe, expect, it } from "vitest";
import {
	canonicalize,
	DEFAULT_CANONICAL_PRECISION,
	stringifyCanonical,
} from "../src/index.js";

describe("canonical serialization", () => {
	it("serializes equivalent diagrams byte-identically", () => {
		const first = {
			edges: [
				{
					targetId: "node-a",
					sourceId: "node-b",
					id: "edge-b-a",
					points: [
						{ y: 0, x: 10 },
						{ y: 0, x: 0 },
					],
				},
				{ targetId: "node-b", sourceId: "node-a", id: "edge-a-b" },
			],
			nodes: [
				{
					anchors: [
						{ point: { y: 20, x: 10 }, id: "south" },
						{ point: { y: 0, x: 10 }, id: "north" },
					],
					box: { height: 60, width: 120, y: -0, x: 2.1239 },
					id: "node-b",
				},
				{ id: "node-a", box: { y: 0, x: 0, width: 80, height: 40 } },
			],
			groups: [{ id: "group-b" }, { id: "group-a" }],
			constraints: [
				{ kind: "containment", id: "constraint-b", groupId: "group-b" },
				{ kind: "exact-position", id: "constraint-a", targetId: "node-a" },
			],
			diagnostics: [
				{ id: "diagnostic-b", kind: "warning" },
				{ id: "diagnostic-a", kind: "info" },
			],
		};
		const second = {
			constraints: [
				{ targetId: "node-a", id: "constraint-a", kind: "exact-position" },
				{ groupId: "group-b", id: "constraint-b", kind: "containment" },
			],
			diagnostics: [
				{ kind: "info", id: "diagnostic-a" },
				{ kind: "warning", id: "diagnostic-b" },
			],
			groups: [{ id: "group-a" }, { id: "group-b" }],
			nodes: [
				{ box: { height: 40, width: 80, x: 0, y: 0 }, id: "node-a" },
				{
					id: "node-b",
					box: { x: 2.124, y: 0, width: 120, height: 60 },
					anchors: [
						{ id: "north", point: { x: 10, y: 0 } },
						{ id: "south", point: { x: 10, y: 20 } },
					],
				},
			],
			edges: [
				{ id: "edge-a-b", sourceId: "node-a", targetId: "node-b" },
				{
					id: "edge-b-a",
					sourceId: "node-b",
					targetId: "node-a",
					points: [
						{ x: 10, y: 0 },
						{ x: 0, y: 0 },
					],
				},
			],
		};

		const output = stringifyCanonical(first);

		expect(output).toBe(stringifyCanonical(second));
		expect(output.indexOf('"constraints"')).toBeLessThan(
			output.indexOf('"edges"'),
		);
		expect(output.indexOf('"node-a"')).toBeLessThan(output.indexOf('"node-b"'));
		expect(output.indexOf('"edge-a-b"')).toBeLessThan(
			output.indexOf('"edge-b-a"'),
		);
	});

	it("rounds finite numbers to the default precision", () => {
		expect(DEFAULT_CANONICAL_PRECISION).toBe(3);
		expect(stringifyCanonical({ x: 2.1239 })).toContain('"x": 2.124');
	});

	it("normalizes negative zero", () => {
		expect(stringifyCanonical({ x: -0 })).toContain('"x": 0');
	});

	it("omits undefined object properties", () => {
		expect(canonicalize({ id: "node-a", label: undefined })).toEqual({
			id: "node-a",
		});
		expect(
			stringifyCanonical({ id: "node-a", label: undefined }),
		).not.toContain("label");
	});

	it("rejects non-finite numbers", () => {
		expect(() => stringifyCanonical({ x: Number.NaN })).toThrow(
			/Non-finite number/,
		);
		expect(() => stringifyCanonical({ x: Number.POSITIVE_INFINITY })).toThrow(
			/Non-finite number/,
		);
		expect(() => stringifyCanonical({ x: Number.NEGATIVE_INFINITY })).toThrow(
			/Non-finite number/,
		);
	});

	it("preserves semantic point sequence order", () => {
		const route = {
			edges: [
				{
					id: "edge-a-b",
					sourceId: "node-a",
					targetId: "node-b",
					points: [
						{ x: 10, y: 0 },
						{ x: 0, y: 0 },
					],
				},
			],
		};

		expect(canonicalize(route)).toMatchObject({
			edges: [
				{
					points: [
						{ x: 10, y: 0 },
						{ x: 0, y: 0 },
					],
				},
			],
		});
		expect(stringifyCanonical(route).indexOf('"x": 10')).toBeLessThan(
			stringifyCanonical(route).indexOf('"x": 0'),
		);
	});

	it("sorts unordered anchors by anchor name", () => {
		const first = {
			nodes: [
				{
					id: "node-a",
					anchors: [
						{ name: "right", point: { x: 80, y: 20 } },
						{ name: "left", point: { x: 0, y: 20 } },
					],
				},
			],
		};
		const second = {
			nodes: [
				{
					id: "node-a",
					anchors: [
						{ name: "left", point: { x: 0, y: 20 } },
						{ name: "right", point: { x: 80, y: 20 } },
					],
				},
			],
		};
		const output = stringifyCanonical(first);

		expect(output).toBe(stringifyCanonical(second));
		expect(output.indexOf('"left"')).toBeLessThan(output.indexOf('"right"'));
	});

	it("keeps evidence block collections deterministic without reordering semantic internals", () => {
		const diagram = {
			matrices: [
				{
					id: "z-verification-matrix",
					rows: ["verify-a", "verify-b"],
					cols: ["requirement", "function"],
					cells: [
						[{ text: "case-a" }, { text: "pass" }],
						[{ text: "case-b" }, { text: "watch" }],
					],
				},
				{
					id: "a-traceability-matrix",
					rows: ["need-b", "need-a"],
					cols: ["function-b", "function-a"],
					cells: [
						[{ text: "b-b" }, { text: "b-a" }],
						[{ text: "a-b" }, { text: "a-a" }],
					],
				},
			],
			tables: [
				{
					id: "z-params",
					columns: [
						{ id: "parameter", label: { text: "Parameter" } },
						{ id: "source", label: { text: "Source" } },
					],
					rows: [
						{
							id: "row-b",
							cells: { parameter: { text: "mass_kg" } },
						},
						{
							id: "row-a",
							cells: { parameter: { text: "power_w" } },
						},
					],
				},
			],
			evidencePanels: [
				{
					id: "z-note",
					kind: "note",
					items: [
						{ id: "second", label: { text: "Second" } },
						{ id: "first", label: { text: "First" } },
					],
				},
				{
					id: "a-rule",
					kind: "rule",
					items: [{ id: "rule-1", label: { text: "Rule" } }],
				},
			],
		};

		const output = stringifyCanonical(diagram);

		expect(output.indexOf("a-traceability-matrix")).toBeLessThan(
			output.indexOf("z-verification-matrix"),
		);
		expect(output.indexOf("need-b")).toBeLessThan(output.indexOf("need-a"));
		expect(output.indexOf("function-b")).toBeLessThan(
			output.indexOf("function-a"),
		);
		expect(output.indexOf("b-b")).toBeLessThan(output.indexOf("a-a"));
		expect(output.indexOf("row-b")).toBeLessThan(output.indexOf("row-a"));
		expect(output.indexOf("parameter")).toBeLessThan(output.indexOf("source"));
		expect(output.indexOf("a-rule")).toBeLessThan(output.indexOf("z-note"));
		expect(output.indexOf("second")).toBeLessThan(output.indexOf("first"));
	});

	it("rejects invalid precision values", () => {
		for (const precision of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
			expect(() => canonicalize({ x: 1.23 }, { precision })).toThrow(
				/Canonical precision/,
			);
			expect(() => stringifyCanonical({ x: 1.23 }, precision)).toThrow(
				/Canonical precision/,
			);
		}
	});
});
