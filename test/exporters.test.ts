import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDiagramDsl } from "../src/dsl/index.js";
import {
	computeArrowhead,
	exportExcalidraw,
	exportSvg,
} from "../src/exporters/index.js";
import type { CoordinatedDiagram, LabelLayout } from "../src/index.js";

describe("exporters", () => {
	it("computes arrowhead geometry from the final non-zero segment", () => {
		const arrowhead = computeArrowhead([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 20 },
		]);

		expect(arrowhead.tip).toEqual({ x: 10, y: 20 });
		expect(arrowhead.direction).toEqual({ x: 0, y: 1 });
		expect(arrowhead.left).toEqual({ x: 6, y: 10 });
		expect(arrowhead.right).toEqual({ x: 14, y: 10 });
	});

	it("throws when no non-zero segment exists", () => {
		expect(() =>
			computeArrowhead([
				{ x: 2, y: 3 },
				{ x: 2, y: 3 },
			]),
		).toThrow("Arrowhead requires at least one non-zero segment");
	});

	it("exports standalone SVG shapes, labels, groups, edges, and arrowhead polygons", () => {
		const diagram = createCoordinatedDiagram();
		const svg = exportSvg(diagram, { title: "Export <Check>" });

		expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('role="img"');
		expect(svg).toContain('viewBox="0 0 520 360"');
		expect(svg).toContain("<title>Export &lt;Check&gt;</title>");
		expect(svg).toContain('class="group"');
		expect(svg).toContain('class="node node-rectangle"');
		expect(svg).toContain("node-rounded-rectangle");
		expect(svg).toContain("node-ellipse");
		expect(svg).toContain("node-diamond");
		expect(svg).toContain("node-parallelogram");
		expect(svg).toContain("node-hexagon");
		expect(svg).toContain("node-cylinder");
		expect(svg).toContain("<tspan");
		expect(svg).toContain("Alpha &amp; Beta");
		expect(svg).toContain('d="M 80 60 L 180 60 L 180 120"');
		expect(svg).toContain('class="edge-arrowhead"');
		expect(svg).toContain('points="180,130 176,120 184,120"');
	});

	it("exports local label layout coordinates at the owning box position", () => {
		const diagram = createCoordinatedDiagram();
		const node = diagram.nodes[0];
		if (node === undefined) {
			throw new Error("Expected fixture node");
		}
		node.box = { x: 100, y: 200, width: 120, height: 60 };
		node.labelLayout = createLabelLayout("Local Text", {
			x: 16,
			y: 12,
			width: 80,
			height: 20,
		});

		const svg = exportSvg(diagram);

		expect(svg).toContain('<tspan x="116" y="227">Local Text</tspan>');
	});

	it("exports local label layout coordinates for negative owning box positions", () => {
		const diagram = createCoordinatedDiagram();
		const node = diagram.nodes[0];
		if (node === undefined) {
			throw new Error("Expected fixture node");
		}
		node.box = { x: -100, y: -50, width: 120, height: 60 };
		node.labelLayout = createLabelLayout("Negative Text", {
			x: 16,
			y: 12,
			width: 80,
			height: 20,
		});

		const svg = exportSvg(diagram);

		expect(svg).toContain('<tspan x="-84" y="-23">Negative Text</tspan>');
	});

	it("exports edge labels from the routed diagram", () => {
		const source = readFileSync(
			new URL(
				"./fixtures/phase-08/edge-labels.auto-graph.yaml",
				import.meta.url,
			),
			"utf8",
		);

		const result = renderDiagramDsl(source, { format: "svg" });

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain("user command");
		expect(result.content).toContain("coolingPower_W");
	});

	it("exports dashed edges and hollow triangle arrowheads", () => {
		const result = renderDiagramDsl(`
title: Styled Edges
layout:
  direction: LR
nodes:
  source:
    label: Source
    position: { x: 0, y: 0 }
  target:
    label: Target
edges:
  - source: source
    target: target
    label: realizes
    style: dashed
    arrowhead: hollowTriangle
constraints:
  - kind: relative-position
    source: target
    reference: source
    relation: right-of
    offset: { x: 160, y: 0 }
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('stroke-dasharray="6 4"');
		expect(result.content).toContain('fill="none"');
		expect(result.content).toContain('data-edge="source-target"');
	});

	it("exports Excalidraw dashed edges and hollow triangle arrowheads", () => {
		const result = renderDiagramDsl(
			`
title: Styled Excalidraw Edges
layout:
  direction: LR
nodes:
  source:
    label: Source
    position: { x: 0, y: 0 }
  target:
    label: Target
edges:
  - source: source
    target: target
    style: dashed
    arrowhead: hollowTriangle
constraints:
  - kind: relative-position
    source: target
    reference: source
    relation: right-of
    offset: { x: 160, y: 0 }
`,
			{ format: "excalidraw" },
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toBeDefined();
		const scene = JSON.parse(result.content ?? "") as {
			elements: Array<Record<string, unknown>>;
		};
		const arrow = scene.elements.find(
			(element) => element.id === "edge:source-target",
		);

		expect(arrow).toMatchObject({
			type: "arrow",
			strokeStyle: "dashed",
			endArrowhead: "triangle_outline",
		});
	});

	it("exports deterministic Excalidraw elements with text, bindings, and groupIds", () => {
		const scene = JSON.parse(exportExcalidraw(createCoordinatedDiagram())) as {
			type: string;
			version: number;
			source: string;
			elements: Array<Record<string, unknown>>;
		};

		expect(scene.type).toBe("excalidraw");
		expect(scene.version).toBe(2);
		expect(scene.source).toBe("auto-graph");
		expect(scene.elements.map((element) => element.id)).toContain(
			"node:rectangle",
		);
		expect(scene.elements.map((element) => element.id)).toContain(
			"node-text:rectangle",
		);
		expect(scene.elements.map((element) => element.id)).toContain(
			"group:group-a",
		);

		const nodeText = scene.elements.find(
			(element) => element.id === "node-text:rectangle",
		);
		expect(nodeText).toMatchObject({
			type: "text",
			text: "Alpha & Beta",
			groupIds: ["group:group-a"],
		});

		const arrow = scene.elements.find(
			(element) => element.id === "edge:edge-a-b",
		);
		expect(arrow).toMatchObject({
			type: "arrow",
			x: 80,
			y: 60,
			points: [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 70 },
			],
			startBinding: { elementId: "node:rectangle", focus: 0, gap: 0 },
			endBinding: { elementId: "node:parallelogram", focus: 0, gap: 0 },
		});

		const groupedNode = scene.elements.find(
			(element) => element.id === "node:ellipse",
		);
		expect(groupedNode).toMatchObject({ groupIds: ["group:group-a"] });
	});

	it("exports Excalidraw edge style and arrowhead semantics", () => {
		const diagram = createCoordinatedDiagram();
		const edge = diagram.edges[0];
		if (edge === undefined) {
			throw new Error("Expected fixture edge");
		}
		edge.style = "dashed";
		edge.arrowhead = "hollowTriangle";

		const scene = JSON.parse(exportExcalidraw(diagram)) as {
			elements: Array<Record<string, unknown>>;
		};
		const arrow = scene.elements.find(
			(element) => element.id === "edge:edge-a-b",
		);

		expect(arrow).toMatchObject({
			type: "arrow",
			strokeStyle: "dashed",
			endArrowhead: "triangle_outline",
		});
	});

	it("exports SysML visual structures from DSL", () => {
		const source = readFileSync(
			new URL(
				"./fixtures/phase-08/sysml-structure.auto-graph.yaml",
				import.meta.url,
			),
			"utf8",
		);

		const result = renderDiagramDsl(source, { format: "svg" });

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain("sysml-frame");
		expect(result.content).toContain("ibd [block] Processing System");
		expect(result.content).toContain('class="port"');
		expect(result.content).toContain(
			'data-port="processing_block.cooling_out"',
		);
		expect(result.content).toContain("swimlane");
		expect(result.content).toContain("compartment");
		expect(result.content).toContain("«block»");
		expect(result.content).toContain("#fff2cc");
		expect(result.content).toContain("coolingPower_W");
	});

	it("exports contract swimlane header and content regions from DSL", () => {
		const source = readFileSync(
			new URL(
				"./fixtures/phase-08/contract-swimlane.auto-graph.yaml",
				import.meta.url,
			),
			"utf8",
		);

		const result = renderDiagramDsl(source, { format: "svg" });

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('class="swimlane-header"');
		expect(result.content).toContain('class="swimlane-content"');
		expect(result.content).toContain('data-lane-header="behavior.left"');
		expect(result.content).toContain('data-lane-content="behavior.right"');
	});

	it("exports contract swimlane regions even without lane labels", () => {
		const result = renderDiagramDsl(`
title: Unlabeled Contract Swimlane
layout:
  direction: LR
swimlanes:
  behavior:
    layout: contract
    headerHeight: 24
    padding: 16
    orientation: vertical
    lanes:
      source:
        children: [source_a]
      target:
        children: [target_a]
nodes:
  source_a:
    label: Source A
  target_a:
    label: Target A
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('class="swimlane-header"');
		expect(result.content).toContain('class="swimlane-content"');
		expect(result.content).not.toContain('class="swimlane-label"');
	});

	it("rotates horizontal contract swimlane header labels", () => {
		const result = renderDiagramDsl(`
title: Horizontal Contract Swimlane
layout:
  direction: TB
swimlanes:
  behavior:
    layout: contract
    headerHeight: 24
    padding: 16
    orientation: horizontal
    lanes:
      observe:
        label: Observe
        children: [observe_node]
      decide:
        label: Decide
        children: [decide_node]
nodes:
  observe_node:
    label: Observe Node
  decide_node:
    label: Decide Node
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('class="swimlane-label"');
		expect(result.content).toContain('transform="rotate(-90');
	});

	it("does not render duplicate centered labels for compartment nodes", () => {
		const result = renderDiagramDsl(`
nodes:
  block:
    label: Processing
    compartments:
      stereotype: "«block»"
      name: Processing
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('class="compartment-name"');
		expect(result.content).not.toContain('class="label" data-for="block"');
	});

	it("honors custom port stroke styles in SVG output", () => {
		const result = renderDiagramDsl(`
nodes:
  block:
    label: Block
    ports:
      flow:
        side: right
        style:
          fill: "#d9ead3"
          stroke: "#16a34a"
`);

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('data-port="block.flow"');
		expect(result.content).toContain('stroke="#16a34a"');
	});

	it("renders evidence blocks in SVG with physical matrix cells, table stripes, and panel kinds", () => {
		const result = renderDiagramDsl(evidenceBlocksSource(), { format: "svg" });

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain('class="matrix-block"');
		expect(result.content).toContain('class="table-block"');
		expect(result.content).toContain(
			'class="evidence-panel evidence-panel--legend"',
		);
		expect(result.content).toContain("evidence-panel--rule");
		expect(result.content).toContain("evidence-panel--note");
		expect(result.content).toContain("evidence-panel--verification");
		expect(countOccurrences(result.content ?? "", 'class="matrix-cell"')).toBe(
			4,
		);
		expect(
			countOccurrences(result.content ?? "", 'class="matrix-cell-label"'),
		).toBe(4);
		expect(result.content).toContain('class="table-row table-row-even"');
		expect(result.content).toContain('class="table-row table-row-odd"');
		expect(result.content).toContain('class="evidence-panel-title-cell"');
		expect(result.content).toContain('class="evidence-panel-items-cell"');
		expect(result.content).toContain('data-column-count="3"');
		expect(result.content).toContain('data-col="parameter" x="220"');
		expect(result.content).toContain('data-col="value" x="340"');
		expect(result.content).toContain('data-col="source" x="460"');
	});

	it("exports evidence blocks to deterministic editable Excalidraw elements", () => {
		const result = renderDiagramDsl(evidenceBlocksSource(), {
			format: "excalidraw",
		});

		expect(result.diagnostics).toEqual([]);
		const scene = JSON.parse(result.content ?? "{}") as {
			elements: Array<Record<string, unknown>>;
		};
		const ids = scene.elements.map((element) => element.id);

		expect(ids).toEqual(
			expect.arrayContaining([
				"matrix:coverage-matrix",
				"matrix-text:coverage-matrix",
				"table:parameter-table",
				"table-text:parameter-table",
				"evidence-panel:verification-panel",
				"evidence-panel-text:verification-panel",
			]),
		);
		expect(
			scene.elements.find((element) => element.id === "matrix:coverage-matrix"),
		).toMatchObject({
			type: "rectangle",
			x: 220,
			y: 20,
			width: 200,
			height: 90,
			groupIds: ["matrix:coverage-matrix"],
		});
		expect(
			scene.elements.find((element) => element.id === "table:parameter-table"),
		).toMatchObject({
			type: "rectangle",
			x: 220,
			y: 140,
			width: 360,
			height: 102,
			groupIds: ["table:parameter-table"],
		});
		expect(
			scene.elements.find(
				(element) => element.id === "evidence-panel:verification-panel",
			),
		).toMatchObject({
			type: "rectangle",
			x: 560,
			y: 380,
			width: 320,
			height: 72,
			groupIds: ["evidence-panel:verification-panel"],
		});
		expect(
			scene.elements.find(
				(element) => element.id === "evidence-panel-text:verification-panel",
			),
		).toMatchObject({
			type: "text",
			text: "verification: verification-panel\nTest case: Pass",
			containerId: "evidence-panel:verification-panel",
			groupIds: ["evidence-panel:verification-panel"],
		});
	});

	it.each([
		"01-method-chain.yaml",
		"04-traceability-spine.yaml",
		"05-structure-parameter-extraction.yaml",
	])("renders evidence-block fixture %s through the full SVG pipeline", (name) => {
		const result = renderDiagramDsl(readEvidenceFixture(name), {
			sourcePath: evidenceFixturePath(name),
			format: "svg",
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.content).toContain("<svg");
		expect(result.diagram).toBeDefined();
		const expectedClasses = [
			...(result.diagram?.matrices === undefined ? [] : ["matrix-block"]),
			...(result.diagram?.tables === undefined ? [] : ["table-block"]),
			...(result.diagram?.evidencePanels === undefined
				? []
				: ["evidence-panel"]),
		];
		for (const className of expectedClasses) {
			expect(result.content).toContain(`class="${className}`);
		}
	});

	it("blocks exporter geometry recomputation imports and calls", () => {
		const forbiddenTerms = [
			"solveDiagram",
			"runDagreInitialLayout",
			"applyLayoutConstraints",
			"routeEdge",
			"fitLabel",
			"TextMeasurer",
			"computeShapeGeometry",
			"computeContainerGeometry",
		];
		const exporterDir = new URL("../src/exporters", import.meta.url);
		const sourceFiles = readdirSync(exporterDir)
			.filter((fileName) => fileName.endsWith(".ts"))
			.map((fileName) => join(exporterDir.pathname, fileName));

		for (const filePath of sourceFiles) {
			const content = readFileSync(filePath, "utf8");
			for (const term of forbiddenTerms) {
				expect(content, `${filePath} must not contain ${term}`).not.toContain(
					term,
				);
			}
		}
	});

	it("blocks DSL and CLI geometry recomputation imports and calls", () => {
		const forbiddenPatterns = [
			/runDagreInitialLayout/,
			/applyLayoutConstraints/,
			/routeEdge/,
			/computeShapeGeometry/,
			/computeContainerGeometry/,
			/unionBoxes/,
			/from\s+["']\.\.\/layout\//,
			/from\s+["']\.\.\/routing\//,
			/from\s+["']\.\.\/geometry\//,
		];
		const sourceFiles = [
			...sourceFilesIn(new URL("../src/dsl", import.meta.url)),
			...sourceFilesIn(new URL("../src/cli", import.meta.url)),
		];

		for (const filePath of sourceFiles) {
			const content = readFileSync(filePath, "utf8");
			for (const pattern of forbiddenPatterns) {
				expect(
					content,
					`${filePath} must not match forbidden recomputation pattern ${pattern}`,
				).not.toMatch(pattern);
			}
		}

		const normalizeSource = readFileSync(
			new URL("../src/dsl/normalize.ts", import.meta.url),
			"utf8",
		);
		expect(normalizeSource).toContain("fitLabel");
		expect(normalizeSource).toContain("createDefaultTextMeasurer");
	});

	it("runs the built agh binary against the architecture example", () => {
		const binaryPath = new URL("../dist/cli/index.js", import.meta.url)
			.pathname;
		const examplePath = new URL(
			"../examples/architecture.yaml",
			import.meta.url,
		).pathname;

		expect(existsSync(binaryPath)).toBe(true);
		const output = execFileSync(process.execPath, [
			binaryPath,
			"--input",
			examplePath,
			"--format",
			"svg",
		]).toString("utf8");

		expect(output).toContain("<svg");
		expect(output).toContain("</svg>");
	});
});

function sourceFilesIn(directory: URL): string[] {
	return readdirSync(directory)
		.filter((fileName) => fileName.endsWith(".ts"))
		.map((fileName) => join(directory.pathname, fileName));
}

function readEvidenceFixture(name: string): string {
	return readFileSync(evidenceFixturePath(name), "utf8");
}

function evidenceFixturePath(name: string): string {
	return new URL(`./fixtures/evidence-blocks/${name}`, import.meta.url)
		.pathname;
}

function countOccurrences(value: string, token: string): number {
	return value.split(token).length - 1;
}

function evidenceBlocksSource(): string {
	return `
title: Evidence Blocks
layout: { direction: LR }
nodes:
  anchor:
    label: Anchor
    position: { x: 0, y: 0 }
matrices:
  - id: coverage-matrix
    rows: [need-1, need-2]
    cols: [function-1, function-2]
    position: { x: 220, y: 20 }
    size: { width: 200, height: 90 }
    cells:
      - [covered, gap]
      - [derived, covered]
tables:
  - id: parameter-table
    columns:
      - { id: parameter, label: Parameter }
      - { id: value, label: Value }
      - { id: source, label: Source }
    rows:
      - id: row-one
        cells:
          parameter: mass
          value: 12kg
          source: test
      - id: row-two
        cells:
          parameter: power
          value: 80W
          source: analysis
    position: { x: 220, y: 140 }
    size: { width: 360, height: 102 }
evidencePanels:
  - id: legend-panel
    kind: legend
    position: { x: 220, y: 280 }
    size: { width: 320, height: 72 }
    items:
      - { id: solid, label: Solid, detail: Required trace }
  - id: rule-panel
    kind: rule
    position: { x: 560, y: 280 }
    size: { width: 320, height: 72 }
    items:
      - { id: one-hop, label: One-hop, detail: No skips }
  - id: note-panel
    kind: note
    position: { x: 220, y: 380 }
    size: { width: 320, height: 72 }
    items:
      - { id: warning, label: Warning, detail: Explain gaps }
  - id: verification-panel
    kind: verification
    position: { x: 560, y: 380 }
    size: { width: 320, height: 72 }
    items:
      - { id: test-case, label: Test case, detail: Pass }
`;
}

function createCoordinatedDiagram(): CoordinatedDiagram {
	const labelLayout = createLabelLayout("Alpha & Beta", {
		x: 12,
		y: 24,
		width: 96,
		height: 20,
	});

	return {
		id: "svg-export",
		direction: "LR",
		nodes: [
			{
				id: "rectangle",
				shape: "rectangle",
				label: { text: "Alpha & Beta" },
				labelLayout,
				box: { x: 10, y: 20, width: 120, height: 60 },
				anchors: [],
			},
			{
				id: "rounded",
				shape: "rounded-rectangle",
				label: { text: "Rounded" },
				box: { x: 170, y: 20, width: 120, height: 60 },
				anchors: [],
			},
			{
				id: "ellipse",
				shape: "ellipse",
				label: { text: "Ellipse" },
				box: { x: 330, y: 20, width: 120, height: 60 },
				anchors: [],
			},
			{
				id: "diamond",
				shape: "diamond",
				label: { text: "Diamond" },
				box: { x: 10, y: 130, width: 120, height: 70 },
				anchors: [],
			},
			{
				id: "parallelogram",
				shape: "parallelogram",
				label: { text: "Para" },
				box: { x: 170, y: 130, width: 120, height: 70 },
				anchors: [],
			},
			{
				id: "hexagon",
				shape: "hexagon",
				label: { text: "Hex" },
				box: { x: 330, y: 130, width: 120, height: 70 },
				anchors: [],
			},
			{
				id: "cylinder",
				shape: "cylinder",
				label: { text: "DB" },
				box: { x: 170, y: 250, width: 120, height: 70 },
				anchors: [],
			},
		],
		edges: [
			{
				id: "edge-a-b",
				source: { nodeId: "rectangle" },
				target: { nodeId: "parallelogram" },
				points: [
					{ x: 80, y: 60 },
					{ x: 180, y: 60 },
					{ x: 180, y: 130 },
				],
			},
		],
		groups: [
			{
				id: "group-a",
				label: { text: "Group" },
				nodeIds: ["rectangle", "rounded", "ellipse"],
				groupIds: [],
				padding: { top: 12, right: 12, bottom: 12, left: 12 },
				box: { x: 0, y: 0, width: 470, height: 110 },
			},
		],
		diagnostics: [],
		bounds: { x: 0, y: 0, width: 520, height: 360 },
	};
}

function createLabelLayout(text: string, box: LabelLayout["box"]): LabelLayout {
	return {
		text,
		box,
		contentBox: box,
		naturalSize: { width: box.width, height: box.height },
		fittedSize: { width: box.width, height: box.height },
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		font: { fontFamily: "Arial", fontSize: 14, lineHeight: 18 },
		lineHeight: 18,
		lines: [
			{
				text,
				box,
				baselineY: box.y + 15,
				width: box.width,
				lineIndex: 0,
			},
		],
		overflow: { horizontal: false, vertical: false, truncated: false },
		diagnostics: [],
	};
}
