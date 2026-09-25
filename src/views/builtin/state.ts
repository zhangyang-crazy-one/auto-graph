import { z } from "zod";
import {
	itemSchema,
	labelOf,
	NodeResolver,
	parseRelation,
	type RelationInput,
	reachable,
	relationEdges,
	relationSchema,
} from "../common.js";
import type { ViewDefinition } from "../types.js";

const STATE_TYPES = ["state", "choice", "final"] as const;

const schema = z
	.object({
		title: z.string().optional(),
		direction: z.enum(["LR", "TB"]).optional(),
		states: z
			.record(z.string(), itemSchema({ type: z.enum(STATE_TYPES).optional() }))
			.optional(),
		initial: z.string().optional(),
		transitions: z.array(relationSchema).min(1),
	})
	.strict();

type StateInput = z.infer<typeof schema>;

/** `[*]` is the initial pseudo-state as a source and a final one as a target. */
const PSEUDO = "[*]";
const INITIAL_ID = "__initial";
const FINAL_ID = "__final";

export const stateView: ViewDefinition<StateInput> = {
	id: "state",
	title: "State machine",
	summary:
		"The states of one thing (an order, a ticket, a device) and the events that move it between them.",
	schema,
	example: `view: state
title: 订单状态
states:
  created: 待支付
  paid: 已支付
  shipped: 已发货
  done: { label: 已完成, type: final }
  cancelled: { label: 已取消, type: final }
transitions:
  - "[*] -> created"
  - created -> paid: 支付成功
  - created -> cancelled: 超时 / 取消
  - paid -> shipped: 发货
  - shipped -> done: 确认收货
`,
	expand(input, context) {
		const nodes: Record<string, Record<string, unknown>> = {};
		const resolver = new NodeResolver(context, (id) => {
			nodes[id] = {
				label: resolver.nodes.get(id) ?? id,
				shape: "rounded-rectangle",
			};
		});
		const finals = new Set<string>();
		for (const [id, item] of Object.entries(input.states ?? {})) {
			const label = labelOf(id, item);
			const type = typeof item === "string" ? "state" : (item.type ?? "state");
			resolver.add(id, label);
			if (type === "final") finals.add(id);
			nodes[id] =
				type === "choice"
					? { label, role: "decision" }
					: {
							label,
							shape: "rounded-rectangle",
							...(type === "final"
								? { style: { stroke: "#111827", fill: "#e5e7eb" } }
								: {}),
						};
		}

		// Rewrite `[*]` ends to the initial / final pseudo-states.
		let usesInitial = input.initial !== undefined;
		let usesFinal = false;
		const rewritten: RelationInput[] = input.transitions.map((relation) => {
			const hops = parseRelation(relation);
			if (hops === undefined) return relation;
			const text = (
				typeof relation === "string"
					? relation
					: (Object.keys(relation)[0] as string)
			).replace(/\[\*\]/g, (_match, offset: number, whole: string) => {
				const before = whole.slice(0, offset);
				if (/(-\.->|-->|->)\s*$/.test(before)) {
					usesFinal = true;
					return FINAL_ID;
				}
				usesInitial = true;
				return INITIAL_ID;
			});
			return typeof relation === "string"
				? text
				: { [text]: Object.values(relation)[0] as string };
		});
		// Pseudo-states are drawn as terminals in the diagram's language
		// (every ellipse is a circle of at least the minimum node size, so a
		// bare UML dot would be a large empty circle).
		const chinese = [...resolver.nodes.values()].some((label) =>
			/[\u3400-\u9fff]/.test(label),
		);
		if (usesInitial) {
			resolver.add(INITIAL_ID, PSEUDO);
			nodes[INITIAL_ID] = { label: chinese ? "开始" : "Start", role: "start" };
		}
		if (usesFinal) {
			resolver.add(FINAL_ID, `${PSEUDO} end`);
			nodes[FINAL_ID] = { label: chinese ? "结束" : "End", role: "end" };
		}
		const edges = relationEdges(rewritten, resolver, context, "transitions");
		if (input.initial !== undefined) {
			const first = resolver.resolve(input.initial, ["initial"]);
			if (first !== undefined)
				edges.unshift({ sourceId: INITIAL_ID, targetId: first });
		}

		if (!usesInitial) {
			context.info(
				["transitions"],
				"view.state.no-initial",
				"No initial state.",
				'Mark where the machine starts: `initial: <state>` or a transition "[*] -> <state>".',
			);
		} else {
			const seen = reachable([INITIAL_ID], edges);
			for (const id of resolver.nodes.keys()) {
				if (id === FINAL_ID || seen.has(id)) continue;
				context.warn(
					input.states?.[id] === undefined ? ["transitions"] : ["states", id],
					"view.state.unreachable",
					`State "${id}" cannot be reached from the initial state.`,
					"Add the transition that leads into it, or remove it.",
				);
			}
		}
		for (const id of finals) {
			if (edges.some((edge) => edge.sourceId === id)) {
				context.warn(
					["states", id],
					"view.state.final-has-exit",
					`Final state "${id}" has outgoing transitions.`,
					"A final state ends the machine; drop `type: final` or its transitions.",
				);
			}
		}
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			layout: { direction: input.direction ?? "LR", mode: "global" },
			nodes,
			edges,
		};
	},
};
