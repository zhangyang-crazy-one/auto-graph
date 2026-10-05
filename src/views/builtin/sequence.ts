import { z } from "zod";
import { closest, labelOf, NodeResolver } from "../common.js";
import type { ViewContext, ViewDefinition } from "../types.js";

const PARTICIPANT_TYPES = ["participant", "actor", "database"] as const;
const FRAGMENT_KINDS = [
	"alt",
	"opt",
	"loop",
	"par",
	"break",
	"critical",
	"neg",
] as const;

type FragmentKind = (typeof FRAGMENT_KINDS)[number];

/**
 * A step: a message or command string, a `{ "a -> b": text }` map, or a
 * fragment (`alt: guard` with `messages`, `else`, `and`).
 */
type StepInput = string | Record<string, unknown>;

const stepSchema: z.ZodType<StepInput> = z.union([
	z.string().min(1),
	z.record(z.string(), z.unknown()),
]);

const schema = z
	.object({
		title: z.string().optional(),
		participants: z
			.record(
				z.string(),
				z.union([
					z.string(),
					z
						.object({
							label: z.string().optional(),
							type: z.enum(PARTICIPANT_TYPES).optional(),
						})
						.strict(),
				]),
			)
			.optional(),
		autonumber: z.boolean().optional(),
		autoActivate: z.boolean().optional(),
		messages: z.array(stepSchema).min(1),
	})
	.strict();

type SequenceInput = z.infer<typeof schema>;
type Path = (string | number)[];
type DslStep = Record<string, unknown>;

/** `->` sync, `->>` async, `-->` / `-->>` reply, `->*` create; `+` / `-` after it (de)activate. */
const ARROW =
	/^(?<from>.+?)\s*(?<arrow>-->>|-->|->>|->\*|->)(?<mark>[+-])?\s*(?<to>[^:：]+?)\s*(?:[:：]\s*(?<text>.*))?$/s;
const NOTE =
	/^note\s+(?<position>left of|right of|over)\s+(?<who>[^:：]+?)\s*[:：]\s*(?<text>.+)$/is;
const REF = /^ref\s+over\s+(?<who>[^:：]+?)\s*[:：]\s*(?<text>.+)$/is;
const COMMAND = /^(?<command>activate|deactivate|destroy)\s+(?<who>.+)$/i;
const DIVIDER = /^==\s*(?<text>.*?)\s*==$/s;

export const sequenceView: ViewDefinition<SequenceInput> = {
	id: "sequence",
	title: "Sequence diagram",
	summary:
		"Who calls whom, in time order: participants side by side, messages top to bottom, with alt/loop/par fragments and notes.",
	schema,
	example: `view: sequence
title: 用户登录
participants:
  user: { label: 用户, type: actor }
  web: Web 前端
  auth: 认证服务
  db: { label: 用户库, type: database }
messages:
  - user -> web: 输入账号密码
  - web -> auth: POST /login
  - auth -> db: 查询用户
  - db --> auth: 用户记录
  - alt: 密码正确
    messages:
      - auth -> auth: 签发 JWT
      - auth --> web: 200 + token
    else:
      - guard: 密码错误
        messages:
          - auth --> web: 401
          - note right of web: 连续失败 5 次锁定账号
  - web ->> user: 显示结果
`,
	expand(input, context) {
		const nodes: Record<string, Record<string, unknown>> = {};
		const kinds = new Map<string, (typeof PARTICIPANT_TYPES)[number]>();
		const order: string[] = [];
		const resolver = new NodeResolver(context, (id) => {
			// A participant written only in the messages.
			nodes[id] = { label: resolver.nodes.get(id) ?? id };
			order.push(id);
		});
		for (const [id, item] of Object.entries(input.participants ?? {})) {
			const label = labelOf(id, item);
			const type = typeof item === "string" ? undefined : item.type;
			resolver.add(id, label);
			order.push(id);
			nodes[id] = {
				label,
				...(type === "database" ? { shape: "cylinder" } : {}),
			};
			if (type !== undefined) kinds.set(id, type);
		}
		const steps = expandSteps(input.messages, ["messages"], resolver, context);
		if (Object.keys(nodes).length === 0) {
			context.error(
				["messages"],
				"view.sequence.no-participants",
				"The diagram has no participants.",
				'Write messages such as "client -> server: request".',
			);
		}
		return {
			...(input.title === undefined ? {} : { title: input.title }),
			nodes,
			sequence: {
				participants: order.map((id) => {
					const kind = kinds.get(id);
					return kind === undefined ? id : { id, kind };
				}),
				...(input.autonumber === undefined
					? {}
					: { autonumber: input.autonumber }),
				...(input.autoActivate === undefined
					? {}
					: { autoActivate: input.autoActivate }),
				steps,
			},
		};
	},
};

function expandSteps(
	inputs: readonly StepInput[],
	path: Path,
	resolver: NodeResolver,
	context: ViewContext,
): DslStep[] {
	const steps: DslStep[] = [];
	inputs.forEach((input, index) => {
		steps.push(...expandStep(input, [...path, index], resolver, context));
	});
	return steps;
}

function expandStep(
	input: StepInput,
	path: Path,
	resolver: NodeResolver,
	context: ViewContext,
): DslStep[] {
	if (typeof input === "string") {
		return expandText(input.trim(), undefined, path, resolver, context);
	}
	const keys = Object.keys(input);
	const fragmentKey = keys.find((key): key is FragmentKind =>
		(FRAGMENT_KINDS as readonly string[]).includes(key),
	);
	if (fragmentKey !== undefined) {
		return [expandFragment(fragmentKey, input, path, resolver, context)];
	}
	// `{ "a -> b": text }`; YAML reads "a -> b: 401" as a number.
	const [key, value] = Object.entries(input)[0] ?? [];
	if (
		keys.length === 1 &&
		key !== undefined &&
		(value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean")
	) {
		return expandText(
			key.trim(),
			value === null ? "" : String(value),
			path,
			resolver,
			context,
		);
	}
	context.error(
		path,
		"view.sequence.invalid-step",
		`Cannot read this step: ${JSON.stringify(input)}.`,
		`A step is a message ("a -> b: text"), a note ("note right of a: text"), "== divider ==", "activate a", or a fragment (${FRAGMENT_KINDS.join(", ")}) with messages.`,
	);
	return [];
}

function expandText(
	text: string,
	mapText: string | undefined,
	path: Path,
	resolver: NodeResolver,
	context: ViewContext,
): DslStep[] {
	const resolve = (token: string) => resolver.resolve(token.trim(), path);
	const resolveList = (tokens: string) =>
		tokens
			.split(/[,，]/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0)
			.map(resolve);

	const divider = DIVIDER.exec(text);
	if (divider?.groups !== undefined) {
		const label = divider.groups.text ?? "";
		return [{ type: "divider", ...(label === "" ? {} : { text: label }) }];
	}
	const note = NOTE.exec(mapText === undefined ? text : `${text}: ${mapText}`);
	if (note?.groups !== undefined) {
		const ids = resolveList(note.groups.who ?? "");
		if (ids.some((id) => id === undefined)) return [];
		const position = (note.groups.position ?? "over").toLowerCase();
		if (ids.length > (position === "over" ? 2 : 1)) {
			context.error(
				path,
				"view.sequence.note-span",
				`A note ${position} spans ${position === "over" ? "one or two participants" : "one participant"}.`,
			);
			return [];
		}
		return [
			{
				type: "note",
				text: (note.groups.text ?? "").trim(),
				position: position.startsWith("left")
					? "left"
					: position.startsWith("right")
						? "right"
						: "over",
				participants: ids as string[],
			},
		];
	}
	const ref = REF.exec(mapText === undefined ? text : `${text}: ${mapText}`);
	if (ref?.groups !== undefined) {
		const ids = resolveList(ref.groups.who ?? "");
		if (ids.some((id) => id === undefined)) return [];
		return [
			{
				type: "ref",
				text: (ref.groups.text ?? "").trim(),
				participants: ids as string[],
			},
		];
	}
	const command = COMMAND.exec(text);
	if (command?.groups !== undefined && mapText === undefined) {
		const id = resolve(command.groups.who ?? "");
		if (id === undefined) return [];
		return [
			{
				type: (command.groups.command ?? "").toLowerCase(),
				participant: id,
			},
		];
	}
	const arrow = ARROW.exec(text);
	if (arrow?.groups !== undefined) {
		const from = resolve(arrow.groups.from ?? "");
		const to = resolve(arrow.groups.to ?? "");
		if (from === undefined || to === undefined) return [];
		const label = (mapText ?? arrow.groups.text ?? "").trim();
		const symbol = arrow.groups.arrow;
		const kind =
			symbol === "->>"
				? "async"
				: symbol === "-->" || symbol === "-->>"
					? "reply"
					: symbol === "->*"
						? "create"
						: "sync";
		return [
			{
				type: "message",
				from,
				to,
				...(label === "" ? {} : { text: label }),
				kind,
				...(arrow.groups.mark === "+" ? { activate: true } : {}),
				...(arrow.groups.mark === "-" ? { deactivate: true } : {}),
			},
		];
	}
	context.error(
		path,
		"view.sequence.invalid-step",
		`Cannot read "${text}".`,
		'Messages: "a -> b: call", "a ->> b: signal", "b --> a: return", "a ->* b: create". Also "note right of a: text", "== divider ==", "activate a", "destroy a".',
	);
	return [];
}

function expandFragment(
	kind: FragmentKind,
	input: Record<string, unknown>,
	path: Path,
	resolver: NodeResolver,
	context: ViewContext,
): DslStep {
	const allowed = new Set([kind, "messages", "else", "and"]);
	for (const key of Object.keys(input)) {
		if (allowed.has(key)) continue;
		const near = closest(key, [...allowed]);
		context.error(
			[...path, key],
			"view.sequence.invalid-fragment",
			`Unknown key "${key}" in a ${kind} fragment.`,
			near.length > 0
				? `Did you mean "${near[0]}"?`
				: `A fragment has "${kind}: guard", "messages" and, for alternatives, "else" (alt) or "and" (par).`,
		);
	}
	const guard = input[kind];
	const operands: DslStep[] = [
		{
			...(typeof guard === "string" && guard !== "" ? { guard } : {}),
			steps: operandSteps(
				input.messages,
				[...path, "messages"],
				resolver,
				context,
			),
		},
	];
	for (const key of ["else", "and"] as const) {
		const more = input[key];
		if (more === undefined) continue;
		if (!Array.isArray(more)) {
			context.error(
				[...path, key],
				"view.sequence.invalid-fragment",
				`"${key}" lists further operands.`,
				`Write "${key}:" as a list of { guard, messages }.`,
			);
			continue;
		}
		more.forEach((operand: unknown, index) => {
			const at = [...path, key, index];
			if (
				operand === null ||
				typeof operand !== "object" ||
				Array.isArray(operand)
			) {
				context.error(
					at,
					"view.sequence.invalid-fragment",
					"An operand is { guard, messages }.",
				);
				return;
			}
			const record = operand as Record<string, unknown>;
			operands.push({
				...(typeof record.guard === "string" && record.guard !== ""
					? { guard: record.guard }
					: {}),
				steps: operandSteps(
					record.messages,
					[...at, "messages"],
					resolver,
					context,
				),
			});
		});
	}
	return { type: "fragment", kind, operands };
}

function operandSteps(
	value: unknown,
	path: Path,
	resolver: NodeResolver,
	context: ViewContext,
): DslStep[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		context.error(
			path,
			"view.sequence.invalid-fragment",
			"A fragment's messages are a list.",
		);
		return [];
	}
	const valid = value.filter(
		(item): item is StepInput =>
			typeof item === "string" ||
			(item !== null && typeof item === "object" && !Array.isArray(item)),
	);
	if (valid.length !== value.length) {
		context.error(
			path,
			"view.sequence.invalid-step",
			"Every step is a string or a map.",
		);
	}
	return expandSteps(valid, path, resolver, context);
}
