import { createRequire } from "node:module";

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
				return contextId === "2d" ? this.canvas.getContext("2d") : null;
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
