import type { Box, Point } from "../ir/geometry.js";

/** Height of the stick figure drawn for an actor head. */
export const ACTOR_FIGURE_HEIGHT = 34;
/** Arm span of the actor stick figure. */
export const ACTOR_FIGURE_WIDTH = 20;

export interface ActorFigure {
	head: { cx: number; cy: number; r: number };
	/** Body, arms and legs, as line segments. */
	lines: [Point, Point][];
}

/**
 * The UML stick figure at the top centre of an actor's head box; its name
 * goes below it.
 */
export function actorFigure(box: Box): ActorFigure {
	const cx = box.x + box.width / 2;
	const top = box.y + 1;
	const r = 6;
	const neck = top + 2 * r;
	const hip = neck + 12;
	const foot = top + ACTOR_FIGURE_HEIGHT - 1;
	const arms = neck + 4;
	return {
		head: { cx, cy: top + r, r },
		lines: [
			[
				{ x: cx, y: neck },
				{ x: cx, y: hip },
			],
			[
				{ x: cx - ACTOR_FIGURE_WIDTH / 2, y: arms },
				{ x: cx + ACTOR_FIGURE_WIDTH / 2, y: arms },
			],
			[
				{ x: cx, y: hip },
				{ x: cx - 9, y: foot },
			],
			[
				{ x: cx, y: hip },
				{ x: cx + 9, y: foot },
			],
		],
	};
}

/** Corners of a fragment's operator tag: a box with its lower right cut. */
export function fragmentTagPoints(box: Box, cut: number): Point[] {
	return [
		{ x: box.x, y: box.y },
		{ x: box.x + box.width, y: box.y },
		{ x: box.x + box.width, y: box.y + box.height - cut },
		{ x: box.x + box.width - cut, y: box.y + box.height },
		{ x: box.x, y: box.y + box.height },
	];
}

/** Outline of a note: a box with its upper right corner folded. */
export function noteOutlinePoints(box: Box, fold: number): Point[] {
	return [
		{ x: box.x, y: box.y },
		{ x: box.x + box.width - fold, y: box.y },
		{ x: box.x + box.width, y: box.y + fold },
		{ x: box.x + box.width, y: box.y + box.height },
		{ x: box.x, y: box.y + box.height },
	];
}
