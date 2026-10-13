import type {
	LayoutCursor,
	LayoutLine,
	PreparedTextWithSegments,
} from "@chenglou/pretext";
import {
	layoutNextLineRange,
	layoutWithLines,
	materializeLineRange,
	measureNaturalWidth,
	prepareWithSegments,
} from "@chenglou/pretext";
import type {
	PreparedText,
	TextLayout,
	TextMeasurer,
	TextStyleOptions,
} from "./types.js";
import {
	assertFiniteNonNegative,
	resolveLineHeight,
	toCanvasFont,
	validateTextStyle,
} from "./types.js";

type InternalPretextPrepared = PreparedText & {
	readonly pretextPrepared: PreparedTextWithSegments;
};

const RUNTIME_UNAVAILABLE = "text.pretext.runtime-unavailable";

export function isPretextRuntimeAvailable(): boolean {
	return (
		typeof Intl.Segmenter === "function" &&
		typeof globalThis.OffscreenCanvas === "function"
	);
}

export class PretextTextMeasurer implements TextMeasurer {
	prepare(text: string, style: TextStyleOptions): PreparedText {
		if (!isPretextRuntimeAvailable()) {
			throw new TypeError(RUNTIME_UNAVAILABLE);
		}

		validateTextStyle(style);

		const font = toCanvasFont(style);
		// An authored line break ends the line: text carrying one is laid
		// out as pre-wrap unless the style says otherwise.
		const whiteSpace =
			style.whiteSpace ?? (text.includes("\n") ? "pre-wrap" : undefined);
		const options = {
			...(whiteSpace === undefined ? {} : { whiteSpace }),
			...(style.wordBreak === undefined ? {} : { wordBreak: style.wordBreak }),
			...(style.letterSpacing === undefined
				? {}
				: { letterSpacing: style.letterSpacing }),
		};
		const prepared = prepareWithSegments(text, font, options);

		return {
			text,
			font,
			style: { ...style },
			backend: "pretext",
			pretextPrepared: prepared,
		} as InternalPretextPrepared;
	}

	layout(
		prepared: PreparedText,
		maxWidth: number,
		lineHeight = resolveLineHeight(prepared.style),
	): TextLayout {
		assertFiniteNonNegative(maxWidth, "maxWidth");
		if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
			throw new TypeError("lineHeight must be finite and positive");
		}

		const internal = toInternalPrepared(prepared);
		let result = layoutWithLines(internal, maxWidth, lineHeight);
		if (
			result.lines.some((line, index) =>
				badBreak(internal, line, result.lines[index + 1]),
			)
		) {
			const lines = relayoutLines(internal, prepared.font, maxWidth);
			result = {
				lines,
				lineCount: lines.length,
				height: lines.length * lineHeight,
			};
		}
		const width = result.lines.reduce(
			(current, line) => Math.max(current, line.width),
			0,
		);

		return {
			width,
			height: result.height,
			lineHeight,
			lineCount: result.lineCount,
			lines: result.lines.map((line) => ({
				text: line.text,
				width: line.width,
				start: {
					segmentIndex: line.start.segmentIndex,
					graphemeIndex: line.start.graphemeIndex,
				},
				end: {
					segmentIndex: line.end.segmentIndex,
					graphemeIndex: line.end.graphemeIndex,
				},
			})),
			diagnostics: [],
		};
	}

	naturalWidth(prepared: PreparedText): number {
		return measureNaturalWidth(toInternalPrepared(prepared));
	}
}

/** Latin letters and digits: a run of them is one word. */
const WORD_CHAR = /[A-Za-z0-9]/;
/** Opening brackets and quotes, kept with the word after them. */
const OPENERS = new Set([..."（([［【「『〈《“‘"]);
/** Closing punctuation, never at the start of a line. */
const CLOSERS = new Set([..."）)]］】」』〉》”’。，、；：！？.,;:!?"]);

/**
 * A break inside a Latin word or number ("(F" / "UN-144"), or before a
 * closing bracket or stop. Pretext merges an opening bracket with the word
 * after it into one CJK segment and then breaks that per character. A line
 * the author ended (a hard break) is never a bad break.
 */
function badBreak(
	prepared: PreparedTextWithSegments,
	line: LayoutLine,
	next: LayoutLine | undefined,
): boolean {
	if (next === undefined || endsAtHardBreak(prepared, line)) return false;
	const last = line.text.at(-1) ?? "";
	const first = next.text[0] ?? "";
	return (WORD_CHAR.test(last) && WORD_CHAR.test(first)) || CLOSERS.has(first);
}

/** Whether a line ends at an authored line break rather than for width. */
function endsAtHardBreak(
	prepared: PreparedTextWithSegments,
	line: LayoutLine,
): boolean {
	const { kinds } = prepared as PreparedTextWithSegments & {
		kinds?: readonly string[];
	};
	const { segmentIndex, graphemeIndex } = line.end;
	return graphemeIndex === 0 && kinds?.[segmentIndex - 1] === "hard-break";
}

/** Where a bad break moves back to: before the line's last word. */
function breakBefore(text: string): number {
	let end = text.length;
	if (WORD_CHAR.test(text[end - 1] ?? "")) {
		while (end > 0 && WORD_CHAR.test(text[end - 1] ?? "")) end -= 1;
	} else {
		end -= 1;
	}
	while (end > 0 && OPENERS.has(text[end - 1] ?? "")) end -= 1;
	return end;
}

/** Line by line, moving each bad break back before the word it splits. */
function relayoutLines(
	prepared: PreparedTextWithSegments,
	font: string,
	maxWidth: number,
): LayoutLine[] {
	const lines: LayoutLine[] = [];
	const next = (cursor: LayoutCursor, width: number) => {
		const range = layoutNextLineRange(prepared, cursor, width);
		return range === null ? null : materializeLineRange(prepared, range);
	};
	let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
	let line = next(cursor, maxWidth);
	while (line !== null) {
		let following = next(line.end, maxWidth);
		if (following !== null && badBreak(prepared, line, following)) {
			const keep = breakBefore(line.text);
			if (keep > 0) {
				const width =
					measureNaturalWidth(
						prepareWithSegments(line.text.slice(0, keep), font),
					) + 0.01;
				const shorter = next(cursor, Math.min(width, maxWidth));
				if (shorter !== null && shorter.text.length < line.text.length) {
					line = shorter;
					following = next(line.end, maxWidth);
				}
			}
		}
		lines.push(line);
		cursor = line.end;
		line = following;
	}
	return lines;
}

function toInternalPrepared(prepared: PreparedText): PreparedTextWithSegments {
	if (prepared.backend !== "pretext" || !("pretextPrepared" in prepared)) {
		throw new TypeError("prepared text was not created by PretextTextMeasurer");
	}

	return prepared.pretextPrepared as PreparedTextWithSegments;
}
