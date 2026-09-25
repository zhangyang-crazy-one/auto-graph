import type { z } from "zod";
import type { DslDiagnostic } from "../dsl/types.js";

/**
 * A view: a kind of diagram (flowchart, swimlane process, layered
 * architecture, …) with its own compact, semantic input. The author — often
 * a language model — picks a view and fills in content; the view expands it
 * into the full diagram DSL with the shapes, containers, direction and
 * layout settings that kind of diagram needs, and checks the rules of that
 * kind (a decision needs branches, a lane needs steps, …).
 */
export interface ViewDefinition<Input = unknown> {
	/** Value of the `view` key, e.g. `flowchart`. */
	id: string;
	/** Human-readable name. */
	title: string;
	/** One sentence: what the view is for, so an agent can pick one. */
	summary: string;
	/** Validates the view input (everything but the `view` key). */
	schema: z.ZodType<Input>;
	/** A complete, valid YAML document using the view. */
	example: string;
	/**
	 * Expand valid input into a diagram DSL document (plain data, validated
	 * afterwards like any hand-written DSL). Report problems through
	 * `context`; paths are relative to the view document.
	 */
	expand(input: Input, context: ViewContext): Record<string, unknown>;
}

export interface ViewContext {
	readonly viewId: string;
	warn(
		path: readonly (string | number)[],
		code: string,
		message: string,
		hint?: string,
	): void;
	error(
		path: readonly (string | number)[],
		code: string,
		message: string,
		hint?: string,
	): void;
	info(
		path: readonly (string | number)[],
		code: string,
		message: string,
		hint?: string,
	): void;
	readonly diagnostics: DslDiagnostic[];
}

export interface ViewSummary {
	id: string;
	title: string;
	summary: string;
}
