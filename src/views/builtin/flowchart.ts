import { z } from "zod";
import {
	checkFlow,
	inferStepType,
	itemSchema,
	labelOf,
	NodeResolver,
	relationEdges,
	relationSchema,
	STEP_TYPES,
	type StepType,
	stepNode,
} from "../common.js";
import type { ViewDefinition } from "../types.js";

const schema = z
	.object({
		title: z.string().optional(),
		direction: z.enum(["TB", "LR", "BT", "RL"]).optional(),
		steps: z
			.record(z.string(), itemSchema({ type: z.enum(STEP_TYPES).optional() }))
			.optional(),
		flow: z.array(relationSchema).min(1),
	})
	.strict();

type FlowchartInput = z.infer<typeof schema>;

export const flowchartView: ViewDefinition<FlowchartInput> = {
	id: "flowchart",
	title: "Flowchart",
	summary:
		"A process as steps, decisions and outcomes connected by arrows (top to bottom).",
	schema,
	example: `view: flowchart
title: 报销审批
steps:
  start: 开始
  submit: 提交报销单
  check: 金额超过 5000?
  manager: 部门经理审批
  finance: 财务审核
  pay: { label: 打款, type: io }
  end: 结束
flow:
  - start -> submit -> check
  - check -> manager: 是
  - check -> finance: 否
  - manager -> finance -> pay -> end
`,
	expand(input, context) {
		const types = new Map<string, StepType>();
		const nodes: Record<string, Record<string, unknown>> = {};
		const resolver = new NodeResolver(context, (id) => {
			// Steps written only in the flow: typed from their wording.
			const label = resolver.nodes.get(id) ?? id;
			types.set(id, inferStepType(id, label, undefined));
		});
		for (const [id, item] of Object.entries(input.steps ?? {})) {
			const label = labelOf(id, item);
			resolver.add(id, label);
			types.set(
				id,
				inferStepType(
					id,
					label,
					typeof item === "string" ? undefined : item.type,
				),
			);
		}
		const edges = relationEdges(input.flow, resolver, context, "flow");
		for (const [id, label] of resolver.nodes) {
			nodes[id] = stepNode(label, types.get(id) ?? "step");
		}
		checkFlow(
			context,
			types,
			edges,
			(id) => (input.steps?.[id] === undefined ? ["flow"] : ["steps", id]),
			(id) => resolver.name(id),
		);
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			layout: { direction: input.direction ?? "TB", mode: "global" },
			nodes,
			edges,
		};
	},
};
