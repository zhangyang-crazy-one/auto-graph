import { createRequire } from "node:module";
import { cjkAwareWidth, fontSizeOf, isCjkFontStack } from "./cjk-width.js";

type OffscreenCanvasConstructor = typeof globalThis.OffscreenCanvas;
type NodeCanvas = import("@napi-rs/canvas").Canvas;
type NodeCanvasModule = {
	createCanvas(width: number, height: number): NodeCanvas;
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
		const NodeOffscreenCanvas = class {
			private readonly canvas: NodeCanvas;

			constructor(width: number, height: number) {
				this.canvas = createCanvas(width, height);
			}

			getContext(contextId: "2d") {
				return contextId === "2d"
					? withCjkAwareMeasurement(this.canvas.getContext("2d"))
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

/**
 * Node canvases measure CJK text with whatever fallback glyphs the machine
 * has (often not 1 em wide): report font-independent CJK widths instead,
 * so labels fit when a browser draws them with a real CJK font.
 */
function withCjkAwareMeasurement(context: Context2d): Context2d {
	const measure = context.measureText.bind(context);
	context.measureText = ((text: string) => {
		const metrics = measure(text);
		const fontSize = fontSizeOf(context.font);
		if (fontSize === undefined) return metrics;
		const width = cjkAwareWidth(
			text,
			fontSize,
			isCjkFontStack(context.font),
			(run) => measure(run).width,
		);
		return new Proxy(metrics, {
			get: (target, key) =>
				key === "width" ? width : Reflect.get(target, key, target),
		});
	}) as Context2d["measureText"];
	return context;
}
