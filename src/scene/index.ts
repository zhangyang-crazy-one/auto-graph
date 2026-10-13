export type { NormalizeSceneDslResult, SceneDsl } from "./dsl.js";
export {
	isSceneDocument,
	normalizeSceneDsl,
	parseSceneDsl,
	sceneDslSchema,
} from "./dsl.js";
export type * from "./ir.js";
export { solveScene } from "./solve.js";
export type { SceneTopViewOptions } from "./top-view.js";
export { sceneTopViewSvg } from "./top-view.js";
