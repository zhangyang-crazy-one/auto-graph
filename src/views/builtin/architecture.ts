import { z } from "zod";
import {
	itemSchema,
	labelOf,
	NodeResolver,
	relationEdges,
	relationSchema,
} from "../common.js";
import type { ViewDefinition } from "../types.js";

/** Component kinds and how they are drawn. */
const KIND_NODE: Record<string, Record<string, unknown>> = {
	service: { shape: "rectangle" },
	app: { shape: "rounded-rectangle" },
	client: { shape: "rounded-rectangle" },
	web: { shape: "rounded-rectangle" },
	gateway: { shape: "hexagon" },
	database: { shape: "cylinder" },
	cache: { shape: "cylinder", style: { fill: "#fef3c7" } },
	storage: { shape: "cylinder" },
	queue: { shape: "parallelogram" },
	user: { shape: "ellipse" },
	external: {
		shape: "rounded-rectangle",
		style: { fill: "#f3f4f6", stroke: "#6b7280" },
	},
};
const KIND_ALIASES: Record<string, string> = {
	db: "database",
	mq: "queue",
	topic: "queue",
	stream: "queue",
	bucket: "storage",
	file: "storage",
	person: "user",
	actor: "user",
	ui: "client",
	frontend: "client",
	mobile: "app",
	lb: "gateway",
	proxy: "gateway",
	thirdparty: "external",
	"third-party": "external",
};
export const COMPONENT_KINDS = Object.keys(KIND_NODE);

const componentSchema = itemSchema({
	kind: z.string().optional(),
	note: z.string().optional(),
});

const layerSchema = z
	.object({
		id: z.string().optional(),
		label: z.string(),
		components: z
			.record(z.string(), componentSchema)
			.refine(
				(value) => Object.keys(value).length > 0,
				"A layer needs at least one component.",
			),
	})
	.strict();

const schema = z
	.object({
		title: z.string().optional(),
		direction: z.enum(["TB", "LR", "BT", "RL"]).optional(),
		layers: z.array(layerSchema).min(1),
		links: z.array(relationSchema).optional(),
	})
	.strict();

type ArchitectureInput = z.infer<typeof schema>;

export const architectureView: ViewDefinition<ArchitectureInput> = {
	id: "architecture",
	title: "Layered architecture",
	summary:
		"A system as ordered layers (client, services, data, …) of components and the calls between them.",
	schema,
	example: `view: architecture
title: 电商系统架构
layers:
  - label: 接入层
    components:
      web: { label: Web 商城, kind: client }
      app: { label: 移动 App, kind: app }
  - label: 网关
    components:
      gateway: { label: API 网关, kind: gateway }
  - label: 业务服务
    components:
      order: 订单服务
      user: 用户服务
      pay: 支付服务
  - label: 数据与中间件
    components:
      mysql: { label: MySQL, kind: database }
      redis: { label: Redis, kind: cache }
      kafka: { label: Kafka, kind: queue }
links:
  - web, app -> gateway: HTTPS
  - gateway -> order, user, pay
  - order, user -> mysql
  - user -> redis
  - order -.-> kafka: 订单事件
`,
	expand(input, context) {
		const resolver = new NodeResolver(context);
		const nodes: Record<string, Record<string, unknown>> = {};
		const groups: Record<string, { label: string; nodes: string[] }> = {};
		const layerOf = new Map<string, number>();
		const groupIds = new Set<string>();
		input.layers.forEach((layer, index) => {
			const groupId = layer.id ?? `layer${index + 1}`;
			if (groupIds.has(groupId)) {
				context.error(
					["layers", index, "id"],
					"view.architecture.duplicate-layer",
					`Layer id "${groupId}" is used twice.`,
				);
			}
			groupIds.add(groupId);
			const members: string[] = [];
			for (const [id, item] of Object.entries(layer.components)) {
				const path = ["layers", index, "components", id];
				if (layerOf.has(id)) {
					context.error(
						path,
						"view.architecture.duplicate-component",
						`Component "${id}" is already in layer ${(layerOf.get(id) ?? 0) + 1}.`,
						"Give each component one layer.",
					);
					continue;
				}
				const label = labelOf(id, item);
				const kindText = typeof item === "string" ? undefined : item.kind;
				const kind =
					kindText === undefined
						? "service"
						: (KIND_ALIASES[kindText.toLowerCase()] ?? kindText.toLowerCase());
				if (KIND_NODE[kind] === undefined) {
					context.warn(
						[...path, "kind"],
						"view.architecture.unknown-kind",
						`Unknown component kind "${kindText}"; drawn as a service.`,
						`Kinds: ${COMPONENT_KINDS.join(", ")}.`,
					);
				}
				const note = typeof item === "string" ? undefined : item.note;
				resolver.add(id, label);
				layerOf.set(id, index);
				members.push(id);
				nodes[id] = {
					label: note === undefined ? label : `${label}\n${note}`,
					...(KIND_NODE[kind] ?? KIND_NODE.service),
				};
			}
			groups[groupId] = { label: layer.label, nodes: members };
		});
		const edges = relationEdges(input.links ?? [], resolver, context, "links");

		// A layer no link touches has no place in the tier order.
		const linked = new Set<number>();
		for (const edge of edges) {
			const from = layerOf.get(edge.sourceId);
			const to = layerOf.get(edge.targetId);
			if (from !== undefined && to !== undefined && from !== to) {
				linked.add(from);
				linked.add(to);
			}
		}
		if (input.layers.length > 1) {
			input.layers.forEach((layer, index) => {
				if (linked.has(index)) return;
				context.warn(
					["layers", index],
					"view.architecture.isolated-layer",
					`Layer "${layer.label}" has no link to another layer.`,
					"Add the calls between this layer and its neighbours so it takes its place in the stack.",
				);
			});
		}
		const upward = edges.filter(
			(edge) =>
				(layerOf.get(edge.sourceId) ?? 0) > (layerOf.get(edge.targetId) ?? 0),
		);
		if (upward.length > 0) {
			context.info(
				["links"],
				"view.architecture.upward-links",
				`${upward.length} link(s) point to an earlier layer (${upward
					.slice(0, 3)
					.map((edge) => `${edge.sourceId} -> ${edge.targetId}`)
					.join(", ")}).`,
				"Layers are drawn in the order links run; write callbacks and replies after the forward calls, or dashed (-.->).",
			);
		}
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			layout: { direction: input.direction ?? "TB", mode: "global" },
			nodes,
			edges,
			groups,
		};
	},
};
