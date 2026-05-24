export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export type DiagramDirection = "TB" | "LR" | "BT" | "RL";

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Box extends Point, Size {}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export type AnchorName =
	| "center"
	| "top"
	| "right"
	| "bottom"
	| "left"
	| "top-left"
	| "top-right"
	| "bottom-right"
	| "bottom-left";

export interface AnchorPoint {
	name: AnchorName;
	point: Point;
}
