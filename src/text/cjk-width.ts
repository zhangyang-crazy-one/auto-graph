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
 *
 * Both are fallbacks: when the canvas has the real font (installed, or
 * registered with `registerFonts`), its measurement is used as is.
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

export interface CjkWidthOptions {
	/** Backend measurement of a run of characters. */
	measure: (run: string) => number;
	/** Trust `measure` for full-width runs (a real CJK font is in use). */
	trustFullWidth: boolean;
	/** Factor applied to measured non-full-width runs. */
	latinScale: number;
}

/**
 * Width of `text`: full-width runs measured by the backend when it has a
 * real CJK font, else counted as `fontSize` per character; other runs
 * measured and scaled by `latinScale`.
 */
export function cjkAwareWidth(
	text: string,
	fontSize: number,
	options: CjkWidthOptions,
): number {
	let width = 0;
	let run = "";
	let runIsFull = false;
	const flush = () => {
		if (run.length === 0) return;
		if (runIsFull) {
			width += options.trustFullWidth
				? options.measure(run)
				: Array.from(run).length * fontSize;
		} else {
			width += options.measure(run) * options.latinScale;
		}
		run = "";
	};
	for (const char of text) {
		const full = isFullWidthCodePoint(char.codePointAt(0) as number);
		if (run.length > 0 && full !== runIsFull) flush();
		runIsFull = full;
		run += char;
	}
	flush();
	return width;
}

/** Family names of a CSS font shorthand, unquoted, in order. */
export function fontFamiliesOf(font: string): string[] {
	const match = /\d+(?:\.\d+)?px(?:\s*\/\s*\S+)?\s+(.+)$/.exec(font);
	if (match === null) return [];
	return (match[1] as string)
		.split(",")
		.map((family) => family.trim().replace(/^["']|["']$/g, ""))
		.filter((family) => family.length > 0);
}

/** CSS generic families: they resolve to whatever the machine has. */
export const GENERIC_FAMILIES = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-sans-serif",
	"ui-serif",
	"ui-monospace",
]);

/** Font size in px from a CSS font shorthand ("400 14px Arial"). */
export function fontSizeOf(font: string): number | undefined {
	const match = /(\d+(?:\.\d+)?)px/.exec(font);
	return match === null ? undefined : Number(match[1]);
}
