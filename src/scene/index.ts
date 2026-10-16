export type { NormalizeSceneDslResult, SceneDsl } from "./dsl.js";
export {
	isSceneDocument,
	normalizeSceneDsl,
	parseSceneDsl,
	sceneDslSchema,
} from "./dsl.js";
export { sceneToBlenderScript } from "./export/blender.js";
export type { SceneDocument } from "./export/json.js";
export {
	sceneDocumentSchema,
	sceneJsonSchema,
	sceneToDocument,
	sceneToJson,
} from "./export/json.js";
export * as geo from "./geo/index.js";
export type * from "./ir.js";
export type {
	RenderSceneDslOptions,
	RenderSceneDslResult,
	SceneOutputFormat,
} from "./render.js";
export { renderSceneDsl, SCENE_OUTPUT_FORMATS } from "./render.js";
export { solveScene } from "./solve.js";
export * as terrain from "./terrain/index.js";
export type { SceneTopViewOptions } from "./top-view.js";
export { sceneTopViewSvg } from "./top-view.js";
