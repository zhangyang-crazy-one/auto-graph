import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import {
	exportDrawio,
	exportExcalidraw,
	exportGeometry,
	exportSvg,
	geometryDocumentSchema,
} from "../src/exporters/index.js";
import { ACTOR_FIGURE_WIDTH } from "../src/geometry/index.js";
import { expandViewSource } from "../src/index.js";
import type {
	Box,
	CoordinatedDiagram,
	CoordinatedEdge,
	CoordinatedSequence,
} from "../src/ir/index.js";

const EXAMPLE = readFileSync(
	new URL("../examples/sequence.yaml", import.meta.url),
	"utf8",
);
const VIEW_EXAMPLE = readFileSync(
	new URL("../examples/views/sequence.yaml", import.meta.url),
	"utf8",
);

function solve(source: string): CoordinatedDiagram {
	const result = renderDiagramDsl(source);
	const errors = result.diagnostics.filter(
		(diagnostic) => diagnostic.severity === "error",
	);
	expect(errors).toEqual([]);
	if (result.diagram === undefined) throw new Error("did not solve");
	return result.diagram;
}

function sequenceOf(diagram: CoordinatedDiagram): CoordinatedSequence {
	if (diagram.sequence === undefined) throw new Error("no sequence");
	return diagram.sequence;
}

function edge(diagram: CoordinatedDiagram, id: string): CoordinatedEdge {
	const found = diagram.edges.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no edge ${id}`);
	return found;
}

function overlaps(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width - 0.01 &&
		b.x < a.x + a.width - 0.01 &&
		a.y < b.y + b.height - 0.01 &&
		b.y < a.y + a.height - 0.01
	);
}

function inside(inner: Box, outer: Box, slack = 0.01): boolean {
	return (
		inner.x >= outer.x - slack &&
		inner.y >= outer.y - slack &&
		inner.x + inner.width <= outer.x + outer.width + slack &&
		inner.y + inner.height <= outer.y + outer.height + slack
	);
}

const diagrams: [string, CoordinatedDiagram][] = [
	["full DSL example", solve(EXAMPLE)],
	["view example", solve(VIEW_EXAMPLE)],
];

describe("sequence diagram solver", () => {
	for (const [name, diagram] of diagrams) {
		describe(name, () => {
			const sequence = sequenceOf(diagram);
			const lifelineOf = (id: string) =>
				sequence.lifelines.find((lifeline) => lifeline.participantId === id);

			it("draws messages horizontally, top to bottom in order", () => {
				let last = Number.NEGATIVE_INFINITY;
				for (const id of sequence.messageOrder) {
					const message = edge(diagram, id);
					const y = message.points[0]?.y ?? 0;
					expect(y, id).toBeGreaterThan(last);
					last = y;
					if (message.source.nodeId !== message.target.nodeId) {
						expect(message.points).toHaveLength(2);
						expect(message.points[1]?.y).toBe(y);
					}
				}
			});

			it("starts lifelines at the bottom of their heads, centred under them", () => {
				for (const lifeline of sequence.lifelines) {
					const head = diagram.nodes.find(
						(node) => node.id === lifeline.participantId,
					);
					expect(head).toBeDefined();
					const box = head?.box as Box;
					expect(lifeline.x).toBeCloseTo(box.x + box.width / 2, 6);
					expect(lifeline.top).toBeCloseTo(box.y + box.height, 6);
					expect(lifeline.bottom).toBeGreaterThan(lifeline.top);
				}
				// Heads not created by a message stand level.
				const tops = new Set(
					sequence.lifelines
						.filter((lifeline) => !lifeline.created)
						.map((lifeline) => lifeline.headBox.y),
				);
				expect(tops.size).toBe(1);
			});

			it("keeps every message end on its lifeline, bar or created head", () => {
				for (const id of sequence.messageOrder) {
					const message = edge(diagram, id);
					const ends = [
						[message.source.nodeId, message.points[0]],
						[message.target.nodeId, message.points.at(-1)],
					] as const;
					for (const [participant, point] of ends) {
						const lifeline = lifelineOf(participant);
						expect(lifeline, participant).toBeDefined();
						if (lifeline === undefined || point === undefined) continue;
						const onBar = sequence.activations.some(
							(activation) =>
								activation.participantId === participant &&
								point.y >= activation.box.y - 0.01 &&
								point.y <= activation.box.y + activation.box.height + 0.01 &&
								(Math.abs(point.x - activation.box.x) < 0.01 ||
									Math.abs(point.x - activation.box.x - activation.box.width) <
										0.01),
						);
						const onHead =
							lifeline.created &&
							Math.abs(
								point.y - (lifeline.headBox.y + lifeline.headBox.height / 2),
							) < 0.01;
						const onLine = Math.abs(point.x - lifeline.x) < 0.01;
						expect(onBar || onHead || onLine, `${id} at ${participant}`).toBe(
							true,
						);
					}
				}
			});

			it("overlaps no text with other text or with a head, bar or note", () => {
				expect(
					diagram.diagnostics.filter(
						(diagnostic) => diagnostic.code === "sequence.text.overlap",
					),
				).toEqual([]);
				const texts = diagram.textAnnotations ?? [];
				for (const [index, a] of texts.entries()) {
					for (const b of texts.slice(index + 1)) {
						if (a.ownerId === b.ownerId && a.surfaceKind === b.surfaceKind)
							continue;
						expect(overlaps(a.box, b.box), `${a.ownerId} / ${b.ownerId}`).toBe(
							false,
						);
					}
				}
				const labels = texts.filter(
					(text) => text.surfaceKind === "edge-label",
				);
				for (const label of labels) {
					for (const node of diagram.nodes) {
						expect(
							overlaps(label.box, node.box),
							`${label.ownerId} / ${node.id}`,
						).toBe(false);
					}
					for (const activation of sequence.activations) {
						expect(
							overlaps(label.box, activation.box),
							`${label.ownerId} / ${activation.id}`,
						).toBe(false);
					}
					for (const note of sequence.notes) {
						expect(
							overlaps(label.box, note.box),
							`${label.ownerId} / ${note.id}`,
						).toBe(false);
					}
				}
			});

			it("fits each message label between the ends of its arrow", () => {
				for (const id of sequence.messageOrder) {
					const message = edge(diagram, id);
					if (message.source.nodeId === message.target.nodeId) continue;
					const label = (diagram.textAnnotations ?? []).find(
						(text) => text.surfaceKind === "edge-label" && text.ownerId === id,
					);
					if (label === undefined) continue;
					const xs = message.points.map((point) => point.x);
					expect(label.box.x, id).toBeGreaterThanOrEqual(Math.min(...xs));
					expect(label.box.x + label.box.width, id).toBeLessThanOrEqual(
						Math.max(...xs),
					);
					expect(label.box.y + label.box.height, id).toBeLessThanOrEqual(
						message.points[0]?.y ?? 0,
					);
				}
			});

			it("nests fragments with padding and keeps them clear of outside lifelines", () => {
				for (const fragment of sequence.fragments) {
					for (const other of sequence.fragments) {
						if (other === fragment || other.depth <= fragment.depth) continue;
						const nested =
							other.box.y > fragment.box.y &&
							other.box.y + other.box.height <
								fragment.box.y + fragment.box.height;
						if (!nested) continue;
						expect(
							other.box.x,
							`${other.id} in ${fragment.id}`,
						).toBeGreaterThan(fragment.box.x);
						expect(other.box.x + other.box.width).toBeLessThan(
							fragment.box.x + fragment.box.width,
						);
					}
					for (const operand of fragment.operands) {
						expect(operand.top).toBeGreaterThanOrEqual(fragment.box.y);
						expect(operand.top).toBeLessThan(
							fragment.box.y + fragment.box.height,
						);
					}
					for (const activation of sequence.activations) {
						const crosses =
							activation.box.y < fragment.box.y + fragment.box.height &&
							activation.box.y + activation.box.height > fragment.box.y;
						if (!crosses) continue;
						// A bar is either inside the fragment or fully outside it.
						const left = fragment.box.x;
						const right = fragment.box.x + fragment.box.width;
						const barLeft = activation.box.x;
						const barRight = activation.box.x + activation.box.width;
						expect(
							barRight <= left ||
								barLeft >= right ||
								(barLeft > left && barRight < right),
							`${activation.id} vs ${fragment.id}`,
						).toBe(true);
					}
				}
			});

			it("contains everything it draws in its bounds", () => {
				const boxes = [
					...diagram.nodes.map((node) => node.box),
					...sequence.activations.map((activation) => activation.box),
					...sequence.fragments.map((fragment) => fragment.box),
					...sequence.notes.map((note) => note.box),
					...(diagram.textAnnotations ?? []).map((text) => text.box),
				];
				for (const box of boxes) expect(inside(box, diagram.bounds)).toBe(true);
			});

			it("exports a valid geometry document with the sequence block", () => {
				const document = geometryDocumentSchema.parse(exportGeometry(diagram));
				expect(document.sequence?.lifelines).toHaveLength(
					sequence.lifelines.length,
				);
				expect(document.sequence?.messageOrder).toEqual(sequence.messageOrder);
			});
		});
	}

	it("activates the receiver of a call until its reply", () => {
		const diagram = solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence:
  steps:
    - { type: message, from: a, to: b, text: call }
    - { type: message, from: b, to: a, text: done, kind: reply }
`);
		const sequence = sequenceOf(diagram);
		expect(sequence.activations).toHaveLength(1);
		const bar = sequence.activations[0];
		const call = edge(diagram, "m1");
		const reply = edge(diagram, "m2");
		expect(bar?.participantId).toBe("b");
		expect(bar?.box.y).toBe(call.points[0]?.y);
		expect((bar?.box.y ?? 0) + (bar?.box.height ?? 0)).toBe(reply.points[0]?.y);
		// The call ends at the bar's left edge; the reply starts there.
		expect(call.points[1]?.x).toBeCloseTo(bar?.box.x ?? 0, 6);
		expect(reply.points[0]?.x).toBeCloseTo(bar?.box.x ?? 0, 6);
		expect(call.arrowhead).toBe("triangle");
		expect(reply.arrowhead).toBe("open");
		expect(reply.style).toBe("dashed");
	});

	it("does not activate with autoActivate off", () => {
		const diagram = solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence:
  autoActivate: false
  steps:
    - { type: message, from: a, to: b, text: call }
    - { type: activate, participant: b }
    - { type: message, from: b, to: a, kind: reply }
    - { type: deactivate, participant: b }
`);
		const sequence = sequenceOf(diagram);
		// Only the explicit bar, from the call to the reply.
		expect(sequence.activations).toHaveLength(1);
		expect(sequence.activations[0]?.box.y).toBe(
			edge(diagram, "m1").points[0]?.y,
		);
		expect(
			(sequence.activations[0]?.box.y ?? 0) +
				(sequence.activations[0]?.box.height ?? 0),
		).toBe(edge(diagram, "m2").points[0]?.y);
	});

	it("loops a self message to the right with its label beside it", () => {
		const diagram = solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence:
  steps:
    - { type: message, from: a, to: a, text: validate input data }
    - { type: message, from: a, to: b, text: go }
`);
		const self = edge(diagram, "m1");
		expect(self.points).toHaveLength(4);
		const [start, out, down, back] = self.points;
		expect(out?.x).toBeGreaterThan(start?.x ?? 0);
		expect(down?.x).toBe(out?.x);
		expect(back?.y).toBeGreaterThan(start?.y ?? 0);
		const label = diagram.textAnnotations?.find(
			(text) => text.surfaceKind === "edge-label" && text.ownerId === "m1",
		);
		expect(label?.box.x).toBeGreaterThan(out?.x ?? 0);
		// The next lifeline leaves room for the loop and its label.
		const b = sequenceOf(diagram).lifelines[1];
		expect((label?.box.x ?? 0) + (label?.box.width ?? 0)).toBeLessThan(
			(b?.x ?? 0) - 5,
		);
	});

	it("starts a created participant at its create message and ends a destroyed one at the X", () => {
		const diagram = solve(`
nodes: { a: { label: A } }
sequence:
  participants: [a, { id: w, label: Worker }]
  steps:
    - { type: message, from: a, to: w, text: new, kind: create }
    - { type: message, from: a, to: w, text: run }
    - { type: destroy, participant: w }
    - { type: message, from: a, to: w, text: too late }
`);
		const sequence = sequenceOf(diagram);
		const worker = sequence.lifelines.find(
			(item) => item.participantId === "w",
		);
		const create = edge(diagram, "m1");
		expect(worker?.created).toBe(true);
		expect((worker?.headBox.y ?? 0) + (worker?.headBox.height ?? 0) / 2).toBe(
			create.points[0]?.y,
		);
		// The create arrow ends at the head's edge.
		expect(create.points[1]?.x).toBeCloseTo(worker?.headBox.x ?? 0, 6);
		expect(worker?.destroyed).toBe(true);
		expect(worker?.bottom).toBe(sequence.destructions[0]?.point.y);
		expect(diagram.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"sequence.message.after-destroy",
		);
	});

	it("widens a gap so a long label fits between its lifelines", () => {
		const short = sequenceOf(
			solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence: { steps: [ { type: message, from: a, to: b, text: hi } ] }
`),
		);
		const long = sequenceOf(
			solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence: { steps: [ { type: message, from: a, to: b, text: "a very long message label that needs room" } ] }
`),
		);
		const gap = (sequence: CoordinatedSequence) =>
			(sequence.lifelines[1]?.x ?? 0) - (sequence.lifelines[0]?.x ?? 0);
		expect(gap(long)).toBeGreaterThan(gap(short) + 50);
	});

	it("numbers messages when autonumber is on", () => {
		const diagram = solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence:
  autonumber: true
  steps:
    - { type: message, from: a, to: b, text: one }
    - { type: message, from: b, to: a, kind: reply }
`);
		expect(edge(diagram, "m1").label?.text).toBe("1. one");
		expect(edge(diagram, "m2").label?.text).toBe("2");
	});

	it("is deterministic", () => {
		expect(renderDiagramDsl(EXAMPLE).content).toBe(
			renderDiagramDsl(EXAMPLE).content,
		);
		expect(renderDiagramDsl(EXAMPLE, { format: "drawio" }).content).toBe(
			renderDiagramDsl(EXAMPLE, { format: "drawio" }).content,
		);
	});

	it("reports unknown participants, duplicates and misplaced notes", () => {
		const codes = (source: string) =>
			renderDiagramDsl(source).diagnostics.map((diagnostic) => diagnostic.code);
		expect(
			codes(`
nodes: { a: { label: A } }
sequence: { steps: [ { type: message, from: a, to: ghost } ] }
`),
		).toContain("validate.reference.missing");
		expect(
			codes(`
nodes: { a: { label: A } }
sequence: { participants: [a, a], steps: [] }
`),
		).toContain("validate.sequence.duplicate-participant");
		expect(
			codes(`
nodes: { a: { label: A }, b: { label: B } }
sequence: { steps: [ { type: note, position: left, participants: [a, b], text: x } ] }
`),
		).toContain("validate.sequence.note-span");
		expect(
			codes(`
nodes: { a: { label: A } }
sequence: { steps: [ { type: message, from: a, to: a, kind: create } ] }
`),
		).toContain("validate.sequence.self-create");
	});
});

describe("sequence exporters", () => {
	const diagram = solve(EXAMPLE);
	const sequence = sequenceOf(diagram);

	it("SVG draws lifelines, bars, fragments, notes, dividers and the X", () => {
		const svg = exportSvg(diagram);
		const count = (pattern: RegExp) => svg.match(pattern)?.length ?? 0;
		expect(count(/class="sequence-lifeline"/g)).toBe(sequence.lifelines.length);
		expect(count(/class="sequence-activation"/g)).toBe(
			sequence.activations.length,
		);
		expect(count(/class="sequence-fragment"/g)).toBe(sequence.fragments.length);
		expect(count(/<path class="sequence-note"/g)).toBe(sequence.notes.length);
		expect(count(/class="sequence-destruction"/g)).toBe(1);
		expect(count(/class="node node-actor"/g)).toBe(1);
		// Open arrowheads are two strokes; filled ones are triangles.
		const open = diagram.edges.filter((item) => item.arrowhead === "open");
		expect(count(/<polyline class="edge-arrowhead"/g)).toBe(open.length);
		// Lifelines and bars paint before the messages, notes after them.
		expect(svg.indexOf("sequence-lifeline")).toBeLessThan(
			svg.indexOf('class="edge"'),
		);
		expect(svg.indexOf('<path class="sequence-note"')).toBeGreaterThan(
			svg.lastIndexOf('class="edge"'),
		);
	});

	it("draw.io connects messages to native lifelines at pinned points", () => {
		const xml = exportDrawio(diagram);
		const cells = [...xml.matchAll(/<mxCell [^>]*>/g)].map((match) => match[0]);
		const lifelineIds = new Set(
			cells
				.filter((cell) => cell.includes("shape=umlLifeline"))
				.map((cell) => /id="([^"]+)"/.exec(cell)?.[1]),
		);
		expect(lifelineIds.size).toBe(sequence.lifelines.length);
		const edges = cells.filter((cell) => cell.includes('edge="1"'));
		expect(edges).toHaveLength(diagram.edges.length);
		for (const cell of edges) {
			const source = /source="([^"]+)"/.exec(cell)?.[1];
			const target = /target="([^"]+)"/.exec(cell)?.[1];
			expect(lifelineIds.has(source)).toBe(true);
			expect(lifelineIds.has(target)).toBe(true);
			for (const [, value] of cell.matchAll(/(?:exit|entry)[XY]=([-\d.]+)/g)) {
				expect(Number(value)).toBeGreaterThanOrEqual(0);
				expect(Number(value)).toBeLessThanOrEqual(1);
			}
		}
		// Activation bars are children of their lifelines.
		const bars = cells.filter((cell) =>
			cell.includes("perimeter=orthogonalPerimeter"),
		);
		expect(bars).toHaveLength(sequence.activations.length);
		for (const bar of bars) {
			expect(lifelineIds.has(/parent="([^"]+)"/.exec(bar)?.[1])).toBe(true);
		}
		expect(xml).toContain("shape=umlFrame");
		expect(xml).toContain("shape=umlDestroy");
		expect(xml).toContain("participant=umlActor");
		expect(xml).toContain("endArrow=open");
	});

	// Found by loading the export into mxGraph (draw.io's engine) in Chromium.
	it("draw.io paints fragments over lifelines and bars, below messages", () => {
		const xml = exportDrawio(diagram);
		const cells = [...xml.matchAll(/<mxCell [^>]*>/g)].map((match) => match[0]);
		const position = (test: (cell: string) => boolean) =>
			cells
				.map((cell, index) => (test(cell) ? index : -1))
				.filter((i) => i >= 0);
		const frames = position(
			(cell) =>
				cell.includes("shape=umlFrame") && cell.includes("pointerEvents=0"),
		);
		const lifelinesAndBars = position(
			(cell) =>
				cell.includes("shape=umlLifeline") ||
				cell.includes("perimeter=orthogonalPerimeter"),
		);
		const messages = position((cell) => cell.includes('edge="1"'));
		expect(frames).toHaveLength(sequence.fragments.length);
		expect(Math.min(...frames)).toBeGreaterThan(Math.max(...lifelinesAndBars));
		expect(Math.max(...frames)).toBeLessThan(Math.min(...messages));
		// umlFrame fills its tag with fillColor, its body with
		// swimlaneFillColor: tags are opaque, only a ref covers its body.
		// Frames are written in fragment order.
		frames.forEach((index, order) => {
			const cell = cells[index] as string;
			expect(cell).toContain("fillColor=#ffffff;");
			const ref = sequence.fragments[order]?.kind === "ref";
			expect(cell).toContain(
				ref ? "swimlaneFillColor=#ffffff;" : "swimlaneFillColor=none;",
			);
		});
		expect(sequence.fragments.some((fragment) => fragment.kind === "ref")).toBe(
			true,
		);
	});

	it("draw.io pins message ends exactly and keeps the actor figure upright", () => {
		const xml = exportDrawio(diagram);
		const cells = [
			...xml.matchAll(/<mxCell [^>]*[^/]>[\s\S]*?<\/mxCell>/g),
		].map((match) => match[0]);
		const attribute = (cell: string, name: string) =>
			new RegExp(`\\b${name}="([^"]*)"`).exec(cell)?.[1];
		const style = (cell: string, name: string) =>
			Number(new RegExp(`${name}=([-\\d.]+)`).exec(cell)?.[1]);
		const geometry = (cell: string) => {
			const tag = /<mxGeometry [^>]*>/.exec(cell)?.[0] ?? "";
			return {
				x: Number(attribute(tag, "x") ?? 0),
				y: Number(attribute(tag, "y") ?? 0),
				width: Number(attribute(tag, "width") ?? 0),
				height: Number(attribute(tag, "height") ?? 0),
			};
		};
		const byId = new Map(cells.map((cell) => [attribute(cell, "id"), cell]));
		for (const cell of cells.filter((item) => item.includes('edge="1"'))) {
			// The relative exit/entry point must land on the solved end: a
			// rounded fraction moves it on a tall lifeline, and draw.io then
			// routes a step into a horizontal message.
			for (const [end, terminal, point] of [
				["exit", "source", "sourcePoint"],
				["entry", "target", "targetPoint"],
			] as const) {
				const box = geometry(byId.get(attribute(cell, terminal)) ?? "");
				const solved = new RegExp(
					`<mxPoint as="${point}" x="([-\\d.]+)" y="([-\\d.]+)"`,
				).exec(cell);
				// Edge points are relative to the edge's parent (a self call's
				// is its lifeline).
				const parent = attribute(cell, "parent");
				const origin =
					parent === "1" ? { x: 0, y: 0 } : geometry(byId.get(parent) ?? "");
				const x = box.x + style(cell, `${end}X`) * box.width;
				const y = box.y + style(cell, `${end}Y`) * box.height;
				expect(Math.abs(x - origin.x - Number(solved?.[1]))).toBeLessThan(0.01);
				expect(Math.abs(y - origin.y - Number(solved?.[2]))).toBeLessThan(0.01);
			}
		}
		// draw.io stretches an actor figure across its cell.
		const actor = cells.find((cell) => cell.includes("participant=umlActor"));
		expect(geometry(actor ?? "").width).toBe(ACTOR_FIGURE_WIDTH);
		expect(actor).toContain("whiteSpace=nowrap;");
		expect(actor).toContain("labelBackgroundColor=#ffffff;");
	});

	it("Excalidraw draws lines and leaves messages unbound", () => {
		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: {
				id: string;
				type: string;
				startBinding: unknown;
				endBinding: unknown;
			}[];
		};
		const lines = scene.elements.filter((element) => element.type === "line");
		expect(
			lines.filter((element) => element.id.startsWith("lifeline:")),
		).toHaveLength(sequence.lifelines.length);
		const arrows = scene.elements.filter((element) => element.type === "arrow");
		expect(arrows).toHaveLength(diagram.edges.length);
		for (const arrow of arrows) {
			expect(arrow.startBinding).toBeNull();
			expect(arrow.endBinding).toBeNull();
		}
	});
});

describe("sequence view", () => {
	function expand(source: string) {
		return expandViewSource(source);
	}

	it("reads arrows, notes, commands, dividers, refs and fragments", () => {
		const result = expand(`view: sequence
participants:
  a: { label: Alice, type: actor }
  b: Bob
messages:
  - a -> b: call
  - a ->> b: signal
  - b --> a: return
  - a ->* c: create
  - a ->+ b: and activate
  - b -->- a
  - note right of a: hello
  - note over a, b: spanning
  - == Phase 2 ==
  - ref over a, b: Other interaction
  - activate b
  - deactivate b
  - destroy c
  - alt: x > 0
    messages: [ "a -> b: yes" ]
    else:
      - guard: otherwise
        messages: [ "a -> b: no" ]
  - par:
    messages: [ "a -> b: one" ]
    and:
      - messages: [ "a -> b: two" ]
`);
		expect(result.diagnostics).toEqual([]);
		const sequence = result.value?.sequence as {
			participants: unknown[];
			steps: Record<string, unknown>[];
		};
		expect(sequence.participants).toEqual([
			{ id: "a", kind: "actor" },
			"b",
			"n1",
		]);
		const steps = sequence.steps;
		expect(steps.slice(0, 4).map((step) => step.kind)).toEqual([
			"sync",
			"async",
			"reply",
			"create",
		]);
		expect(steps[4]).toMatchObject({ activate: true, text: "and activate" });
		expect(steps[5]).toMatchObject({ deactivate: true, kind: "reply" });
		expect(steps[6]).toMatchObject({
			type: "note",
			position: "right",
			participants: ["a"],
		});
		expect(steps[7]).toMatchObject({
			position: "over",
			participants: ["a", "b"],
		});
		expect(steps[8]).toEqual({ type: "divider", text: "Phase 2" });
		expect(steps[9]).toMatchObject({ type: "ref", text: "Other interaction" });
		expect(steps.slice(10, 13).map((step) => step.type)).toEqual([
			"activate",
			"deactivate",
			"destroy",
		]);
		expect(steps[13]).toMatchObject({
			type: "fragment",
			kind: "alt",
			operands: [{ guard: "x > 0" }, { guard: "otherwise" }],
		});
		expect((steps[14]?.operands as unknown[]).length).toBe(2);
		// The expansion solves.
		const rendered = renderDiagramDsl(`view: sequence
participants: { a: A, b: B }
messages: [ "a -> b: call", "b --> a: ok" ]
`);
		expect(rendered.diagram?.sequence?.messageOrder).toEqual(["m1", "m2"]);
	});

	it("reads a YAML map message whose text is a number", () => {
		const result = expand(`view: sequence
messages:
  - a -> b: 401
`);
		expect(result.diagnostics).toEqual([]);
		const sequence = result.value?.sequence as { steps: unknown[] };
		expect(sequence.steps[0]).toMatchObject({ text: "401" });
	});

	it("flags a participant one letter off a declared one", () => {
		const result = expand(`view: sequence
participants: { server: Server, client: Client }
messages: [ "client -> sever: hi" ]
`);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"view.sequence.unknown-node",
		);
		expect(result.diagnostics[0]?.hint).toContain('"server"');
	});

	it("rejects a step it cannot read and an unknown fragment key", () => {
		const result = expand(`view: sequence
participants: { a: A, b: B }
messages:
  - a b c
  - loop: forever
    mesages: [ "a -> b: x" ]
`);
		const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
		expect(codes).toContain("view.sequence.invalid-step");
		expect(codes).toContain("view.sequence.invalid-fragment");
	});
});

describe("sequence diagram properties", () => {
	/** Deterministic random sequence diagrams: fragments, notes, bars. */
	function generate(seed: number): string {
		let state = seed;
		const random = () => {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			return state / 0x7fffffff;
		};
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)] as T;
		const words = [
			"get",
			"update user profile",
			"ok",
			"validate the whole request payload",
			"查询",
			"返回结果列表",
			"notify subscribers asynchronously",
		];
		const count = 2 + Math.floor(random() * 5);
		const ids = Array.from({ length: count }, (_, index) => `p${index}`);
		const nodes = Object.fromEntries(
			ids.map((id) => [
				id,
				{
					label: `${pick(["Service", "A", "Long Participant Name", "用户界面"])} ${id}`,
				},
			]),
		);
		const steps = (depth: number, length: number): unknown[] =>
			Array.from({ length }, () => {
				const roll = random();
				if (roll < 0.55) {
					return {
						type: "message",
						from: pick(ids),
						to: pick(ids),
						text: pick(words),
						kind: pick(["sync", "async", "reply", "sync"]),
					};
				}
				if (roll < 0.7) {
					return {
						type: "note",
						position: pick(["left", "right", "over"]),
						participants: [pick(ids)],
						text: pick(words),
					};
				}
				if (roll < 0.75) return { type: "divider", text: pick(words) };
				if (roll < 0.8) {
					return {
						type: pick(["activate", "deactivate"]),
						participant: pick(ids),
					};
				}
				if (roll < 0.84) {
					return {
						type: "ref",
						participants: [...new Set([pick(ids), pick(ids)])],
						text: pick(words),
					};
				}
				if (depth >= 3) return { type: "divider" };
				return {
					type: "fragment",
					kind: pick(["alt", "loop", "opt", "par"]),
					operands: Array.from(
						{ length: 1 + Math.floor(random() * 2) },
						() => ({
							...(random() < 0.7 ? { guard: pick(words) } : {}),
							steps: steps(depth + 1, 1 + Math.floor(random() * 3)),
						}),
					),
				};
			});
		return JSON.stringify({
			nodes,
			sequence: {
				autonumber: random() < 0.3,
				steps: steps(0, 6 + Math.floor(random() * 8)),
			},
		});
	}

	it("keeps text, heads, bars, notes and fragment borders apart on random diagrams", () => {
		for (let seed = 1; seed <= 150; seed += 1) {
			const result = renderDiagramDsl(generate(seed), { sourceFormat: "json" });
			const diagram = result.diagram;
			expect(diagram, `seed ${seed}`).toBeDefined();
			if (diagram === undefined) continue;
			const sequence = sequenceOf(diagram);
			expect(
				diagram.diagnostics.filter(
					(diagnostic) => diagnostic.code === "sequence.text.overlap",
				),
				`seed ${seed}`,
			).toEqual([]);
			const texts = diagram.textAnnotations ?? [];
			for (const label of texts.filter(
				(text) => text.surfaceKind === "edge-label",
			)) {
				const message = edge(diagram, label.ownerId);
				for (const activation of sequence.activations) {
					expect(
						overlaps(label.box, activation.box),
						`seed ${seed} ${label.ownerId}`,
					).toBe(false);
				}
				for (const node of diagram.nodes) {
					expect(
						overlaps(label.box, node.box),
						`seed ${seed} ${label.ownerId}`,
					).toBe(false);
				}
				if (message.source.nodeId !== message.target.nodeId) {
					const xs = message.points.map((point) => point.x);
					expect(label.box.x).toBeGreaterThanOrEqual(Math.min(...xs) - 0.01);
					expect(label.box.x + label.box.width).toBeLessThanOrEqual(
						Math.max(...xs) + 0.01,
					);
				}
			}
			for (const note of sequence.notes) {
				for (const text of texts) {
					if (text.ownerId === note.id) continue;
					expect(overlaps(text.box, note.box), `seed ${seed} ${note.id}`).toBe(
						false,
					);
				}
				for (const activation of sequence.activations) {
					// A note over a participant covers its own lifeline.
					if (
						note.position === "over" &&
						(note.participants.includes(activation.participantId) ||
							note.participants.length === 2)
					) {
						continue;
					}
					expect(
						overlaps(note.box, activation.box),
						`seed ${seed} ${note.id}`,
					).toBe(false);
				}
			}
			for (const [index, a] of diagram.nodes.entries()) {
				for (const b of diagram.nodes.slice(index + 1)) {
					expect(overlaps(a.box, b.box), `seed ${seed} ${a.id}/${b.id}`).toBe(
						false,
					);
				}
			}
			for (const fragment of sequence.fragments) {
				const left = fragment.box.x;
				const right = fragment.box.x + fragment.box.width;
				for (const activation of sequence.activations) {
					const crosses =
						activation.box.y < fragment.box.y + fragment.box.height &&
						activation.box.y + activation.box.height > fragment.box.y;
					if (!crosses) continue;
					const barLeft = activation.box.x;
					const barRight = activation.box.x + activation.box.width;
					expect(
						barRight <= left ||
							barLeft >= right ||
							(barLeft > left && barRight < right),
						`seed ${seed} ${activation.id} / ${fragment.id}`,
					).toBe(true);
				}
			}
		}
	});
});

describe("open arrowheads on ordinary edges", () => {
	it("draws an open arrowhead as two strokes and runs the line to its tip", () => {
		const result = renderDiagramDsl(`
nodes: { a: { label: A }, b: { label: B } }
edges:
  - { source: a, target: b, arrowhead: open }
`);
		const svg = result.content ?? "";
		expect(svg).toContain('<polyline class="edge-arrowhead"');
		const edgeItem = result.diagram?.edges[0];
		const tip = edgeItem?.points.at(-1);
		const path = /<path class="edge"[^>]* d="([^"]+)"/.exec(svg)?.[1] ?? "";
		const last = path.trim().split(/\s+/).slice(-2).map(Number);
		expect(last[0]).toBeCloseTo(tip?.x ?? Number.NaN, 1);
		expect(last[1]).toBeCloseTo(tip?.y ?? Number.NaN, 1);
		const drawio = renderDiagramDsl(
			`
nodes: { a: { label: A }, b: { label: B } }
edges:
  - { source: a, target: b, arrowhead: open }
`,
			{ format: "drawio" },
		).content;
		expect(drawio).toContain("endArrow=open");
	});
});

describe("sequence diagram inputs it does not draw", () => {
	it("warns that edges and groups beside a sequence are ignored", () => {
		const result = renderDiagramDsl(`
nodes: { a: { label: A }, b: { label: B } }
edges: [ "a -> b" ]
groups: { g: { nodes: [a] } }
sequence: { steps: [ { type: message, from: a, to: b, text: hi } ] }
`);
		const ignored = result.diagnostics.filter(
			(diagnostic) => diagnostic.code === "sequence.ignored",
		);
		expect(ignored.map((diagnostic) => diagnostic.path?.[0])).toEqual([
			"edges",
			"groups",
		]);
		expect(result.diagram?.edges.map((item) => item.id)).toEqual(["m1"]);
	});
});

describe("sequence fragment operands", () => {
	it("starts each alternative from the bars open when the fragment starts", () => {
		const diagram = solve(`
nodes: { a: { label: A }, b: { label: B } }
sequence:
  steps:
    - { type: message, from: a, to: b, text: call }
    - type: fragment
      kind: alt
      operands:
        - guard: ok
          steps: [ { type: message, from: b, to: a, text: done, kind: reply } ]
        - guard: failed
          steps: [ { type: message, from: b, to: a, text: error, kind: reply } ]
`);
		const sequence = sequenceOf(diagram);
		const separator = sequence.fragments[0]?.operands[1]?.top ?? 0;
		const bars = sequence.activations.filter(
			(activation) => activation.participantId === "b",
		);
		// The call's bar ends at the first reply; the second operand reopens
		// it at its separator, and its reply ends it again.
		expect(bars).toHaveLength(2);
		expect(bars[1]?.box.y).toBe(separator);
		const error = edge(diagram, "m3");
		expect((bars[1]?.box.y ?? 0) + (bars[1]?.box.height ?? 0)).toBe(
			error.points[0]?.y,
		);
		expect(error.points[0]?.x).toBeCloseTo(bars[1]?.box.x ?? 0, 6);
	});
});
