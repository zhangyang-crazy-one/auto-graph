import type { Box, Insets, Point } from "../ir/geometry.js";

export function normalizeInsets(input: Insets | number = 0): Insets {
	if (typeof input === "number") {
		validateMargin(input, "margin");
		return {
			top: input,
			right: input,
			bottom: input,
			left: input,
		};
	}

	validateMargin(input.top, "insets.top");
	validateMargin(input.right, "insets.right");
	validateMargin(input.bottom, "insets.bottom");
	validateMargin(input.left, "insets.left");

	return {
		top: input.top,
		right: input.right,
		bottom: input.bottom,
		left: input.left,
	};
}

export function validateBox(box: Box, label = "box"): void {
	validateFinite(box.x, `${label}.x`);
	validateFinite(box.y, `${label}.y`);
	validateFinite(box.width, `${label}.width`);
	validateFinite(box.height, `${label}.height`);

	if (box.width < 0 || box.height < 0) {
		throw new TypeError(`${label} dimensions must be non-negative`);
	}
}

export function boxCenter(box: Box): Point {
	validateBox(box);

	return {
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
	};
}

export function expandBox(box: Box, margin: number | Insets): Box {
	validateBox(box);

	const insets = normalizeInsets(margin);

	return {
		x: box.x - insets.left,
		y: box.y - insets.top,
		width: box.width + insets.left + insets.right,
		height: box.height + insets.top + insets.bottom,
	};
}

export function unionBoxes(boxes: readonly Box[]): Box {
	if (boxes.length === 0) {
		throw new TypeError("Cannot union empty box collection");
	}

	for (const [index, box] of boxes.entries()) {
		validateBox(box, `boxes[${index}]`);
	}

	const minX = Math.min(...boxes.map((box) => box.x));
	const minY = Math.min(...boxes.map((box) => box.y));
	const maxX = Math.max(...boxes.map((box) => box.x + box.width));
	const maxY = Math.max(...boxes.map((box) => box.y + box.height));

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

export function intersectsAabb(a: Box, b: Box): boolean {
	validateBox(a, "a");
	validateBox(b, "b");

	return (
		a.x <= b.x + b.width &&
		a.x + a.width >= b.x &&
		a.y <= b.y + b.height &&
		a.y + a.height >= b.y
	);
}

function validateMargin(value: number, label: string): void {
	validateFinite(value, label);

	if (value < 0) {
		throw new TypeError(`${label} must be non-negative`);
	}
}

function validateFinite(value: number, label: string): void {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${label} must be finite`);
	}
}
