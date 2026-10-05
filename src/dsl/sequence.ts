import type {
	SequenceParticipant,
	SequenceParticipantKind,
	SequenceSpec,
	SequenceStep,
} from "../ir/sequence.js";
import type { DiagramDsl, SequenceStepDsl } from "./schema.js";
import type { DslDiagnostic } from "./types.js";

type SequenceDsl = NonNullable<DiagramDsl["sequence"]>;
type ParticipantDsl = NonNullable<SequenceDsl["participants"]>[number];
type DslPath = Array<string | number>;

/**
 * The DSL with a node for every sequence participant: participants listed
 * only under `sequence.participants` become nodes (their label, or their
 * id), and a `database` participant without a shape is drawn as a
 * cylinder.
 */
export function withSequenceParticipantNodes(dsl: DiagramDsl): DiagramDsl {
	if (dsl.sequence === undefined) return dsl;
	const nodes = { ...dsl.nodes };
	for (const entry of dsl.sequence.participants ?? []) {
		const { id, label, kind } = participantEntry(entry);
		const node = nodes[id];
		if (node === undefined) {
			nodes[id] = {
				label: label ?? id,
				...(kind === "database" ? { shape: "cylinder" as const } : {}),
			};
		} else if (kind === "database" && node.shape === undefined) {
			nodes[id] = { ...node, shape: "cylinder" };
		}
	}
	return { ...dsl, nodes };
}

/** Missing participants, misplaced notes and duplicate participants. */
export function validateSequenceReferences(dsl: DiagramDsl): DslDiagnostic[] {
	const sequence = dsl.sequence;
	if (sequence === undefined) return [];
	const diagnostics: DslDiagnostic[] = [];
	const known = new Set(Object.keys(dsl.nodes));
	const listed = new Map<string, number>();
	(sequence.participants ?? []).forEach((entry, index) => {
		const { id } = participantEntry(entry);
		known.add(id);
		const first = listed.get(id);
		if (first !== undefined) {
			diagnostics.push({
				severity: "error",
				layer: "validate",
				code: "validate.sequence.duplicate-participant",
				message: `Participant "${id}" is listed twice.`,
				path: ["sequence", "participants", index],
				hint: `Remove the repeat; it is first listed at index ${first}.`,
			});
		} else {
			listed.set(id, index);
		}
	});
	const check = (id: string, path: DslPath) => {
		if (!known.has(id)) {
			diagnostics.push({
				severity: "error",
				layer: "validate",
				code: "validate.reference.missing",
				message: `Participant "${id}" does not exist.`,
				path,
				hint: "Declare it under `nodes` or `sequence.participants`, or fix the reference.",
			});
		}
	};
	const visit = (steps: readonly SequenceStepDsl[], path: DslPath) => {
		steps.forEach((step, index) => {
			const at = [...path, index];
			switch (step.type) {
				case "message":
					check(step.from, [...at, "from"]);
					check(step.to, [...at, "to"]);
					if (step.kind === "create" && step.from === step.to) {
						diagnostics.push({
							severity: "error",
							layer: "validate",
							code: "validate.sequence.self-create",
							message: `Participant "${step.from}" cannot create itself.`,
							path: [...at, "to"],
							hint: "A create message goes to the participant it starts.",
						});
					}
					break;
				case "activate":
				case "deactivate":
				case "destroy":
					check(step.participant, [...at, "participant"]);
					break;
				case "note":
					step.participants.forEach((id, participantIndex) => {
						check(id, [...at, "participants", participantIndex]);
					});
					if (
						step.participants.length === 2 &&
						(step.position ?? "over") !== "over"
					) {
						diagnostics.push({
							severity: "error",
							layer: "validate",
							code: "validate.sequence.note-span",
							message: `A note ${step.position} of participants spans one participant.`,
							path: [...at, "participants"],
							hint: "List one participant, or use `position: over` to span two.",
						});
					}
					break;
				case "ref":
					step.participants.forEach((id, participantIndex) => {
						check(id, [...at, "participants", participantIndex]);
					});
					break;
				case "fragment":
					step.operands.forEach((operand, operandIndex) => {
						visit(operand.steps, [...at, "operands", operandIndex, "steps"]);
					});
					break;
				case "divider":
					break;
			}
		});
	};
	visit(sequence.steps, ["sequence", "steps"]);
	return diagnostics;
}

/**
 * The normalized sequence: participants left to right (as listed, then the
 * other nodes in the order they are declared), defaults filled in.
 */
export function normalizeSequence(dsl: DiagramDsl): SequenceSpec | undefined {
	const sequence = dsl.sequence;
	if (sequence === undefined) return undefined;
	const participants: SequenceParticipant[] = [];
	const seen = new Set<string>();
	const add = (id: string, kind: SequenceParticipantKind) => {
		if (seen.has(id)) return;
		seen.add(id);
		participants.push({ id, kind });
	};
	for (const entry of sequence.participants ?? []) {
		const { id, kind } = participantEntry(entry);
		add(id, kind ?? defaultKind(dsl, id));
	}
	for (const id of Object.keys(dsl.nodes)) add(id, defaultKind(dsl, id));
	return {
		participants,
		steps: sequence.steps.map(normalizeStep),
		autoActivate: sequence.autoActivate ?? true,
		autonumber: sequence.autonumber ?? false,
	};
}

function normalizeStep(step: SequenceStepDsl): SequenceStep {
	switch (step.type) {
		case "message":
			return {
				type: "message",
				...(step.id === undefined ? {} : { id: step.id }),
				from: step.from,
				to: step.to,
				...(step.text === undefined ? {} : { text: step.text }),
				kind: step.kind ?? "sync",
				...(step.activate === undefined ? {} : { activate: step.activate }),
				...(step.deactivate === undefined
					? {}
					: { deactivate: step.deactivate }),
			};
		case "activate":
		case "deactivate":
		case "destroy":
			return { type: step.type, participant: step.participant };
		case "note":
			return {
				type: "note",
				...(step.id === undefined ? {} : { id: step.id }),
				text: step.text,
				position: step.position ?? "over",
				participants: [...step.participants],
			};
		case "divider":
			return {
				type: "divider",
				...(step.text === undefined ? {} : { text: step.text }),
			};
		case "fragment":
			return {
				type: "fragment",
				...(step.id === undefined ? {} : { id: step.id }),
				kind: step.kind,
				operands: step.operands.map((operand) => ({
					...(operand.guard === undefined ? {} : { guard: operand.guard }),
					steps: operand.steps.map(normalizeStep),
				})),
			};
		case "ref":
			return {
				type: "ref",
				...(step.id === undefined ? {} : { id: step.id }),
				text: step.text,
				participants: [...step.participants],
			};
	}
}

/** A node drawn as a cylinder reads as a database head. */
function defaultKind(dsl: DiagramDsl, id: string): SequenceParticipantKind {
	return dsl.nodes[id]?.shape === "cylinder" ? "database" : "participant";
}

function participantEntry(entry: ParticipantDsl): {
	id: string;
	label?: string;
	kind?: SequenceParticipantKind;
} {
	if (typeof entry === "string") return { id: entry };
	const label =
		entry.label === undefined
			? undefined
			: typeof entry.label === "string"
				? entry.label
				: entry.label.text;
	return {
		id: entry.id,
		...(label === undefined ? {} : { label }),
		...(entry.kind === undefined ? {} : { kind: entry.kind }),
	};
}
