export const DEFAULT_CANONICAL_PRECISION = 3;

export interface CanonicalizeOptions {
	precision?: number;
}

export type CanonicalJson =
	| null
	| boolean
	| number
	| string
	| CanonicalJson[]
	| { [key: string]: CanonicalJson };

const UNORDERED_COLLECTION_KEYS = new Set([
	"nodes",
	"edges",
	"groups",
	"constraints",
	"diagnostics",
	"anchors",
]);

const IDENTITY_KEYS = [
	"id",
	"name",
	"sourceId",
	"targetId",
	"nodeId",
	"groupId",
	"kind",
] as const;

type IdentityKey = (typeof IDENTITY_KEYS)[number];

export function canonicalize(
	value: unknown,
	options: CanonicalizeOptions = {},
): CanonicalJson {
	const precision = resolvePrecision(
		options.precision ?? DEFAULT_CANONICAL_PRECISION,
	);

	return canonicalizeValue(value, precision);
}

export function stringifyCanonical(
	value: unknown,
	precision = DEFAULT_CANONICAL_PRECISION,
): string {
	return `${JSON.stringify(
		canonicalize(value, { precision: resolvePrecision(precision) }),
		null,
		2,
	)}\n`;
}

function resolvePrecision(precision: number): number {
	if (!Number.isInteger(precision) || precision < 0) {
		throw new TypeError("Canonical precision must be a non-negative integer");
	}

	return precision;
}

function canonicalizeValue(
	value: unknown,
	precision: number,
	parentKey?: string,
): CanonicalJson {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return value;
	}

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("Non-finite number cannot be canonicalized");
		}

		if (Object.is(value, -0)) {
			return 0;
		}

		const factor = 10 ** precision;
		const rounded = Math.round(value * factor) / factor;

		return Object.is(rounded, -0) ? 0 : rounded;
	}

	if (Array.isArray(value)) {
		return canonicalizeArray(value, precision, parentKey);
	}

	if (typeof value === "object") {
		return canonicalizeObject(value, precision);
	}

	throw new TypeError("Unsupported value cannot be canonicalized");
}

function canonicalizeArray(
	value: unknown[],
	precision: number,
	parentKey?: string,
): CanonicalJson[] {
	const canonicalItems = value.map((item) =>
		canonicalizeValue(item, precision, parentKey),
	);

	if (!shouldSortArray(value, parentKey)) {
		return canonicalItems;
	}

	return [...canonicalItems].sort(compareCanonicalItems);
}

function canonicalizeObject(
	value: object,
	precision: number,
): { [key: string]: CanonicalJson } {
	const result: { [key: string]: CanonicalJson } = {};

	for (const key of Object.keys(value).sort()) {
		const rawValue = (value as Record<string, unknown>)[key];

		if (rawValue === undefined) {
			continue;
		}

		result[key] = canonicalizeValue(rawValue, precision, key);
	}

	return result;
}

function shouldSortArray(value: unknown[], parentKey?: string): boolean {
	if (parentKey === "points" || value.every(isPointLikeRecord)) {
		return false;
	}

	if (parentKey !== undefined && UNORDERED_COLLECTION_KEYS.has(parentKey)) {
		return value.every(isPlainObject);
	}

	return (
		value.length > 0 &&
		value.every((item) => isPlainObject(item) && hasIdentityKey(item))
	);
}

function compareCanonicalItems(a: CanonicalJson, b: CanonicalJson): number {
	const aKey = itemSortKey(a);
	const bKey = itemSortKey(b);

	return aKey.localeCompare(bKey);
}

function itemSortKey(value: CanonicalJson): string {
	if (!isCanonicalObject(value)) {
		return "";
	}

	return IDENTITY_KEYS.map((key) => identityPart(key, value)).join("\u0000");
}

function identityPart(
	key: IdentityKey,
	value: { [key: string]: CanonicalJson },
): string {
	const part = value[key];

	if (typeof part === "string" || typeof part === "number") {
		return String(part);
	}

	return "";
}

function hasIdentityKey(value: object): boolean {
	return IDENTITY_KEYS.some((key) => key in value);
}

function isPlainObject(value: unknown): value is object {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
}

function isCanonicalObject(
	value: CanonicalJson,
): value is { [key: string]: CanonicalJson } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPointLikeRecord(value: unknown): boolean {
	return (
		isPlainObject(value) &&
		typeof (value as Record<string, unknown>).x === "number" &&
		typeof (value as Record<string, unknown>).y === "number"
	);
}
