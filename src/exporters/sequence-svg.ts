import {
	actorFigure,
	fragmentTagPoints,
	noteOutlinePoints,
} from "../geometry/sequence-shapes.js";
import type { CoordinatedNode } from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { SolvedTextAnnotation } from "../ir/label-layout.js";
import {
	type CoordinatedSequence,
	SEQUENCE_DESTRUCTION_HALF_SIZE,
	SEQUENCE_NOTE_FOLD,
	SEQUENCE_TAG_CUT,
} from "../ir/sequence.js";

const STROKE = "#374151";
const LIFELINE_STROKE = "#6b7280";
const ACTIVATION_FILL = "#f3f4f6";
const NOTE_FILL = "#fffbeb";
const NOTE_STROKE = "#b45309";
const TEXT_FILL = "#111827";

/** Sequence text surfaces, drawn by `renderSequenceText`. */
export const SEQUENCE_TEXT_SURFACES = new Set<
	SolvedTextAnnotation["surfaceKind"]
>(["sequence-note", "fragment-tag", "fragment-guard", "sequence-divider"]);

/**
 * Lifelines and activation bars, then fragments over them (a fragment's
 * tag stays readable where it crosses a bar): all below the messages.
 */
export function renderSequenceBackground(
	sequence: CoordinatedSequence,
): string[] {
	return [
		...sequence.lifelines.map(
			(lifeline) =>
				`<line class="sequence-lifeline" data-for="${attr(lifeline.participantId)}" x1="${n(lifeline.x)}" y1="${n(lifeline.top)}" x2="${n(lifeline.x)}" y2="${n(lifeline.bottom)}" stroke="${LIFELINE_STROKE}" stroke-dasharray="5 4"/>`,
		),
		...sequence.activations.map(
			(activation) =>
				`<rect class="sequence-activation" data-for="${attr(activation.participantId)}" data-depth="${activation.depth}" x="${n(activation.box.x)}" y="${n(activation.box.y)}" width="${n(activation.box.width)}" height="${n(activation.box.height)}" fill="${ACTIVATION_FILL}" stroke="${STROKE}"/>`,
		),
		...sequence.fragments.flatMap((fragment) => [
			`<rect class="sequence-fragment" data-id="${attr(fragment.id)}" data-kind="${attr(fragment.kind)}" x="${n(fragment.box.x)}" y="${n(fragment.box.y)}" width="${n(fragment.box.width)}" height="${n(fragment.box.height)}" fill="${fragment.kind === "ref" ? "#ffffff" : "none"}" stroke="${STROKE}"/>`,
			`<polygon class="sequence-fragment-tag" data-for="${attr(fragment.id)}" points="${points(fragmentTagPoints(fragment.tagBox, SEQUENCE_TAG_CUT))}" fill="#ffffff" stroke="${STROKE}"/>`,
			...fragment.operands
				.slice(1)
				.map(
					(operand) =>
						`<line class="sequence-operand-separator" data-for="${attr(fragment.id)}" x1="${n(fragment.box.x)}" y1="${n(operand.top)}" x2="${n(fragment.box.x + fragment.box.width)}" y2="${n(operand.top)}" stroke="${STROKE}" stroke-dasharray="5 4"/>`,
				),
		]),
	];
}

/** Notes, dividers and destruction marks: above the messages. */
export function renderSequenceForeground(
	sequence: CoordinatedSequence,
): string[] {
	return [
		...sequence.notes.map(
			(note) =>
				`<path class="sequence-note" data-id="${attr(note.id)}" d="${notePath(note.box)}" fill="${NOTE_FILL}" stroke="${NOTE_STROKE}"/>`,
		),
		...sequence.dividers.flatMap((divider) => [
			`<line class="sequence-divider" data-id="${attr(divider.id)}" x1="${n(divider.x1)}" y1="${n(divider.y - 1.5)}" x2="${n(divider.x2)}" y2="${n(divider.y - 1.5)}" stroke="${STROKE}"/>`,
			`<line class="sequence-divider" data-id="${attr(divider.id)}" x1="${n(divider.x1)}" y1="${n(divider.y + 1.5)}" x2="${n(divider.x2)}" y2="${n(divider.y + 1.5)}" stroke="${STROKE}"/>`,
			...(divider.box === undefined
				? []
				: [
						`<rect class="sequence-divider-label" data-for="${attr(divider.id)}" x="${n(divider.box.x)}" y="${n(divider.box.y)}" width="${n(divider.box.width)}" height="${n(divider.box.height)}" fill="#ffffff" stroke="${STROKE}"/>`,
					]),
		]),
		...sequence.destructions.map((destruction) => {
			const { x, y } = destruction.point;
			const h = SEQUENCE_DESTRUCTION_HALF_SIZE;
			return `<path class="sequence-destruction" data-for="${attr(destruction.participantId)}" d="M ${n(x - h)} ${n(y - h)} L ${n(x + h)} ${n(y + h)} M ${n(x - h)} ${n(y + h)} L ${n(x + h)} ${n(y - h)}" fill="none" stroke="${TEXT_FILL}" stroke-width="2"/>`;
		}),
	];
}

/** An actor head: the stick figure (its name is the node label). */
export function renderActor(node: CoordinatedNode): string {
	const figure = actorFigure(node.box);
	const stroke = node.style?.stroke ?? STROKE;
	const d = figure.lines
		.map(([from, to]) => `M ${n(from.x)} ${n(from.y)} L ${n(to.x)} ${n(to.y)}`)
		.join(" ");
	return [
		`<g class="node node-actor" data-id="${attr(node.id)}" fill="none" stroke="${attr(stroke)}" stroke-width="1.5">`,
		`  <circle cx="${n(figure.head.cx)}" cy="${n(figure.head.cy)}" r="${n(figure.head.r)}" fill="${attr(node.style?.fill ?? "#ffffff")}"/>`,
		`  <path d="${d}"/>`,
		"</g>",
	].join("\n");
}

/** A solved sequence text: each line at its own box and baseline. */
export function renderSequenceText(annotation: SolvedTextAnnotation): string[] {
	const head = `<text class="${annotation.surfaceKind}" data-for="${attr(annotation.ownerId)}" data-text-surface="${attr(annotation.surfaceKind)}" data-text-backend="${attr(annotation.textBackend ?? "deterministic")}" font-family="${attr(annotation.fontFamily)}" font-size="${n(annotation.fontSize)}" fill="${TEXT_FILL}"`;
	if (annotation.lines.length === 0) {
		return [
			`${head} x="${n(annotation.box.x)}" y="${n(annotation.box.y + annotation.box.height)}">${text(annotation.text)}</text>`,
		];
	}
	return [
		`${head}>`,
		...annotation.lines.map(
			(line) =>
				`  <tspan x="${n(annotation.box.x + line.box.x)}" y="${n(annotation.box.y + line.baselineY)}">${text(line.text)}</tspan>`,
		),
		"</text>",
	];
}

function notePath(box: Box): string {
	const outline = noteOutlinePoints(box, SEQUENCE_NOTE_FOLD);
	const fold = SEQUENCE_NOTE_FOLD;
	const corner = { x: box.x + box.width - fold, y: box.y };
	return `M ${outline.map((point) => `${n(point.x)} ${n(point.y)}`).join(" L ")} Z M ${n(corner.x)} ${n(corner.y)} L ${n(corner.x)} ${n(corner.y + fold)} L ${n(box.x + box.width)} ${n(corner.y + fold)}`;
}

function points(list: readonly Point[]): string {
	return list.map((point) => `${n(point.x)},${n(point.y)}`).join(" ");
}

function n(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

function text(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function attr(value: string): string {
	return text(value).replace(/"/g, "&quot;");
}
