import type { CoordinatedNode } from "../ir/elements.js";

/**
 * Row indices a compartment separator is drawn above: the first property
 * row and the first constraint row, where a section starts. Rows are
 * stereotype (optional), name, properties, constraints, in that order.
 */
export function compartmentSeparatorRows(
	compartments: NonNullable<CoordinatedNode["compartments"]>,
): Set<number> {
	const properties = (compartments.properties ?? []).length;
	const constraints = (compartments.constraints ?? []).length;
	const firstProperty = compartments.stereotype === undefined ? 1 : 2;
	const rows = new Set<number>();
	if (properties > 0) rows.add(firstProperty);
	if (constraints > 0) rows.add(firstProperty + properties);
	return rows;
}
