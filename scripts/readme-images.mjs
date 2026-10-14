// Renders the README examples into docs/images/: the diagrams in
// examples/readme/*.yaml as SVG, and the scenes in examples/scene/*.yaml as
// top views (the 3D renders come from scripts/scene-renders.mjs).
// Run after `npm run build`: npm run docs:images
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { renderDiagramDsl, renderSceneDsl } from "../dist/index.js";

const yamlIn = (dir) =>
	readdirSync(dir).filter((name) => name.endsWith(".yaml"));

for (const file of yamlIn("examples/readme")) {
	const result = renderDiagramDsl(
		readFileSync(`examples/readme/${file}`, "utf8"),
		{
			format: "svg",
		},
	);
	if (result.content === undefined) {
		throw new Error(
			`${file}: ${result.diagnostics.map((item) => item.message).join("; ")}`,
		);
	}
	writeFileSync(`docs/images/${basename(file, ".yaml")}.svg`, result.content);
	console.log(`docs/images/${basename(file, ".yaml")}.svg`);
}

for (const file of yamlIn("examples/scene")) {
	const result = renderSceneDsl(
		readFileSync(`examples/scene/${file}`, "utf8"),
		{
			format: "svg",
		},
	);
	if (result.content === undefined || result.scene?.valid !== true) {
		throw new Error(
			`${file}: ${result.diagnostics.map((item) => item.message).join("; ")}`,
		);
	}
	const out = `docs/images/scene-${basename(file, ".yaml")}.top.svg`;
	writeFileSync(out, result.content);
	console.log(out);
}
