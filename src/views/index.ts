import { architectureView } from "./builtin/architecture.js";
import { flowchartView } from "./builtin/flowchart.js";
import { stateView } from "./builtin/state.js";
import { swimlaneView } from "./builtin/swimlane.js";
import { systemContextView } from "./builtin/system-context.js";
import { treeView } from "./builtin/tree.js";
import { registerView } from "./registry.js";

export {
	closest,
	inferStepType,
	itemSchema,
	labelOf,
	NodeResolver,
	parseRelation,
	relationEdges,
	relationSchema,
	STEP_TYPES,
	type StepType,
	stepNode,
} from "./common.js";
export {
	expandView,
	getView,
	isViewDocument,
	listViews,
	registerView,
	viewJsonSchema,
} from "./registry.js";
export type * from "./types.js";

export {
	architectureView,
	flowchartView,
	stateView,
	swimlaneView,
	systemContextView,
	treeView,
};

registerView(flowchartView, { replace: true });
registerView(swimlaneView, { replace: true });
registerView(architectureView, { replace: true });
registerView(systemContextView, { replace: true });
registerView(stateView, { replace: true });
registerView(treeView, { replace: true });
