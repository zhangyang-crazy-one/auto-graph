import { z } from "zod";
import type { ViewContext } from "./types.js";

/**
 * Building blocks shared by the built-in views, so every view reads the
 * same way: items are `id: label` maps (or `id: { label, … }`), relations
 * are arrow strings.
 *
 * Relation strings:
 *   a -> b                one edge
 *   a -> b -> c           a chain
 *   a, b -> c             fan-in (and `a -> b, c` fan-out)
 *   a -.-> b              dashed (asynchronous, optional, …)
 *   a -> b: label         label on the (last) edge; `：` works too
 *   { "a -> b": label }   the same, as a map entry
 * Ends are ids, or a node's exact label when it is unique.
 */
export const relationSchema = z.union([
	z.string().min(1),
	z
		.record(z.string(), z.string())
		.refine(
			(value) => Object.keys(value).length === 1,
			"A relation map has exactly one `from -> to: label` entry.",
		),
]);

export type RelationInput = z.infer<typeof relationSchema>;

export interface ParsedHop {
	from: string[];
	to: string[];
	dashed: boolean;
	label?: string;
}

/** Split a relation into hops; undefined when it has no arrow. */
export function parseRelation(
	relation: RelationInput,
): ParsedHop[] | undefined {
	let text: string;
	let label: string | undefined;
	if (typeof relation === "string") {
		text = relation;
	} else {
		const [key, value] = Object.entries(relation)[0] as [string, string];
		text = key;
		label = value;
	}
	const parts = text.split(/\s*(-\.->|-->|->)\s*/);
	if (parts.length < 3) return undefined;
	// A label follows the last end: "a -> b: yes".
	const lastIndex = parts.length - 1;
	const last = parts[lastIndex] as string;
	const colon = last.search(/[:：]/);
	if (colon >= 0) {
		const inline = last.slice(colon + 1).trim();
		parts[lastIndex] = last.slice(0, colon);
		if (label === undefined && inline.length > 0) label = inline;
	}
	const ends = parts
		.filter((_, index) => index % 2 === 0)
		.map((part) =>
			part
				.split(/[,，]/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0),
		);
	const arrows = parts.filter((_, index) => index % 2 === 1);
	if (ends.some((list) => list.length === 0)) return undefined;
	const hops: ParsedHop[] = [];
	for (let index = 0; index + 1 < ends.length; index += 1) {
		hops.push({
			from: ends[index] as string[],
			to: ends[index + 1] as string[],
			dashed: arrows[index] === "-.->",
			...(index === ends.length - 2 && label !== undefined ? { label } : {}),
		});
	}
	return hops;
}

/** `id: label` or `id: { label, … }`. */
export function itemSchema<Extra extends z.ZodRawShape>(extra: Extra) {
	return z.union([
		z.string(),
		z.object({ label: z.string().optional(), ...extra }),
	]);
}

export function labelOf(
	id: string,
	item: string | { label?: string | undefined },
): string {
	return typeof item === "string" ? item : (item.label ?? id);
}

/**
 * Resolves relation ends to node ids: by id, else by a unique exact label
 * (models often write the label), else — when the view allows it — creates
 * a node for the text, else reports the closest ids.
 */
export class NodeResolver {
	private readonly labels = new Map<string, string[]>();
	private implicitCount = 0;
	private readonly implicitIds = new Set<string>();
	readonly nodes = new Map<string, string>();

	constructor(
		private readonly context: ViewContext,
		private readonly implicit?: (id: string) => void,
	) {}

	add(id: string, label: string): void {
		this.nodes.set(id, label);
		const key = normalise(label);
		const list = this.labels.get(key) ?? [];
		list.push(id);
		this.labels.set(key, list);
	}

	resolve(
		token: string,
		path: readonly (string | number)[],
	): string | undefined {
		if (this.nodes.has(token)) return token;
		const byLabel = this.labels.get(normalise(token));
		if (byLabel?.length === 1) return byLabel[0];
		if (this.implicit !== undefined) {
			// An id-like word one or two letters off a declared id is a typo,
			// not a new step.
			const allowed = token.length >= 5 ? 2 : token.length >= 3 ? 1 : 0;
			const near =
				allowed > 0 && /^[A-Za-z_][\w.-]*$/.test(token)
					? [...this.nodes.keys()]
							.filter((id) => !this.implicitIds.has(id))
							.filter(
								(id) =>
									editDistance(token.toLowerCase(), id.toLowerCase()) <=
									allowed,
							)
							.sort()
					: [];
			if (near.length > 0) {
				this.context.error(
					path,
					`view.${this.context.viewId}.unknown-node`,
					`Unknown node "${token}".`,
					`Did you mean "${near[0]}"? To add a new node with this id, declare it first.`,
				);
				return undefined;
			}
			const id = this.freshId();
			this.add(id, token);
			this.implicit(id);
			return id;
		}
		const suggestions = closest(token, [...this.nodes.keys()]);
		this.context.error(
			path,
			`view.${this.context.viewId}.unknown-node`,
			byLabel !== undefined && byLabel.length > 1
				? `"${token}" is the label of several nodes (${byLabel.join(", ")}); use an id.`
				: `Unknown node "${token}".`,
			suggestions.length > 0
				? `Did you mean ${suggestions.map((id) => `"${id}"`).join(" or ")}? Declare every node before using it in a relation.`
				: "Declare every node before using it in a relation.",
		);
		return undefined;
	}

	/** `"label" (id)` for nodes created from relation text, else the id. */
	name(id: string): string {
		const label = this.nodes.get(id);
		return this.implicitIds.has(id) && label !== undefined
			? `"${label}" (${id})`
			: `"${id}"`;
	}

	private freshId(): string {
		let id: string;
		do {
			this.implicitCount += 1;
			id = `n${this.implicitCount}`;
		} while (this.nodes.has(id));
		this.implicitIds.add(id);
		return id;
	}
}

export interface DslEdge {
	sourceId: string;
	targetId: string;
	label?: string;
	style?: "dashed";
}

/** Relations to DSL edges; duplicate source/target/label edges are dropped. */
export function relationEdges(
	relations: readonly RelationInput[],
	resolver: NodeResolver,
	context: ViewContext,
	key: string,
): DslEdge[] {
	const edges: DslEdge[] = [];
	const seen = new Set<string>();
	relations.forEach((relation, index) => {
		const path = [key, index];
		const hops = parseRelation(relation);
		if (hops === undefined) {
			context.error(
				path,
				`view.${context.viewId}.relation-invalid`,
				`"${typeof relation === "string" ? relation : Object.keys(relation)[0]}" is not a relation.`,
				'Write relations as "a -> b", "a -> b -> c", "a -> b: label" or "a -.-> b" (dashed).',
			);
			return;
		}
		for (const hop of hops) {
			const from = hop.from.map((token) => resolver.resolve(token, path));
			const to = hop.to.map((token) => resolver.resolve(token, path));
			for (const source of from) {
				for (const target of to) {
					if (source === undefined || target === undefined) continue;
					const signature = `${source}\u0000${target}\u0000${hop.label ?? ""}`;
					if (seen.has(signature)) continue;
					seen.add(signature);
					edges.push({
						sourceId: source,
						targetId: target,
						...(hop.label === undefined ? {} : { label: hop.label }),
						...(hop.dashed ? { style: "dashed" as const } : {}),
					});
				}
			}
		}
	});
	return edges;
}

/** Node ids reachable from `starts` along `edges`. */
export function reachable(
	starts: readonly string[],
	edges: readonly DslEdge[],
): Set<string> {
	const next = new Map<string, string[]>();
	for (const edge of edges) {
		const list = next.get(edge.sourceId) ?? [];
		list.push(edge.targetId);
		next.set(edge.sourceId, list);
	}
	const seen = new Set(starts);
	const stack = [...starts];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		for (const target of next.get(id) ?? []) {
			if (seen.has(target)) continue;
			seen.add(target);
			stack.push(target);
		}
	}
	return seen;
}

function normalise(text: string): string {
	return text.trim().toLowerCase();
}

/** Up to two ids within edit distance 2 (or containing the token). */
export function closest(
	token: string,
	candidates: readonly string[],
): string[] {
	const target = normalise(token);
	return candidates
		.map((candidate) => ({
			candidate,
			distance: normalise(candidate).includes(target)
				? 0.5
				: editDistance(target, normalise(candidate)),
		}))
		.filter(({ distance }) => distance <= 2)
		.sort(
			(a, b) =>
				a.distance - b.distance || a.candidate.localeCompare(b.candidate),
		)
		.slice(0, 2)
		.map(({ candidate }) => candidate);
}

function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		let diagonal = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const above = row[j] as number;
			row[j] = Math.min(
				above + 1,
				(row[j - 1] as number) + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return row[b.length] as number;
}

/** Kinds of flow steps and how they are drawn. */
export const STEP_TYPES = [
	"start",
	"end",
	"step",
	"decision",
	"data",
	"io",
	"subprocess",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

const START_WORDS = new Set(["start", "begin", "开始", "起点", "开始节点"]);
const END_WORDS = new Set([
	"end",
	"stop",
	"finish",
	"结束",
	"终点",
	"结束节点",
]);

/** Type from an explicit value, else from the id / label wording. */
export function inferStepType(
	id: string,
	label: string,
	explicit: StepType | undefined,
): StepType {
	if (explicit !== undefined) return explicit;
	const words = [normalise(id), normalise(label)];
	if (words.some((word) => START_WORDS.has(word))) return "start";
	if (words.some((word) => END_WORDS.has(word))) return "end";
	if (/[?？]\s*$/.test(label) || /^是否/.test(label.trim())) return "decision";
	return "step";
}

/** DSL node fields for a step type. */
export function stepNode(
	label: string,
	type: StepType,
): Record<string, unknown> {
	switch (type) {
		case "start":
			return { label, role: "start" };
		case "end":
			return { label, role: "end" };
		case "decision":
			return { label, role: "decision" };
		case "data":
			return { label, role: "data" };
		case "io":
			return { label, shape: "parallelogram" };
		case "subprocess":
			return { label, shape: "rectangle", style: { stroke: "#1f2937" } };
		default:
			return { label, role: "process" };
	}
}

/**
 * Flow checks shared by flowchart, swimlane and state views: a decision
 * needs two or more labelled branches, and every node should be reachable
 * from a start when there is one.
 */
export function checkFlow(
	context: ViewContext,
	types: ReadonlyMap<string, StepType>,
	edges: readonly DslEdge[],
	pathOf: (id: string) => (string | number)[],
	nameOf: (id: string) => string = (id) => `"${id}"`,
): void {
	const outgoing = new Map<string, DslEdge[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.sourceId) ?? [];
		list.push(edge);
		outgoing.set(edge.sourceId, list);
	}
	for (const [id, type] of types) {
		if (type !== "decision") continue;
		const branches = outgoing.get(id) ?? [];
		if (branches.length < 2) {
			context.warn(
				pathOf(id),
				`view.${context.viewId}.decision-branches`,
				`Decision ${nameOf(id)} has ${branches.length} outgoing branch(es).`,
				"Give a decision at least two outgoing relations, e.g. `check -> ok: 是` and `check -> retry: 否`.",
			);
		} else if (branches.some((edge) => edge.label === undefined)) {
			context.info(
				pathOf(id),
				`view.${context.viewId}.decision-unlabelled`,
				`Some branches of decision ${nameOf(id)} have no label.`,
				'Label each branch with its condition: "check -> ok: 是".',
			);
		}
	}
	const starts = [...types].filter(([, type]) => type === "start");
	if (starts.length === 0) return;
	const seen = reachable(
		starts.map(([id]) => id),
		edges,
	);
	for (const id of types.keys()) {
		if (seen.has(id)) continue;
		context.warn(
			pathOf(id),
			`view.${context.viewId}.unreachable`,
			`${nameOf(id)} cannot be reached from the start.`,
			"Connect it to the flow or remove it.",
		);
	}
}
