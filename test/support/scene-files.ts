import { readFileSync } from "node:fs";

/** The README examples live in examples/scene; test-only scenes in test/fixtures/scene. */
const EXAMPLES = new Set([
	"study",
	"meeting",
	"showroom",
	"office",
	"storeroom",
	"park",
	"hillside",
]);

export function sceneSourceUrl(name: string): URL {
	return EXAMPLES.has(name)
		? new URL(`../../examples/scene/${name}.yaml`, import.meta.url)
		: new URL(`../fixtures/scene/${name}.yaml`, import.meta.url);
}

/** Golden top views: the README pictures for examples, fixtures otherwise. */
export function sceneTopViewUrl(name: string): URL {
	return EXAMPLES.has(name)
		? new URL(`../../docs/images/scene-${name}.top.svg`, import.meta.url)
		: new URL(`../fixtures/scene/${name}.top.svg`, import.meta.url);
}

export function sceneSource(name: string): string {
	return readFileSync(sceneSourceUrl(name), "utf8");
}
