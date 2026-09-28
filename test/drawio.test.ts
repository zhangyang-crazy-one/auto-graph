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
		// Narrow first column (60) and wide second (240), both rows.
		expect(xml).toContain('value="Key"');
		expect(xml).toContain('x="0" y="100" width="60" height="20"');
		expect(xml).toContain('x="60" y="120" width="240" height="20"');
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
		// Port at node-relative (95,15); its label at (110,0).
		expect(xml).toContain(
			`parent="${nodeId}"><mxGeometry x="95" y="15" width="10" height="10"`,
		);
		expect(xml).toContain(
			`parent="${nodeId}"><mxGeometry x="110" y="0" width="10" height="10"`,
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
		expect(exportDrawio(wrapped)).toContain('value="first&lt;br&gt;second"');
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
		// Title column 72 wide (0.36 × 200), rows 20 high, page-relative.
		expect(xml).toContain('value="legend:&lt;br&gt;legend-1"');
		expect(xml).toContain('x="0" y="100" width="72" height="40"');
		expect(xml).toContain('value="Solid: flow"');
		expect(xml).toContain('x="72" y="100" width="128" height="20"');
		expect(xml).toContain('x="72" y="120" width="128" height="20"');
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
