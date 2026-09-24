/**
 * Advance widths that do not depend on which CJK font the renderer picks.
 *
 * Every mainstream CJK font (Microsoft YaHei, PingFang, Hiragino, Noto /
 * Source Han Sans, SimSun, WenQuanYi) draws ideographs, kana, Hangul and
 * full-width punctuation exactly 1 em wide. Canvas backends without such a
 * font fall back to glyphs of other widths (0.75 em with the fonts bundled
 * in many Linux images), so a label measured there overflows once a
 * browser draws it with a real CJK font. Measuring those characters as
 * 1 em makes the width right for any CJK font and the same on every
 * machine.
 *
 * Latin letters inside a CJK font stack are drawn with that font's Latin
 * glyphs, which run a few percent wider than the Arial-metric fonts a
 * canvas usually falls back to, hence `LATIN_IN_CJK_SCALE`.
 */

/** Latin glyphs of CJK fonts versus Arial-metric fallbacks. */
export const LATIN_IN_CJK_SCALE = 1.06;

/** Family names that make a font stack a CJK stack. */
const CJK_FAMILY =
	/yahei|pingfang|hiragino|noto sans cjk|noto serif cjk|source han|wenquanyi|simsun|simhei|nsimsun|heiti|songti|kaiti|fangsong|dengxian|microsoft jhenghei|meiryo|yu gothic|malgun|apple sd gothic|ms gothic|ms mincho/i;

export function isCjkFontStack(font: string): boolean {
	return CJK_FAMILY.test(font);
}

/** Characters every CJK font draws exactly 1 em wide. */
export function isFullWidthCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo (leading)
		(code >= 0x2e80 && code <= 0x303e) || // radicals, CJK symbols & punctuation
		(code >= 0x3041 && code <= 0x33ff) || // kana, bopomofo, Hangul compat, enclosed CJK
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
		(code >= 0xa960 && code <= 0xa97f) || // Hangul Jamo Extended-A
		(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
		(code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
		(code >= 0xff01 && code <= 0xff60) || // full-width forms
		(code >= 0xffe0 && code <= 0xffe6) || // full-width signs
		(code >= 0x20000 && code <= 0x3fffd) // CJK Extensions B–H
	);
}

/**
 * Width of `text` with full-width characters counted as `fontSize` each
 * and every other run measured by `measure` (scaled for CJK stacks).
 */
export function cjkAwareWidth(
	text: string,
	fontSize: number,
	cjkStack: boolean,
	measure: (run: string) => number,
): number {
	let width = 0;
	let run = "";
	let fullWidth = 0;
	for (const char of text) {
		const code = char.codePointAt(0) as number;
		if (isFullWidthCodePoint(code)) {
			fullWidth += 1;
			if (run.length > 0) {
				width += measure(run) * (cjkStack ? LATIN_IN_CJK_SCALE : 1);
				run = "";
			}
		} else {
			run += char;
		}
	}
	if (run.length > 0) {
		width += measure(run) * (cjkStack ? LATIN_IN_CJK_SCALE : 1);
	}
	return width + fullWidth * fontSize;
}

/** Font size in px from a CSS font shorthand ("400 14px Arial"). */
export function fontSizeOf(font: string): number | undefined {
	const match = /(\d+(?:\.\d+)?)px/.exec(font);
	return match === null ? undefined : Number(match[1]);
}
