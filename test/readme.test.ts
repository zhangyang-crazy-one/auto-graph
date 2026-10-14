import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import { renderSceneDsl } from "../src/scene/index.js";

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
		].filter((pair) => !pair[2]?.startsWith("scene-"));
		const scenes = [
			...text.matchAll(
				/```yaml\n((?:(?!```)[\s\S])*?)```\s*<\/td>\s*<td>\s*<img src="docs\/images\/scene-([\w-]+)\.top\.svg"/g,
			),
		];

		it(`${readme} shows the scene examples`, () => {
			expect(scenes.map((pair) => pair[2])).toEqual(["study"]);
			for (const name of ["study", "meeting", "showroom"]) {
				expect(text).toContain(`docs/images/scene-${name}.jpg`);
			}
		});

		for (const [, code, name] of scenes) {
			it(`${readme}: scene ${name} matches examples/scene/${name}.yaml`, () => {
				const source = readFileSync(
					new URL(`../examples/scene/${name}.yaml`, import.meta.url),
					"utf8",
				);
				expect(code).toBe(source);
				const result = renderSceneDsl(source);
				expect(result.scene?.valid).toBe(true);
				expect(
					result.diagnostics.filter((item) => item.severity !== "info"),
				).toEqual([]);
			});
		}

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
