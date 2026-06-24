import type { Diagnostic } from "../ir/diagnostics.js";
import type { Box, DiagramDirection, Size } from "../ir/geometry.js";

export interface DagreLayoutOptions {
	nodesep: number;
	ranksep: number;
	edgesep: number;
	marginx: number;
	marginy: number;
	componentGap: number;
	ranker: "network-simplex" | "tight-tree" | "longest-path";
}

export interface DagreLayoutNode {
	id: string;
	size: Size;
}

export interface DagreLayoutEdge {
	id: string;
	sourceId: string;
	targetId: string;
}

export interface DagreLayoutInput {
	direction: DiagramDirection;
	nodes: readonly DagreLayoutNode[];
	edges: readonly DagreLayoutEdge[];
	options?: Partial<DagreLayoutOptions>;
}

export interface InitialLayoutResult {
	boxes: Map<string, Box>;
	diagnostics: Diagnostic[];
}
