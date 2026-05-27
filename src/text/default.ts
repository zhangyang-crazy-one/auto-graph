import { DeterministicTextMeasurer } from "./fallback.js";
import { installNodeCanvasRuntime } from "./node-canvas.js";
import { isPretextRuntimeAvailable, PretextTextMeasurer } from "./pretext.js";
import type { TextMeasurer } from "./types.js";

export interface DefaultTextMeasurerOptions {
	installNodeCanvasRuntime?: () => boolean;
}

export function createDefaultTextMeasurer(
	options: DefaultTextMeasurerOptions = {},
): TextMeasurer {
	const installRuntime =
		options.installNodeCanvasRuntime ?? installNodeCanvasRuntime;
	installRuntime();

	return isPretextRuntimeAvailable()
		? new PretextTextMeasurer()
		: new DeterministicTextMeasurer();
}
