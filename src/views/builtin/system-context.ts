import { z } from "zod";
import {
	itemSchema,
	labelOf,
	NodeResolver,
	relationEdges,
	relationSchema,
} from "../common.js";
import type { ViewDefinition } from "../types.js";

const partySchema = itemSchema({ description: z.string().optional() });

const schema = z
	.object({
		title: z.string().optional(),
		direction: z.enum(["LR", "TB"]).optional(),
		system: z.union([
			z.string(),
			z
				.object({
					id: z.string().optional(),
					label: z.string(),
					description: z.string().optional(),
				})
				.strict(),
		]),
		people: z.record(z.string(), partySchema).optional(),
		externals: z.record(z.string(), partySchema).optional(),
		relations: z.array(relationSchema).min(1),
	})
	.strict();

type ContextInput = z.infer<typeof schema>;

const STYLE = {
	person: { shape: "ellipse", style: { fill: "#dbeafe", stroke: "#1d4ed8" } },
	system: {
		shape: "rounded-rectangle",
		style: { fill: "#bfdbfe", stroke: "#1e3a8a" },
	},
	external: {
		shape: "rounded-rectangle",
		style: { fill: "#f3f4f6", stroke: "#6b7280" },
	},
} as const;

export const systemContextView: ViewDefinition<ContextInput> = {
	id: "system-context",
	title: "System context (C4 level 1)",
	summary:
		"One system in its environment: the people who use it and the external systems it talks to.",
	schema,
	example: `view: system-context
title: 网上银行 系统上下文
system: { id: bank, label: 网上银行系统, description: 账户查询与转账 }
people:
  customer: { label: 个人客户, description: 持有银行账户 }
  staff: 客服人员
externals:
  core: { label: 核心银行系统, description: 账户与交易记账 }
  sms: 短信网关
relations:
  - customer -> bank: 查询余额、转账
  - staff -> bank: 处理客户问题
  - bank -> core: 读写账户
  - bank -> sms: 发送验证码
  - sms -> customer: 短信
`,
	expand(input, context) {
		const resolver = new NodeResolver(context);
		const nodes: Record<string, Record<string, unknown>> = {};
		const text = (label: string, description: string | undefined) =>
			description === undefined ? label : `${label}\n${description}`;
		const system =
			typeof input.system === "string"
				? { id: "system", label: input.system, description: undefined }
				: {
						id: input.system.id ?? "system",
						label: input.system.label,
						description: input.system.description,
					};
		resolver.add(system.id, system.label);
		nodes[system.id] = {
			label: text(system.label, system.description),
			...STYLE.system,
		};
		const where = new Map<string, (string | number)[]>();
		for (const [key, kind] of [
			["people", "person"],
			["externals", "external"],
		] as const) {
			for (const [id, item] of Object.entries(input[key] ?? {})) {
				const path = [key, id];
				if (resolver.nodes.has(id)) {
					context.error(
						path,
						"view.system-context.duplicate",
						`"${id}" is declared twice.`,
						"Use one id per person, system and external system.",
					);
					continue;
				}
				const label = labelOf(id, item);
				resolver.add(id, label);
				where.set(id, path);
				nodes[id] = {
					label: text(
						label,
						typeof item === "string" ? undefined : item.description,
					),
					...STYLE[kind],
				};
			}
		}
		const edges = relationEdges(
			input.relations,
			resolver,
			context,
			"relations",
		);
		const touched = new Set(
			edges.flatMap((edge) => [edge.sourceId, edge.targetId]),
		);
		for (const [id, path] of where) {
			if (touched.has(id)) continue;
			context.warn(
				path,
				"view.system-context.unrelated",
				`"${id}" has no relation.`,
				`Say how it relates to the system, e.g. "${id} -> ${system.id}: uses".`,
			);
		}
		if (
			!edges.some(
				(edge) => edge.sourceId === system.id || edge.targetId === system.id,
			)
		) {
			context.warn(
				["system"],
				"view.system-context.system-unrelated",
				"No relation involves the system.",
				"A context view shows how people and systems relate to the system in its centre.",
			);
		}
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			layout: { direction: input.direction ?? "LR", mode: "global" },
			nodes,
			edges,
		};
	},
};
