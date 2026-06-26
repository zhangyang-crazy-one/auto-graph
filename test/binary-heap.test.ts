import { describe, expect, it } from "vitest";
import { BinaryHeap } from "../src/routing/binary-heap.js";

describe("BinaryHeap", () => {
	it("pops items in ascending priority order", () => {
		const heap = new BinaryHeap<string>();
		heap.push("c", 30);
		heap.push("a", 10);
		heap.push("b", 20);

		expect(heap.size).toBe(3);
		expect(heap.pop()).toBe("a");
		expect(heap.pop()).toBe("b");
		expect(heap.pop()).toBe("c");
		expect(heap.size).toBe(0);
		expect(heap.pop()).toBeUndefined();
	});

	it("returns undefined when empty", () => {
		const heap = new BinaryHeap<number>();
		expect(heap.pop()).toBeUndefined();
		expect(heap.peek()).toBeUndefined();
		expect(heap.size).toBe(0);
	});

	it("peek returns min without removing", () => {
		const heap = new BinaryHeap<number>();
		heap.push(1, 50);
		heap.push(2, 10);

		expect(heap.peek()).toBe(2);
		expect(heap.size).toBe(2);
		expect(heap.peek()).toBe(2); // still there
	});

	it("is deterministic with tie-breaking on insertion order", () => {
		// Same priority → order of insertion determines extraction.
		const heap = new BinaryHeap<string>();
		heap.push("first", 10);
		heap.push("second", 10);
		heap.push("third", 10);

		expect(heap.pop()).toBe("first");
		expect(heap.pop()).toBe("second");
		expect(heap.pop()).toBe("third");
	});

	it("handles interleaved priorities correctly", () => {
		const heap = new BinaryHeap<number>();
		heap.push(1, 5);
		heap.push(2, 3);
		heap.push(3, 7);
		heap.push(4, 1);
		heap.push(5, 4);

		const result: number[] = [];
		while (heap.size > 0) {
			result.push(heap.pop()!);
		}
		expect(result).toEqual([4, 2, 5, 1, 3]);
	});

	it("handles large input efficiently", () => {
		const heap = new BinaryHeap<number>();
		const N = 1000;
		for (let i = 0; i < N; i++) {
			heap.push(i, Math.random());
		}
		expect(heap.size).toBe(N);

		const prev = -Infinity;
		while (heap.size > 0) {
			heap.pop();
		}
		expect(heap.size).toBe(0);
	});
});
