import type { DslDiagnostic, ParseDiagramDslOptions } from "../dsl/types.js";
import { parseSceneDsl } from "./dsl.js";
import { sceneToBlenderScript } from "./export/blender.js";
import { sceneToGlb, sceneToGltf } from "./export/gltf.js";
import { sceneToJson } from "./export/json.js";
import type { SceneDiagnostic, SolvedScene } from "./ir.js";
import { solveScene } from "./solve.js";
import { sceneTopViewSvg } from "./top-view.js";

export type SceneOutputFormat =
	| "scene-json"
	| "blender"
	| "svg"
	| "gltf"
	| "glb";

export const SCENE_OUTPUT_FORMATS: readonly SceneOutputFormat[] = [
	"scene-json",
	"blender",
	"svg",
	"gltf",
	"glb",
];

export interface RenderSceneDslOptions extends ParseDiagramDslOptions {
	/**
	 * scene-json (default), blender (a bpy script), svg (a top view), gltf
	 * (glTF 2.0 JSON) or glb (binary glTF).
	 */
	format?: string;
}

export interface RenderSceneDslResult {
	scene?: SolvedScene;
	format?: SceneOutputFormat;
	/**
	 * The output, also when the scene is invalid (it then shows what is
	 * wrong); absent when the document itself does not validate, and for
	 * glb, which is `bytes` instead.
	 */
	content?: string;
	/** The glb file, under the same conditions. */
	bytes?: Uint8Array;
	diagnostics: DslDiagnostic[];
}

/** Parse, solve and export a `scene:` document in one call. */
export function renderSceneDsl(
	source: string,
	options: RenderSceneDslOptions = {},
): RenderSceneDslResult {
	const format = (options.format ?? "scene-json") as SceneOutputFormat;
	if (!SCENE_OUTPUT_FORMATS.includes(format)) {
		return {
			diagnostics: [
				{
					severity: "error",
					layer: "export",
					code: "export.scene.format",
					message: `Unknown scene output format "${options.format}".`,
					hint: `Use ${SCENE_OUTPUT_FORMATS.join(", ")}.`,
				},
			],
		};
	}
	const parsed = parseSceneDsl(source, options);
	if (parsed.scene === undefined) return { diagnostics: parsed.diagnostics };
	const scene = solveScene(parsed.scene);
	const output =
		format === "glb"
			? { bytes: sceneToGlb(scene) }
			: { content: sceneText(scene, format) };
	return {
		scene,
		format,
		...output,
		diagnostics: [
			...parsed.diagnostics,
			...scene.diagnostics.map(toDslDiagnostic),
		],
	};
}

function sceneText(scene: SolvedScene, format: SceneOutputFormat): string {
	switch (format) {
		case "blender":
			return sceneToBlenderScript(scene);
		case "svg":
			return sceneTopViewSvg(scene);
		case "gltf":
			return sceneToGltf(scene);
		default:
			return sceneToJson(scene);
	}
}

function toDslDiagnostic(diagnostic: SceneDiagnostic): DslDiagnostic {
	const detail = {
		...(diagnostic.objects === undefined
			? {}
			: { objects: diagnostic.objects }),
		...diagnostic.detail,
	};
	return {
		severity: diagnostic.severity,
		layer: "solve",
		code: diagnostic.code,
		message: diagnostic.message,
		...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
		...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
		...(Object.keys(detail).length === 0 ? {} : { detail }),
	};
}
