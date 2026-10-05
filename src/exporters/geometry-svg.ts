import type { GeometryDocument, GeometryPathCommand } from "./geometry.js";

/**
 * Reference renderer for the geometry contract: SVG from the document
 * alone, with no access to the solver. It shows what any renderer (canvas,
 * PDF, a slide deck, a game engine) has to do — walk `zOrder` and draw
 * paths, rectangles and text runs at the given coordinates. Styling is
 * deliberately minimal; it is a proof that the contract is sufficient,
 * not a replacement for `exportSvg`.
 */
export function renderGeometrySvg(document: GeometryDocument): string {
	const nodes = new Map(document.nodes.map((node) => [node.id, node]));
	const containers = new Map(
		document.containers.map((item) => [item.id, item]),
	);
	const edges = new Map(document.edges.map((edge) => [edge.id, edge]));
	const texts = new Map(document.texts.map((text) => [text.id, text]));
	const ports = new Map<
		string,
		GeometryDocument["nodes"][number]["ports"][number]
	>(
		document.nodes.flatMap((node) =>
			node.ports.map((port) => [`${node.id}.${port.id}`, port] as const),
		),
	);
	const sequence = document.sequence;
	const lifelines = new Map(
		(sequence?.lifelines ?? []).map((item) => [item.participantId, item]),
	);
	const activations = new Map(
		(sequence?.activations ?? []).map((item) => [item.id, item]),
	);
	const fragments = new Map(
		(sequence?.fragments ?? []).map((item) => [item.id, item]),
	);
	const notes = new Map((sequence?.notes ?? []).map((item) => [item.id, item]));
	const dividers = new Map(
		(sequence?.dividers ?? []).map((item) => [item.id, item]),
	);
	const destructions = new Map(
		(sequence?.destructions ?? []).map((item) => [item.participantId, item]),
	);
	const { x, y, width, height } = document.bounds;
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(x)} ${n(y)} ${n(width)} ${n(height)}">`,
		`<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="#ffffff"/>`,
	];
	for (const paint of document.zOrder) {
		switch (paint.kind) {
			case "container": {
				const item = containers.get(paint.id);
				if (item === undefined) break;
				const dash = item.kind === "group" ? ' stroke-dasharray="6 4"' : "";
				const fill = item.kind === "lane" ? "none" : "#f9fafb";
				out.push(rect(item.box, `fill="${fill}" stroke="#374151"${dash}`));
				if (item.headerBox !== undefined) {
					out.push(rect(item.headerBox, 'fill="#f3f4f6" stroke="#374151"'));
				}
				break;
			}
			case "edge": {
				const edge = edges.get(paint.id);
				if (edge === undefined) break;
				const dash = edge.style === "dashed" ? ' stroke-dasharray="6 4"' : "";
				out.push(
					`<path d="${d(edge.path)}" fill="none" stroke="#111827" stroke-width="1.5"${dash}/>`,
				);
				for (const head of edge.arrowheads) {
					if (head.fill === "open") {
						const [tip, left, right] = head.points;
						if (tip === undefined || left === undefined || right === undefined)
							continue;
						out.push(
							`<polyline points="${[left, tip, right].map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}" fill="none" stroke="#111827" stroke-width="1.5"/>`,
						);
						continue;
					}
					const fill = head.fill === "hollow" ? "none" : "#111827";
					out.push(
						`<polygon points="${head.points.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}" fill="${fill}" stroke="#111827"/>`,
					);
				}
				break;
			}
			case "node": {
				const node = nodes.get(paint.id);
				if (node === undefined) break;
				out.push(
					`<path d="${d(node.path)}" fill="${node.strokeOnly === true ? "none" : "#f8fafc"}" stroke="#374151"/>`,
				);
				break;
			}
			case "lifeline": {
				const item = lifelines.get(paint.id);
				if (item !== undefined) {
					out.push(line(item.line, 'stroke="#6b7280" stroke-dasharray="5 4"'));
				}
				break;
			}
			case "activation": {
				const item = activations.get(paint.id);
				if (item !== undefined) {
					out.push(rect(item.box, 'fill="#f3f4f6" stroke="#374151"'));
				}
				break;
			}
			case "fragment": {
				const item = fragments.get(paint.id);
				if (item === undefined) break;
				const fill = item.kind === "ref" ? "#ffffff" : "none";
				out.push(rect(item.box, `fill="${fill}" stroke="#374151"`));
				out.push(
					`<polygon points="${item.tag.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}" fill="#ffffff" stroke="#374151"/>`,
				);
				for (const separator of item.separators) {
					out.push(line(separator, 'stroke="#374151" stroke-dasharray="5 4"'));
				}
				break;
			}
			case "note": {
				const item = notes.get(paint.id);
				if (item !== undefined) {
					out.push(
						`<path d="${d(item.path)}" fill="#fffbeb" stroke="#b45309"/>`,
					);
				}
				break;
			}
			case "divider": {
				const item = dividers.get(paint.id);
				if (item === undefined) break;
				for (const segment of item.lines) {
					out.push(line(segment, 'stroke="#374151"'));
				}
				if (item.box !== undefined) {
					out.push(rect(item.box, 'fill="#ffffff" stroke="#374151"'));
				}
				break;
			}
			case "destruction": {
				const item = destructions.get(paint.id);
				if (item === undefined) break;
				for (const segment of item.lines) {
					out.push(line(segment, 'stroke="#111827" stroke-width="2"'));
				}
				break;
			}
			case "port": {
				const port = ports.get(paint.id);
				if (port !== undefined) {
					out.push(rect(port.box, 'fill="#d9ead3" stroke="#374151"'));
				}
				break;
			}
			case "backdrop": {
				const text = texts.get(paint.id);
				if (text?.backdrop) {
					out.push(rect(text.backdrop, 'rx="2" fill="#ffffff"'));
				}
				break;
			}
			case "text": {
				const text = texts.get(paint.id);
				if (text === undefined) break;
				const cx = text.box.x + text.box.width / 2;
				const cy = text.box.y + text.box.height / 2;
				const rotate =
					text.rotation === 0
						? ""
						: ` transform="rotate(${n(text.rotation)} ${n(cx)} ${n(cy)})"`;
				out.push(
					`<text font-family="${escapeXml(text.font.family)}" font-size="${n(text.font.size)}" fill="#111827"${rotate}>${text.lines
						.map(
							(line) =>
								`<tspan x="${n(line.x)}" y="${n(line.y)}">${escapeXml(line.text)}</tspan>`,
						)
						.join("")}</text>`,
				);
				break;
			}
		}
	}
	out.push("</svg>");
	return `${out.join("\n")}\n`;
}

function d(commands: readonly GeometryPathCommand[]): string {
	return commands.map(command).join(" ");
}

function command(entry: GeometryPathCommand): string {
	if (entry.op === "Z") return "Z";
	if (entry.op === "A") {
		return `A ${n(entry.rx)} ${n(entry.ry)} ${n(entry.rotation)} ${entry.largeArc ? 1 : 0} ${entry.sweep ? 1 : 0} ${n(entry.x)} ${n(entry.y)}`;
	}
	return `${entry.op} ${n(entry.x)} ${n(entry.y)}`;
}

function line(
	segment: { x1: number; y1: number; x2: number; y2: number },
	attributes: string,
): string {
	return `<line x1="${n(segment.x1)}" y1="${n(segment.y1)}" x2="${n(segment.x2)}" y2="${n(segment.y2)}" ${attributes}/>`;
}

function rect(
	box: { x: number; y: number; width: number; height: number },
	attributes: string,
): string {
	return `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" ${attributes}/>`;
}

function n(value: number): string {
	return String(Math.round(value * 100) / 100);
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
