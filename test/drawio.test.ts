import { describe, expect, it } from "vitest";
import { exportDiagram } from "../src/dsl/render.js";
import { exportDrawio } from "../src/exporters/index.js";
import type { CoordinatedDiagram } from "../src/ir/index.js";

function diagram(
	overrides: Partial<CoordinatedDiagram> = {},
): CoordinatedDiagram {
	return {
		id: "d",
		direction: "LR",
		nodes: [
			{
				id: "a",
				shape: "parallelogram",
				box: { x: 500, y: 100, width: 100, height: 40 },
				label: { text: "A" },
			},
			{
				id: "b",
				shape: "hexagon",
				box: { x: 800, y: 100, width: 100, height: 40 },
				label: { text: "B" },
			},
		],
		edges: [
			{
				id: "a-b",
				source: { nodeId: "a" },
				target: { nodeId: "b" },
				style: "dashed",
				arrowhead: "hollowTriangle",
				points: [
					{ x: 600, y: 110 },
					{ x: 700, y: 110 },
					{ x: 700, y: 130 },
					{ x: 800, y: 130 },
				],
			},
		],
		groups: [],
		constraints: [],
		diagnostics: [],
		bounds: { x: 500, y: 100, width: 400, height: 40 },
		...overrides,
	} as CoordinatedDiagram;
}

describe("draw.io export", () => {
	it("pins solved end points as exit/entry constraints", () => {
		const xml = exportDrawio(diagram());
		// (600,110) on a's right side at 25% height; (800,130) on b's left at 75%.
		expect(xml).toContain("exitX=1;exitY=0.25;");
		expect(xml).toContain("entryX=0;entryY=0.75;");
		expect(xml).toContain("exitPerimeter=0");
		expect(xml).toContain("entryPerimeter=0");
	});

	it("keeps shapes, stroke style and arrowhead", () => {
		const xml = exportDrawio(diagram());
		expect(xml).toContain("shape=parallelogram");
		expect(xml).toContain("shape=hexagon");
		expect(xml).toContain("dashed=1");
		expect(xml).toContain("endFill=0");
	});

	it("draws straight routes as solved instead of re-routing them", () => {
		const straight = diagram();
		const edge = straight.edges[0];
		if (edge === undefined) throw new Error("fixture");
		edge.points = [
			{ x: 600, y: 120 },
			{ x: 800, y: 130 },
		];
		expect(exportDrawio(straight)).toContain("edgeStyle=none");
		expect(exportDrawio(diagram())).toContain("edgeStyle=orthogonalEdgeStyle");
	});

	it("translates geometry to the page origin", () => {
		const xml = exportDrawio(diagram());
		expect(xml).toContain('x="0" y="0" width="100" height="40"');
		expect(xml).toContain('pageWidth="400"');
		expect(xml).toContain('<mxPoint x="200" y="10"/>');
	});

	it("maps crossing styles per edge", () => {
		const crossing = diagram({
			edgeCrossings: [
				{ x: 700, y: 120, underEdgeId: "a-b", overEdgeId: "z", style: "gap" },
			],
		});
		expect(exportDrawio(crossing)).toContain("jumpStyle=gap");
		expect(exportDrawio(diagram())).toContain("jumpStyle=none");
	});

	it("splits an edge whose crossings mix styles into styled pieces", () => {
		const xml = exportDrawio(
			diagram({
				edgeCrossings: [
					{ x: 650, y: 110, underEdgeId: "a-b", overEdgeId: "z", style: "gap" },
					{
						x: 750,
						y: 130,
						underEdgeId: "a-b",
						overEdgeId: "y",
						style: "jump",
					},
				],
			}),
		);
		const pieces = [...xml.matchAll(/<mxCell [^>]*dgeEdge=a-b[^>]*>/g)].map(
			(match) => match[0],
		);
		expect(pieces).toHaveLength(2);
		const [first, last] = pieces as [string, string];
		// Each piece keeps its own crossing style.
		expect(first).toContain("jumpStyle=gap");
		expect(last).toContain("jumpStyle=arc");
		// Source terminal on the first piece, target and arrowhead on the last.
		expect(first).toContain(" source=");
		expect(first).not.toContain(" target=");
		expect(first).toContain("endArrow=none");
		expect(last).toContain(" target=");
		expect(last).not.toContain(" source=");
		expect(last).toContain("endArrow=block");
	});

	it("encodes a split edge's id in its style", () => {
		const base = diagram({
			edgeCrossings: [
				{
					x: 650,
					y: 110,
					underEdgeId: "a;endArrow=none",
					overEdgeId: "z",
					style: "gap",
				},
				{
					x: 750,
					y: 130,
					underEdgeId: "a;endArrow=none",
					overEdgeId: "y",
					style: "jump",
				},
			],
		});
		const edge = base.edges[0];
		if (edge === undefined) throw new Error("fixture");
		edge.id = "a;endArrow=none";
		const xml = exportDrawio(base);
		const pieces = [
			...xml.matchAll(/<mxCell [^>]*dgeEdge=a%3BendArrow%3Dnone[^>]*>/g),
		].map((match) => match[0]);
		expect(pieces).toHaveLength(2);
		// The last piece keeps its arrowhead: the id adds no style entry.
		expect(pieces[1]).toContain("endArrow=block");
		expect(pieces[1]).not.toContain("endArrow=none");
	});

	it("keeps a single-style edge as one connector", () => {
		const xml = exportDrawio(
			diagram({
				edgeCrossings: [
					{ x: 650, y: 110, underEdgeId: "a-b", overEdgeId: "z", style: "gap" },
					{ x: 750, y: 130, underEdgeId: "a-b", overEdgeId: "y", style: "gap" },
				],
			}),
		);
		expect(xml).not.toContain("dgeEdge=");
		expect(xml).toContain("jumpStyle=gap");
	});

	it("falls back to authored port labels without solved text", () => {
		const base = diagram();
		const node = base.nodes[0];
		if (node === undefined) throw new Error("fixture");
		node.ports = [
			{
				id: "out",
				side: "right",
				kind: "flow",
				label: { text: "OUT" },
				anchor: { x: node.box.x + node.box.width, y: node.box.y + 20 },
				box: {
					x: node.box.x + node.box.width - 5,
					y: node.box.y + 15,
					width: 10,
					height: 10,
				},
			},
		];
		const xml = exportDrawio({ ...base, textAnnotations: undefined } as never);
		expect(xml).toContain('value="OUT"');
	});

	it("covers crossing glyphs on the page", () => {
		const xml = exportDrawio(
			diagram({
				edgeCrossings: [
					{
						x: 700,
						y: 100,
						underEdgeId: "a-b",
						overEdgeId: "z",
						style: "jump",
					},
				],
			}),
		);
		// The bounds start at y=100; the hop reaches 6px above it.
		expect(xml).toContain('pageHeight="46"');
	});

	it("writes each jumping edge after the edge it jumps", () => {
		const cross = (
			id: string,
			points: { x: number; y: number }[],
		): CoordinatedDiagram["edges"][number] => ({
			id,
			source: { nodeId: "a" },
			target: { nodeId: "b" },
			points,
		});
		// "v" hops "h", but "h" comes later in the diagram.
		const xml = exportDrawio(
			diagram({
				edges: [
					cross("v", [
						{ x: 700, y: 100 },
						{ x: 700, y: 140 },
					]),
					cross("h", [
						{ x: 600, y: 120 },
						{ x: 800, y: 120 },
					]),
				],
				edgeCrossings: [
					{ x: 700, y: 120, underEdgeId: "v", overEdgeId: "h", style: "jump" },
				],
			}),
		);
		const cells = [...xml.matchAll(/<mxCell [^>]*edge="1"[^>]*>/g)].map(
			(match) => match[0],
		);
		expect(cells).toHaveLength(2);
		expect(cells[0]).toContain("jumpStyle=none");
		expect(cells[1]).toContain("jumpStyle=arc");
	});

	it("splits edges whose hops form a cycle by role", () => {
		// "p" hops "q" at one crossing and "q" hops "p" at another: no
		// document order draws both. Each edge's jumping piece is written
		// after every piece that is jumped.
		const xml = exportDrawio(
			diagram({
				edges: [
					{
						id: "p",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						points: [
							{ x: 600, y: 110 },
							{ x: 800, y: 110 },
						],
					},
					{
						id: "q",
						source: { nodeId: "a" },
						target: { nodeId: "b" },
						points: [
							{ x: 650, y: 100 },
							{ x: 650, y: 140 },
							{ x: 750, y: 140 },
							{ x: 750, y: 100 },
						],
					},
				],
				edgeCrossings: [
					{ x: 650, y: 110, underEdgeId: "p", overEdgeId: "q", style: "jump" },
					{ x: 750, y: 110, underEdgeId: "q", overEdgeId: "p", style: "jump" },
				],
			}),
		);
		const cells = [...xml.matchAll(/<mxCell [^>]*edge="1"[^>]*>/g)].map(
			(match) => match[0],
		);
		expect(cells).toHaveLength(4);
		// Two pieces that are only jumped, then two that jump.
		expect(
			cells.slice(0, 2).every((cell) => cell.includes("jumpStyle=none")),
		).toBe(true);
		expect(cells.slice(2).every((cell) => cell.includes("jumpStyle=arc"))).toBe(
			true,
		);
	});

	it("lays a requested page out at its size and scale", () => {
		const xml = exportDrawio(diagram(), {
			page: { width: 800, height: 600, scale: 0.5 },
		});
		expect(xml).toContain('pageScale="2"');
		expect(xml).toContain('pageWidth="800" pageHeight="600"');
		// The 400×40 content is centred on the 1600×1200 page: node "a"
		// (the content's left end) sits 600px in and 580px down.
		expect(xml).toContain('x="600" y="580" width="100" height="40"');
	});

	it("keeps authored labels of dotted port ids apart", () => {
		const base = diagram();
		const [first, second] = base.nodes;
		if (first === undefined || second === undefined) throw new Error("fixture");
		const port = (id: string, text: string, node: typeof first) => ({
			id,
			side: "right" as const,
			kind: "flow" as const,
			label: { text },
			anchor: { x: node.box.x + node.box.width, y: node.box.y + 20 },
			box: {
				x: node.box.x + node.box.width - 5,
				y: node.box.y + 15,
				width: 10,
				height: 10,
			},
		});
		// "a"."b.c" and "a.b"."c" share the joined owner id "a.b.c".
		first.id = "a";
		second.id = "a.b";
		first.ports = [port("b.c", "SOLVED", first)];
		second.ports = [port("c", "AUTHORED", second)];
		const solvedBox = { x: 605, y: 105, width: 40, height: 12 };
		const xml = exportDrawio({
			...base,
			edges: [],
			textAnnotations: [
				{
					text: "SOLVED",
					ownerId: "a.b.c",
					surfaceKind: "port-label",
					box: solvedBox,
					anchor: { x: solvedBox.x, y: solvedBox.y },
					paddings: { top: 0, right: 0, bottom: 0, left: 0 },
					lines: [],
					fontFamily: "Arial",
					fontSize: 10,
				},
			],
		} as never);
		expect(xml).toContain('value="AUTHORED"');
	});

	it("keeps an authored label on a split edge without solved text", () => {
		const base = diagram({
			edgeCrossings: [
				{ x: 650, y: 110, underEdgeId: "a-b", overEdgeId: "z", style: "gap" },
				{ x: 750, y: 130, underEdgeId: "a-b", overEdgeId: "y", style: "jump" },
			],
		});
		const edge = base.edges[0];
		if (edge === undefined) throw new Error("fixture");
		edge.label = { text: "flows" };
		const xml = exportDrawio({ ...base, textAnnotations: undefined } as never);
		const pieces = [...xml.matchAll(/<mxCell [^>]*dgeEdge=a-b[^>]*>/g)].map(
			(match) => match[0],
		);
		expect(pieces).toHaveLength(2);
		expect(
			pieces.filter((cell) => cell.includes('value="flows"')),
		).toHaveLength(1);
	});

	it("covers authored port labels on the page", () => {
		const base = diagram();
		const node = base.nodes[1];
		if (node === undefined) throw new Error("fixture");
		// A right-side port on the right edge of the bounds (x=900).
		node.ports = [
			{
				id: "out",
				side: "right",
				kind: "flow",
				label: { text: "LONGLABEL" },
				anchor: { x: 900, y: 120 },
				box: { x: 895, y: 115, width: 10, height: 10 },
			},
		];
		const xml = exportDrawio({ ...base, textAnnotations: undefined } as never);
		// The label starts 8px out and runs 54px: the page reaches x=962.
		expect(xml).toContain('pageWidth="462"');
	});

	it("sizes wide-glyph fallback port labels at a full em", () => {
		const base = diagram();
		const node = base.nodes[1];
		if (node === undefined) throw new Error("fixture");
		node.ports = [
			{
				id: "out",
				side: "right",
				kind: "flow",
				label: { text: "主控单元输出" },
				anchor: { x: 900, y: 120 },
				box: { x: 895, y: 115, width: 10, height: 10 },
			},
		];
		const xml = exportDrawio({ ...base, textAnnotations: undefined } as never);
		// Six CJK glyphs at 10px, 8px out from x=900: the page reaches 968.
		expect(xml).toContain('pageWidth="468"');
	});

	it("covers authored edge labels on the page", () => {
		const base = diagram();
		const edge = base.edges[0];
		if (edge === undefined) throw new Error("fixture");
		// A route along the top of the bounds, labelled without solved text.
		edge.points = [
			{ x: 600, y: 100 },
			{ x: 800, y: 100 },
		];
		edge.label = { text: "flows" };
		const xml = exportDrawio({ ...base, textAnnotations: undefined } as never);
		// The 16px label box is centred on y=100: the page starts at y=92.
		expect(xml).toContain('pageHeight="48"');
	});

	it("exports groups, swimlanes, evidence and callouts", () => {
		const xml = exportDrawio(
			diagram({
				groups: [
					{
						id: "g",
						label: { text: "Zone" },
						nodeIds: ["a"],
						box: { x: 490, y: 90, width: 120, height: 60 },
					},
				],
				swimlanes: [
					{
						id: "s",
						orientation: "horizontal",
						lanes: [
							{
								id: "lane",
								label: { text: "Lane" },
								children: ["a"],
								box: { x: 500, y: 100, width: 400, height: 40 },
								headerBox: { x: 500, y: 100, width: 30, height: 40 },
							},
						],
					},
				],
				evidencePanels: [
					{
						id: "p",
						kind: "legend",
						items: [{ label: { text: "Key" } }],
						box: { x: 500, y: 150, width: 100, height: 40 },
					},
				],
				textAnnotations: [
					{
						text: "E1: long label",
						ownerId: "a-b",
						surfaceKind: "edge-label",
						placement: "external-callout",
						placementDetail: { role: "callout" },
						box: { x: 650, y: 150, width: 90, height: 20 },
						lines: [],
						fontFamily: "Noto Sans CJK SC",
						fontSize: 13,
					},
					{
						text: "E1",
						ownerId: "a-b",
						surfaceKind: "edge-label",
						placement: "external-callout",
						placementDetail: { role: "key" },
						box: { x: 690, y: 110, width: 14, height: 14 },
						lines: [],
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		expect(xml).toContain('value="Zone"');
		expect(xml).toContain("swimlane;");
		expect(xml).toContain("horizontal=0;");
		expect(xml).toContain("legend");
		expect(xml).toContain("E1: long label");
		// Evidence cells use the font their text was measured in.
		expect(xml).toContain("overflow=hidden;fontFamily=Arial;fontSize=10;");
		// The callout keeps the typography its shelf box was measured with.
		expect(xml).toMatch(
			/value="E1: long label" style="[^"]*fontFamily=Noto Sans CJK SC;fontSize=13;/,
		);
		// The edge carries the callout key instead of the full label.
		expect(xml).toMatch(/value="E1" style="edgeStyle/);
	});

	it("keeps node styles, ports, compartments and solved label positions", () => {
		const styled = diagram({
			textAnnotations: [
				{
					text: "IN",
					ownerId: "a.in",
					surfaceKind: "port-label",
					box: { x: 470, y: 104, width: 20, height: 12 },
					lines: [],
				},
				{
					text: "flow",
					ownerId: "a-b",
					surfaceKind: "edge-label",
					box: { x: 690, y: 90, width: 20, height: 10 },
					lines: [],
				},
			],
		} as unknown as Partial<CoordinatedDiagram>);
		const [a, b] = styled.nodes;
		if (a === undefined || b === undefined) throw new Error("fixture");
		a.style = { fill: "#ffeeaa", stroke: "#333333", fontSize: 13 };
		a.ports = [
			{
				id: "in",
				side: "left",
				kind: "flow",
				label: { text: "IN" },
				anchor: { x: 500, y: 110 },
				box: { x: 495, y: 105, width: 10, height: 10 },
			},
		];
		b.compartments = {
			stereotype: "«block»",
			name: "Engine",
			properties: ["rpm: Real"],
		};
		const xml = exportDrawio(styled);
		expect(xml).toContain("fillColor=#ffeeaa");
		expect(xml).toContain("strokeColor=#333333");
		expect(xml).toContain("fontSize=13");
		// The port square at (495,105) → page (-5,5) and its solved label.
		expect(xml).toContain('x="-5" y="5" width="10" height="10"');
		expect(xml).toContain('value="IN"');
		expect(xml).toContain("Engine");
		expect(xml).toContain("rpm: Real");
		expect(xml).toContain("&lt;hr&gt;");
		// Label centre (700,95) against the route's middle (700,120): offset (0,-25).
		expect(xml).toContain('<mxPoint as="offset" x="0" y="-25"/>');
	});

	it("keeps authored port fill and stroke", () => {
		const styled = diagram();
		const node = styled.nodes[0];
		if (node === undefined) throw new Error("fixture");
		node.ports = [
			{
				id: "p",
				side: "right",
				kind: "flow",
				style: { fill: "#ff0000", stroke: "#00ff00" },
				box: { x: 595, y: 115, width: 10, height: 10 },
				anchor: { x: 600, y: 120 },
			},
		];
		const xml = exportDrawio(styled);
		expect(xml).toContain("fillColor=#ff0000;strokeColor=#00ff00;");
	});

	it("draws table cells on the solved column offsets", () => {
		const xml = exportDrawio(
			diagram({
				tables: [
					{
						id: "t",
						columns: [
							{ id: "k", label: { text: "Key" } },
							{ id: "v", label: { text: "Value" } },
						],
						rows: [{ id: "r", cells: { k: { text: "a" }, v: { text: "b" } } }],
						box: { x: 500, y: 200, width: 300, height: 40 },
						columnXOffsets: [500, 560],
					},
				],
			}),
		);
		expect(xml).not.toContain("&lt;table");
		// Narrow first column (60) and wide second (240), both rows, as
		// children of the table's background cell (table-relative).
		const tableId = xml.match(
			/<mxCell id="(\d+)" value="" style="[^"]*" vertex="1" parent="1"><mxGeometry x="0" y="100" width="300" height="40"/,
		)?.[1];
		expect(tableId).toBeDefined();
		expect(xml).toContain('value="Key"');
		expect(xml).toContain(
			`parent="${tableId}"><mxGeometry x="0" y="0" width="60" height="20"`,
		);
		expect(xml).toContain(
			`parent="${tableId}"><mxGeometry x="60" y="20" width="240" height="20"`,
		);
	});

	it("escapes literal label markup for draw.io's HTML labels", () => {
		const literal = diagram();
		const node = literal.nodes[0];
		if (node === undefined) throw new Error("fixture");
		node.label = { text: "List<T> & a < b" };
		const xml = exportDrawio(literal);
		// XML-escaped once for the attribute, HTML-escaped once for html=1.
		expect(xml).toContain(
			'value="List&amp;lt;T&amp;gt; &amp;amp; a &amp;lt; b"',
		);
	});

	it("parents ports and port labels under their node", () => {
		const ported = diagram({
			textAnnotations: [
				{
					text: "P",
					ownerId: "a.p",
					surfaceKind: "port-label",
					box: { x: 610, y: 100, width: 10, height: 10 },
					anchor: { x: 600, y: 120 },
					paddings: { top: 0, right: 0, bottom: 0, left: 0 },
					lines: [],
					fontFamily: "Arial",
					fontSize: 10,
				},
			],
		});
		const node = ported.nodes[0];
		if (node === undefined) throw new Error("fixture");
		node.ports = [
			{
				id: "p",
				side: "right",
				kind: "flow",
				box: { x: 595, y: 115, width: 10, height: 10 },
				anchor: { x: 600, y: 120 },
			},
		];
		const xml = exportDrawio(ported);
		const nodeId = /<mxCell id="(\d+)" value="A"/.exec(xml)?.[1];
		expect(nodeId).toBeDefined();
		// Port at node-relative (95,15); its label is a child of the port,
		// so it follows a moved port: (610,100) - (595,115).
		const portId = new RegExp(
			`<mxCell id="(\\d+)" value="" style="[^"]*" vertex="1" parent="${nodeId}"><mxGeometry x="95" y="15" width="10" height="10"`,
		).exec(xml)?.[1];
		expect(portId).toBeDefined();
		expect(xml).toContain(
			`parent="${portId}"><mxGeometry x="15" y="-15" width="10" height="10"`,
		);
		// A white backdrop keeps passing edges off the label, as in the SVG.
		expect(xml).toMatch(
			new RegExp(
				`value="P" style="[^"]*labelBackgroundColor=#ffffff;[^"]*" vertex="1" parent="${portId}"`,
			),
		);
	});

	it("keeps solved edge-label line breaks", () => {
		const wrapped = diagram({
			textAnnotations: [
				{
					text: "first second",
					ownerId: "a-b",
					surfaceKind: "edge-label",
					box: { x: 680, y: 90, width: 40, height: 28 },
					anchor: { x: 700, y: 110 },
					paddings: { top: 0, right: 0, bottom: 0, left: 0 },
					lines: [
						{ text: "first", width: 30 },
						{ text: "second", width: 40 },
					],
					fontFamily: "Arial",
					fontSize: 12,
				} as never,
			],
		});
		const xml = exportDrawio(wrapped);
		expect(xml).toContain('value="first&lt;br&gt;second"');
		// An opaque backdrop keeps crossing strokes out of the label, as in
		// the SVG.
		expect(xml).toMatch(
			/value="first&lt;br&gt;second" style="[^"]*labelBackgroundColor=#ffffff/,
		);
	});

	it("draws edge labels with the solved typography", () => {
		const xml = exportDrawio(
			diagram({
				textAnnotations: [
					{
						text: "中文",
						ownerId: "a-b",
						surfaceKind: "edge-label",
						box: { x: 680, y: 90, width: 40, height: 20 },
						anchor: { x: 700, y: 100 },
						paddings: { top: 0, right: 0, bottom: 0, left: 0 },
						lines: [{ text: "中文", width: 40 }],
						fontFamily: "Noto Sans CJK SC",
						fontSize: 14,
					} as never,
				],
			}),
		);
		expect(xml).toContain("fontFamily=Noto Sans CJK SC;fontSize=14");
	});

	it("keeps a port label's solved lines and typography", () => {
		const styled = diagram({
			textAnnotations: [
				{
					text: "输入 端口",
					ownerId: "a.in",
					surfaceKind: "port-label",
					box: { x: 460, y: 100, width: 30, height: 28 },
					lines: [
						{ text: "输入", width: 28 },
						{ text: "端口", width: 28 },
					],
					fontFamily: "Noto Sans CJK SC",
					fontSize: 12,
				} as never,
			],
		});
		const [a] = styled.nodes;
		if (a === undefined) throw new Error("fixture");
		a.ports = [
			{
				id: "in",
				side: "left",
				kind: "flow",
				label: { text: "输入 端口" },
				anchor: { x: 500, y: 110 },
				box: { x: 495, y: 105, width: 10, height: 10 },
			},
		];
		const xml = exportDrawio(styled);
		expect(xml).toMatch(
			/value="输入&lt;br&gt;端口" style="text;[^"]*fontFamily=Noto Sans CJK SC;fontSize=12;"/,
		);
		expect(xml).not.toMatch(
			/value="输入&lt;br&gt;端口" style="[^"]*fontSize=10;/,
		);
	});

	it("leaves an unlabeled node blank", () => {
		const unlabeled = diagram({});
		const [a] = unlabeled.nodes;
		if (a === undefined) throw new Error("fixture");
		delete a.label;
		delete a.labelLayout;
		const xml = exportDrawio(unlabeled);
		expect(xml).not.toContain(`value="${a.id}"`);
	});

	it("draws a group title with its solved lines and typography", () => {
		const xml = exportDrawio(
			diagram({
				groups: [
					{
						id: "g",
						label: { text: "Control zone" },
						nodeIds: ["a"],
						box: { x: 490, y: 90, width: 120, height: 60 },
					},
				],
				textAnnotations: [
					{
						text: "Control zone",
						ownerId: "g",
						surfaceKind: "group-label",
						box: { x: 500, y: 92, width: 44, height: 28 },
						lines: [
							{ text: "Control", width: 40 },
							{ text: "zone", width: 26 },
						],
						fontFamily: "Arial",
						fontSize: 11,
					} as never,
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		// The group box itself carries no text; the title is its own cell.
		expect(xml).toMatch(/value="" style="rounded=0;[^"]*dashed=1;/);
		expect(xml).toMatch(
			/value="Control&lt;br&gt;zone" style="text;[^"]*fontFamily=Arial;fontSize=11;"/,
		);
		// A child of the group box, so it moves with it: (500,92) - (490,90).
		const groupId = xml.match(
			/<mxCell id="(\d+)" value="" style="rounded=0;/,
		)?.[1];
		expect(xml).toMatch(
			new RegExp(
				`value="Control&lt;br&gt;zone" [^>]*parent="${groupId}"><mxGeometry x="10" y="2" width="44" height="28"`,
			),
		);
	});

	it("draws lane labels and the frame title from their solved annotations", () => {
		const xml = exportDrawio(
			diagram({
				frame: {
					kind: "bdd",
					titleTab: "bdd Plant control",
					box: { x: 480, y: 60, width: 440, height: 120 },
					titleBox: { x: 480, y: 60, width: 90, height: 34 },
				},
				swimlanes: [
					{
						id: "s",
						orientation: "horizontal",
						lanes: [
							{
								id: "lane",
								label: { text: "Order desk" },
								children: ["a"],
								box: { x: 500, y: 100, width: 400, height: 40 },
								headerBox: { x: 500, y: 100, width: 30, height: 40 },
							},
						],
					},
				],
				textAnnotations: [
					{
						text: "bdd Plant control",
						ownerId: "bdd",
						surfaceKind: "frame-title",
						box: { x: 484, y: 62, width: 70, height: 28 },
						lines: [
							{ text: "bdd Plant", width: 60 },
							{ text: "control", width: 44 },
						],
						fontFamily: "Arial",
						fontSize: 12,
					},
					{
						text: "Order desk",
						ownerId: "s.lane",
						surfaceKind: "swimlane-label",
						box: { x: 495, y: 106, width: 40, height: 28 },
						lines: [
							{ text: "Order", width: 32 },
							{ text: "desk", width: 28 },
						],
						fontFamily: "Noto Sans CJK SC",
						fontSize: 13,
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		// The frame and lane cells carry no text of their own.
		expect(xml).toMatch(/value="" style="shape=umlFrame;/);
		expect(xml).toMatch(/value="" style="swimlane;/);
		expect(xml).toMatch(
			/value="bdd Plant&lt;br&gt;control" style="text;[^"]*fontFamily=Arial;fontSize=12;"/,
		);
		expect(xml).toMatch(
			/value="Order&lt;br&gt;desk" style="text;[^"]*rotation=-90;fontFamily=Noto Sans CJK SC;fontSize=13;"/,
		);
		// Each title is a child of the cell it labels, so dragging the frame
		// or lane in draw.io carries it along: (484,62) - (480,60) and
		// (495,106) - (500,100).
		const frameId = xml.match(
			/<mxCell id="(\d+)" value="" style="shape=umlFrame;/,
		)?.[1];
		const laneId = xml.match(
			/<mxCell id="(\d+)" value="" style="swimlane;/,
		)?.[1];
		expect(xml).toMatch(
			new RegExp(
				`value="bdd Plant&lt;br&gt;control" [^>]*parent="${frameId}"><mxGeometry x="4" y="2" `,
			),
		);
		expect(xml).toMatch(
			new RegExp(
				`value="Order&lt;br&gt;desk" [^>]*parent="${laneId}"><mxGeometry x="-5" y="6" `,
			),
		);
		// The lane's child node is a child of the lane cell (lane-relative),
		// so dragging the lane carries it along.
		expect(xml).toMatch(
			new RegExp(
				`value="A" style="[^"]*" vertex="1" parent="${laneId}"><mxGeometry x="0" y="0" width="100" height="40"`,
			),
		);
	});

	it("stretches the page over ports and port labels past the bounds", () => {
		// Node "b" spans x 800–900; its right port and that port's label
		// reach past the solved bounds (500,100 400×40).
		const ported = diagram({
			textAnnotations: [
				{
					text: "OUT",
					ownerId: "b.out",
					surfaceKind: "port-label",
					box: { x: 906, y: 90, width: 24, height: 12 },
					anchor: { x: 900, y: 120 },
					paddings: { top: 0, right: 0, bottom: 0, left: 0 },
					lines: [],
					fontFamily: "Arial",
					fontSize: 10,
				},
			],
		});
		const node = ported.nodes[1];
		if (node === undefined) throw new Error("fixture");
		node.ports = [
			{
				id: "out",
				side: "right",
				kind: "flow",
				box: { x: 895, y: 115, width: 10, height: 10 },
				anchor: { x: 900, y: 120 },
			},
		];
		const xml = exportDrawio(ported);
		// Page from (500,90) to (930,140): 430×50, so node "a" sits at y=10.
		expect(xml).toContain('pageWidth="430" pageHeight="50"');
		expect(xml).toContain('x="0" y="10" width="100" height="40"');
	});

	it("nests grouped nodes and inner groups under their group cells", () => {
		const xml = exportDrawio(
			diagram({
				groups: [
					{
						id: "outer",
						label: { text: "Outer" },
						nodeIds: ["b"],
						groupIds: ["inner"],
						box: { x: 480, y: 80, width: 440, height: 80 },
					},
					{
						id: "inner",
						label: { text: "Inner" },
						nodeIds: ["a"],
						groupIds: [],
						box: { x: 490, y: 90, width: 120, height: 60 },
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		const cellOf = (label: string) =>
			xml.match(
				new RegExp(
					`<mxCell id="(\\d+)" value="${label}" [^>]*parent="(\\d+)"><mxGeometry x="([^"]+)" y="([^"]+)"`,
				),
			);
		const outer = cellOf("Outer");
		const inner = cellOf("Inner");
		const a = cellOf("A");
		const b = cellOf("B");
		// Outer is at the root; inner sits in outer, a in inner, b in outer,
		// each at geometry relative to its parent.
		expect(outer?.[2]).toBe("1");
		expect(inner?.[2]).toBe(outer?.[1]);
		expect(inner?.slice(3)).toEqual(["10", "10"]);
		expect(a?.[2]).toBe(inner?.[1]);
		expect(a?.slice(3)).toEqual(["10", "10"]);
		expect(b?.[2]).toBe(outer?.[1]);
		expect(b?.slice(3)).toEqual(["320", "20"]);
		// The edge between a and b lives in their shared group, outer, with
		// its points relative to it: (600,110) - (480,80).
		expect(xml).toMatch(
			new RegExp(
				`edge="1" parent="${outer?.[1]}"[^>]*><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="220" y="30"/><mxPoint x="220" y="50"/></Array><mxPoint as="sourcePoint" x="120" y="30"/><mxPoint as="targetPoint" x="320" y="50"/>`,
			),
		);
	});

	it("draws the pool frame and nests its lanes in it", () => {
		const xml = exportDrawio(
			diagram({
				swimlanes: [
					{
						id: "pool",
						orientation: "horizontal",
						box: { x: 480, y: 80, width: 440, height: 80 },
						lanes: [
							{
								id: "lane",
								children: [],
								box: { x: 490, y: 90, width: 420, height: 60 },
							},
						],
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		// The pool frame at (480,80) - page origin (500,100), as the SVG's
		// swimlane-frame rect; the lane is its child at (10,10).
		const poolId = xml.match(
			/<mxCell id="(\d+)" value="" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="-20" y="-20" width="440" height="80"/,
		)?.[1];
		expect(poolId).toBeDefined();
		expect(xml).toMatch(
			new RegExp(
				`style="swimlane;[^"]*" vertex="1" parent="${poolId}"><mxGeometry x="10" y="10" width="420" height="60"`,
			),
		);
	});

	it("makes a self-loop its node's child", () => {
		const xml = exportDrawio(
			diagram({
				edges: [
					{
						id: "loop",
						source: { nodeId: "a" },
						target: { nodeId: "a" },
						points: [
							{ x: 600, y: 110 },
							{ x: 620, y: 110 },
							{ x: 620, y: 90 },
							{ x: 560, y: 90 },
							{ x: 560, y: 100 },
						],
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		const nodeId = xml.match(/<mxCell id="(\d+)" value="A"/)?.[1];
		expect(nodeId).toBeDefined();
		// Points relative to node "a" at (500,100): (600,110) -> (100,10).
		expect(xml).toMatch(
			new RegExp(
				`edge="1" parent="${nodeId}"[^>]*><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="120" y="10"/>`,
			),
		);
		expect(xml).toContain('<mxPoint as="sourcePoint" x="100" y="10"/>');
	});

	it("gives a node listed by equally large nested groups to the inner one", () => {
		// Outer "a" nests inner "z" with no padding (same box), and both list
		// node "a": the node belongs to "z", though "a" sorts first by id.
		const box = { x: 490, y: 90, width: 120, height: 60 };
		const xml = exportDrawio(
			diagram({
				groups: [
					{
						id: "a",
						label: { text: "Outer" },
						nodeIds: ["a"],
						groupIds: ["z"],
						box,
					},
					{
						id: "z",
						label: { text: "Inner" },
						nodeIds: ["a"],
						groupIds: [],
						box,
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		const innerId = xml.match(/<mxCell id="(\d+)" value="Inner"/)?.[1];
		expect(innerId).toBeDefined();
		expect(xml).toMatch(
			new RegExp(`value="A" style="[^"]*" vertex="1" parent="${innerId}"`),
		);
	});

	it("emits a nested group after an equally large parent", () => {
		// "z" contains "a" with no padding: both boxes are the same, and "a"
		// sorts first by id, yet the parent must come first.
		const box = { x: 490, y: 90, width: 120, height: 60 };
		const xml = exportDrawio(
			diagram({
				groups: [
					{
						id: "a",
						label: { text: "Inner" },
						nodeIds: ["a"],
						groupIds: [],
						box,
					},
					{
						id: "z",
						label: { text: "Outer" },
						nodeIds: [],
						groupIds: ["a"],
						box,
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		const outerId = xml.match(/<mxCell id="(\d+)" value="Outer"/)?.[1];
		expect(outerId).toBeDefined();
		expect(xml).toMatch(
			new RegExp(
				`value="Inner" [^>]*parent="${outerId}"><mxGeometry x="0" y="0"`,
			),
		);
	});

	it("paints edges below nodes, ports and their labels, as the SVG does", () => {
		const xml = exportDrawio(diagram());
		const edgeAt = xml.indexOf('edge="1"');
		const nodeAt = xml.indexOf('value="A"');
		expect(edgeAt).toBeGreaterThan(0);
		expect(nodeAt).toBeGreaterThan(edgeAt);
	});

	it("pads the page by the requested viewport padding", () => {
		const xml = exportDrawio(diagram(), { viewportPadding: 24 });
		// Bounds 400×40 at (500,100) → page 448×88, node "a" at (24,24).
		expect(xml).toContain('pageWidth="448" pageHeight="88"');
		expect(xml).toContain('x="24" y="24" width="100" height="40"');
	});

	it("draws solved compartment rows at their own boxes", () => {
		const styled = diagram({
			textAnnotations: [
				{
					text: "«block»",
					ownerId: "b",
					surfaceKind: "compartment-row",
					surfaceIndex: 0,
					box: { x: 830, y: 111, width: 40, height: 13 },
					lines: [{ text: "«block»", width: 40 }],
					fontFamily: "Arial",
					fontSize: 11,
				},
				{
					text: "Engine",
					ownerId: "b",
					surfaceKind: "compartment-row",
					surfaceIndex: 1,
					box: { x: 832, y: 127, width: 36, height: 13 },
					lines: [{ text: "Engine", width: 36 }],
					fontFamily: "Arial",
					fontSize: 11,
				},
				{
					text: "rpm: Real",
					ownerId: "b",
					surfaceKind: "compartment-row",
					surfaceIndex: 2,
					box: { x: 826, y: 143, width: 48, height: 13 },
					lines: [{ text: "rpm: Real", width: 48 }],
					fontFamily: "Arial",
					fontSize: 11,
				},
			],
		} as unknown as Partial<CoordinatedDiagram>);
		const [, b] = styled.nodes;
		if (b === undefined) throw new Error("fixture");
		b.compartments = {
			stereotype: "«block»",
			name: "Engine",
			properties: ["rpm: Real"],
		};
		const xml = exportDrawio(styled);
		const nodeId = xml.match(
			/<mxCell id="(\d+)" value="" style="shape=hexagon/,
		)?.[1];
		expect(nodeId).toBeDefined();
		// Rows are node children at node-relative positions: (826,143)-(800,100).
		expect(xml).toMatch(
			new RegExp(
				`value="rpm: Real" style="text;[^"]*fontSize=11;" vertex="1" parent="${nodeId}"><mxGeometry x="26" y="43"`,
			),
		);
		// One separator above the properties row.
		expect(xml.match(/style="line;/g)).toHaveLength(1);
		expect(xml).not.toContain("&lt;hr&gt;");
	});

	it("moves a node label to its solved box with spacing", () => {
		const styled = diagram({
			textAnnotations: [
				{
					text: "Orders DB",
					ownerId: "a",
					surfaceKind: "node-label",
					// 8px below the node centre (550,120), as for a cylinder cap.
					box: { x: 520, y: 121, width: 60, height: 14 },
					lines: [{ text: "Orders DB", width: 60 }],
					fontFamily: "Arial",
					fontSize: 13,
				},
			],
		} as unknown as Partial<CoordinatedDiagram>);
		const [a] = styled.nodes;
		if (a === undefined) throw new Error("fixture");
		a.shape = "cylinder";
		a.label = { text: "Orders DB" };
		const xml = exportDrawio(styled);
		expect(xml).toMatch(
			/value="Orders DB" style="[^"]*fontSize=13;spacingTop=16;"/,
		);
	});

	it("leaves an unlabeled lane blank", () => {
		const xml = exportDrawio(
			diagram({
				swimlanes: [
					{
						id: "s",
						orientation: "vertical",
						lanes: [
							{
								id: "lane-internal-id",
								children: ["a"],
								box: { x: 500, y: 100, width: 120, height: 40 },
							},
						],
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		expect(xml).not.toContain("lane-internal-id");
		expect(xml).toMatch(/value="" style="swimlane;/);
	});

	it("docks an edge at its named port cell", () => {
		const ported = diagram({});
		const [a] = ported.nodes;
		const [edge] = ported.edges;
		if (a === undefined || edge === undefined) throw new Error("fixture");
		a.ports = [
			{
				id: "out",
				side: "right",
				kind: "flow",
				anchor: { x: 600, y: 110 },
				box: { x: 595, y: 105, width: 10, height: 10 },
			},
		];
		edge.source = { nodeId: "a", portId: "out" };
		const xml = exportDrawio(ported);
		const portId = xml.match(
			/<mxCell id="(\d+)" value="" style="[^"]*" vertex="1" parent="\d+"><mxGeometry x="95" y="5" width="10" height="10"/,
		)?.[1];
		expect(portId).toBeDefined();
		// The edge starts at the port cell, at its centre.
		expect(xml).toMatch(new RegExp(`edge="1" parent="1" source="${portId}"`));
		expect(xml).toContain("exitX=0.5;exitY=0.5;");
	});

	it("keeps ports apart when node and port ids contain dots", () => {
		const dotted = diagram({});
		const [a, b] = dotted.nodes;
		const [edge] = dotted.edges;
		if (a === undefined || b === undefined || edge === undefined) {
			throw new Error("fixture");
		}
		// "a" + "b.c" and "a.b" + "c" would both read "a.b.c".
		a.id = "a";
		a.ports = [
			{
				id: "b.c",
				side: "right",
				kind: "flow",
				anchor: { x: 600, y: 110 },
				box: { x: 595, y: 105, width: 10, height: 10 },
			},
		];
		b.id = "a.b";
		b.ports = [
			{
				id: "c",
				side: "left",
				kind: "flow",
				anchor: { x: 800, y: 130 },
				box: { x: 795, y: 125, width: 10, height: 10 },
			},
		];
		edge.source = { nodeId: "a", portId: "b.c" };
		edge.target = { nodeId: "a.b", portId: "c" };
		// Both port labels carry the same joined owner id, "a.b.c".
		dotted.textAnnotations = [
			{
				text: "OUT",
				ownerId: "a.b.c",
				surfaceKind: "port-label",
				box: { x: 606, y: 104, width: 20, height: 12 },
				lines: [],
			},
			{
				text: "IN",
				ownerId: "a.b.c",
				surfaceKind: "port-label",
				box: { x: 772, y: 124, width: 20, height: 12 },
				lines: [],
			},
		] as never;
		const xml = exportDrawio(dotted);
		const nodeCell = (label: string) =>
			xml.match(
				new RegExp(`<mxCell id="(\\d+)" value="${label}" style="shape=`),
			)?.[1];
		const portCell = (node: string, x: number, y: number) =>
			xml.match(
				new RegExp(
					`<mxCell id="(\\d+)" value="" style="[^"]*" vertex="1" parent="${nodeCell(node)}"><mxGeometry x="${x}" y="${y}" width="10" height="10"`,
				),
			)?.[1];
		const sourcePort = portCell("A", 95, 5);
		const targetPort = portCell("B", -5, 25);
		expect(sourcePort).toBeDefined();
		expect(targetPort).toBeDefined();
		expect(sourcePort).not.toBe(targetPort);
		// Each label is a child of its own port.
		expect(xml).toMatch(
			new RegExp(`value="OUT" style="[^"]*" vertex="1" parent="${sourcePort}"`),
		);
		expect(xml).toMatch(
			new RegExp(`value="IN" style="[^"]*" vertex="1" parent="${targetPort}"`),
		);
		expect(xml).toContain(`source="${sourcePort}" target="${targetPort}"`);
	});

	it("gives each lane its own label when swimlane and lane ids contain dots", () => {
		const xml = exportDrawio(
			diagram({
				swimlanes: [
					{
						id: "a",
						orientation: "vertical",
						lanes: [
							{
								id: "b.c",
								label: { text: "First" },
								children: [],
								box: { x: 500, y: 100, width: 100, height: 40 },
								headerBox: { x: 500, y: 100, width: 100, height: 20 },
							},
						],
					},
					{
						id: "a.b",
						orientation: "vertical",
						lanes: [
							{
								id: "c",
								label: { text: "Second" },
								children: [],
								box: { x: 700, y: 100, width: 100, height: 40 },
								headerBox: { x: 700, y: 100, width: 100, height: 20 },
							},
						],
					},
				],
				// Both labels carry the joined owner id "a.b.c".
				textAnnotations: [
					{
						text: "First",
						ownerId: "a.b.c",
						surfaceKind: "swimlane-label",
						box: { x: 530, y: 103, width: 40, height: 14 },
						lines: [{ text: "First", width: 40 }],
						fontFamily: "Arial",
						fontSize: 12,
					},
					{
						text: "Second",
						ownerId: "a.b.c",
						surfaceKind: "swimlane-label",
						box: { x: 730, y: 103, width: 40, height: 14 },
						lines: [{ text: "Second", width: 40 }],
						fontFamily: "Arial",
						fontSize: 12,
					},
				],
			} as unknown as Partial<CoordinatedDiagram>),
		);
		// Each label is a child of its own lane (at (500,100) and (700,100)),
		// so both sit at the same lane-relative spot.
		const laneIds = [
			...xml.matchAll(/<mxCell id="(\d+)" value="" style="swimlane;/g),
		].map((match) => match[1]);
		expect(laneIds).toHaveLength(2);
		expect(xml).toMatch(
			new RegExp(
				`value="First" style="text;[^"]*" vertex="1" parent="${laneIds[0]}"><mxGeometry x="30" y="3"`,
			),
		);
		expect(xml).toMatch(
			new RegExp(
				`value="Second" style="text;[^"]*" vertex="1" parent="${laneIds[1]}"><mxGeometry x="30" y="3"`,
			),
		);
	});

	it("keeps the authored frame fill and stroke", () => {
		const xml = exportDrawio(
			diagram({
				frame: {
					kind: "bdd",
					titleTab: "bdd Plant",
					style: { fill: "#fafafa", stroke: "#123456" },
					box: { x: 480, y: 60, width: 440, height: 120 },
					titleBox: { x: 480, y: 60, width: 90, height: 20 },
				},
			}),
		);
		expect(xml).toMatch(
			/shape=umlFrame;[^"]*fillColor=#fafafa;strokeColor=#123456;/,
		);
	});

	it("keeps the requested page title through exportDiagram", () => {
		const xml = exportDiagram("drawio", diagram({}), {
			title: "Page A",
		}).content;
		expect(xml).toContain('name="Page A"');
	});

	it("draws evidence panels as a title column and one row per item", () => {
		const xml = exportDrawio(
			diagram({
				evidencePanels: [
					{
						id: "legend-1",
						kind: "legend",
						items: [
							{ label: { text: "Solid" }, detail: { text: "flow" } },
							{ label: { text: "Dashed" } },
						],
						box: { x: 500, y: 200, width: 200, height: 40 },
						titleLayout: { lines: ["legend:", "legend-1"] },
					},
				],
			}),
		);
		// Title column 72 wide (0.36 × 200), rows 20 high, as children of
		// the panel's background cell (panel-relative).
		const panelId = xml.match(
			/<mxCell id="(\d+)" value="" style="[^"]*" vertex="1" parent="1"><mxGeometry x="0" y="100" width="200" height="40"/,
		)?.[1];
		expect(panelId).toBeDefined();
		expect(xml).toContain('value="legend:&lt;br&gt;legend-1"');
		expect(xml).toContain(
			`parent="${panelId}"><mxGeometry x="0" y="0" width="72" height="40"`,
		);
		expect(xml).toContain('value="Solid: flow"');
		expect(xml).toContain(
			`parent="${panelId}"><mxGeometry x="72" y="0" width="128" height="20"`,
		);
		expect(xml).toContain(
			`parent="${panelId}"><mxGeometry x="72" y="20" width="128" height="20"`,
		);
	});

	it("keeps the solver's node-label line breaks and size", () => {
		const wrapped = diagram();
		const node = wrapped.nodes[0];
		if (node === undefined) throw new Error("fixture");
		node.label = { text: "Mission planning" };
		node.labelLayout = {
			lines: [
				{ text: "Mission", width: 50 },
				{ text: "planning", width: 55 },
			],
			font: { fontFamily: "Arial", fontSize: 13, lineHeight: 16 },
		} as never;
		const xml = exportDrawio(wrapped);
		expect(xml).toContain('value="Mission&lt;br&gt;planning"');
		expect(xml).toContain("fontSize=13;");
	});
});
