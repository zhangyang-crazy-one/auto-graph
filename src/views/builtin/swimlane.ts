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

const stepSchema = itemSchema({ type: z.enum(STEP_TYPES).optional() });

const schema = z
	.object({
		title: z.string().optional(),
		direction: z.enum(["LR", "TB"]).optional(),
		lanes: z
			.record(
				z.string(),
				z.union([
					z.string(),
					z
						.object({
							label: z.string().optional(),
							steps: z.record(z.string(), stepSchema).optional(),
						})
						.strict(),
				]),
			)
			.refine(
				(lanes) => Object.keys(lanes).length > 0,
				"Add at least one lane.",
			),
		steps: z
			.record(
				z.string(),
				z.union([
					z.string(),
					z.object({
						label: z.string().optional(),
						type: z.enum(STEP_TYPES).optional(),
						lane: z.string(),
					}),
				]),
			)
			.optional(),
		flow: z.array(relationSchema).min(1),
	})
	.strict();

type SwimlaneInput = z.infer<typeof schema>;

export const swimlaneView: ViewDefinition<SwimlaneInput> = {
	id: "swimlane",
	title: "Swimlane process",
	summary:
		"A cross-team process: each lane is a role or system, steps sit in the lane that performs them.",
	schema,
	example: `view: swimlane
title: 订单履约
lanes:
  customer:
    label: 客户
    steps: { order: 下单, pay: 付款, receive: 收货 }
  shop:
    label: 商家
    steps: { check: 库存充足?, ship: 发货 }
  bank:
    label: 银行
    steps: { charge: 扣款, refund: 退款 }
flow:
  - order -> check
  - check -> pay: 是
  - check -> refund: 否
  - pay -> charge -> ship -> receive
`,
	expand(input, context) {
		const types = new Map<string, StepType>();
		const laneOf = new Map<string, string>();
		const where = new Map<string, (string | number)[]>();
		const resolver = new NodeResolver(context);
		const addStep = (
			id: string,
			item:
				| string
				| { label?: string | undefined; type?: StepType | undefined },
			lane: string,
			path: (string | number)[],
		) => {
			if (laneOf.has(id)) {
				context.error(
					path,
					"view.swimlane.duplicate-step",
					`Step "${id}" is declared in lanes "${laneOf.get(id)}" and "${lane}".`,
					"Give each step one lane; use a new id for a second step.",
				);
				return;
			}
			const label = labelOf(id, item);
			resolver.add(id, label);
			laneOf.set(id, lane);
			where.set(id, path);
			types.set(
				id,
				inferStepType(
					id,
					label,
					typeof item === "string" ? undefined : item.type,
				),
			);
		};
		for (const [laneId, lane] of Object.entries(input.lanes)) {
			if (typeof lane === "string") continue;
			for (const [id, item] of Object.entries(lane.steps ?? {})) {
				addStep(id, item, laneId, ["lanes", laneId, "steps", id]);
			}
		}
		for (const [id, item] of Object.entries(input.steps ?? {})) {
			const path = ["steps", id];
			if (typeof item === "string") {
				// Known to the flow, so the only error is the missing lane.
				resolver.add(id, item);
				context.error(
					path,
					"view.swimlane.step-without-lane",
					`Step "${id}" has no lane.`,
					`Write it inside a lane (lanes.<lane>.steps.${id}) or as { label: ..., lane: <lane> }.`,
				);
				continue;
			}
			if (input.lanes[item.lane] === undefined) {
				resolver.add(id, labelOf(id, item));
				context.error(
					[...path, "lane"],
					"view.swimlane.unknown-lane",
					`Step "${id}" names unknown lane "${item.lane}".`,
					`Lanes: ${Object.keys(input.lanes).join(", ")}.`,
				);
				continue;
			}
			addStep(id, item, item.lane, path);
		}

		const edges = relationEdges(input.flow, resolver, context, "flow");
		const direction = input.direction ?? "LR";
		const lanes: Record<string, { label: string; children: string[] }> = {};
		for (const [laneId, lane] of Object.entries(input.lanes)) {
			const children = [...laneOf]
				.filter(([, l]) => l === laneId)
				.map(([id]) => id);
			if (children.length === 0) {
				context.warn(
					["lanes", laneId],
					"view.swimlane.empty-lane",
					`Lane "${laneId}" has no steps.`,
					"Add the steps this role performs, or remove the lane.",
				);
			}
			lanes[laneId] = {
				label: typeof lane === "string" ? lane : (lane.label ?? laneId),
				children,
			};
		}
		const nodes: Record<string, Record<string, unknown>> = {};
		for (const [id, label] of resolver.nodes) {
			nodes[id] = stepNode(label, types.get(id) ?? "step");
		}
		checkFlow(context, types, edges, (id) => where.get(id) ?? ["flow"]);
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			layout: { direction, mode: "global" },
			swimlanes: {
				process: {
					...(input.title === undefined ? {} : { label: input.title }),
					layout: "contract",
					orientation: direction === "LR" ? "horizontal" : "vertical",
					lanes,
				},
			},
			nodes,
			edges,
		};
	},
};
