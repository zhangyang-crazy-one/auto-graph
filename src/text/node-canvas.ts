import { createRequire } from "node:module";
import {
	cjkAwareWidth,
	fontFamiliesOf,
	fontSizeOf,
	GENERIC_FAMILIES,
	isCjkFontStack,
	LATIN_IN_CJK_SCALE,
} from "./cjk-width.js";

type OffscreenCanvasConstructor = typeof globalThis.OffscreenCanvas;
type NodeCanvas = import("@napi-rs/canvas").Canvas;
type NodeCanvasModule = {
	createCanvas(width: number, height: number): NodeCanvas;
	GlobalFonts?: { has(name: string): boolean };
};
type LoadNodeCanvasModule = () => NodeCanvasModule;

const require = createRequire(import.meta.url);

export function installNodeCanvasRuntime(
	loadNodeCanvasModule: LoadNodeCanvasModule = loadDefaultNodeCanvasModule,
): boolean {
	if (typeof globalThis.OffscreenCanvas === "function") {
		return true;
	}

	try {
		const canvasModule = loadNodeCanvasModule();
		const { createCanvas } = canvasModule;
		const hasFamily = (family: string) =>
			canvasModule.GlobalFonts?.has(family) ?? false;
		const NodeOffscreenCanvas = class {
			private readonly canvas: NodeCanvas;

			constructor(width: number, height: number) {
				this.canvas = createCanvas(width, height);
			}

			getContext(contextId: "2d") {
				return contextId === "2d"
					? withCjkAwareMeasurement(this.canvas.getContext("2d"), hasFamily)
					: null;
			}
		};

		globalThis.OffscreenCanvas =
			NodeOffscreenCanvas as unknown as OffscreenCanvasConstructor;
		return true;
	} catch {
		return false;
	}
}

function loadDefaultNodeCanvasModule(): NodeCanvasModule {
	return require("@napi-rs/canvas") as NodeCanvasModule;
}

type Context2d = ReturnType<NodeCanvas["getContext"]>;

interface FontTrust {
	/** The canvas draws CJK with a real CJK font (1 em per ideograph). */
	fullWidth: boolean;
	/** Factor for measured non-CJK runs. */
	latinScale: number;
}

/** Per CSS font string; reset when fonts are registered. */
const FONT_TRUST = new Map<string, FontTrust>();

export function resetFontTrust(): void {
	FONT_TRUST.clear();
}

/** A probe ideograph: exactly 1 em in every real CJK font. */
const CJK_PROBE = "\u6c38";

/**
 * Wrap `measureText` so widths do not depend on what the machine happens
 * to have installed. When the canvas resolves the font stack to a real
 * CJK font (the probe ideograph measures 1 em) and to a real Latin face,
 * its measurement is used unchanged — install or register the fonts the
 * diagram is drawn with and Pretext measures them exactly. Otherwise
 * full-width characters count 1 em each and Latin runs in a CJK stack get
 * `LATIN_IN_CJK_SCALE`, so labels still fit once a browser draws them
 * with a real CJK font.
 */
function withCjkAwareMeasurement(
	context: Context2d,
	hasFamily: (family: string) => boolean,
): Context2d {
	const measure = context.measureText.bind(context);
	const trustOf = (font: string, fontSize: number): FontTrust => {
		const cached = FONT_TRUST.get(font);
		if (cached !== undefined) return cached;
		const probe = measure(CJK_PROBE).width;
		const fullWidth = Math.abs(probe - fontSize) <= fontSize * 0.02;
		const realFamily = fontFamiliesOf(font).some(
			(family) =>
				!GENERIC_FAMILIES.has(family.toLowerCase()) && hasFamily(family),
		);
		const trust = {
			fullWidth,
			latinScale: realFamily || !isCjkFontStack(font) ? 1 : LATIN_IN_CJK_SCALE,
		};
		FONT_TRUST.set(font, trust);
		return trust;
	};
	context.measureText = ((text: string) => {
		const metrics = measure(text);
		const fontSize = fontSizeOf(context.font);
		if (fontSize === undefined) return metrics;
		const trust = trustOf(context.font, fontSize);
		if (trust.fullWidth && trust.latinScale === 1) return metrics;
		const width = cjkAwareWidth(text, fontSize, {
			measure: (run) => measure(run).width,
			trustFullWidth: trust.fullWidth,
			latinScale: trust.latinScale,
		});
		return new Proxy(metrics, {
			get: (target, key) =>
				key === "width" ? width : Reflect.get(target, key, target),
		});
	}) as Context2d["measureText"];
	return context;
}
