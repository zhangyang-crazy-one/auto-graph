/**
 * A conservative width for text drawn without a solved measurement, at
 * least the glyph's advance in Arial/Helvetica: outside ASCII a full em
 * (CJK, Hangul, fullwidth forms, dashes, accented letters) and 1.25 em for
 * emoji; in ASCII 1.05 em for "@", a full em for the broadest glyphs
 * (M, W, m, w, %), 0.8 em for other capitals (O, Q, G reach 0.78) and
 * 0.6 em for the rest (lowercase, digits, punctuation stay under 0.59).
 */
export function fallbackTextWidth(text: string, fontSize: number): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const em =
			code >= 0x1f000
				? 1.25
				: code > 0x7f
					? 1
					: char === "@"
						? 1.05
						: "MWmw%".includes(char)
							? 1
							: char >= "A" && char <= "Z"
								? 0.8
								: 0.6;
		width += em * fontSize;
	}
	return width;
}
