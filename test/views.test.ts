import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseDiagramDsl, renderDiagramDsl } from "../src/dsl/index.js";
import type { CoordinatedDiagram } from "../src/ir/index.js";
import {
	LAYOUT_METRIC_HARD_KEYS,
	measureLayoutQuality,
} from "../src/quality/index.js";
import { DeterministicTextMeasurer } from "../src/text/index.js";
import {
	expandView,
	getView,
	listViews,
	parseRelation,
	registerView,
	viewJsonSchema,
} from "../src/views/index.js";

function expand(source: Record<string, unknown>) {
	return expandView(source);
}

function codes(diagnostics: readonly { code: string }[]): string[] {
	return diagnostics.map((diagnostic) => diagnostic.code);
}

function render(source: string) {
	return renderDiagramDsl(source, {
		textMeasurer: new DeterministicTextMeasurer(),
	});
}

describe("relation syntax", () => {
	it("reads chains, fans, dashes and labels", () => {
		expect(parseRelation("a -> b -> c")).toEqual([
			{ from: ["a"], to: ["b"], dashed: false },
			{ from: ["b"], to: ["c"], dashed: false },
		]);
		expect(parseRelation("a, b -> c，d: 调用")).toEqual([
			{ from: ["a", "b"], to: ["c", "d"], dashed: false, label: "调用" },
		]);
		expect(parseRelation("a -.-> b：异步")).toEqual([
			{ from: ["a"], to: ["b"], dashed: true, label: "异步" },
		]);
		expect(parseRelation({ "a -> b": "yes" })).toEqual([
			{ from: ["a"], to: ["b"], dashed: false, label: "yes" },
		]);
		expect(parseRelation("a b")).toBeUndefined();
		expect(parseRelation("a -> ")).toBeUndefined();
	});
});

describe("built-in views", () => {
	it("registers six views with examples that render cleanly", () => {
		const ids = listViews().map((view) => view.id);
		expect(ids).toEqual([
			"architecture",
			"flowchart",
			"state",
			"swimlane",
			"system-context",
			"tree",
		]);
		for (const id of ids) {
			const result = render(getView(id)?.example ?? "");
			expect(result.diagram, id).toBeDefined();
			expect(
				result.diagnostics.filter(
					(diagnostic) =>
						diagnostic.layer === "view" || diagnostic.severity === "error",
				),
				id,
			).toEqual([]);
			const metrics = measureLayoutQuality(
				result.diagram as CoordinatedDiagram,
			);
			for (const key of LAYOUT_METRIC_HARD_KEYS) {
				expect(metrics[key], `${id} ${key}`).toBe(0);
			}
		}
	});

	it("ships every example under examples/views", () => {
		for (const { id } of listViews()) {
			if (id.endsWith("-test")) continue;
			expect(
				readFileSync(
					new URL(`../examples/views/${id}.yaml`, import.meta.url),
					"utf8",
				),
				id,
			).toBe(getView(id)?.example);
		}
	});

	it("flowchart: infers step types and creates steps written in the flow", () => {
		const result = expand({
			view: "flowchart",
			steps: { check: "库存充足?" },
			flow: ["开始 -> 下单 -> check", "check -> 发货: 是", "check -> 结束: 否"],
		});
		expect(result.diagnostics).toEqual([]);
		const nodes = result.value?.nodes as Record<
			string,
			Record<string, unknown>
		>;
		const byLabel = new Map(
			Object.values(nodes).map((node) => [node.label, node]),
		);
		expect(byLabel.get("开始")?.role).toBe("start");
		expect(byLabel.get("结束")?.role).toBe("end");
		expect(byLabel.get("库存充足?")?.role).toBe("decision");
		expect(byLabel.get("下单")?.role).toBe("process");
		expect(result.value?.layout).toEqual({ direction: "TB", mode: "global" });
	});

	it("flowchart: reports a typo instead of inventing a step", () => {
		const result = expand({
			view: "flowchart",
			steps: { review: "审核" },
			flow: ["reveiw -> 结束"],
		});
		expect(result.value).toBeUndefined();
		const error = result.diagnostics.find(
			(diagnostic) => diagnostic.code === "view.flowchart.unknown-node",
		);
		expect(error?.hint).toContain('"review"');
		expect(error?.path).toEqual(["flow", 0]);
	});

	it("flowchart: warns about a decision with one branch", () => {
		const result = expand({
			view: "flowchart",
			flow: ["开始 -> 通过? -> 结束"],
		});
		expect(codes(result.diagnostics)).toContain(
			"view.flowchart.decision-branches",
		);
	});

	it("resolves relation ends written as a unique label", () => {
		const result = expand({
			view: "architecture",
			layers: [
				{ label: "服务", components: { api: "API 服务" } },
				{ label: "数据", components: { db: { label: "数据库", kind: "db" } } },
			],
			links: ["API 服务 -> 数据库"],
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.value?.edges).toEqual([{ sourceId: "api", targetId: "db" }]);
	});

	it("swimlane: puts steps in their lanes, orientation follows direction", () => {
		const result = expand({
			view: "swimlane",
			direction: "TB",
			lanes: {
				dev: { label: "开发", steps: { code: "编码" } },
				qa: { label: "测试", steps: { test: "测试通过?" } },
			},
			steps: { fix: { label: "修复", lane: "dev" } },
			flow: ["code -> test", "test -> fix: 否", "fix -> test"],
		});
		const swimlane = (
			result.value?.swimlanes as Record<string, Record<string, unknown>>
		).process as { orientation: string; lanes: Record<string, unknown> };
		expect(swimlane.orientation).toBe("vertical");
		expect(swimlane.lanes).toEqual({
			dev: { label: "开发", children: ["code", "fix"] },
			qa: { label: "测试", children: ["test"] },
		});
		expect(codes(result.diagnostics)).toEqual([
			"view.swimlane.decision-branches",
		]);
	});

	it("swimlane: a step needs a known lane", () => {
		const result = expand({
			view: "swimlane",
			lanes: { a: "客户" },
			steps: { x: "下单", y: { label: "付款", lane: "b" } },
			flow: ["x -> y"],
		});
		expect(result.value).toBeUndefined();
		expect(codes(result.diagnostics)).toEqual(
			expect.arrayContaining([
				"view.swimlane.step-without-lane",
				"view.swimlane.unknown-lane",
			]),
		);
		expect(codes(result.diagnostics)).not.toContain(
			"view.swimlane.unknown-node",
		);
	});

	it("architecture: layers become groups, kinds become shapes", () => {
		const result = expand({
			view: "architecture",
			layers: [
				{ id: "svc", label: "服务", components: { api: "API" } },
				{
					label: "数据",
					components: {
						db: { label: "MySQL", kind: "database" },
						mq: { label: "Kafka", kind: "mq" },
						x: { label: "X", kind: "mainframe" },
					},
				},
			],
			links: ["api -> db", "api -.-> mq"],
		});
		expect(result.value?.groups).toEqual({
			svc: { label: "服务", nodes: ["api"] },
			layer2: { label: "数据", nodes: ["db", "mq", "x"] },
		});
		const nodes = result.value?.nodes as Record<string, { shape?: string }>;
		expect(nodes.db?.shape).toBe("cylinder");
		expect(nodes.mq?.shape).toBe("parallelogram");
		expect(result.value?.edges).toContainEqual({
			sourceId: "api",
			targetId: "mq",
			style: "dashed",
		});
		expect(codes(result.diagnostics)).toEqual([
			"view.architecture.unknown-kind",
		]);
	});

	it("architecture: warns about a layer no link reaches", () => {
		const result = expand({
			view: "architecture",
			layers: [
				{ label: "A", components: { a: "A" } },
				{ label: "B", components: { b: "B" } },
			],
		});
		expect(codes(result.diagnostics)).toEqual([
			"view.architecture.isolated-layer",
			"view.architecture.isolated-layer",
		]);
	});

	it("system-context: styles the parties and flags unrelated ones", () => {
		const result = expand({
			view: "system-context",
			system: "商城",
			people: { buyer: { label: "买家", description: "下单购物" } },
			externals: { erp: "ERP" },
			relations: ["buyer -> system: 下单"],
		});
		const nodes = result.value?.nodes as Record<string, { label: string }>;
		expect(nodes.buyer?.label).toBe("买家\n下单购物");
		expect(nodes.system?.label).toBe("商城");
		expect(codes(result.diagnostics)).toEqual([
			"view.system-context.unrelated",
		]);
	});

	it("state: [*] becomes the initial and final pseudo-states", () => {
		const result = expand({
			view: "state",
			states: { open: "打开", closed: { label: "关闭", type: "final" } },
			transitions: ["[*] -> open", "open -> closed: 关闭", "closed -> [*]"],
		});
		const nodes = result.value?.nodes as Record<
			string,
			Record<string, unknown>
		>;
		expect(nodes.__initial).toEqual({ label: "开始", role: "start" });
		expect(nodes.__final).toEqual({ label: "结束", role: "end" });
		expect(result.value?.edges).toEqual([
			{ sourceId: "__initial", targetId: "open" },
			{ sourceId: "open", targetId: "closed", label: "关闭" },
			{ sourceId: "closed", targetId: "__final" },
		]);
		expect(codes(result.diagnostics)).toEqual(["view.state.final-has-exit"]);
	});

	it("state: `initial` names the first state; unreachable states warn", () => {
		const result = expand({
			view: "state",
			initial: "idle",
			states: { idle: "Idle", run: "Running", lost: "Lost" },
			transitions: ["idle -> run: start"],
		});
		expect(result.value?.edges).toContainEqual({
			sourceId: "__initial",
			targetId: "idle",
		});
		expect(codes(result.diagnostics)).toEqual(["view.state.unreachable"]);
	});

	it("tree: an outline becomes parent → child edges", () => {
		const result = expand({
			view: "tree",
			root: { 公司: ["财务", { 技术: ["前端", "后端"] }] },
		});
		const nodes = result.value?.nodes as Record<string, { label: string }>;
		expect(Object.values(nodes).map((node) => node.label)).toEqual([
			"公司",
			"财务",
			"技术",
			"前端",
			"后端",
		]);
		expect(result.value?.edges).toEqual([
			{ sourceId: "t1", targetId: "t2" },
			{ sourceId: "t3", targetId: "t4" },
			{ sourceId: "t3", targetId: "t5" },
			{ sourceId: "t1", targetId: "t3" },
		]);
	});
});

describe("view registry", () => {
	it("passes layout, routing and output through over the view defaults", () => {
		const result = expand({
			view: "flowchart",
			flow: ["a -> b"],
			layout: { direction: "LR" },
			output: { format: "geometry" },
		});
		expect(result.value?.layout).toEqual({ direction: "LR", mode: "global" });
		expect(result.value?.output).toEqual({ format: "geometry" });
	});

	it("suggests the closest view for an unknown one", () => {
		const result = expand({ view: "flowchrt" });
		expect(result.diagnostics[0]?.code).toBe("view.unknown");
		expect(result.diagnostics[0]?.hint).toContain('"flowchart"');
	});

	it("reports schema errors with paths into the view document", () => {
		const result = expand({ view: "tree" });
		expect(result.diagnostics[0]?.code).toBe("view.tree.invalid");
		expect(result.diagnostics[0]?.path).toEqual(["root"]);
	});

	it("publishes a JSON Schema per view", () => {
		const schema = viewJsonSchema("architecture") as {
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(schema.properties.view).toMatchObject({ const: "architecture" });
		expect(schema.required).toEqual(expect.arrayContaining(["view", "layers"]));
		expect(viewJsonSchema("nope")).toBeUndefined();
	});

	it("accepts custom views", () => {
		registerView(
			{
				id: "pipeline-test",
				title: "Pipeline",
				summary: "Stages in a row.",
				schema: z.object({ stages: z.array(z.string()).min(2) }),
				example: "view: pipeline-test\nstages: [a, b]\n",
				expand: (input) => ({
					layout: { direction: "LR" },
					nodes: Object.fromEntries(
						input.stages.map((stage, index) => [`s${index}`, { label: stage }]),
					),
					edges: input.stages.slice(1).map((_, index) => ({
						sourceId: `s${index}`,
						targetId: `s${index + 1}`,
					})),
				}),
			},
			{ replace: true },
		);
		const parsed = parseDiagramDsl(
			"view: pipeline-test\nstages: [拉取, 构建, 部署]\n",
		);
		expect(parsed.diagnostics).toEqual([]);
		expect(Object.keys((parsed.value as { nodes: object }).nodes)).toEqual([
			"s0",
			"s1",
			"s2",
		]);
		const view = getView("pipeline-test");
		if (view === undefined) throw new Error("not registered");
		expect(() => registerView(view)).toThrow(/already registered/);
		expect(() => registerView({ ...view, id: "Bad Id" })).toThrow(/lowercase/);
	});
});

describe("edge stroke style with CJK labels", () => {
	it("keeps a dashed edge dashed when its label is Chinese", () => {
		const result = render(
			"nodes: { a: { label: A }, b: { label: B } }\nedges:\n  - { sourceId: a, targetId: b, style: dashed, label: 异步 }\n  - { sourceId: b, targetId: a, label: 回调 }\n",
		);
		const edges = result.diagram?.edges ?? [];
		expect(edges.find((edge) => edge.id === "a-b")?.style).toBe("dashed");
		expect(edges.find((edge) => edge.id === "b-a")?.style).toBeUndefined();
	});
});
