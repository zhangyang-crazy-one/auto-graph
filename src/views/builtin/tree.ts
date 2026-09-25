import { z } from "zod";
import type { ViewDefinition } from "../types.js";

/**
 * A tree node: a label, `{ label, children }`, or a one-entry map
 * `label: [children]` — the shortest way to write an outline.
 */
type TreeNode =
	| string
	| {
			label: string;
			id?: string | undefined;
			children?: TreeNode[] | undefined;
	  }
	| { [label: string]: TreeNode[] };

const treeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
	z.union([
		z.string(),
		z
			.object({
				label: z.string(),
				id: z.string().optional(),
				children: z.array(treeNodeSchema).optional(),
			})
			.strict(),
		z
			.record(z.string(), z.array(treeNodeSchema))
			.refine(
				(value) => Object.keys(value).length === 1,
				"Write a branch as `label: [children]` with one label.",
			),
	]),
);

const schema = z
	.object({
		title: z.string().optional(),
		direction: z.enum(["TB", "LR"]).optional(),
		root: treeNodeSchema,
	})
	.strict();

type TreeInput = z.infer<typeof schema>;

export const treeView: ViewDefinition<TreeInput> = {
	id: "tree",
	title: "Tree",
	summary:
		"A hierarchy — org chart, work breakdown, module decomposition, taxonomy — written as a nested outline.",
	schema,
	example: `view: tree
title: 研发中心组织架构
root:
  研发中心:
    - 平台部:
        - 基础架构组
        - 数据平台组
    - 业务部:
        - 交易组
        - 会员组
    - 质量保障部
`,
	expand(input, context) {
		const nodes: Record<string, Record<string, unknown>> = {};
		const edges: { sourceId: string; targetId: string }[] = [];
		let count = 0;
		const used = new Set<string>();
		const visit = (
			node: TreeNode,
			path: (string | number)[],
			depth: number,
		): string => {
			let label: string;
			let id: string | undefined;
			let children: TreeNode[] = [];
			if (typeof node === "string") {
				label = node;
			} else if ("label" in node && typeof node.label === "string") {
				const object = node as {
					label: string;
					id?: string | undefined;
					children?: TreeNode[] | undefined;
				};
				label = object.label;
				id = object.id;
				children = object.children ?? [];
			} else {
				const [key, value] = Object.entries(node)[0] as [string, TreeNode[]];
				label = key;
				children = value;
			}
			if (id !== undefined && used.has(id)) {
				context.error(
					path,
					"view.tree.duplicate-id",
					`Id "${id}" is used twice.`,
				);
			}
			if (id === undefined) {
				do {
					count += 1;
					id = `t${count}`;
				} while (used.has(id));
			}
			used.add(id);
			nodes[id] = {
				label,
				shape: depth === 0 ? "rounded-rectangle" : "rectangle",
				...(depth === 0
					? { style: { fill: "#dbeafe", stroke: "#1d4ed8" } }
					: {}),
			};
			children.forEach((child, index) => {
				const childId = visit(child, [...path, index], depth + 1);
				edges.push({ sourceId: id as string, targetId: childId });
			});
			return id;
		};
		visit(input.root, ["root"], 0);
		if (edges.length === 0) {
			context.warn(
				["root"],
				"view.tree.single-node",
				"The tree has only its root.",
				"Nest the children under the root: `root: { 公司: [部门A, 部门B] }`.",
			);
		}
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			layout: { direction: input.direction ?? "TB", mode: "global" },
			nodes,
			edges,
		};
	},
};
