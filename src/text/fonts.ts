import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { clearCache } from "@chenglou/pretext";
import { installNodeCanvasRuntime, resetFontTrust } from "./node-canvas.js";

/** A font file to measure with, optionally under a given family name. */
export interface FontSource {
	path: string;
	/** Family name to register it as (default: the name in the file). */
	family?: string;
}

export interface RegisteredFont {
	path: string;
	/** Family names the file added. */
	families: string[];
	/** It draws CJK ideographs (exactly 1 em wide). */
	cjk: boolean;
}

interface NodeCanvasFonts {
	createCanvas(
		width: number,
		height: number,
	): {
		getContext(id: "2d"): {
			font: string;
			measureText(text: string): { width: number };
		};
	};
	GlobalFonts: {
		readonly families: { family: string }[];
		registerFromPath(path: string, nameAlias?: string): unknown;
	};
}

const require = createRequire(import.meta.url);

/**
 * Register font files with the Node canvas that Pretext measures on, so
 * labels are measured with exactly the fonts the diagram is drawn with
 * (no fallback estimates for CJK or Latin). Clears Pretext's measurement
 * cache. Throws when a file cannot be loaded.
 */
export function registerFonts(
	fonts: readonly (string | FontSource)[],
): RegisteredFont[] {
	if (fonts.length === 0) return [];
	const canvas = require("@napi-rs/canvas") as NodeCanvasFonts;
	installNodeCanvasRuntime();
	const context = canvas.createCanvas(1, 1).getContext("2d");
	const registered: RegisteredFont[] = [];
	for (const entry of fonts) {
		const source = typeof entry === "string" ? { path: entry } : entry;
		const before = new Set(
			canvas.GlobalFonts.families.map((item) => item.family),
		);
		const key = canvas.GlobalFonts.registerFromPath(source.path, source.family);
		if (key === null || key === undefined) {
			throw new Error(`Cannot load font file ${source.path}`);
		}
		const added = canvas.GlobalFonts.families
			.map((item) => item.family)
			.filter((family) => !before.has(family));
		// A family the machine already had is not "added": read the names
		// from the file itself.
		const families =
			source.family !== undefined
				? [source.family]
				: [...new Set([...added, ...fontFileFamilies(source.path)])];
		const cjk = families.some((family) => {
			context.font = `100px "${family}"`;
			return Math.abs(context.measureText("永").width - 100) <= 2;
		});
		registered.push({ path: source.path, families, cjk });
	}
	resetFontTrust();
	clearCache();
	return registered;
}

/**
 * Family names in an OpenType / TrueType file or collection (name table:
 * typographic family, else family; Windows English first). Empty for
 * formats it cannot read (e.g. compressed WOFF2).
 */
export function fontFileFamilies(path: string): string[] {
	let data: Buffer;
	try {
		data = readFileSync(path);
	} catch {
		return [];
	}
	const tag = data.toString("latin1", 0, 4);
	const offsets: number[] = [];
	if (tag === "ttcf") {
		const count = data.readUInt32BE(8);
		for (let index = 0; index < count; index += 1) {
			offsets.push(data.readUInt32BE(12 + index * 4));
		}
	} else if (
		tag === "OTTO" ||
		tag === "true" ||
		data.readUInt32BE(0) === 0x10000
	) {
		offsets.push(0);
	}
	const families = new Set<string>();
	for (const offset of offsets) {
		const name = sfntFamily(data, offset);
		if (name !== undefined) families.add(name);
	}
	return [...families];
}

function sfntFamily(data: Buffer, offset: number): string | undefined {
	const tables = data.readUInt16BE(offset + 4);
	let nameTable: number | undefined;
	for (let index = 0; index < tables; index += 1) {
		const record = offset + 12 + index * 16;
		if (data.toString("latin1", record, record + 4) === "name") {
			nameTable = data.readUInt32BE(record + 8);
			break;
		}
	}
	if (nameTable === undefined) return undefined;
	const count = data.readUInt16BE(nameTable + 2);
	const strings = nameTable + data.readUInt16BE(nameTable + 4);
	let best: { score: number; value: string } | undefined;
	for (let index = 0; index < count; index += 1) {
		const record = nameTable + 6 + index * 12;
		const platform = data.readUInt16BE(record);
		const language = data.readUInt16BE(record + 4);
		const nameId = data.readUInt16BE(record + 6);
		if (nameId !== 1 && nameId !== 16) continue;
		const length = data.readUInt16BE(record + 8);
		const start = strings + data.readUInt16BE(record + 10);
		let value: string;
		if (platform === 3 || platform === 0) {
			const bytes = Buffer.from(data.subarray(start, start + length));
			bytes.swap16();
			value = bytes.toString("utf16le");
		} else if (platform === 1) {
			value = data.toString("latin1", start, start + length);
		} else {
			continue;
		}
		const score =
			(nameId === 16 ? 4 : 0) +
			(platform === 3 ? 2 : 0) +
			(platform === 3 && language === 0x409 ? 1 : 0);
		if (best === undefined || score > best.score) best = { score, value };
	}
	return best?.value;
}
