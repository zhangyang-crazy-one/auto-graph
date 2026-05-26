import { DeterministicTextMeasurer } from "./fallback.js";
import { isPretextRuntimeAvailable, PretextTextMeasurer } from "./pretext.js";
import type { TextMeasurer } from "./types.js";

export function createDefaultTextMeasurer(): TextMeasurer {
	return isPretextRuntimeAvailable()
		? new PretextTextMeasurer()
		: new DeterministicTextMeasurer();
}
