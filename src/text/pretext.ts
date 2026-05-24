import type { PreparedTextWithSegments } from "@chenglou/pretext";
import {
	layoutWithLines,
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
		const options = {
			...(style.whiteSpace === undefined
				? {}
				: { whiteSpace: style.whiteSpace }),
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

		const result = layoutWithLines(
			toInternalPrepared(prepared),
			maxWidth,
			lineHeight,
		);
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

function toInternalPrepared(prepared: PreparedText): PreparedTextWithSegments {
	if (prepared.backend !== "pretext" || !("pretextPrepared" in prepared)) {
		throw new TypeError("prepared text was not created by PretextTextMeasurer");
	}

	return prepared.pretextPrepared as PreparedTextWithSegments;
}
