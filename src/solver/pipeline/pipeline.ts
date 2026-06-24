import type { LayoutPhase, LayoutState } from "./types.js";

/**
 * Pluggable layout pipeline (Issue #54, 方案 D).
 *
 * Phases run sequentially, each mutating the shared LayoutState.
 * Custom pipelines are built with the fluent builder API:
 *
 *   new LayoutPipeline()
 *     .addPhase(myPhase)
 *     .addBefore("apply-constraints", prePhase)
 *     .run(diagram, options);
 */
export class LayoutPipeline {
	private phases: LayoutPhase[] = [];

	addPhase(phase: LayoutPhase): this {
		this.phases.push(phase);
		return this;
	}

	addBefore(refName: string, phase: LayoutPhase): this {
		const idx = this.phases.findIndex((p) => p.name === refName);
		if (idx === -1) throw new Error(`Phase "${refName}" not found`);
		this.phases.splice(idx, 0, phase);
		return this;
	}

	addAfter(refName: string, phase: LayoutPhase): this {
		const idx = this.phases.findIndex((p) => p.name === refName);
		if (idx === -1) throw new Error(`Phase "${refName}" not found`);
		this.phases.splice(idx + 1, 0, phase);
		return this;
	}

	replacePhase(name: string, phase: LayoutPhase): this {
		const idx = this.phases.findIndex((p) => p.name === name);
		if (idx === -1) throw new Error(`Phase "${name}" not found`);
		this.phases[idx] = phase;
		return this;
	}

	run(state: LayoutState): void {
		for (const phase of this.phases) {
			const before = state.diagnostics.length;
			const start = performance.now();
			phase.run(state);
			state.phaseTrace.push({
				phase: phase.name,
				durationMs: performance.now() - start,
				diagnosticsAdded: state.diagnostics.length - before,
			});
		}
	}
}
