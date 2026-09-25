import { z } from "zod";
import type { DslDiagnostic } from "../dsl/types.js";
import { closest } from "./common.js";
import type { ViewContext, ViewDefinition, ViewSummary } from "./types.js";

const registry = new Map<string, ViewDefinition>();

/**
 * Keys a view document may carry besides its own input: they pass through
 * into the expanded DSL (layout and routing settings merged over the
 * view's defaults).
 */
const PASS_THROUGH = ["id", "title", "output", "layout", "routing"] as const;

/** Add a view. Re-registering an id throws unless `replace` is set. */
export function registerView<Input>(
	definition: ViewDefinition<Input>,
	options: { replace?: boolean } = {},
): void {
	if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) {
		throw new Error(
			`View id "${definition.id}" must be lowercase letters, digits and dashes.`,
		);
	}
	if (registry.has(definition.id) && options.replace !== true) {
		throw new Error(`View "${definition.id}" is already registered.`);
	}
	registry.set(definition.id, definition as ViewDefinition);
}

export function getView(id: string): ViewDefinition | undefined {
	return registry.get(id);
}

/** Registered views, by id. */
export function listViews(): ViewSummary[] {
	return [...registry.values()]
		.map(({ id, title, summary }) => ({ id, title, summary }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** JSON Schema of a view's input (the `view` key included). */
export function viewJsonSchema(
	id: string,
): Record<string, unknown> | undefined {
	const view = registry.get(id);
	if (view === undefined) return undefined;
	const schema = z.toJSONSchema(view.schema, {
		unrepresentable: "any",
	}) as Record<string, unknown>;
	const properties = (schema.properties ?? {}) as Record<string, unknown>;
	return {
		...schema,
		properties: {
			view: { const: id, description: view.summary },
			...properties,
		},
		required: ["view", ...((schema.required as string[] | undefined) ?? [])],
	};
}

/** True for a parsed document that names a view. */
export function isViewDocument(
	value: unknown,
): value is Record<string, unknown> & { view: unknown } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"view" in value
	);
}

/**
 * Expand a view document into a diagram DSL document. Returns `value`
 * only when there is no error; diagnostics use the `view` layer and paths
 * into the view document.
 */
export function expandView(document: Record<string, unknown>): {
	value?: Record<string, unknown>;
	diagnostics: DslDiagnostic[];
} {
	const diagnostics: DslDiagnostic[] = [];
	const id = document.view;
	const view = typeof id === "string" ? registry.get(id) : undefined;
	if (view === undefined) {
		const known = listViews().map((summary) => summary.id);
		const near = typeof id === "string" ? closest(id, known) : [];
		diagnostics.push({
			severity: "error",
			layer: "view",
			code: "view.unknown",
			message: `Unknown view ${JSON.stringify(id)}.`,
			path: ["view"],
			hint:
				near.length > 0
					? `Did you mean "${near[0]}"? Views: ${known.join(", ")}.`
					: `Views: ${known.join(", ")}.`,
		});
		return { diagnostics };
	}

	const { view: _view, ...rest } = document;
	const input: Record<string, unknown> = {};
	const passed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rest)) {
		if ((PASS_THROUGH as readonly string[]).includes(key) && key !== "title") {
			passed[key] = value;
		} else {
			input[key] = value;
		}
	}
	const parsed = view.schema.safeParse(input);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			diagnostics.push({
				severity: "error",
				layer: "view",
				code: `view.${view.id}.invalid`,
				message: issue.message,
				path: issue.path.filter(
					(segment): segment is string | number =>
						typeof segment === "string" || typeof segment === "number",
				),
				hint: `See the "${view.id}" example: agh --view-example ${view.id}.`,
			});
		}
		return { diagnostics };
	}

	const context = createContext(view.id, diagnostics);
	const expanded = view.expand(parsed.data, context);
	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { diagnostics };
	}
	const value: Record<string, unknown> = { ...expanded };
	for (const [key, passedValue] of Object.entries(passed)) {
		const base = value[key];
		value[key] =
			isPlainObject(base) && isPlainObject(passedValue)
				? { ...base, ...passedValue }
				: passedValue;
	}
	return { value, diagnostics };
}

function createContext(
	viewId: string,
	diagnostics: DslDiagnostic[],
): ViewContext {
	const push =
		(severity: DslDiagnostic["severity"]) =>
		(
			path: readonly (string | number)[],
			code: string,
			message: string,
			hint?: string,
		) => {
			diagnostics.push({
				severity,
				layer: "view",
				code,
				message,
				path: [...path],
				...(hint === undefined ? {} : { hint }),
			});
		};
	return {
		viewId,
		diagnostics,
		error: push("error"),
		warn: push("warning"),
		info: push("info"),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
