// Renders the scene examples (examples/scene/*.yaml) in Blender into
// docs/images/scene-<name>.jpg. Needs a Python with the bpy module
// (`pip install bpy`): DGE_BLENDER_PYTHON=/path/to/python npm run docs:scene-renders
// Run after `npm run build`.
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { renderSceneDsl } from "../dist/index.js";

const python = process.env.DGE_BLENDER_PYTHON;
if (python === undefined) {
	console.error("Set DGE_BLENDER_PYTHON to a Python with the bpy module.");
	process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), "dge-renders-"));
try {
	for (const file of readdirSync("examples/scene").filter((name) =>
		name.endsWith(".yaml"),
	)) {
		const name = basename(file, ".yaml");
		const script = join(dir, `${name}.py`);
		const result = renderSceneDsl(
			readFileSync(`examples/scene/${file}`, "utf8"),
			{
				format: "blender",
			},
		);
		if (result.content === undefined) throw new Error(`${file} did not solve`);
		writeFileSync(script, result.content);
		const out = resolve(`docs/images/scene-${name}.jpg`);
		execFileSync(
			python,
			[script, "--", "--render", out, "--size", "800x600", "--samples", "16"],
			{ stdio: "ignore" },
		);
		console.log(`docs/images/scene-${name}.jpg`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
