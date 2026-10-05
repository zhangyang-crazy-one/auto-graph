/**
 * Sequence diagram solver.
 *
 * Time runs down, participants run across. The vertical pass walks the
 * steps in order and gives every row (message, note, divider, fragment
 * header and separator, destruction) its y from the measured heights of
 * its text alone, tracking activation bars as it goes. The horizontal pass
 * then spaces the lifelines just far enough apart for everything that has
 * to fit between or beside them: heads, message labels, self-call loops,
 * notes, and the borders of nested fragments. Nothing is placed by a
 * general graph layout, so the result is a valid UML sequence diagram by
 * construction: messages are horizontal and in order, fragments nest, and
 * no two text boxes overlap.
 */
import {
	ACTOR_FIGURE_HEIGHT,
	computeShapeGeometry,
	unionBoxes,
} from "../geometry/index.js";
import type { Diagnostic } from "../ir/diagnostics.js";
import type { CoordinatedDiagram, NormalizedDiagram } from "../ir/diagram.js";
import type {
	CoordinatedEdge,
	CoordinatedNode,
	Label,
	NormalizedEdge,
	NormalizedNode,
} from "../ir/elements.js";
import type { Box, Point } from "../ir/geometry.js";
import type { LabelLayout, SolvedTextAnnotation } from "../ir/label-layout.js";
import {
	type CoordinatedActivation,
	type CoordinatedDestruction,
	type CoordinatedFragment,
	type CoordinatedLifeline,
	type CoordinatedSequence,
	type CoordinatedSequenceDivider,
	type CoordinatedSequenceNote,
	SEQUENCE_ACTIVATION_HALF_WIDTH,
	SEQUENCE_DESTRUCTION_HALF_SIZE,
	type SequenceFragmentKind,
	type SequenceMessageStep,
	type SequenceNoteStep,
	type SequenceParticipantKind,
	type SequenceSpec,
	type SequenceStep,
	SEQUENCE_TAG_CUT as TAG_CUT,
} from "../ir/sequence.js";
import { fitLabel, translateLabelLayout } from "../labels/index.js";
import type { TextMeasurer, TextStyleOptions } from "../text/index.js";
import { createDefaultTextMeasurer } from "../text/index.js";
import {
	createCjkTypographyOptions,
	enhanceEdgeCjkTypography,
	enhanceNodeCjkTypography,
	typographyForLabel,
	typographyTextStyle,
} from "./cjk-typography.js";
import { coordinateFrame } from "./coordinate.js";
import {
	cloneNormalizedNodeForSolver,
	recenterNodeLabelLayout,
	reportPageOverflow,
} from "./helpers.js";
import {
	buildCenteredTextAnnotation,
	buildTextAnnotation,
	coordinateBaseTextAnnotations,
	coordinateFrameTextAnnotation,
} from "./labels.js";
import type { SolveDiagramOptions } from "./options.js";
import { buildDeliverabilityReport } from "./remediation.js";

const BAR = SEQUENCE_ACTIVATION_HALF_WIDTH;
/** Least room between two neighbouring heads. */
const HEAD_GAP = 32;
/** Least room between things drawn beside neighbouring lifelines. */
const SIDE_CLEARANCE = 12;
/** Room between a message label and the arrow ends on either side. */
const LABEL_PAD = 10;
/** Gap between a message label's bottom and its arrow. */
const LABEL_RISE = 4;
/** Gap below each row before the next one. */
const ROW_GAP = 14;
/** Gap between the heads and the first row. */
const FIRST_GAP = 18;
/** Lifeline left below the last row. */
const FOOT = 18;
const SELF_WIDTH = 30;
const SELF_HEIGHT = 18;
/** Height of the short bar a self call starts. */
const SELF_ACTIVATION_HEIGHT = 16;
const SELF_LABEL_GAP = 6;
/** Shortest drawn activation bar. */
const MIN_ACTIVATION_HEIGHT = 12;
const NOTE_GAP = 10;
/** How far a note over two lifelines reaches past each. */
const NOTE_OVERHANG = 16;
const NOTE_PADDING = { top: 6, right: 10, bottom: 6, left: 10 };
const NOTE_MAX_WIDTH = 180;
/** Fragment border beyond what it encloses, per nesting level. */
const FRAGMENT_PAD = 12;
const TAG_PAD_X = 6;
const TAG_PAD_Y = 3;
const GUARD_GAP = 8;
/** Room below a fragment header or separator before its first row. */
const OPERAND_TOP_GAP = 8;
const REF_PAD = 12;
const ACTOR_FIGURE_WIDTH = 24;
const ACTOR_LABEL_GAP = 4;

const MESSAGE_FONT: TextStyleOptions = {
	fontFamily: "Arial",
	fontSize: 12,
	lineHeight: 14,
};
const NOTE_FONT: TextStyleOptions = {
	fontFamily: "Arial",
	fontSize: 12,
	lineHeight: 14,
};
const TAG_FONT: TextStyleOptions = {
	fontFamily: "Arial",
	fontSize: 11,
	lineHeight: 13,
};
const HEAD_FONT: TextStyleOptions = {
	fontFamily: "Arial",
	fontSize: 14,
	lineHeight: 18,
};
const MESSAGE_MAX_WIDTH = 220;
const GUARD_MAX_WIDTH = 260;

interface Participant {
	id: string;
	index: number;
	kind: SequenceParticipantKind;
	node: NormalizedNode;
	width: number;
	/** y of the head's centre when a message creates it. */
	createdAt?: number;
	destroyedAt?: number;
}

interface Activation {
	id: string;
	participant: number;
	depth: number;
	top: number;
	bottom: number;
	/** False while still open in the vertical pass. */
	closed: boolean;
}

interface MessageRow {
	id: string;
	step: SequenceMessageStep;
	edge: NormalizedEdge;
	text?: string;
	layout?: LabelLayout;
	y: number;
	from: number;
	to: number;
	/** Depth of the sender's top bar when it is sent; -1 for none. */
	fromDepth: number;
	/** Depth of the receiver's top bar when it arrives; -1 for none. */
	toDepth: number;
	/** Participants it passes whose bars are active then, by top depth. */
	busy: Map<number, number>;
	fragments: string[];
}

interface NoteRow {
	id: string;
	step: SequenceNoteStep;
	layout: LabelLayout;
	top: number;
	height: number;
	participants: number[];
	/** Top bar depth of each listed participant at the note. */
	depths: number[];
	fragments: string[];
}

interface DividerRow {
	id: string;
	y: number;
	layout?: LabelLayout;
	height: number;
}

interface FragmentRow {
	id: string;
	kind: SequenceFragmentKind;
	top: number;
	bottom: number;
	tag: LabelLayout;
	/** Separator y (operands after the first) and guard layout. */
	operands: { top: number; guard?: LabelLayout; guardText?: string }[];
	/** Participant indices it encloses. */
	participants: Set<number>;
	parent?: string;
	depth: number;
	/** `ref` only: the interaction it names. */
	text?: LabelLayout;
}

/** How far past a lifeline something attached to it reaches. */
interface Attachment {
	participant: number;
	left: number;
	right: number;
	/**
	 * Fragments the row lies in; undefined for an activation bar, which
	 * counts for every fragment its time span overlaps.
	 */
	fragments?: string[];
	top: number;
	bottom: number;
}

interface VerticalPass {
	messages: MessageRow[];
	notes: NoteRow[];
	dividers: DividerRow[];
	fragments: FragmentRow[];
	activations: Activation[];
	destructions: { participant: number; y: number }[];
	attachments: Attachment[];
	bottom: number;
}

/** Offset from the lifeline of the right edge of a bar at `depth`. */
function rightEdge(depth: number): number {
	return depth < 0 ? 0 : (depth + 1) * BAR;
}

/** Offset from the lifeline of the left edge of a bar at `depth`. */
function leftEdge(depth: number): number {
	return depth < 0 ? 0 : (depth - 1) * BAR;
}

export function solveSequenceDiagram(
	diagram: NormalizedDiagram & { sequence: SequenceSpec },
	options: SolveDiagramOptions = {},
): CoordinatedDiagram {
	const sequence = diagram.sequence;
	const measurer = options.textMeasurer ?? createDefaultTextMeasurer();
	const diagnostics: Diagnostic[] = [...diagram.diagnostics];
	// A sequence diagram draws its messages, not graph edges or containers.
	for (const [key, count] of [
		["edges", diagram.edges.length],
		["groups", diagram.groups.length],
		["swimlanes", diagram.swimlanes?.length ?? 0],
	] as const) {
		if (count === 0) continue;
		diagnostics.push({
			severity: "warning",
			code: "sequence.ignored",
			message: `A sequence diagram does not draw ${key}; ${count} ${key === "edges" ? "edge" : key.slice(0, -1)}${count === 1 ? " is" : "s are"} ignored.`,
			path: [key],
			detail: { key, count },
		});
	}
	const typography = createCjkTypographyOptions(options);
	const nodeById = new Map(
		diagram.nodes.map((node) => [
			node.id,
			enhanceNodeCjkTypography(
				cloneNormalizedNodeForSolver(node),
				typography,
				diagnostics,
			),
		]),
	);
	const participants: Participant[] = [];
	for (const entry of sequence.participants) {
		const node = nodeById.get(entry.id);
		if (node === undefined) continue;
		participants.push({
			id: entry.id,
			index: participants.length,
			kind: entry.kind,
			node,
			width: 0,
		});
	}
	const indexOf = new Map(participants.map((p) => [p.id, p.index]));

	// Heads: one height for all, so the lifelines start level.
	const actorLabels = new Map<string, LabelLayout>();
	for (const participant of participants) {
		if (participant.kind === "actor") {
			const layout = fitLabel(
				participant.node.label?.text ?? participant.id,
				{
					font: typographyTextStyle(participant.node.label, HEAD_FONT),
					padding: 0,
					maxWidth: 160,
					align: "center",
				},
				measurer,
			);
			actorLabels.set(participant.id, layout);
			participant.width = Math.max(layout.box.width, ACTOR_FIGURE_WIDTH + 12);
		} else {
			participant.width = participant.node.size.width;
		}
	}
	const headHeight = Math.max(
		40,
		...participants.map((participant) => {
			const actor = actorLabels.get(participant.id);
			return actor === undefined
				? participant.node.size.height
				: ACTOR_FIGURE_HEIGHT + ACTOR_LABEL_GAP + actor.box.height;
		}),
	);

	const vertical = layOutRows(
		sequence,
		participants,
		indexOf,
		headHeight,
		measurer,
		typography,
		diagnostics,
	);
	const xs = spaceLifelines(participants, vertical);

	// Heads and lifelines.
	const nodes: CoordinatedNode[] = [];
	const lifelines: CoordinatedLifeline[] = [];
	for (const participant of participants) {
		const x = xs[participant.index] ?? 0;
		const top =
			participant.createdAt === undefined
				? 0
				: participant.createdAt - headHeight / 2;
		const box: Box = {
			x: x - participant.width / 2,
			y: top,
			width: participant.width,
			height: headHeight,
		};
		const node = cloneNormalizedNodeForSolver(participant.node);
		const actor = actorLabels.get(participant.id);
		if (actor !== undefined) {
			// The figure on top, the name below it.
			node.labelLayout = translateLabelLayout(
				actor,
				(box.width - actor.box.width) / 2 - actor.box.x,
				box.height - actor.box.height - actor.box.y,
			);
		} else {
			recenterNodeLabelLayout(node, box);
		}
		const geometry = computeShapeGeometry({
			shape: node.shape,
			box,
			obstacleMargin: 0,
		});
		nodes.push({
			id: node.id,
			...(node.label === undefined ? {} : { label: node.label }),
			...(node.style === undefined ? {} : { style: node.style }),
			...(node.labelLayout === undefined
				? {}
				: { labelLayout: node.labelLayout }),
			shape: node.shape,
			metadata: {
				...(node.metadata ?? {}),
				sequenceParticipant: participant.kind,
			},
			box: geometry.box,
			anchors: geometry.anchors,
		});
		lifelines.push({
			participantId: participant.id,
			kind: participant.kind,
			x,
			top: top + headHeight,
			bottom: participant.destroyedAt ?? vertical.bottom,
			headBox: box,
			created: participant.createdAt !== undefined,
			destroyed: participant.destroyedAt !== undefined,
		});
	}
	const headOf = (index: number) => nodes[index]?.box;
	const xOf = (index: number) => xs[index] ?? 0;

	const activations: CoordinatedActivation[] = vertical.activations.map(
		(activation) => {
			const x = xOf(activation.participant) + activation.depth * BAR;
			return {
				id: activation.id,
				participantId: participants[activation.participant]?.id ?? "",
				depth: activation.depth,
				box: {
					x: x - BAR,
					y: activation.top,
					width: 2 * BAR,
					height: Math.max(0, activation.bottom - activation.top),
				},
			};
		},
	);

	// Messages.
	const edges: CoordinatedEdge[] = [];
	const edgeAnnotations: SolvedTextAnnotation[] = [];
	for (const row of vertical.messages) {
		const fromX = xOf(row.from);
		const toX = xOf(row.to);
		let points: Point[];
		let labelCenter: Point | undefined;
		if (row.from === row.to) {
			const start = fromX + rightEdge(row.fromDepth);
			const back = fromX + rightEdge(row.toDepth);
			const outer = Math.max(start, back) + SELF_WIDTH;
			points = [
				{ x: start, y: row.y },
				{ x: outer, y: row.y },
				{ x: outer, y: row.y + SELF_HEIGHT },
				{ x: back, y: row.y + SELF_HEIGHT },
			];
			if (row.layout !== undefined) {
				labelCenter = {
					x: outer + SELF_LABEL_GAP + row.layout.box.width / 2,
					y: row.y + SELF_HEIGHT / 2,
				};
			}
		} else {
			const rightward = toX > fromX;
			const start =
				fromX +
				(rightward ? rightEdge(row.fromDepth) : leftEdge(row.fromDepth));
			const head = headOf(row.to);
			const end =
				row.step.kind === "create" && head !== undefined
					? rightward
						? head.x
						: head.x + head.width
					: toX + (rightward ? leftEdge(row.toDepth) : rightEdge(row.toDepth));
			points = [
				{ x: start, y: row.y },
				{ x: end, y: row.y },
			];
			if (row.layout !== undefined) {
				labelCenter = {
					x: messageLabelX(row, xs, participants),
					y: row.y - LABEL_RISE - row.layout.box.height / 2,
				};
			}
		}
		const label: Label | undefined =
			row.text === undefined
				? undefined
				: { ...(row.edge.label ?? {}), text: row.text };
		edges.push({
			id: row.id,
			source: { nodeId: participants[row.from]?.id ?? "" },
			target: { nodeId: participants[row.to]?.id ?? "" },
			...(label === undefined ? {} : { label }),
			...(row.step.kind === "reply" || row.step.kind === "create"
				? { style: "dashed" as const }
				: {}),
			arrowhead: row.step.kind === "sync" ? "triangle" : "open",
			metadata: { sequenceMessage: row.step.kind },
			points,
			...(labelCenter === undefined ? {} : { labelPosition: labelCenter }),
		});
		if (row.layout !== undefined && labelCenter !== undefined) {
			edgeAnnotations.push(
				buildCenteredTextAnnotation({
					ownerId: row.id,
					surfaceKind: "edge-label",
					layout: row.layout,
					typography: typographyForLabel(row.edge.label),
					center: labelCenter,
				}),
			);
		}
	}

	// Notes.
	const notes: CoordinatedSequenceNote[] = [];
	const sequenceAnnotations: SolvedTextAnnotation[] = [];
	for (const note of vertical.notes) {
		const box = noteBox(note, xs);
		notes.push({
			id: note.id,
			position: note.step.position,
			participants: note.participants.map(
				(index) => participants[index]?.id ?? "",
			),
			box,
		});
		sequenceAnnotations.push(
			buildTextAnnotation({
				ownerId: note.id,
				surfaceKind: "sequence-note",
				layout: note.layout,
				anchor: box,
			}),
		);
	}

	// Fragments (and refs), outermost first so nested ones paint on top.
	const extents = fragmentExtents(vertical, participants.length);
	const fragments: CoordinatedFragment[] = [];
	for (const fragment of vertical.fragments) {
		const extent = extents.get(fragment.id);
		if (extent === undefined) continue;
		const left = xOf(extent.lo) - extent.left;
		const right = xOf(extent.hi) + extent.right;
		const box: Box = {
			x: left,
			y: fragment.top,
			width: right - left,
			height: fragment.bottom - fragment.top,
		};
		const tagBox: Box = {
			x: box.x,
			y: box.y,
			width: fragment.tag.box.width + 2 * TAG_PAD_X + TAG_CUT,
			height: fragment.tag.box.height + 2 * TAG_PAD_Y,
		};
		fragments.push({
			id: fragment.id,
			kind: fragment.kind,
			box,
			tagBox,
			operands: fragment.operands.map((operand) => ({
				top: operand.top,
				...(operand.guardText === undefined
					? {}
					: { guard: operand.guardText }),
			})),
			depth: fragment.depth,
		});
		sequenceAnnotations.push(
			buildTextAnnotation({
				ownerId: fragment.id,
				surfaceKind: "fragment-tag",
				layout: fragment.tag,
				anchor: {
					x: tagBox.x + TAG_PAD_X - fragment.tag.box.x,
					y: tagBox.y + TAG_PAD_Y - fragment.tag.box.y,
					width: fragment.tag.box.width,
					height: fragment.tag.box.height,
				},
			}),
		);
		fragment.operands.forEach((operand, index) => {
			if (operand.guard === undefined) return;
			const y =
				index === 0
					? box.y + (tagBox.height - operand.guard.box.height) / 2
					: operand.top + 4;
			const x = clearOfBars(
				index === 0
					? tagBox.x + tagBox.width + GUARD_GAP
					: box.x + TAG_PAD_X + TAG_CUT,
				y,
				operand.guard.box,
				box,
				activations,
			);
			sequenceAnnotations.push(
				buildTextAnnotation({
					ownerId: fragment.id,
					surfaceKind: "fragment-guard",
					surfaceIndex: index,
					layout: operand.guard,
					anchor: {
						x: x - operand.guard.box.x,
						y: y - operand.guard.box.y,
						width: operand.guard.box.width,
						height: operand.guard.box.height,
					},
				}),
			);
		});
		if (fragment.text !== undefined) {
			const text = fragment.text;
			const top = tagBox.y + tagBox.height + 4;
			sequenceAnnotations.push(
				buildTextAnnotation({
					ownerId: fragment.id,
					surfaceKind: "sequence-note",
					layout: text,
					anchor: {
						x: box.x + (box.width - text.box.width) / 2 - text.box.x,
						y:
							top +
							(box.y + box.height - top - text.box.height) / 2 -
							text.box.y,
						width: text.box.width,
						height: text.box.height,
					},
				}),
			);
		}
	}

	const destructions: CoordinatedDestruction[] = vertical.destructions.map(
		(destruction) => ({
			participantId: participants[destruction.participant]?.id ?? "",
			point: { x: xOf(destruction.participant), y: destruction.y },
		}),
	);

	const nodeAnnotations = coordinateBaseTextAnnotations({
		nodes,
		groups: [],
		swimlanes: [],
		textMeasurer: measurer,
	});

	// Everything but the dividers, which run across all of it.
	const drawn = unionBoxes([
		...nodes.map((node) => node.box),
		...lifelines.map((lifeline) => ({
			x: lifeline.x - BAR,
			y: lifeline.top,
			width: 2 * BAR,
			height: Math.max(0, lifeline.bottom - lifeline.top),
		})),
		...activations.map((activation) => activation.box),
		...edges.map((edge) => pointsBox(edge.points)),
		...edgeAnnotations.map((annotation) => annotation.box),
		...notes.map((note) => note.box),
		...fragments.map((fragment) => fragment.box),
		...sequenceAnnotations.map((annotation) => annotation.box),
		...destructions.map((destruction) => ({
			x: destruction.point.x - SEQUENCE_DESTRUCTION_HALF_SIZE,
			y: destruction.point.y - SEQUENCE_DESTRUCTION_HALF_SIZE,
			width: 2 * SEQUENCE_DESTRUCTION_HALF_SIZE,
			height: 2 * SEQUENCE_DESTRUCTION_HALF_SIZE,
		})),
	]);
	const dividers: CoordinatedSequenceDivider[] = [];
	for (const divider of vertical.dividers) {
		const layout = divider.layout;
		const textWidth = layout === undefined ? 0 : layout.box.width + 16;
		const center = drawn.x + drawn.width / 2;
		const x1 = Math.min(drawn.x, center - textWidth / 2 - 8);
		const x2 = Math.max(drawn.x + drawn.width, center + textWidth / 2 + 8);
		const box =
			layout === undefined
				? undefined
				: {
						x: center - textWidth / 2,
						y: divider.y - divider.height / 2,
						width: textWidth,
						height: divider.height,
					};
		dividers.push({
			id: divider.id,
			y: divider.y,
			x1,
			x2,
			...(box === undefined ? {} : { box }),
		});
		if (layout !== undefined && box !== undefined) {
			sequenceAnnotations.push(
				buildTextAnnotation({
					ownerId: divider.id,
					surfaceKind: "sequence-divider",
					layout,
					anchor: {
						x: box.x + (box.width - layout.box.width) / 2 - layout.box.x,
						y: box.y + (box.height - layout.box.height) / 2 - layout.box.y,
						width: layout.box.width,
						height: layout.box.height,
					},
				}),
			);
		}
	}

	const textAnnotationsBase = [
		...nodeAnnotations,
		...edgeAnnotations,
		...sequenceAnnotations,
	];
	diagnostics.push(...reportSequenceTextOverlaps(textAnnotationsBase));

	const content = unionBoxes([
		drawn,
		...dividers.map((divider) => ({
			x: divider.x1,
			y: divider.y - 2,
			width: divider.x2 - divider.x1,
			height: 4,
		})),
	]);
	const frame =
		diagram.frame === undefined
			? undefined
			: coordinateFrame(diagram.frame, content);
	const textAnnotations =
		frame === undefined
			? textAnnotationsBase
			: [
					...textAnnotationsBase,
					coordinateFrameTextAnnotation(frame, options.textMeasurer),
				];
	const bounds =
		frame === undefined
			? content
			: unionBoxes([content, frame.box, frame.titleBox]);
	diagnostics.push(...reportPageOverflow(bounds, options.pageBounds));
	const deliverability = buildDeliverabilityReport(diagnostics, options);

	const coordinatedSequence: CoordinatedSequence = {
		lifelines,
		activations,
		fragments,
		notes,
		dividers,
		destructions,
		messageOrder: vertical.messages.map((row) => row.id),
	};
	return {
		id: diagram.id,
		...(diagram.title === undefined ? {} : { title: diagram.title }),
		direction: diagram.direction,
		nodes,
		edges,
		groups: [],
		diagnostics,
		degraded: deliverability.degraded,
		deliverability,
		bounds,
		...(frame === undefined ? {} : { frame }),
		textAnnotations,
		sequence: coordinatedSequence,
		...(diagram.metadata === undefined ? {} : { metadata: diagram.metadata }),
	};
}

/**
 * The vertical pass: every row's y, the activation bars, and what each
 * row attaches beside its lifelines (for the horizontal pass).
 */
function layOutRows(
	sequence: SequenceSpec,
	participants: Participant[],
	indexOf: ReadonlyMap<string, number>,
	headHeight: number,
	measurer: TextMeasurer,
	typography: ReturnType<typeof createCjkTypographyOptions>,
	diagnostics: Diagnostic[],
): VerticalPass {
	const pass: VerticalPass = {
		messages: [],
		notes: [],
		dividers: [],
		fragments: [],
		activations: [],
		destructions: [],
		attachments: [],
		bottom: 0,
	};
	const open = new Map<number, Activation[]>();
	const stack = (index: number) => {
		let list = open.get(index);
		if (list === undefined) {
			list = [];
			open.set(index, list);
		}
		return list;
	};
	const topDepth = (index: number) => stack(index).at(-1)?.depth ?? -1;
	const usedIds = new Set<string>();
	const uniqueId = (wanted: string | undefined, prefix: string, n: number) => {
		let id = wanted ?? `${prefix}${n}`;
		let suffix = 2;
		while (usedIds.has(id)) {
			id = `${wanted ?? `${prefix}${n}`}~${suffix}`;
			suffix += 1;
		}
		if (wanted !== undefined && id !== wanted) {
			diagnostics.push({
				severity: "warning",
				code: "sequence.id.duplicate",
				message: `Sequence id "${wanted}" is used twice; the repeat is "${id}".`,
				path: ["sequence", "steps"],
			});
		}
		usedIds.add(id);
		return id;
	};
	let messageCount = 0;
	let noteCount = 0;
	let fragmentCount = 0;
	let dividerCount = 0;
	let activationCount = 0;
	let cursor = headHeight + FIRST_GAP;
	/** The last message, for `activate` / `deactivate` right after it. */
	let lastMessage: MessageRow | undefined;
	const fragmentStack: FragmentRow[] = [];

	const activate = (index: number, top: number) => {
		const list = stack(index);
		const activation: Activation = {
			id: `activation-${++activationCount}`,
			participant: index,
			depth: list.length,
			top,
			bottom: top,
			closed: false,
		};
		list.push(activation);
		pass.activations.push(activation);
		return activation;
	};
	const deactivate = (index: number, bottom: number) => {
		const activation = stack(index).pop();
		if (activation === undefined) return false;
		activation.bottom = Math.max(
			bottom,
			activation.top + MIN_ACTIVATION_HEIGHT,
		);
		activation.closed = true;
		return true;
	};
	const touch = (indices: readonly number[]) => {
		for (const fragment of fragmentStack) {
			for (const index of indices) fragment.participants.add(index);
		}
	};
	const enclosing = () => fragmentStack.map((fragment) => fragment.id);
	// CJK text gets the CJK font stack and size, as message labels do.
	const styled = (text: string, base: TextStyleOptions) =>
		typographyTextStyle(
			enhanceEdgeCjkTypography(
				{
					id: "",
					source: { nodeId: "" },
					target: { nodeId: "" },
					label: { text },
				},
				typography,
				[],
			).label,
			base,
		);
	const fitText = (text: string, font: TextStyleOptions, maxWidth: number) =>
		fitLabel(
			text,
			{ font: styled(text, font), padding: 0, maxWidth },
			measurer,
		);

	const visit = (steps: readonly SequenceStep[], path: (string | number)[]) => {
		steps.forEach((step, stepIndex) => {
			const at = [...path, stepIndex];
			switch (step.type) {
				case "message": {
					const from = indexOf.get(step.from);
					const to = indexOf.get(step.to);
					if (from === undefined || to === undefined) return;
					messageCount += 1;
					const id = uniqueId(step.id, "m", messageCount);
					const text = sequence.autonumber
						? step.text === undefined || step.text === ""
							? `${messageCount}`
							: `${messageCount}. ${step.text}`
						: step.text;
					const edge = enhanceEdgeCjkTypography(
						{
							id,
							source: { nodeId: step.from },
							target: { nodeId: step.to },
							...(text === undefined ? {} : { label: { text } }),
						},
						typography,
						diagnostics,
					);
					const layout =
						text === undefined || text === ""
							? undefined
							: fitText(
									text,
									typographyTextStyle(edge.label, MESSAGE_FONT),
									MESSAGE_MAX_WIDTH,
								);
					const labelHeight = layout?.box.height ?? 0;
					checkAlive(participants, from, cursor, at, "from", diagnostics);
					if (step.kind !== "create") {
						checkAlive(participants, to, cursor, at, "to", diagnostics);
					}
					const fromDepth = topDepth(from);
					const busy = new Map<number, number>();
					for (
						let index = Math.min(from, to) + 1;
						index < Math.max(from, to);
						index += 1
					) {
						if (stack(index).length > 0) busy.set(index, topDepth(index));
					}
					let y: number;
					let toDepth: number;
					if (from === to) {
						y = Math.max(
							cursor + 6,
							cursor + labelHeight / 2 - SELF_HEIGHT / 2,
						);
						let after = Math.max(
							y + SELF_HEIGHT,
							y + SELF_HEIGHT / 2 + labelHeight / 2,
						);
						const calls =
							(step.kind === "sync" && sequence.autoActivate) ||
							step.activate === true;
						if (calls) {
							const bar = activate(from, y + SELF_HEIGHT - 2);
							toDepth = bar.depth;
							if (step.activate !== true) {
								// A self call's own bar: short, closed at once.
								deactivate(from, bar.top + SELF_ACTIVATION_HEIGHT);
							}
							after = Math.max(after, bar.top + SELF_ACTIVATION_HEIGHT);
						} else {
							toDepth = fromDepth;
						}
						if (step.deactivate === true) deactivate(from, y);
						const right =
							Math.max(rightEdge(fromDepth), rightEdge(toDepth)) + SELF_WIDTH;
						pass.attachments.push({
							participant: from,
							left: fromDepth < 0 ? 0 : BAR,
							right:
								layout === undefined
									? right
									: right + SELF_LABEL_GAP + layout.box.width,
							fragments: enclosing(),
							top: y,
							bottom: y + SELF_HEIGHT,
						});
						cursor = after + ROW_GAP;
					} else if (step.kind === "create") {
						const target = participants[to];
						y = Math.max(
							cursor + labelHeight + LABEL_RISE,
							cursor + headHeight / 2 + LABEL_RISE,
						);
						if (target !== undefined) {
							if (target.createdAt !== undefined) {
								diagnostics.push({
									severity: "warning",
									code: "sequence.create.repeated",
									message: `Participant "${target.id}" is created twice; it starts at the first.`,
									path: [...at, "to"],
								});
							} else {
								target.createdAt = y;
							}
						}
						toDepth = -1;
						if (step.deactivate === true) deactivate(from, y);
						cursor = y + headHeight / 2 + ROW_GAP;
					} else {
						y = cursor + labelHeight + LABEL_RISE;
						const ends =
							step.deactivate === true ||
							(step.kind === "reply" && sequence.autoActivate);
						if (ends) deactivate(from, y);
						const calls =
							(step.kind === "sync" && sequence.autoActivate) ||
							step.activate === true;
						if (calls) activate(to, y);
						toDepth = topDepth(to);
						cursor = y + ROW_GAP;
					}
					const row: MessageRow = {
						id,
						step,
						edge,
						...(text === undefined ? {} : { text }),
						...(layout === undefined ? {} : { layout }),
						y,
						from,
						to,
						fromDepth,
						toDepth,
						busy,
						fragments: enclosing(),
					};
					pass.messages.push(row);
					lastMessage = row;
					touch([from, to]);
					return;
				}
				case "activate": {
					const index = indexOf.get(step.participant);
					if (index === undefined) return;
					const top =
						lastMessage !== undefined && lastMessage.to === index
							? lastMessage.y
							: cursor;
					activate(index, top);
					touch([index]);
					return;
				}
				case "deactivate": {
					const index = indexOf.get(step.participant);
					if (index === undefined) return;
					const bottom =
						lastMessage !== undefined && lastMessage.from === index
							? lastMessage.y
							: cursor;
					if (!deactivate(index, bottom)) {
						diagnostics.push({
							severity: "warning",
							code: "sequence.activation.unmatched",
							message: `"${step.participant}" is deactivated without an active bar.`,
							path: at,
						});
					}
					touch([index]);
					return;
				}
				case "destroy": {
					const index = indexOf.get(step.participant);
					const participant =
						index === undefined ? undefined : participants[index];
					if (index === undefined || participant === undefined) return;
					const y = cursor + SEQUENCE_DESTRUCTION_HALF_SIZE;
					while (stack(index).length > 0) deactivate(index, y);
					if (participant.destroyedAt === undefined) {
						participant.destroyedAt = y;
						pass.destructions.push({ participant: index, y });
					}
					touch([index]);
					cursor = y + SEQUENCE_DESTRUCTION_HALF_SIZE + ROW_GAP;
					return;
				}
				case "note": {
					const indices = step.participants
						.map((id) => indexOf.get(id))
						.filter((index): index is number => index !== undefined);
					if (indices.length === 0) return;
					noteCount += 1;
					const id = uniqueId(step.id, "note-", noteCount);
					const layout = fitLabel(
						step.text,
						{
							font: styled(step.text, NOTE_FONT),
							padding: NOTE_PADDING,
							maxWidth: NOTE_MAX_WIDTH,
						},
						measurer,
					);
					const height = layout.box.height;
					const depths = indices.map(topDepth);
					const note: NoteRow = {
						id,
						step,
						layout,
						top: cursor,
						height,
						participants: indices,
						depths,
						fragments: enclosing(),
					};
					pass.notes.push(note);
					const width = layout.box.width;
					const first = indices[0] as number;
					const last = indices.at(-1) as number;
					const span = (index: number, left: number, right: number) =>
						pass.attachments.push({
							participant: index,
							left,
							right,
							fragments: enclosing(),
							top: cursor,
							bottom: cursor + height,
						});
					if (step.position === "right") {
						span(first, 0, rightEdge(depths[0] ?? -1) + NOTE_GAP + width);
					} else if (step.position === "left") {
						span(
							first,
							(depths[0] ?? -1) < 0 ? NOTE_GAP + width : BAR + NOTE_GAP + width,
							0,
						);
					} else if (first === last) {
						span(first, width / 2, width / 2);
					} else {
						const lo = Math.min(first, last);
						const hi = Math.max(first, last);
						span(lo, NOTE_OVERHANG, 0);
						span(hi, 0, NOTE_OVERHANG);
					}
					touch(indices);
					cursor += height + ROW_GAP;
					return;
				}
				case "divider": {
					dividerCount += 1;
					const id = uniqueId(undefined, "divider-", dividerCount);
					const layout =
						step.text === undefined || step.text === ""
							? undefined
							: fitText(step.text, MESSAGE_FONT, MESSAGE_MAX_WIDTH);
					const height = Math.max(8, (layout?.box.height ?? 0) + 8);
					pass.dividers.push({
						id,
						y: cursor + height / 2,
						...(layout === undefined ? {} : { layout }),
						height,
					});
					cursor += height + ROW_GAP;
					return;
				}
				case "fragment":
				case "ref": {
					fragmentCount += 1;
					const id = uniqueId(
						step.id,
						`${step.type === "ref" ? "ref" : "fragment"}-`,
						fragmentCount,
					);
					const kind = step.type === "ref" ? "ref" : step.kind;
					const tag = fitText(kind, TAG_FONT, 120);
					const parent = fragmentStack.at(-1);
					const fragment: FragmentRow = {
						id,
						kind,
						top: cursor,
						bottom: cursor,
						tag,
						operands: [],
						participants: new Set(),
						...(parent === undefined ? {} : { parent: parent.id }),
						depth: fragmentStack.length,
					};
					pass.fragments.push(fragment);
					const tagHeight = tag.box.height + 2 * TAG_PAD_Y;
					if (step.type === "ref") {
						const text = fitText(step.text, MESSAGE_FONT, MESSAGE_MAX_WIDTH);
						fragment.text = text;
						const indices = step.participants
							.map((participant) => indexOf.get(participant))
							.filter((index): index is number => index !== undefined);
						for (const index of indices) fragment.participants.add(index);
						touch(indices);
						fragment.operands.push({ top: cursor });
						cursor += tagHeight + 4 + text.box.height + 10;
						fragment.bottom = cursor;
						cursor += ROW_GAP;
						return;
					}
					fragmentStack.push(fragment);
					// Operands are alternatives (or run side by side): each one
					// starts from the bars open when the fragment starts.
					const atStart = new Map(
						participants.map((participant) => [
							participant.index,
							[...stack(participant.index)],
						]),
					);
					const restore = (y: number) => {
						for (const [index, before] of atStart) {
							const now = stack(index);
							let common = 0;
							while (
								common < now.length &&
								common < before.length &&
								now[common] === before[common]
							) {
								common += 1;
							}
							while (now.length > common) deactivate(index, y);
							for (const _ of before.slice(common)) activate(index, y);
						}
					};
					step.operands.forEach((operand, operandIndex) => {
						const guardText =
							operand.guard === undefined || operand.guard === ""
								? undefined
								: /^\[.*\]$/s.test(operand.guard)
									? operand.guard
									: `[${operand.guard}]`;
						const guard =
							guardText === undefined
								? undefined
								: fitText(guardText, TAG_FONT, GUARD_MAX_WIDTH);
						const top = operandIndex === 0 ? fragment.top : cursor;
						if (operandIndex > 0) restore(top);
						fragment.operands.push({
							top,
							...(guard === undefined || guardText === undefined
								? {}
								: { guard, guardText }),
						});
						cursor =
							operandIndex === 0
								? fragment.top +
									Math.max(tagHeight, (guard?.box.height ?? 0) + 4) +
									OPERAND_TOP_GAP
								: top + 4 + (guard?.box.height ?? 0) + OPERAND_TOP_GAP;
						visit(operand.steps, [...at, "operands", operandIndex, "steps"]);
					});
					fragmentStack.pop();
					// The last row's gap is the fragment's bottom padding.
					fragment.bottom = cursor;
					cursor += ROW_GAP;
					return;
				}
			}
		});
	};
	visit(sequence.steps, ["sequence", "steps"]);
	for (const row of pass.messages) {
		for (const index of [row.from, row.to]) {
			const participant = participants[index];
			if (
				participant?.createdAt !== undefined &&
				row.y < participant.createdAt
			) {
				diagnostics.push({
					severity: "warning",
					code: "sequence.message.before-create",
					message: `Message "${row.id}" reaches "${participant.id}" before it is created.`,
					path: ["sequence", "steps"],
				});
			}
		}
	}

	// Bars still open run to the end of the diagram.
	pass.bottom = cursor + FOOT;
	for (const [index, list] of open) {
		while (list.length > 0) deactivate(index, cursor);
	}
	for (const activation of pass.activations) {
		pass.attachments.push({
			participant: activation.participant,
			left: BAR,
			right: rightEdge(activation.depth),
			top: activation.top,
			bottom: activation.bottom,
		});
	}
	// A fragment holding nothing spans every participant.
	for (const fragment of pass.fragments) {
		if (fragment.participants.size === 0) {
			for (const participant of participants) {
				fragment.participants.add(participant.index);
			}
		}
	}
	return pass;
}

function checkAlive(
	participants: readonly Participant[],
	index: number,
	y: number,
	path: (string | number)[],
	end: "from" | "to",
	diagnostics: Diagnostic[],
): void {
	const participant = participants[index];
	if (participant === undefined) return;
	if (participant.destroyedAt !== undefined && y >= participant.destroyedAt) {
		diagnostics.push({
			severity: "warning",
			code: "sequence.message.after-destroy",
			message: `A message ${end === "from" ? "from" : "to"} "${participant.id}" comes after it is destroyed.`,
			path: [...path, end],
		});
	}
}

interface FragmentExtent {
	lo: number;
	hi: number;
	/** Border beyond the leftmost / rightmost enclosed lifeline. */
	left: number;
	right: number;
	/** Width its tag and guards need. */
	needed: number;
}

/**
 * How far each fragment's border reaches past its outermost lifelines:
 * past everything attached to those lifelines inside it, and past the
 * borders of nested fragments on the same lifeline, plus its padding.
 * A fragment on one lifeline also widens to fit its tag and guards.
 */
function fragmentExtents(
	pass: VerticalPass,
	participantCount: number,
): Map<string, FragmentExtent> {
	const extents = new Map<string, FragmentExtent>();
	const children = new Map<string, FragmentRow[]>();
	for (const fragment of pass.fragments) {
		if (fragment.parent === undefined) continue;
		const list = children.get(fragment.parent) ?? [];
		list.push(fragment);
		children.set(fragment.parent, list);
	}
	const compute = (fragment: FragmentRow): FragmentExtent => {
		const cached = extents.get(fragment.id);
		if (cached !== undefined) return cached;
		const indices = [...fragment.participants];
		const lo = indices.length === 0 ? 0 : Math.min(...indices);
		const hi =
			indices.length === 0 ? participantCount - 1 : Math.max(...indices);
		let left = 0;
		let right = 0;
		for (const attachment of pass.attachments) {
			const inside =
				attachment.fragments === undefined
					? attachment.top < fragment.bottom && attachment.bottom > fragment.top
					: attachment.fragments.includes(fragment.id);
			if (!inside) continue;
			if (attachment.participant === lo) {
				left = Math.max(left, attachment.left);
			}
			if (attachment.participant === hi) {
				right = Math.max(right, attachment.right);
			}
		}
		for (const child of children.get(fragment.id) ?? []) {
			const extent = compute(child);
			if (extent.lo === lo) left = Math.max(left, extent.left);
			if (extent.hi === hi) right = Math.max(right, extent.right);
		}
		left += FRAGMENT_PAD;
		right += FRAGMENT_PAD;
		const tagWidth = fragment.tag.box.width + 2 * TAG_PAD_X + TAG_CUT;
		const guards = fragment.operands.map(
			(operand) => operand.guard?.box.width ?? 0,
		);
		const needed = Math.max(
			tagWidth + GUARD_GAP + (guards[0] ?? 0) + TAG_PAD_X,
			...guards.slice(1).map((width) => width + 2 * TAG_PAD_X + TAG_CUT),
			fragment.text === undefined ? 0 : fragment.text.box.width + 2 * REF_PAD,
		);
		if (lo === hi) right = Math.max(right, needed - left);
		const extent = { lo, hi, left, right, needed };
		extents.set(fragment.id, extent);
		return extent;
	};
	for (const fragment of pass.fragments) compute(fragment);
	return extents;
}

/**
 * Lifeline x positions: neighbours far enough apart for their heads and
 * what is drawn beside them; then every constraint spanning several gaps
 * (message labels, notes over two lifelines, fragment widths, nested
 * fragment borders), shortest first, its shortfall spread evenly over the
 * gaps it spans. Gaps only grow, so earlier constraints stay met.
 */
function spaceLifelines(
	participants: readonly Participant[],
	pass: VerticalPass,
): number[] {
	const count = participants.length;
	if (count === 0) return [];
	const leftNeed = new Array<number>(count).fill(0);
	const rightNeed = new Array<number>(count).fill(0);
	for (const attachment of pass.attachments) {
		const index = attachment.participant;
		leftNeed[index] = Math.max(leftNeed[index] ?? 0, attachment.left);
		rightNeed[index] = Math.max(rightNeed[index] ?? 0, attachment.right);
	}
	const extents = fragmentExtents(pass, count);
	const spans: { lo: number; hi: number; need: number }[] = [];
	const byId = new Map(
		pass.fragments.map((fragment) => [fragment.id, fragment]),
	);
	for (const fragment of pass.fragments) {
		const extent = extents.get(fragment.id);
		if (extent === undefined) continue;
		leftNeed[extent.lo] = Math.max(leftNeed[extent.lo] ?? 0, extent.left);
		rightNeed[extent.hi] = Math.max(rightNeed[extent.hi] ?? 0, extent.right);
		if (extent.lo < extent.hi) {
			spans.push({
				lo: extent.lo,
				hi: extent.hi,
				need: extent.needed - extent.left - extent.right,
			});
		}
		// A nested fragment's border stays a padding inside its parent's.
		const parent =
			fragment.parent === undefined ? undefined : byId.get(fragment.parent);
		const outer = parent === undefined ? undefined : extents.get(parent.id);
		if (outer !== undefined) {
			if (extent.lo > outer.lo) {
				spans.push({
					lo: outer.lo,
					hi: extent.lo,
					need: extent.left + FRAGMENT_PAD - outer.left,
				});
			}
			if (extent.hi < outer.hi) {
				spans.push({
					lo: extent.hi,
					hi: outer.hi,
					need: extent.right + FRAGMENT_PAD - outer.right,
				});
			}
		}
	}
	for (const row of pass.messages) {
		if (row.from === row.to) continue;
		const segment = labelSegment(row, participants);
		spans.push({
			lo: Math.min(segment.near, segment.far),
			hi: Math.max(segment.near, segment.far),
			need:
				(row.layout?.box.width ?? 0) +
				2 * LABEL_PAD +
				segment.nearExt +
				segment.farExt,
		});
	}
	for (const note of pass.notes) {
		if (note.step.position !== "over" || note.participants.length < 2) {
			continue;
		}
		const lo = Math.min(...note.participants);
		const hi = Math.max(...note.participants);
		if (lo < hi) {
			spans.push({
				lo,
				hi,
				need: note.layout.box.width - 2 * NOTE_OVERHANG,
			});
		}
	}

	const gaps: number[] = [];
	for (let index = 0; index + 1 < count; index += 1) {
		const left = participants[index] as Participant;
		const right = participants[index + 1] as Participant;
		gaps.push(
			Math.max(
				(left.width + right.width) / 2 + HEAD_GAP,
				(rightNeed[index] ?? 0) + (leftNeed[index + 1] ?? 0) + SIDE_CLEARANCE,
			),
		);
	}
	spans.sort(
		(a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || a.need - b.need,
	);
	for (const span of spans) {
		let current = 0;
		for (let index = span.lo; index < span.hi; index += 1) {
			current += gaps[index] ?? 0;
		}
		const shortfall = span.need - current;
		if (shortfall <= 1e-6) continue;
		const share = shortfall / (span.hi - span.lo);
		for (let index = span.lo; index < span.hi; index += 1) {
			gaps[index] = (gaps[index] ?? 0) + share;
		}
	}
	const first = participants[0] as Participant;
	const xs = [Math.max(first.width / 2, leftNeed[0] ?? 0)];
	for (const gap of gaps) xs.push((xs.at(-1) ?? 0) + gap);
	return xs.map(round);
}

/**
 * The stretch of a message where its label goes: from the sender to the
 * first lifeline it passes whose activation bar is active then (a label
 * must not sit on a bar), or to the receiver. `nearExt` / `farExt` are how
 * far into the stretch its ends lie from those lifelines: the arrow's
 * start and end, or the edge of the bar in the way.
 */
function labelSegment(
	row: MessageRow,
	participants: readonly Participant[],
): { near: number; far: number; nearExt: number; farExt: number } {
	const step = row.to > row.from ? 1 : -1;
	// Clear of every bar on the end lifelines, not only the innermost one
	// the arrow meets: nested bars stack rightwards, so the outermost bar
	// reaches furthest left and the innermost furthest right.
	const outerLeft = (depth: number) => (depth < 0 ? 0 : BAR);
	const nearExt =
		step > 0 ? rightEdge(row.fromDepth) : outerLeft(row.fromDepth);
	for (let index = row.from + step; index !== row.to; index += step) {
		const depth = row.busy.get(index);
		if (depth === undefined) continue;
		return {
			near: row.from,
			far: index,
			nearExt,
			// Nested bars stack rightwards from the outermost one.
			farExt: step > 0 ? BAR : rightEdge(depth),
		};
	}
	const target = participants[row.to];
	return {
		near: row.from,
		far: row.to,
		nearExt,
		farExt:
			row.step.kind === "create" && target !== undefined
				? target.width / 2
				: step > 0
					? outerLeft(row.toDepth)
					: rightEdge(row.toDepth),
	};
}

/**
 * Where a message label sits along its arrow: in its label stretch (see
 * `labelSegment`), over the first gap from the sender when it fits there,
 * so it reads next to where the arrow starts and does not straddle the
 * lifelines it passes; otherwise centred in the stretch.
 */
function messageLabelX(
	row: MessageRow,
	xs: readonly number[],
	participants: readonly Participant[],
): number {
	const width = row.layout?.box.width ?? 0;
	const step = row.to > row.from ? 1 : -1;
	const segment = labelSegment(row, participants);
	const start = (xs[segment.near] ?? 0) + step * segment.nearExt;
	// (The arrow itself may start further in, at a nested bar.)
	const end = (xs[segment.far] ?? 0) - step * segment.farExt;
	if (Math.abs(segment.far - segment.near) > 1) {
		const next = xs[row.from + step] ?? end;
		const near = next - step * BAR;
		if (Math.abs(near - start) >= width + 2 * LABEL_PAD) {
			return (start + near) / 2;
		}
	}
	return (start + end) / 2;
}

function noteBox(note: NoteRow, xs: readonly number[]): Box {
	const width = note.layout.box.width;
	const first = note.participants[0] as number;
	const x = xs[first] ?? 0;
	const depth = note.depths[0] ?? -1;
	if (note.step.position === "right") {
		return {
			x: x + rightEdge(depth) + NOTE_GAP,
			y: note.top,
			width,
			height: note.height,
		};
	}
	if (note.step.position === "left") {
		return {
			x: x - (depth < 0 ? 0 : BAR) - NOTE_GAP - width,
			y: note.top,
			width,
			height: note.height,
		};
	}
	const lo = Math.min(...note.participants.map((index) => xs[index] ?? 0));
	const hi = Math.max(...note.participants.map((index) => xs[index] ?? 0));
	const span = hi - lo + (lo === hi ? 0 : 2 * NOTE_OVERHANG);
	const drawn = Math.max(width, span);
	return {
		x: (lo + hi) / 2 - drawn / 2,
		y: note.top,
		width: drawn,
		height: note.height,
	};
}

/**
 * The first x from `x` rightwards where a guard of `size` at `y` clears
 * every activation bar, while it still fits in its fragment; otherwise `x`.
 */
function clearOfBars(
	x: number,
	y: number,
	size: { width: number; height: number },
	fragment: Box,
	activations: readonly CoordinatedActivation[],
): number {
	let candidate = x;
	for (let attempt = 0; attempt < activations.length + 1; attempt += 1) {
		const box = { x: candidate, y, width: size.width, height: size.height };
		const hit = activations.find((activation) => overlaps(box, activation.box));
		if (hit === undefined) {
			return candidate + size.width <= fragment.x + fragment.width - TAG_PAD_X
				? candidate
				: x;
		}
		candidate = hit.box.x + hit.box.width + 4;
	}
	return x;
}

function reportSequenceTextOverlaps(
	annotations: readonly SolvedTextAnnotation[],
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (let i = 0; i < annotations.length; i += 1) {
		const a = annotations[i] as SolvedTextAnnotation;
		for (let j = i + 1; j < annotations.length; j += 1) {
			const b = annotations[j] as SolvedTextAnnotation;
			if (a.ownerId === b.ownerId && a.surfaceKind === b.surfaceKind) {
				continue;
			}
			if (!overlaps(a.box, b.box)) continue;
			diagnostics.push({
				severity: "warning",
				code: "sequence.text.overlap",
				message: `Text of ${a.surfaceKind} "${a.ownerId}" overlaps text of ${b.surfaceKind} "${b.ownerId}".`,
				path: ["textAnnotations", a.surfaceKind, a.ownerId],
				detail: {
					ownerId: a.ownerId,
					conflictingObjectId: b.ownerId,
					textSurfaceKind: a.surfaceKind,
					otherSurfaceKind: b.surfaceKind,
				},
			});
		}
	}
	return diagnostics;
}

function overlaps(a: Box, b: Box): boolean {
	const epsilon = 0.01;
	return (
		a.x < b.x + b.width - epsilon &&
		b.x < a.x + a.width - epsilon &&
		a.y < b.y + b.height - epsilon &&
		b.y < a.y + a.height - epsilon
	);
}

function pointsBox(points: readonly Point[]): Box {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return {
		x,
		y,
		width: Math.max(...xs) - x,
		height: Math.max(...ys) - y,
	};
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
