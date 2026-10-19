import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run.js";
import {
	parseSceneDsl,
	renderSceneDsl,
	type SceneDocument,
	sceneToJson,
	sceneToUsda,
	solveScene,
} from "../src/index.js";
import { sceneSource } from "./support/scene-files.js";

const FIXTURES = [
	"study",
	"study-pinned",
	"study-broken",
	"meeting",
	"showroom",
	"study-paths",
	"office",
	"storeroom",
	"park",
	"hillside",
	"windfarm",
	"solar",
	"streetlights",
];

function solved(source: string) {
	const parsed = parseSceneDsl(source);
	if (parsed.scene === undefined) throw new Error("does not parse");
	return solveScene(parsed.scene);
}

/** The lines of the prim that carries `dge_id` `id`, up to its first child. */
function primOf(usda: string, id: string): string {
	const at = usda.indexOf(
		`custom string userProperties:dge_id = ${JSON.stringify(id)}`,
	);
	expect(at, id).toBeGreaterThan(0);
	return usda.slice(at, usda.indexOf("def ", at));
}

function numbers(text: string): number[] {
	return (text.match(/-?[\d.]+(?:e[-+]?\d+)?/g) ?? []).map(Number);
}

const ASSETS = [
	"scene: kit",
	"bounds: { width: 4, depth: 3, height: 2.5 }",
	"objects:",
	"  sofa: { size: [2, 0.9, 0.8], front: -y, asset: sofa-v2 }",
	"  lamp: { size: [0.3, 0.3, 1.5] }",
	"relations:",
	"  - sofa against wall north",
	"  - lamp right-of sofa, gap 0.2",
].join("\n");

describe("USD export", () => {
	it("writes a z-up stage in metres with the scene's numbers", () => {
		const scene = solved(sceneSource("study"));
		const usda = sceneToUsda(scene);
		expect(usda).toMatch(/^#usda 1\.0\n/);
		expect(usda).toContain('upAxis = "Z"');
		expect(usda).toContain("metersPerUnit = 1");
		expect(usda).toContain('defaultPrim = "study"');
		const document = JSON.parse(sceneToJson(scene)) as SceneDocument;
		for (const item of document.objects) {
			const prim = primOf(usda, item.id);
			const translate = /double3 xformOp:translate = (\(.*\))/.exec(prim)?.[1];
			expect(numbers(translate ?? "")).toEqual(item.position);
			const orient = /quatd xformOp:orient = (\(.*\))/.exec(prim)?.[1];
			const [w, x, y, z] = numbers(orient ?? "");
			const [qx, qy, qz, qw] = item.quaternion;
			const norm = Math.hypot(qx, qy, qz, qw);
			[x, y, z, w].forEach((value, k) => {
				expect(value).toBeCloseTo(([qx, qy, qz, qw][k] as number) / norm, 9);
			});
			expect(prim).toContain(
				`custom string userProperties:dge_front = "${item.front}"`,
			);
		}
	});

	it("time-samples each agent along its path", () => {
		const usda = sceneToUsda(solved(sceneSource("study-paths")));
		expect(usda).toContain("timeCodesPerSecond = 24");
		expect(usda).toMatch(/double dge_time_origin = /);
		expect(usda).toContain("double3 xformOp:translate.timeSamples = {");
	});

	it("puts terrain, lines, waypoints and landmarks in", () => {
		const usda = sceneToUsda(solved(sceneSource("hillside")));
		expect(usda).toContain('def Xform "terrain"');
		expect(usda).toContain('def Xform "lines"');
		expect(usda).toContain('def Xform "waypoints"');
		expect(usda).toContain('def Points "markers"');
		expect(usda).toContain("double3 dge_geo_origin = ");
		expect(sceneToUsda(solved(sceneSource("park")))).toContain(
			'def Xform "landmarks"',
		);
	});

	it("makes ids into unique prim names and keeps the ids", () => {
		const usda = sceneToUsda(
			solved(
				[
					"scene: my room-1",
					"bounds: { width: 6, depth: 2, height: 2 }",
					"objects:",
					"  a-b: { size: [0.5, 0.5, 0.5], position: [0.5, 1] }",
					"  a_b: { size: [0.5, 0.5, 0.5], position: [1.5, 1] }",
				].join("\n"),
			),
		);
		expect(usda).toContain('defaultPrim = "my_room_1"');
		expect(usda).toContain('def Xform "a_b"');
		expect(usda).toContain('def Xform "a_b_2"');
		expect(usda).toContain('userProperties:dge_id = "a-b"');
		expect(usda).toContain('userProperties:dge_id = "a_b"');
	});

	it("references assets through a geometry variant set", () => {
		const scene = solved(ASSETS);
		const plain = sceneToUsda(scene);
		expect(plain).not.toContain("variantSet");
		expect(plain).toContain('userProperties:dge_asset = "sofa-v2"');
		const usda = sceneToUsda(scene, { assetPath: "./assets/{asset}.usda" });
		expect(usda).toContain("prepend references = @./assets/sofa-v2.usda@");
		expect(usda).toContain('variants = { string geometry = "asset" }');
		expect(usda).toContain('"placeholder" {');
		// Only objects that name an asset get the variant set.
		expect(usda.match(/prepend variantSets/g)).toHaveLength(1);
	});

	it("is byte-stable", () => {
		expect(sceneToUsda(solved(sceneSource("windfarm")))).toBe(
			sceneToUsda(solved(sceneSource("windfarm"))),
		);
	});

	it("comes out of renderSceneDsl and the CLI", async () => {
		const result = renderSceneDsl(ASSETS, {
			format: "usda",
			assetPath: "assets/{asset}.usd",
		});
		expect(result.content).toContain("@assets/sofa-v2.usd@");
		const run = async (args: string[]) => {
			let stdout = "";
			let stderr = "";
			const sink = (write: (text: string) => void) =>
				new Writable({
					write(chunk, _encoding, callback) {
						write(chunk.toString());
						callback();
					},
				});
			const code = await runCli(args, {
				stdin: Readable.from([ASSETS]),
				stdout: sink((text) => {
					stdout += text;
				}),
				stderr: sink((text) => {
					stderr += text;
				}),
			});
			return { code, stdout, stderr };
		};
		const usda = await run([
			"--format",
			"usda",
			"--asset-path",
			"a/{asset}.usd",
		]);
		expect(usda.code).toBe(0);
		expect(usda.stdout).toContain("@a/sofa-v2.usd@");
		const wrong = await run([
			"--format",
			"glb",
			"--asset-path",
			"a/{asset}.usd",
		]);
		expect(wrong.code).toBe(2);
		expect(wrong.stderr).toContain("io.scene-option");
	});

	// Opens every fixture with the USD library and runs its validators, then
	// compares transforms, boxes and agent times with the JSON. Needs a
	// Python with usd-core: DGE_USD_PYTHON=/path/to/python
	const usd = process.env.DGE_USD_PYTHON;
	const check = (
		python: string,
		script: string,
		usda: string,
		json: string,
		assets?: string,
	) => {
		const dir = mkdtempSync(join(tmpdir(), "dge-usd-"));
		try {
			writeFileSync(join(dir, "scene.usda"), usda);
			writeFileSync(join(dir, "scene.json"), json);
			if (assets !== undefined) {
				mkdirSync(join(dir, "assets"));
				writeFileSync(join(dir, "assets", assets), ASSET_LAYER);
			}
			const output = execFileSync(
				python,
				[
					new URL(`./support/${script}`, import.meta.url).pathname,
					join(dir, "scene.usda"),
					join(dir, "scene.json"),
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			);
			return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	it.skipIf(usd === undefined).each(FIXTURES)(
		"%s opens in USD with no validation errors, exactly as solved",
		(name) => {
			const scene = solved(sceneSource(name));
			const result = check(
				usd as string,
				"usd_check.py",
				sceneToUsda(scene),
				sceneToJson(scene),
			);
			expect(result.problems).toEqual([]);
			expect(result.objects).toBe(scene.objects.length);
			expect(result.agents).toBe(
				scene.paths.filter((path) => path.times.length > 0).length,
			);
		},
		60_000,
	);
	it.skipIf(usd === undefined)(
		"loads a referenced asset in USD",
		() => {
			const scene = solved(ASSETS);
			const result = check(
				usd as string,
				"usd_check.py",
				sceneToUsda(scene, { assetPath: "./assets/{asset}.usda" }),
				sceneToJson(scene),
				"sofa-v2.usda",
			);
			expect(result.problems).toEqual([]);
		},
		60_000,
	);

	// Imports every fixture with Blender's USD importer: DGE_BLENDER_PYTHON.
	const blender = process.env.DGE_BLENDER_PYTHON;
	it.skipIf(blender === undefined).each(FIXTURES)(
		"%s imports into Blender exactly as solved",
		(name) => {
			const scene = solved(sceneSource(name));
			const result = check(
				blender as string,
				"usd_blender_check.py",
				sceneToUsda(scene),
				sceneToJson(scene),
			);
			expect(result.problems).toEqual([]);
			expect(result.objects).toBe(scene.objects.length);
		},
		120_000,
	);
});

const ASSET_LAYER = `#usda 1.0
(
    defaultPrim = "model"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "model"
{
    def Cube "body"
    {
        double size = 1
    }
}
`;
