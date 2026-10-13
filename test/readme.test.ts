import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";

/**
 * Every picture in the READMEs sits beside the YAML that drew it. The YAML
 * shown must be the example file the picture is rendered from
 * (`npm run docs:images`), and it must render cleanly.
 */
const READMES = [
	["README.md", "en"],
	["README.zh-CN.md", "zh"],
] as const;

describe("README examples", () => {
	for (const [readme, lang] of READMES) {
		const text = readFileSync(new URL(`../${readme}`, import.meta.url), "utf8");
		const pairs = [
			...text.matchAll(
				/```yaml\n([\s\S]*?)```\s*<\/td>\s*<td>\s*<img src="docs\/images\/([\w-]+)\.(\w+)\.svg"/g,
			),
		];

		it(`${readme} pairs every picture with its YAML`, () => {
			expect(pairs.map((pair) => pair[2])).toEqual([
				"swimlane",
				"architecture",
				"sequence",
			]);
		});

		for (const [, code, name, pictureLang] of pairs) {
			it(`${readme}: ${name} matches examples/readme/${name}.${lang}.yaml`, () => {
				expect(pictureLang).toBe(lang);
				const source = readFileSync(
					new URL(`../examples/readme/${name}.${lang}.yaml`, import.meta.url),
					"utf8",
				);
				expect(code).toBe(source);
				const result = renderDiagramDsl(source);
				expect(result.diagram).toBeDefined();
				expect(
					result.diagnostics.filter(
						(item) => item.severity === "error" || item.severity === "warning",
					),
				).toEqual([]);
			});
		}
	}
});
