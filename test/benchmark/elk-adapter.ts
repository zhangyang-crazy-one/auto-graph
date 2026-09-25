import ELK from "elkjs/lib/elk.bundled.js";
import type {
	ElkExtendedEdge,
	ElkNode,
	LayoutOptions,
} from "elkjs/lib/elk-api.js";
import type {
	Box,
	CoordinatedDiagram,
	Point,
	SolvedTextAnnotation,
} from "../../src/ir/index.js";

/**
 * Lays out an already solved DGE diagram again with ELK layered, so both
 * engines are measured on identical input: the same node sizes (labels
 * already fitted by DGE's text measurement), the same group / lane
 * hierarchy and paddings, the same edge label sizes and similar spacing.
 * The result is the DGE diagram with ELK's node, container, edge and
 * edge-label geometry written in, ready for `measureLayoutQuality`.
 *
 * Not modelled in ELK: ports (edges attach to nodes), equal-thickness
 * abutting lanes (lanes become ordinary compound nodes) and explicit
 * constraints.
 */
export interface ElkRun {
	diagram: CoordinatedDiagram;
	/** Time spent inside `elk.layout` (ms). */
	layoutMs: number;
}

const DIRECTION = { LR: "RIGHT", RL: "LEFT", TB: "DOWN", BT: "UP" } as const;

export async function layoutWithElk(
	solved: CoordinatedDiagram,
): Promise<ElkRun> {
	const containers = containerTree(solved);
	const edgeLabels = new Map<string, SolvedTextAnnotation>();
	for (const annotation of solved.textAnnotations ?? []) {
		if (annotation.surfaceKind === "edge-label") {
			edgeLabels.set(annotation.ownerId, annotation);
		}
	}

	const elkChildren = new Map<string, ElkNode[]>();
	const push = (parent: string, child: ElkNode) => {
		const list = elkChildren.get(parent) ?? [];
		list.push(child);
		elkChildren.set(parent, list);
	};
	for (const node of solved.nodes) {
		push(containers.parentOfNode.get(node.id) ?? ROOT, {
			id: node.id,
			width: node.box.width,
			height: node.box.height,
		});
	}
	const build = (id: string): ElkNode => {
		const children = [
			...(containers.childContainers.get(id) ?? []).map(build),
			...(elkChildren.get(id) ?? []),
		];
		const padding = containers.padding.get(id);
		return {
			id,
			children,
			...(padding === undefined
				? {}
				: {
						layoutOptions: {
							"elk.padding": `[top=${padding.top},left=${padding.left},bottom=${padding.bottom},right=${padding.right}]`,
						},
					}),
		};
	};
	const edges: ElkExtendedEdge[] = solved.edges.map((edge) => {
		const label = edgeLabels.get(edge.id);
		return {
			id: edge.id,
			sources: [edge.source.nodeId],
			targets: [edge.target.nodeId],
			...(label === undefined
				? {}
				: {
						labels: [
							{
								id: `${edge.id}::label`,
								text: label.text,
								width: label.box.width,
								height: label.box.height,
							},
						],
					}),
		};
	});
	const layoutOptions: LayoutOptions = {
		"elk.algorithm": "layered",
		"elk.direction": DIRECTION[solved.direction],
		"elk.edgeRouting": "ORTHOGONAL",
		"elk.hierarchyHandling": "INCLUDE_CHILDREN",
		"elk.json.edgeCoords": "ROOT",
		"elk.json.shapeCoords": "ROOT",
		// DGE's defaults: node gap 48, layer gap 56, edge gap 12.
		"elk.spacing.nodeNode": "48",
		"elk.layered.spacing.nodeNodeBetweenLayers": "56",
		"elk.spacing.edgeEdge": "12",
		"elk.spacing.edgeNode": "12",
		"elk.layered.spacing.edgeEdgeBetweenLayers": "12",
		"elk.layered.spacing.edgeNodeBetweenLayers": "12",
		"elk.spacing.edgeLabel": "4",
		"elk.edgeLabels.inline": "false",
	};
	const root = { ...build(ROOT), layoutOptions, edges };

	const started = performance.now();
	const result = await new ELK().layout(root);
	const layoutMs = performance.now() - started;

	const boxes = new Map<string, Box>();
	const walk = (node: ElkNode) => {
		boxes.set(node.id, {
			x: node.x ?? 0,
			y: node.y ?? 0,
			width: node.width ?? 0,
			height: node.height ?? 0,
		});
		for (const child of node.children ?? []) walk(child);
	};
	walk(result);
	const routes = new Map<string, Point[]>();
	const labelBoxes = new Map<string, Box>();
	for (const edge of result.edges ?? []) {
		const points: Point[] = [];
		for (const section of edge.sections ?? []) {
			for (const point of [
				section.startPoint,
				...(section.bendPoints ?? []),
				section.endPoint,
			]) {
				const last = points.at(-1);
				if (last === undefined || last.x !== point.x || last.y !== point.y) {
					points.push({ x: point.x, y: point.y });
				}
			}
		}
		routes.set(edge.id, points);
		const label = edge.labels?.[0];
		if (label !== undefined) {
			labelBoxes.set(edge.id, {
				x: label.x ?? 0,
				y: label.y ?? 0,
				width: label.width ?? 0,
				height: label.height ?? 0,
			});
		}
	}
	return { diagram: rewrite(solved, boxes, routes, labelBoxes), layoutMs };
}

const ROOT = "__root__";

interface ContainerTree {
	parentOfNode: Map<string, string>;
	childContainers: Map<string, string[]>;
	padding: Map<
		string,
		{ top: number; right: number; bottom: number; left: number }
	>;
}

/**
 * Groups and lanes as nested compound nodes. A node's parent is the
 * smallest container holding it; a container's parent is the smallest one
 * holding all of its nodes.
 */
function containerTree(solved: CoordinatedDiagram): ContainerTree {
	const members = new Map<string, Set<string>>();
	const padding: ContainerTree["padding"] = new Map();
	const groupsById = new Map(solved.groups.map((group) => [group.id, group]));
	const descendants = (groupId: string, seen = new Set<string>()) => {
		const group = groupsById.get(groupId);
		const result = new Set(group?.nodeIds ?? []);
		for (const child of group?.groupIds ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			for (const id of descendants(child, seen)) result.add(id);
		}
		return result;
	};
	for (const group of solved.groups) {
		members.set(group.id, descendants(group.id));
		const header =
			group.labelLayout?.box.height ??
			group.labelLayout?.fittedSize.height ??
			group.headerHeight ??
			0;
		padding.set(group.id, {
			top: group.padding.top + header,
			right: group.padding.right,
			bottom: group.padding.bottom,
			left: group.padding.left,
		});
	}
	for (const swimlane of solved.swimlanes ?? []) {
		const inner = swimlane.padding ?? 16;
		const all = new Set<string>();
		for (const lane of swimlane.lanes) {
			members.set(lane.id, new Set(lane.children));
			for (const id of lane.children) all.add(id);
			const header = lane.headerBox;
			padding.set(
				lane.id,
				swimlane.orientation === "horizontal"
					? {
							top: inner,
							right: inner,
							bottom: inner,
							left: inner + (header?.width ?? 0),
						}
					: {
							top: inner + (header?.height ?? 0),
							right: inner,
							bottom: inner,
							left: inner,
						},
			);
		}
		members.set(swimlane.id, all);
		padding.set(swimlane.id, {
			top: swimlane.headerHeight ?? 0,
			right: 0,
			bottom: 0,
			left: 0,
		});
	}
	// Smallest strict superset wins; ties break on id for determinism.
	const ids = [...members.keys()].sort(
		(a, b) =>
			(members.get(a)?.size ?? 0) - (members.get(b)?.size ?? 0) ||
			a.localeCompare(b),
	);
	const parentOfNode = new Map<string, string>();
	for (const node of solved.nodes) {
		const holder = ids.find((id) => members.get(id)?.has(node.id));
		parentOfNode.set(node.id, holder ?? ROOT);
	}
	const childContainers = new Map<string, string[]>();
	for (const id of ids) {
		const own = members.get(id) as Set<string>;
		const parent =
			ids.find((other) => {
				if (other === id) return false;
				const set = members.get(other) as Set<string>;
				if (set.size < own.size || (set.size === own.size && other < id)) {
					return false;
				}
				for (const member of own) if (!set.has(member)) return false;
				return true;
			}) ?? ROOT;
		const list = childContainers.get(parent) ?? [];
		list.push(id);
		childContainers.set(parent, list);
	}
	return { parentOfNode, childContainers, padding };
}

function translate<T extends { x: number; y: number }>(
	value: T,
	dx: number,
	dy: number,
): T {
	return { ...value, x: value.x + dx, y: value.y + dy };
}

/** The solved diagram with ELK's geometry written in. */
function rewrite(
	solved: CoordinatedDiagram,
	boxes: ReadonlyMap<string, Box>,
	routes: ReadonlyMap<string, Point[]>,
	labelBoxes: ReadonlyMap<string, Box>,
): CoordinatedDiagram {
	const delta = new Map<string, { dx: number; dy: number }>();
	const moveTo = (id: string, before: Box | undefined) => {
		const after = boxes.get(id);
		if (before === undefined || after === undefined) return;
		delta.set(id, { dx: after.x - before.x, dy: after.y - before.y });
	};
	for (const node of solved.nodes) moveTo(node.id, node.box);
	for (const group of solved.groups) moveTo(group.id, group.box);
	for (const swimlane of solved.swimlanes ?? []) {
		moveTo(swimlane.id, swimlane.box);
		for (const lane of swimlane.lanes) moveTo(lane.id, lane.box);
	}
	const moveAnnotation = (
		annotation: SolvedTextAnnotation,
	): SolvedTextAnnotation => {
		if (annotation.surfaceKind === "edge-label") {
			const box = labelBoxes.get(annotation.ownerId);
			if (box === undefined) return annotation;
			const dx = box.x - annotation.box.x;
			const dy = box.y - annotation.box.y;
			return shiftAnnotation(annotation, dx, dy);
		}
		const shift = delta.get(annotation.ownerId);
		return shift === undefined
			? annotation
			: shiftAnnotation(annotation, shift.dx, shift.dy);
	};
	const nodes = solved.nodes.map((node) => {
		const box = boxes.get(node.id) ?? node.box;
		const shift = delta.get(node.id) ?? { dx: 0, dy: 0 };
		const { ports: _ports, ...rest } = node;
		return {
			...rest,
			box,
			anchors: node.anchors.map((anchor) => ({
				...anchor,
				point: translate(anchor.point, shift.dx, shift.dy),
			})),
			...(node.labelLayout === undefined
				? {}
				: {
						labelLayout: {
							...node.labelLayout,
							box: translate(node.labelLayout.box, shift.dx, shift.dy),
							contentBox: translate(
								node.labelLayout.contentBox,
								shift.dx,
								shift.dy,
							),
						},
					}),
		};
	});
	const groups = solved.groups.map((group) => ({
		...group,
		box: boxes.get(group.id) ?? group.box,
	}));
	const swimlanes = solved.swimlanes?.map((swimlane) => ({
		...swimlane,
		...(boxes.get(swimlane.id) === undefined
			? {}
			: { box: boxes.get(swimlane.id) as Box }),
		lanes: swimlane.lanes.map((lane) => {
			const box = boxes.get(lane.id);
			if (box === undefined) return lane;
			const header = lane.headerBox;
			return {
				...lane,
				box,
				...(header === undefined
					? {}
					: {
							headerBox:
								swimlane.orientation === "horizontal"
									? { ...header, x: box.x, y: box.y, height: box.height }
									: { ...header, x: box.x, y: box.y, width: box.width },
						}),
			};
		}),
	}));
	const edges = solved.edges.map((edge) => {
		const points = routes.get(edge.id);
		return points === undefined || points.length < 2
			? edge
			: { ...edge, points };
	});
	const textAnnotations = (solved.textAnnotations ?? []).map(moveAnnotation);
	const all: Box[] = [
		...nodes.map((node) => node.box),
		...groups.map((group) => group.box),
		...(swimlanes ?? []).flatMap((swimlane) =>
			swimlane.box === undefined ? [] : [swimlane.box],
		),
		...textAnnotations.map((annotation) => annotation.box),
		...edges.flatMap((edge) =>
			edge.points.map((point) => ({ ...point, width: 0, height: 0 })),
		),
	];
	const minX = Math.min(...all.map((box) => box.x));
	const minY = Math.min(...all.map((box) => box.y));
	const maxX = Math.max(...all.map((box) => box.x + box.width));
	const maxY = Math.max(...all.map((box) => box.y + box.height));
	// DGE's declared jump records belong to its own routes.
	const { edgeCrossings: _edgeCrossings, ...rest } = solved;
	return {
		...rest,
		nodes,
		groups,
		...(swimlanes === undefined ? {} : { swimlanes }),
		edges,
		textAnnotations,
		bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
	};
}

function shiftAnnotation(
	annotation: SolvedTextAnnotation,
	dx: number,
	dy: number,
): SolvedTextAnnotation {
	// Line boxes are relative to the annotation box: they move with it.
	return {
		...annotation,
		box: translate(annotation.box, dx, dy),
		anchor: translate(annotation.anchor, dx, dy),
	};
}
