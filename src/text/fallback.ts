import { isFullWidthCodePoint } from "./cjk-width.js";
import type {
	PreparedText,
	TextLayout,
	TextLayoutLine,
	TextMeasurer,
	TextStyleOptions,
} from "./types.js";
import {
	assertFiniteNonNegative,
	resolveLineHeight,
	toCanvasFont,
	validateTextStyle,
} from "./types.js";

export class DeterministicTextMeasurer implements TextMeasurer {
	prepare(text: string, style: TextStyleOptions): PreparedText {
		validateTextStyle(style);

		return {
			text,
			font: toCanvasFont(style),
			style: { ...style },
			backend: "deterministic",
		};
	}

	layout(
		prepared: PreparedText,
		maxWidth: number,
		lineHeight = resolveLineHeight(prepared.style),
	): TextLayout {
		assertFiniteNonNegative(maxWidth, "maxWidth");
		assertFinitePositiveLineHeight(lineHeight);

		const lines = this.wrap(prepared, maxWidth);
		const width = lines.reduce(
			(current, line) => Math.max(current, line.width),
			0,
		);

		return {
			width,
			height: lines.length * lineHeight,
			lineHeight,
			lineCount: lines.length,
			lines,
			diagnostics: [],
		};
	}

	naturalWidth(prepared: PreparedText): number {
		return prepared.text.split("\n").reduce((width, line) => {
			return Math.max(width, textWidth(line, prepared.style));
		}, 0);
	}

	private wrap(prepared: PreparedText, maxWidth: number): TextLayoutLine[] {
		const output: TextLayoutLine[] = [];
		prepared.text.split("\n").forEach((sourceLine, segmentIndex) => {
			output.push(
				...wrapLine(sourceLine, segmentIndex, maxWidth, prepared.style),
			);
		});
		if (output.length === 0) {
			output.push(createLine("", 0, 0, 0, 0));
		}
		return output;
	}
}

/** Width of one character: 1 em for full-width CJK, 0.6 em otherwise. */
function charWidth(char: string, style: TextStyleOptions): number {
	const letterSpacing = style.letterSpacing ?? 0;
	const code = char.codePointAt(0) as number;
	const advance = isFullWidthCodePoint(code)
		? style.fontSize
		: style.fontSize * 0.6;
	return Math.max(0, advance + letterSpacing);
}

/** Counted per character class, so equal texts give bit-equal widths. */
function textWidth(text: string, style: TextStyleOptions): number {
	let full = 0;
	let other = 0;
	for (const char of text) {
		if (isFullWidthCodePoint(char.codePointAt(0) as number)) full += 1;
		else other += 1;
	}
	const letterSpacing = style.letterSpacing ?? 0;
	return (
		full * Math.max(0, style.fontSize + letterSpacing) +
		other * Math.max(0, style.fontSize * 0.6 + letterSpacing)
	);
}

/**
 * Characters that must not start a line (closing brackets and quotes,
 * CJK and Latin sentence punctuation, small kana, prolonged sound mark) and
 * characters that must not end one (opening brackets and quotes): the
 * kinsoku / 避头尾 rules.
 */
const NO_LINE_START = new Set(
	Array.from(
		"，。、；：？！）］｝〕〉》」』】〙〗〟’”｠»‐゠–〜～・ーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々〻‼⁇⁈⁉,.;:!?)]}%…‥",
	),
);
const NO_LINE_END = new Set(Array.from("（［｛〔〈《「『【〘〖〝‘“｟«([{"));

interface Unit {
	text: string;
	start: number;
	end: number;
	width: number;
	space: boolean;
}

/**
 * Break one source line: Latin words stay whole, a break may fall between
 * any two CJK characters or at a space, never before a no-start or after a
 * no-end character. A cluster wider than the line is split by character.
 */
function wrapLine(
	line: string,
	segmentIndex: number,
	maxWidth: number,
	style: TextStyleOptions,
): TextLayoutLine[] {
	if (line.length === 0) return [createLine("", 0, segmentIndex, 0, 0)];
	// Units: a space run, a single full-width character, or a Latin word.
	const units: Unit[] = [];
	let offset = 0;
	for (const char of line) {
		const code = char.codePointAt(0) as number;
		const space = /\s/.test(char);
		const full = isFullWidthCodePoint(code);
		const last = units[units.length - 1];
		const width = charWidth(char, style);
		if (
			last !== undefined &&
			!full &&
			last.space === space &&
			!isFullWidthCodePoint(last.text.codePointAt(0) as number)
		) {
			last.text += char;
			last.end += char.length;
			last.width += width;
		} else {
			units.push({
				text: char,
				start: offset,
				end: offset + char.length,
				width,
				space,
			});
		}
		offset += char.length;
	}
	// Clusters: units joined wherever no break is allowed between them.
	const clusters: Unit[][] = [];
	for (const unit of units) {
		const current = clusters[clusters.length - 1];
		const previous = current?.[current.length - 1];
		const glued =
			previous !== undefined &&
			!unit.space &&
			!previous.space &&
			(NO_LINE_START.has(Array.from(unit.text)[0] as string) ||
				NO_LINE_END.has(Array.from(previous.text).at(-1) as string));
		if (glued && current !== undefined) current.push(unit);
		else clusters.push([unit]);
	}

	const lines: TextLayoutLine[] = [];
	let pending: Unit[] = [];
	const widthOf = (items: readonly Unit[]) =>
		items.reduce((sum, item) => sum + item.width, 0);
	const flush = () => {
		while (pending.length > 0 && pending[pending.length - 1]?.space) {
			pending.pop();
		}
		if (pending.length === 0) return;
		const first = pending[0] as Unit;
		const last = pending[pending.length - 1] as Unit;
		const text = line.slice(first.start, last.end);
		lines.push(
			createLine(
				text,
				textWidth(text, style),
				segmentIndex,
				first.start,
				last.end,
			),
		);
		pending = [];
	};
	for (const cluster of clusters) {
		if (pending.length === 0 && cluster.every((unit) => unit.space)) continue;
		const width = widthOf(cluster);
		const contentWidth = widthOf(pending);
		if (pending.length > 0 && contentWidth + width > maxWidth + 1e-9) {
			if (cluster.every((unit) => unit.space)) {
				flush();
				continue;
			}
			flush();
		}
		if (width > maxWidth + 1e-9 && !cluster.every((unit) => unit.space)) {
			// Emergency break: split the cluster by character.
			for (const unit of cluster) {
				let at = unit.start;
				for (const char of unit.text) {
					const piece: Unit = {
						text: char,
						start: at,
						end: at + char.length,
						width: charWidth(char, style),
						space: false,
					};
					at += char.length;
					if (
						pending.length > 0 &&
						widthOf(pending) + piece.width > maxWidth + 1e-9
					) {
						flush();
					}
					pending.push(piece);
				}
			}
			continue;
		}
		pending.push(...cluster);
	}
	flush();
	return lines.length > 0 ? lines : [createLine("", 0, segmentIndex, 0, 0)];
}

function createLine(
	text: string,
	width: number,
	segmentIndex: number,
	start: number,
	end: number,
): TextLayoutLine {
	return {
		text,
		width,
		start: {
			segmentIndex,
			graphemeIndex: start,
		},
		end: {
			segmentIndex,
			graphemeIndex: end,
		},
	};
}

function assertFinitePositiveLineHeight(lineHeight: number): void {
	if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
		throw new TypeError("lineHeight must be finite and positive");
	}
}
