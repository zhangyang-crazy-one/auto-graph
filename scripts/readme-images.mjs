// Renders the README examples (examples/readme/*.yaml) into docs/images/.
// Run after `npm run build`: npm run docs:images
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { renderDiagramDsl } from "../dist/index.js";

for (const file of readdirSync("examples/readme").filter((name) =>
	name.endsWith(".yaml"),
)) {
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
