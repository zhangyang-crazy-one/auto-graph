/**
 * Variable Placement with Separation Constraints (Dwyer, Marriott & Stuckey,
 * "Fast Node Overlap Removal", 2005), plus a scaled gradient-projection
 * solver for separable-constraint quadratic programs built on top of it
 * (Dwyer, Koren & Marriott, IPSep-CoLa, 2006).
 *
 * `solveVpsc` finds positions x minimising Σ wᵢ (xᵢ − dᵢ)² subject to
 * constraints `x[left] + gap ≤ x[right]` (or `=` for equality constraints).
 * Variables are merged into blocks along active constraints; blocks are
 * split again wherever a Lagrange multiplier turns negative, until no
 * constraint is violated and every active multiplier is non-negative, which
 * are the KKT conditions of this convex problem.
 *
 * `solveSeparationQp` minimises a general convex quadratic made of pairwise
 * `w (x_a − x_b)²` terms and anchor `w (x_v − t)²` terms under the same
 * constraints: it takes diagonally scaled gradient steps and projects each
 * step back onto the feasible set with `solveVpsc`.
 *
 * Everything iterates in index order, so results are deterministic.
 */
export interface VpscVariable {
	desired: number;
	/** Positive weight (default 1). */
	weight?: number;
}

export interface VpscConstraint {
	left: number;
	right: number;
	/** Minimum (or, for equality, exact) distance x[right] − x[left]. */
	gap: number;
	equality?: boolean;
}

export interface VpscResult {
	positions: number[];
	/** Indices of constraints that could not be satisfied (cycles). */
	unsatisfiable: number[];
}

const ZERO_UPPERBOUND = -1e-10;
const LAGRANGIAN_TOLERANCE = -1e-4;

class Variable {
	offset = 0;
	block!: Block;
	readonly cIn: Constraint[] = [];
	readonly cOut: Constraint[] = [];
	constructor(
		public desired: number,
		public readonly weight: number,
	) {}

	position(): number {
		return this.block.posn + this.offset;
	}

	dfdv(): number {
		return 2 * this.weight * (this.position() - this.desired);
	}

	visitNeighbours(
		prev: Variable | null,
		visit: (constraint: Constraint, next: Variable) => void,
	): void {
		for (const constraint of this.cOut) {
			if (constraint.active && constraint.right !== prev) {
				visit(constraint, constraint.right);
			}
		}
		for (const constraint of this.cIn) {
			if (constraint.active && constraint.left !== prev) {
				visit(constraint, constraint.left);
			}
		}
	}
}

class Constraint {
	lm = 0;
	active = false;
	unsatisfiable = false;
	constructor(
		readonly index: number,
		readonly left: Variable,
		readonly right: Variable,
		readonly gap: number,
		readonly equality: boolean,
	) {
		left.cOut.push(this);
		right.cIn.push(this);
	}

	slack(): number {
		return this.unsatisfiable
			? Number.MAX_VALUE
			: this.right.position() - this.gap - this.left.position();
	}
}

class Block {
	readonly vars: Variable[] = [];
	posn = 0;
	private ad = 0;
	private ab = 0;
	private a2 = 0;
	blockIndex = -1;

	constructor(v: Variable) {
		v.offset = 0;
		this.addVariable(v);
	}

	addVariable(v: Variable): void {
		v.block = this;
		this.vars.push(v);
		this.ab += v.weight * v.offset;
		this.ad += v.weight * v.desired;
		this.a2 += v.weight;
		this.posn = (this.ad - this.ab) / this.a2;
	}

	updateWeightedPosition(): void {
		this.ab = 0;
		this.ad = 0;
		this.a2 = 0;
		for (const v of this.vars) {
			this.ab += v.weight * v.offset;
			this.ad += v.weight * v.desired;
			this.a2 += v.weight;
		}
		this.posn = (this.ad - this.ab) / this.a2;
	}

	private computeLm(
		v: Variable,
		prev: Variable | null,
		post: (constraint: Constraint) => void,
	): number {
		let dfdv = v.dfdv();
		v.visitNeighbours(prev, (constraint, next) => {
			const nextDfdv = this.computeLm(next, v, post);
			dfdv += nextDfdv;
			constraint.lm = next === constraint.right ? nextDfdv : -nextDfdv;
			post(constraint);
		});
		return dfdv;
	}

	private populateSplitBlock(v: Variable, prev: Variable | null): void {
		for (const constraint of v.cOut) {
			if (constraint.active && constraint.right !== prev) {
				constraint.right.offset = v.offset + constraint.gap;
				this.addVariable(constraint.right);
				this.populateSplitBlock(constraint.right, v);
			}
		}
		for (const constraint of v.cIn) {
			if (constraint.active && constraint.left !== prev) {
				constraint.left.offset = v.offset - constraint.gap;
				this.addVariable(constraint.left);
				this.populateSplitBlock(constraint.left, v);
			}
		}
	}

	private findPath(
		v: Variable,
		prev: Variable | null,
		to: Variable,
		visit: (constraint: Constraint, next: Variable) => void,
	): boolean {
		let found = false;
		v.visitNeighbours(prev, (constraint, next) => {
			if (!found && (next === to || this.findPath(next, v, to, visit))) {
				found = true;
				visit(constraint, next);
			}
		});
		return found;
	}

	isActiveDirectedPathBetween(u: Variable, v: Variable): boolean {
		if (u === v) return true;
		for (const constraint of u.cOut) {
			if (
				constraint.active &&
				this.isActiveDirectedPathBetween(constraint.right, v)
			) {
				return true;
			}
		}
		return false;
	}

	static split(constraint: Constraint): [Block, Block] {
		constraint.active = false;
		return [
			Block.createSplitBlock(constraint.left),
			Block.createSplitBlock(constraint.right),
		];
	}

	private static createSplitBlock(start: Variable): Block {
		const block = new Block(start);
		block.populateSplitBlock(start, null);
		return block;
	}

	splitBetween(
		vl: Variable,
		vr: Variable,
	): { constraint: Constraint; lb: Block; rb: Block } | undefined {
		const constraint = this.findMinLmBetween(vl, vr);
		if (constraint === undefined) return undefined;
		const [lb, rb] = Block.split(constraint);
		return { constraint, lb, rb };
	}

	mergeAcross(other: Block, constraint: Constraint, distance: number): void {
		constraint.active = true;
		for (const v of other.vars) {
			v.offset += distance;
			this.addVariable(v);
		}
		this.posn = (this.ad - this.ab) / this.a2;
	}

	findMinLm(): Constraint | undefined {
		let min: Constraint | undefined;
		const first = this.vars[0];
		if (first === undefined) return undefined;
		this.computeLm(first, null, (constraint) => {
			if (
				!constraint.equality &&
				(min === undefined || constraint.lm < min.lm)
			) {
				min = constraint;
			}
		});
		return min;
	}

	private findMinLmBetween(lv: Variable, rv: Variable): Constraint | undefined {
		this.computeLm(lv, null, () => {});
		let min: Constraint | undefined;
		this.findPath(lv, null, rv, (constraint, next) => {
			if (
				!constraint.equality &&
				constraint.right === next &&
				(min === undefined || constraint.lm < min.lm)
			) {
				min = constraint;
			}
		});
		return min;
	}

	cost(): number {
		let sum = 0;
		for (const v of this.vars) {
			const d = v.position() - v.desired;
			sum += d * d * v.weight;
		}
		return sum;
	}
}

class Blocks {
	private list: Block[] = [];

	constructor(vars: readonly Variable[]) {
		for (const v of vars) this.insert(new Block(v));
	}

	insert(block: Block): void {
		block.blockIndex = this.list.length;
		this.list.push(block);
	}

	remove(block: Block): void {
		const last = this.list.length - 1;
		const swap = this.list[last];
		if (swap === undefined) return;
		this.list.length = last;
		if (block !== swap) {
			this.list[block.blockIndex] = swap;
			swap.blockIndex = block.blockIndex;
		}
	}

	merge(constraint: Constraint): void {
		const l = constraint.left.block;
		const r = constraint.right.block;
		const distance =
			constraint.right.offset - constraint.left.offset - constraint.gap;
		if (l.vars.length < r.vars.length) {
			r.mergeAcross(l, constraint, distance);
			this.remove(l);
		} else {
			l.mergeAcross(r, constraint, -distance);
			this.remove(r);
		}
	}

	updateBlockPositions(): void {
		for (const block of this.list) block.updateWeightedPosition();
	}

	split(inactive: Constraint[]): void {
		this.updateBlockPositions();
		for (const block of [...this.list]) {
			const constraint = block.findMinLm();
			if (constraint !== undefined && constraint.lm < LAGRANGIAN_TOLERANCE) {
				const owner = constraint.left.block;
				for (const part of Block.split(constraint)) this.insert(part);
				this.remove(owner);
				inactive.push(constraint);
			}
		}
	}

	cost(): number {
		let sum = 0;
		for (const block of this.list) sum += block.cost();
		return sum;
	}
}

class Solver {
	private readonly blocks: Blocks;
	private readonly inactive: Constraint[];

	constructor(
		readonly vars: Variable[],
		readonly constraints: Constraint[],
	) {
		this.blocks = new Blocks(vars);
		this.inactive = [...constraints];
	}

	private mostViolated(): Constraint | undefined {
		let minSlack = Number.MAX_VALUE;
		let found: Constraint | undefined;
		const list = this.inactive;
		const n = list.length;
		let deletePoint = n;
		for (let index = 0; index < n; index += 1) {
			const constraint = list[index] as Constraint;
			if (constraint.unsatisfiable) continue;
			const slack = constraint.slack();
			if (constraint.equality || slack < minSlack) {
				minSlack = slack;
				found = constraint;
				deletePoint = index;
				if (constraint.equality) break;
			}
		}
		if (
			found !== undefined &&
			deletePoint !== n &&
			((minSlack < ZERO_UPPERBOUND && !found.active) || found.equality)
		) {
			list[deletePoint] = list[n - 1] as Constraint;
			list.length = n - 1;
		}
		return found;
	}

	private satisfy(): void {
		this.blocks.split(this.inactive);
		for (;;) {
			const constraint = this.mostViolated();
			if (
				constraint === undefined ||
				!(
					constraint.equality ||
					(constraint.slack() < ZERO_UPPERBOUND && !constraint.active)
				)
			) {
				break;
			}
			const lb = constraint.left.block;
			const rb = constraint.right.block;
			if (lb !== rb) {
				this.blocks.merge(constraint);
				continue;
			}
			if (lb.isActiveDirectedPathBetween(constraint.right, constraint.left)) {
				constraint.unsatisfiable = true;
				continue;
			}
			const split = lb.splitBetween(constraint.left, constraint.right);
			if (split === undefined) {
				constraint.unsatisfiable = true;
				continue;
			}
			this.blocks.insert(split.lb);
			this.blocks.insert(split.rb);
			this.blocks.remove(lb);
			this.inactive.push(split.constraint);
			if (constraint.slack() >= 0) {
				this.inactive.push(constraint);
			} else {
				this.blocks.merge(constraint);
			}
		}
	}

	solve(): void {
		this.satisfy();
		let last = Number.MAX_VALUE;
		let cost = this.blocks.cost();
		let guard = 0;
		while (Math.abs(last - cost) > 1e-4 && guard < 100) {
			this.satisfy();
			last = cost;
			cost = this.blocks.cost();
			guard += 1;
		}
	}
}

export function solveVpsc(
	variables: readonly VpscVariable[],
	constraints: readonly VpscConstraint[],
): VpscResult {
	const vars = variables.map(
		(variable) =>
			new Variable(variable.desired, Math.max(variable.weight ?? 1, 1e-9)),
	);
	const cs: Constraint[] = [];
	constraints.forEach((constraint, index) => {
		const left = vars[constraint.left];
		const right = vars[constraint.right];
		if (left === undefined || right === undefined || left === right) return;
		cs.push(
			new Constraint(
				index,
				left,
				right,
				constraint.gap,
				constraint.equality === true,
			),
		);
	});
	const solver = new Solver(vars, cs);
	solver.solve();
	return {
		positions: vars.map((variable) => variable.position()),
		unsatisfiable: cs
			.filter((constraint) => constraint.unsatisfiable)
			.map((constraint) => constraint.index),
	};
}

export interface SeparationQp {
	/** Number of variables. */
	size: number;
	/** Terms w · (x[a] − x[b])². */
	pairs: readonly { a: number; b: number; weight: number }[];
	/** Terms w · (x[v] − target)². */
	anchors: readonly { v: number; target: number; weight: number }[];
	constraints: readonly VpscConstraint[];
	/** Starting positions (projected onto the constraints first). */
	initial: readonly number[];
}

export interface SeparationQpOptions {
	maxIterations?: number;
	/** Stop when no variable moves more than this (default 1e-3). */
	tolerance?: number;
}

export interface SeparationQpResult {
	positions: number[];
	iterations: number;
	cost: number;
	unsatisfiable: number[];
}

/**
 * Minimise Σ w (x_a − x_b)² + Σ w (x_v − t)² subject to separation
 * constraints, by scaled gradient projection. Every variable must carry at
 * least one term with positive weight (an anchor is enough).
 */
const RELATIVE_COST_TOLERANCE = 1e-6;

export function solveSeparationQp(
	qp: SeparationQp,
	options: SeparationQpOptions = {},
): SeparationQpResult {
	const maxIterations = options.maxIterations ?? 400;
	const tolerance = options.tolerance ?? 1e-3;
	const n = qp.size;
	const diagonal = new Float64Array(n);
	for (const { a, b, weight } of qp.pairs) {
		diagonal[a] = (diagonal[a] ?? 0) + 2 * weight;
		diagonal[b] = (diagonal[b] ?? 0) + 2 * weight;
	}
	for (const { v, weight } of qp.anchors) {
		diagonal[v] = (diagonal[v] ?? 0) + 2 * weight;
	}
	for (let i = 0; i < n; i += 1) {
		if (!((diagonal[i] ?? 0) > 0)) diagonal[i] = 1e-6;
	}

	const gradient = (x: readonly number[]): Float64Array => {
		const g = new Float64Array(n);
		for (const { a, b, weight } of qp.pairs) {
			const d = 2 * weight * ((x[a] ?? 0) - (x[b] ?? 0));
			g[a] = (g[a] ?? 0) + d;
			g[b] = (g[b] ?? 0) - d;
		}
		for (const { v, target, weight } of qp.anchors) {
			g[v] = (g[v] ?? 0) + 2 * weight * ((x[v] ?? 0) - target);
		}
		return g;
	};
	// dᵀ Q d for the Hessian Q of the objective.
	const curvature = (d: ArrayLike<number>): number => {
		let sum = 0;
		for (const { a, b, weight } of qp.pairs) {
			const diff = (d[a] ?? 0) - (d[b] ?? 0);
			sum += 2 * weight * diff * diff;
		}
		for (const { v, weight } of qp.anchors) {
			const value = d[v] ?? 0;
			sum += 2 * weight * value * value;
		}
		return sum;
	};
	const cost = (x: readonly number[]): number => {
		let sum = 0;
		for (const { a, b, weight } of qp.pairs) {
			const diff = (x[a] ?? 0) - (x[b] ?? 0);
			sum += weight * diff * diff;
		}
		for (const { v, target, weight } of qp.anchors) {
			const diff = (x[v] ?? 0) - target;
			sum += weight * diff * diff;
		}
		return sum;
	};
	const project = (desired: ArrayLike<number>) =>
		solveVpsc(
			Array.from({ length: n }, (_, i) => ({
				desired: desired[i] ?? 0,
				weight: diagonal[i] ?? 1,
			})),
			qp.constraints,
		);

	// FISTA (Beck & Teboulle) with adaptive restart (O'Donoghue & Candès),
	// in the metric scaled by D = diag(Q). Q is diagonally dominant (every
	// off-diagonal entry −2w is matched by +2w on both diagonals), so the
	// eigenvalues of D⁻¹Q lie in (0, 2] and the fixed step 1/2 is safe.
	// Same cost per iteration as plain gradient projection, O(1/k²) instead
	// of O(1/k) convergence.
	let projected = project(qp.initial as number[]);
	let x = projected.positions;
	let y = x;
	let momentum = 1;
	let iterations = 0;
	const history: number[] = [];
	for (; iterations < maxIterations; iterations += 1) {
		const g = gradient(y);
		const target = new Float64Array(n);
		for (let i = 0; i < n; i += 1) {
			target[i] = (y[i] ?? 0) - (0.5 * (g[i] ?? 0)) / (diagonal[i] ?? 1);
		}
		projected = project(target);
		const next = projected.positions;
		let moved = 0;
		let restart = 0;
		for (let i = 0; i < n; i += 1) {
			const step = (next[i] ?? 0) - (x[i] ?? 0);
			moved = Math.max(moved, Math.abs(step));
			restart += ((y[i] ?? 0) - (next[i] ?? 0)) * step;
		}
		if (restart > 0) {
			// Momentum points uphill: drop it and continue from `next`.
			momentum = 1;
			y = next;
		} else {
			const following = (1 + Math.sqrt(1 + 4 * momentum * momentum)) / 2;
			const factor = (momentum - 1) / following;
			y = next.map((value, i) => value + factor * (value - (x[i] ?? 0)));
			momentum = following;
		}
		x = next;
		if (moved < tolerance) {
			iterations += 1;
			break;
		}
		// Weakly anchored components keep drifting by tiny amounts long after
		// the objective has settled; stop once ten iterations improved the
		// cost by less than a millionth.
		const current = cost(x);
		history.push(current);
		const earlier = history[history.length - 11];
		if (
			earlier !== undefined &&
			earlier - current <= RELATIVE_COST_TOLERANCE * Math.max(1, earlier)
		) {
			iterations += 1;
			break;
		}
	}
	return {
		positions: x,
		iterations,
		cost: cost(x),
		unsatisfiable: projected.unsatisfiable,
	};
}
