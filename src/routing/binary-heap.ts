// ---------------------------------------------------------------------------
// Deterministic binary min-heap for A* search (Issue #60)
//
// The tie-breaking on insertion order guarantees deterministic output
// when multiple entries share the same priority — critical for auto-graph's
// deterministic contract (tested in determinism.test.ts).
// ---------------------------------------------------------------------------

interface HeapEntry<T> {
	readonly value: T;
	readonly priority: number;
	readonly order: number;
}

export class BinaryHeap<T> {
	private _data: HeapEntry<T>[] = [];
	private _nextOrder = 0;

	get size(): number {
		return this._data.length;
	}

	push(value: T, priority: number): void {
		const entry: HeapEntry<T> = { value, priority, order: this._nextOrder++ };
		this._data.push(entry);
		this._siftUp(this._data.length - 1);
	}

	pop(): T | undefined {
		if (this._data.length === 0) return undefined;
		const top = this._data[0] as HeapEntry<T>;
		const last = this._data.pop()!;
		if (this._data.length > 0) {
			this._data[0] = last;
			this._siftDown(0);
		}
		return top.value;
	}

	peek(): T | undefined {
		return this._data.length > 0 ? this._data[0]!.value : undefined;
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private _siftUp(idx: number): void {
		const entry = this._data[idx] as HeapEntry<T>;
		while (idx > 0) {
			const parentIdx = (idx - 1) >> 1;
			const parent = this._data[parentIdx] as HeapEntry<T>;
			if (this._less(entry, parent)) {
				this._data[idx] = parent;
				idx = parentIdx;
			} else {
				break;
			}
		}
		this._data[idx] = entry;
	}

	private _siftDown(idx: number): void {
		const entry = this._data[idx] as HeapEntry<T>;
		const size = this._data.length;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			let smallestIdx = idx;
			const leftIdx = (idx << 1) + 1;
			const rightIdx = leftIdx + 1;
			// Compare children against entry (the held element being
			// sifted down), not this._data[smallestIdx], because after
			// an earlier swap this._data[idx] holds a child that was
			// moved up, not entry.
			if (
				leftIdx < size &&
				this._less(this._data[leftIdx] as HeapEntry<T>, entry)
			) {
				smallestIdx = leftIdx;
			}
			if (
				rightIdx < size &&
				this._less(
					this._data[rightIdx] as HeapEntry<T>,
					smallestIdx === leftIdx
						? (this._data[leftIdx] as HeapEntry<T>)
						: entry,
				)
			) {
				smallestIdx = rightIdx;
			}
			if (smallestIdx !== idx) {
				this._data[idx] = this._data[smallestIdx] as HeapEntry<T>;
				idx = smallestIdx;
			} else {
				break;
			}
		}
		this._data[idx] = entry;
	}

	/**
	 * Two entries are compared first by priority, then by insertion order
	 * when priorities are equal.  The insertion-order tie-break makes the
	 * heap deterministic: for a given sequence of {value, priority} pushes,
	 * the extraction order is always the same.
	 */
	private _less(a: HeapEntry<T>, b: HeapEntry<T>): boolean {
		if (a.priority !== b.priority) return a.priority < b.priority;
		return a.order < b.order;
	}
}
