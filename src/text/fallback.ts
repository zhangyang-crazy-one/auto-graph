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
		const charWidth = getCharacterWidth(prepared.style);

		return prepared.text.split("\n").reduce((width, line) => {
			return Math.max(width, line.length * charWidth);
		}, 0);
	}

	private wrap(prepared: PreparedText, maxWidth: number): TextLayoutLine[] {
		const charWidth = getCharacterWidth(prepared.style);
		const sourceLines = prepared.text.split("\n");
		const output: TextLayoutLine[] = [];
		let segmentIndex = 0;

		for (const sourceLine of sourceLines) {
			if (sourceLine.length === 0) {
				output.push(createLine("", 0, segmentIndex, 0, 0));
				segmentIndex += 1;
				continue;
			}

			const maxChars =
				maxWidth <= 0 ? 1 : Math.max(1, Math.floor(maxWidth / charWidth));

			for (let start = 0; start < sourceLine.length; start += maxChars) {
				const text = sourceLine.slice(start, start + maxChars);
				output.push(
					createLine(
						text,
						text.length * charWidth,
						segmentIndex,
						start,
						start + text.length,
					),
				);
			}

			segmentIndex += 1;
		}

		if (output.length === 0) {
			output.push(createLine("", 0, 0, 0, 0));
		}

		return output;
	}
}

function getCharacterWidth(style: TextStyleOptions): number {
	const letterSpacing = style.letterSpacing ?? 0;
	return Math.max(0, style.fontSize * 0.6 + letterSpacing);
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
