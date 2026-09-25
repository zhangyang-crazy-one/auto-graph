import { stringify } from "yaml";

/**
 * Deterministic synthetic diagrams for scale benchmarks and property
 * tests. Shapes the kind of graphs enterprise diagrams contain: tiers of
 * nodes wired mostly tier-to-next-tier, some skip and back edges, groups
 * per tier (architecture) or lanes (process), mixed CJK / Latin labels and
 * a few decision / storage shapes.
 */
export interface SyntheticOptions {
	seed: number;
	nodes: number;
	/** "architecture": groups per tier; "process": swimlane lanes; "plain". */
	kind?: "architecture" | "process" | "plain";
	direction?: "LR" | "TB";
	/** Share of edges that point back to an earlier tier (default 0.03). */
	backEdgeRate?: number;
	/** Share of edges with a label (default 0.15). */
	edgeLabelRate?: number;
}

export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CJK = [
	"订单",
	"支付",
	"库存",
	"用户",
	"认证",
	"网关",
	"消息",
	"队列",
	"缓存",
	"审批",
	"风控",
	"对账",
	"结算",
	"通知",
	"报表",
	"搜索",
	"推荐",
	"物流",
	"客服",
	"归档",
];
const LATIN = [
	"Service",
	"Gateway",
	"Order",
	"Payment",
	"Inventory",
	"Auth",
	"Queue",
	"Cache",
	"Review",
	"Billing",
	"Search",
	"Report",
	"Worker",
	"API",
	"Store",
	"Sync",
];

export function generateSyntheticDsl(options: SyntheticOptions): string {
	return stringify(generateSyntheticDocument(options));
}

export function generateSyntheticDocument(
	options: SyntheticOptions,
): Record<string, unknown> {
	const random = mulberry32(options.seed);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)] as T;
	const kind = options.kind ?? "architecture";
	const count = Math.max(2, options.nodes);
	const tierCount = Math.max(2, Math.round(Math.sqrt(count) * 0.9));
	const tiers: string[][] = Array.from({ length: tierCount }, () => []);
	const nodes: Record<string, Record<string, unknown>> = {};
	for (let index = 0; index < count; index += 1) {
		const id = `n${index}`;
		const tier = Math.min(
			tierCount - 1,
			Math.floor((index / count) * tierCount),
		);
		tiers[tier]?.push(id);
		const words = 1 + Math.floor(random() * 3);
		const parts: string[] = [];
		for (let word = 0; word < words; word += 1) {
			parts.push(random() < 0.55 ? pick(CJK) : pick(LATIN));
		}
		const roll = random();
		nodes[id] = {
			label: `${parts.join(random() < 0.5 ? "" : " ")} ${index}`,
			...(roll < 0.05
				? { shape: "diamond" }
				: roll < 0.1
					? { shape: "cylinder" }
					: roll < 0.2
						? { shape: "rounded-rectangle" }
						: {}),
		};
	}

	const edges: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	const addEdge = (source: string, target: string) => {
		const key = `${source}->${target}`;
		if (source === target || seen.has(key)) return;
		seen.add(key);
		edges.push(
			random() < (options.edgeLabelRate ?? 0.15)
				? { source, target, label: random() < 0.6 ? pick(CJK) : pick(LATIN) }
				: { source, target },
		);
	};
	tiers.forEach((tier, tierIndex) => {
		if (tierIndex === 0) return;
		for (const id of tier) {
			const fanIn = 1 + Math.floor(random() * 2);
			for (let k = 0; k < fanIn; k += 1) {
				const from =
					random() < 0.8 || tierIndex < 2
						? (tiers[tierIndex - 1] ?? [])
						: (tiers[Math.floor(random() * (tierIndex - 1))] ?? []);
				if (from.length > 0) addEdge(pick(from), id);
			}
		}
	});
	const backEdges = Math.round(edges.length * (options.backEdgeRate ?? 0.03));
	for (let k = 0; k < backEdges; k += 1) {
		const late = Math.floor(tierCount / 2 + random() * (tierCount / 2));
		const early = Math.floor(random() * Math.max(1, late));
		const from = tiers[late] ?? [];
		const to = tiers[early] ?? [];
		if (from.length > 0 && to.length > 0) addEdge(pick(from), pick(to));
	}

	const document: Record<string, unknown> = {
		title: `synthetic-${kind}-${count}-${options.seed}`,
		layout: { direction: options.direction ?? "LR" },
		nodes,
		edges: edges.map((edge) =>
			edge.label === undefined
				? `${edge.source} -> ${edge.target}`
				: { [`${edge.source} -> ${edge.target}`]: edge.label },
		),
	};

	if (kind === "architecture") {
		const groups: Record<string, unknown> = {};
		tiers.forEach((tier, tierIndex) => {
			// Split each tier into groups of 3–8 members.
			let cursor = 0;
			let groupIndex = 0;
			while (cursor < tier.length) {
				const size = 3 + Math.floor(random() * 6);
				const members = tier.slice(cursor, cursor + size);
				cursor += size;
				if (members.length < 2) continue;
				groups[`g${tierIndex}_${groupIndex}`] = {
					label: `${pick(CJK)}层 ${pick(LATIN)} ${tierIndex}.${groupIndex}`,
					nodes: members,
				};
				groupIndex += 1;
			}
		});
		document.groups = groups;
	} else if (kind === "process") {
		const laneCount = Math.min(
			8,
			Math.max(3, Math.round(Math.sqrt(count) / 2)),
		);
		const lanes: Record<string, { label: string; children: string[] }> = {};
		for (let lane = 0; lane < laneCount; lane += 1) {
			lanes[`lane${lane}`] = { label: `${pick(CJK)}部 ${lane}`, children: [] };
		}
		for (let index = 0; index < count; index += 1) {
			const lane = Math.floor(random() * laneCount);
			lanes[`lane${lane}`]?.children.push(`n${index}`);
		}
		document.swimlanes = {
			flow: {
				label: "流程 Process",
				layout: "contract",
				orientation:
					(options.direction ?? "LR") === "LR" ? "horizontal" : "vertical",
				lanes,
			},
		};
	}
	return document;
}
