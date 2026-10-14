import { mulberry32 } from "./synthetic.js";

/** A random scene document; see test/property/scene-layout.test.ts. */
const WALLS = ["north", "south", "east", "west"] as const;
const SIDES = ["in-front-of", "behind", "left-of", "right-of"] as const;

export function randomScene(seed: number, conflicts = false) {
	const random = mulberry32(seed);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)] as T;
	const between = (low: number, high: number) =>
		Math.round((low + random() * (high - low)) * 20) / 20;

	const count = 3 + Math.floor(random() * 10);
	const sizes = Array.from({ length: count }, () => [
		between(0.3, 1.6),
		between(0.3, 1.2),
		between(0.4, 1.5),
	]);
	const area = sizes.reduce((sum, [w = 0, d = 0]) => sum + w * d, 0);
	let width = between(4, 10);
	let depth = between(4, 10);
	const grow = Math.sqrt(Math.max(1, area / (0.15 * width * depth)));
	width = Math.ceil(width * grow * 10) / 10;
	depth = Math.ceil(depth * grow * 10) / 10;

	const objects: Record<string, { size: number[] }> = {};
	const relations: string[] = [];
	const taken = { north: 0, south: 0, east: 0, west: 0 };
	const onWall: string[] = [];
	const inFront = new Set<string>();
	sizes.forEach((size, k) => {
		const id = `o${k + 1}`;
		objects[id] = { size };
		const roll = random();
		if (roll < 0.35) return;
		if (roll < 0.75) {
			const wall = pick(WALLS);
			const along = wall === "north" || wall === "south" ? width : depth;
			// Against a wall the object's width runs along it.
			if (taken[wall] + (size[0] ?? 0) <= 0.4 * along) {
				taken[wall] += size[0] ?? 0;
				relations.push(`${id} against wall ${wall}`);
				onWall.push(id);
			}
			return;
		}
		const free = onWall.filter((wallId) => !inFront.has(wallId));
		if (free.length > 0) {
			const reference = pick(free);
			inFront.add(reference);
			relations.push(
				`${id} in-front-of ${reference}, gap ${between(0, 0.4)}, facing ${reference}`,
			);
		}
	});
	if (conflicts) {
		const ids = Object.keys(objects);
		for (let k = 0; k < 3; k += 1) {
			const a = pick(ids);
			const b = pick(ids);
			if (a === b) continue;
			relations.push(
				pick([
					`${a} ${pick(SIDES)} ${b}, gap ${between(0, 1)}`,
					`${a} center-of room`,
					`${a} corner ${pick(["ne", "nw", "se", "sw"])}`,
					`keep clear ${between(0.5, 3)} between ${a} and ${b}`,
				]),
			);
		}
	}
	return {
		scene: `random-${seed}`,
		bounds: { width, depth, height: 3 },
		minGap: 0.05,
		objects,
		relations,
	};
}
