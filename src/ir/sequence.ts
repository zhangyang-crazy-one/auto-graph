import type { Box, Point } from "./geometry.js";

/**
 * Sequence (interaction) diagrams: participants side by side, each with a
 * lifeline running down, and messages between them in time order, top to
 * bottom. The participants are the diagram's nodes (their heads); the
 * messages are its edges; everything else a sequence diagram draws
 * (lifelines, activation bars, combined fragments, notes, dividers,
 * destruction marks) lives in the `sequence` block.
 */

/** How a participant's head is drawn. */
export type SequenceParticipantKind = "participant" | "actor" | "database";

/**
 * - `sync`: a call; filled arrowhead. Activates the receiver when
 *   `autoActivate` is on.
 * - `async`: a signal; open arrowhead.
 * - `reply`: a return; dashed with an open arrowhead. Ends the receiver
 *   side's activation started by the call it answers.
 * - `create`: dashed with an open arrowhead into the head of a participant
 *   that starts there.
 */
export type SequenceMessageKind = "sync" | "async" | "reply" | "create";

/** UML combined-fragment operators, plus `ref` (an interaction use). */
export type SequenceFragmentKind =
	| "alt"
	| "opt"
	| "loop"
	| "par"
	| "break"
	| "critical"
	| "neg"
	| "strict"
	| "seq"
	| "ignore"
	| "consider"
	| "assert"
	| "ref";

export type SequenceNotePosition = "left" | "right" | "over";

export interface SequenceParticipant {
	id: string;
	kind: SequenceParticipantKind;
}

export interface SequenceMessageStep {
	type: "message";
	id?: string;
	from: string;
	to: string;
	text?: string;
	kind: SequenceMessageKind;
	/** Start an activation on the receiver (beyond what autoActivate does). */
	activate?: boolean;
	/** End the sender's innermost activation at this message. */
	deactivate?: boolean;
}

export interface SequenceActivationStep {
	type: "activate" | "deactivate";
	participant: string;
}

export interface SequenceDestroyStep {
	type: "destroy";
	participant: string;
}

export interface SequenceNoteStep {
	type: "note";
	id?: string;
	text: string;
	position: SequenceNotePosition;
	/** One participant, or two for a note spanning them (`over`). */
	participants: string[];
}

export interface SequenceDividerStep {
	type: "divider";
	text?: string;
}

export interface SequenceFragmentOperand {
	guard?: string;
	steps: SequenceStep[];
}

export interface SequenceFragmentStep {
	type: "fragment";
	id?: string;
	kind: Exclude<SequenceFragmentKind, "ref">;
	operands: SequenceFragmentOperand[];
}

/** An interaction use: a box over participants naming another interaction. */
export interface SequenceRefStep {
	type: "ref";
	id?: string;
	text: string;
	participants: string[];
}

export type SequenceStep =
	| SequenceMessageStep
	| SequenceActivationStep
	| SequenceDestroyStep
	| SequenceNoteStep
	| SequenceDividerStep
	| SequenceFragmentStep
	| SequenceRefStep;

export interface SequenceSpec {
	/** Participants left to right; every one is also a node. */
	participants: SequenceParticipant[];
	steps: SequenceStep[];
	/** Sync calls activate their receiver until the matching reply. */
	autoActivate: boolean;
	/** Number messages 1, 2, 3, … in the order they occur. */
	autonumber: boolean;
}

export interface CoordinatedLifeline {
	participantId: string;
	kind: SequenceParticipantKind;
	/** Centre line. */
	x: number;
	/** Where the dashed line starts: the bottom of the head. */
	top: number;
	/** Where it ends: the diagram's foot, or the destruction mark. */
	bottom: number;
	/** The head (the participant node's box). */
	headBox: Box;
	/** True when created by a message: the head sits at that message. */
	created: boolean;
	destroyed: boolean;
}

export interface CoordinatedActivation {
	id: string;
	participantId: string;
	/** 0 for the outermost bar; nested bars shift right. */
	depth: number;
	box: Box;
}

export interface CoordinatedFragmentOperand {
	/** Top of the operand; for all but the first, the dashed separator. */
	top: number;
	guard?: string;
}

export interface CoordinatedFragment {
	id: string;
	kind: SequenceFragmentKind;
	box: Box;
	/** The operator tag in the top-left corner (a pentagon). */
	tagBox: Box;
	operands: CoordinatedFragmentOperand[];
	/** Nesting depth: 0 for a top-level fragment. */
	depth: number;
}

export interface CoordinatedSequenceNote {
	id: string;
	position: SequenceNotePosition;
	participants: string[];
	box: Box;
}

export interface CoordinatedSequenceDivider {
	id: string;
	/** Centre of the double rule. */
	y: number;
	/** From the leftmost to the rightmost drawn content. */
	x1: number;
	x2: number;
	/** The box behind its text, when it has one. */
	box?: Box;
}

export interface CoordinatedDestruction {
	participantId: string;
	point: Point;
}

export interface CoordinatedSequence {
	lifelines: CoordinatedLifeline[];
	activations: CoordinatedActivation[];
	fragments: CoordinatedFragment[];
	notes: CoordinatedSequenceNote[];
	dividers: CoordinatedSequenceDivider[];
	destructions: CoordinatedDestruction[];
	/** Message (edge) ids in time order. */
	messageOrder: string[];
}

/** Half the width of an activation bar, and the shift of a nested bar. */
export const SEQUENCE_ACTIVATION_HALF_WIDTH = 5;
/** Size of the X drawn where a lifeline is destroyed (half its side). */
export const SEQUENCE_DESTRUCTION_HALF_SIZE = 7;
/** How far the folded corner of a note cuts in. */
export const SEQUENCE_NOTE_FOLD = 8;
/** Width of the cut corner of a fragment's operator tag. */
export const SEQUENCE_TAG_CUT = 6;
