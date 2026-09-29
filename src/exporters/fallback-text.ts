/**
 * A conservative width for text drawn without a solved measurement:
 * wide glyphs (CJK, Hangul, fullwidth forms) and the broadest Latin ones
 * (M, W, m, w, @, %, &) take a full em, other capitals 0.75, the rest 0.6.
 */
export function fallbackTextWidth(text: string, fontSize: number): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			code >= 0x1f300;
		// Latin capitals run up to ~0.9 em in Arial/Helvetica (W, M), and a
		// few other glyphs reach a full em: size those up too.
		const broad = "MWmw@%&".includes(char);
		const capital = char >= "A" && char <= "Z";
		width +=
			wide || broad ? fontSize : capital ? fontSize * 0.75 : fontSize * 0.6;
	}
	return width;
}
