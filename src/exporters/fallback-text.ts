/**
 * A conservative width for text drawn without a solved measurement, at
 * least the glyph's advance in the `Arial, sans-serif` stack the exporters
 * name (Arial, or a fallback such as DejaVu Sans): CJK, Hangul and
 * fullwidth forms take their full em; any other glyph outside ASCII up to
 * 2 em (DejaVu's per-ten-thousand sign reaches 1.74); in ASCII 1.05 em for
 * "@", a full em for the broadest glyphs (M, W, m, w, %, &), 0.8 em for
 * other capitals (O, Q, G reach 0.78) and 0.6 em for the rest (lowercase,
 * digits, punctuation stay under 0.59).
 */
export function fallbackTextWidth(text: string, fontSize: number): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const fullwidth =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		const em = fullwidth
			? 1
			: code > 0x7f
				? 2
				: char === "@"
					? 1.05
					: "MWmw%&".includes(char)
						? 1
						: char >= "A" && char <= "Z"
							? 0.8
							: 0.6;
		width += em * fontSize;
	}
	return width;
}
