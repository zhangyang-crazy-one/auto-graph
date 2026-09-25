import { stringify } from "yaml";
import { generateSyntheticDocument, mulberry32 } from "../support/synthetic.js";

/**
 * Small, realistic edits to a synthetic diagram document, for measuring
 * how much a layout moves between versions.
 */
export type EditKind = "add-node" | "remove-node" | "add-edge" | "relabel";

export const EDIT_KINDS: readonly EditKind[] = [
	"add-node",
	"remove-node",
	"add-edge",
	"relabel",
];

type Doc = Record<string, unknown> & {
	nodes: Record<string, Record<string, unknown>>;
	edges: (string | Record<string, string>)[];
};

function endpoints(edge: string | Record<string, string>): [string, string] {
	const key =
		typeof edge === "string" ? edge : (Object.keys(edge)[0] as string);
	const [source, target] = key.split(" -> ");
	return [source as string, target as string];
}

/** Containers (group member lists / lane children) holding `id`. */
function memberLists(doc: Doc, id: string): string[][] {
	const lists: string[][] = [];
	for (const group of Object.values(
		(doc.groups ?? {}) as Record<string, { nodes: string[] }>,
	)) {
		if (group.nodes.includes(id)) lists.push(group.nodes);
	}
	for (const swimlane of Object.values(
		(doc.swimlanes ?? {}) as Record<
			string,
			{ lanes: Record<string, { children: string[] }> }
		>,
	)) {
		for (const lane of Object.values(swimlane.lanes)) {
			if (lane.children.includes(id)) lists.push(lane.children);
		}
	}
	return lists;
}

export function baseDocument(
	kind: "plain" | "architecture" | "process",
	nodes: number,
	seed = 42,
): Doc {
	return generateSyntheticDocument({ seed, nodes, kind }) as Doc;
}

export function applyEdit(source: Doc, edit: EditKind, seed = 7): Doc {
	const doc = structuredClone(source);
	const random = mulberry32(seed);
	const ids = Object.keys(doc.nodes);
	// An id from the middle of the diagram: edits there disturb the most.
	const middle = ids[
		Math.floor(ids.length * (0.35 + random() * 0.3))
	] as string;
	switch (edit) {
		case "add-node": {
			const id = "added";
			doc.nodes[id] = { label: "新增 Added" };
			doc.edges.push(`${middle} -> ${id}`);
			for (const list of memberLists(doc, middle)) list.push(id);
			break;
		}
		case "remove-node": {
			delete doc.nodes[middle];
			doc.edges = doc.edges.filter((edge) => !endpoints(edge).includes(middle));
			for (const list of memberLists(doc, middle)) {
				list.splice(list.indexOf(middle), 1);
			}
			// Groups need two members.
			const groups = (doc.groups ?? {}) as Record<string, { nodes: string[] }>;
			for (const [key, group] of Object.entries(groups)) {
				if (group.nodes.length < 2) delete groups[key];
			}
			break;
		}
		case "add-edge": {
			const existing = new Set(doc.edges.map((edge) => endpoints(edge).join()));
			const later = ids.slice(ids.indexOf(middle) + 1);
			const target =
				later.find(
					(id, index) =>
						index > later.length / 4 && !existing.has([middle, id].join()),
				) ?? (later.at(-1) as string);
			doc.edges.push(`${middle} -> ${target}`);
			break;
		}
		case "relabel": {
			const node = doc.nodes[middle] as Record<string, unknown>;
			node.label = `${String(node.label)} 扩展说明 Extended`;
			break;
		}
	}
	return doc;
}

export function toDsl(doc: Doc): string {
	return stringify(doc);
}
