import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOLVER_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../src/solver",
);

const IMPORT_RE = /from\s+["'](\.[^"']+)["']/g;

/** Forbidden edges that would reintroduce #77 cycles. */
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
	["labels", "remediation"],
	["route-edges", "labels"],
	["route-edges", "remediation"],
	["ports", "labels"],
	["ports", "remediation"],
	["coordinate", "labels"],
	["coordinate", "remediation"],
	["helpers", "labels"],
	["helpers", "remediation"],
	["helpers", "ports"],
	["helpers", "route-edges"],
	["options", "labels"],
	["options", "remediation"],
	["options", "solve"],
	["page-policy", "labels"],
	["page-policy", "remediation"],
	["cjk-typography", "labels"],
	["cjk-typography", "remediation"],
];

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = statSync(path);
		if (st.isDirectory()) {
			out.push(...listTsFiles(path));
		} else if (name.endsWith(".ts")) {
			out.push(path);
		}
	}
	return out;
}

function moduleId(file: string): string {
	return relative(SOLVER_ROOT, file).replace(/\.ts$/, "").replace(/\\/g, "/");
}

function resolveSolverImport(
	fromFile: string,
	spec: string,
): string | undefined {
	const cleaned = spec.replace(/\.(js|ts|tsx)$/, "");
	const base = resolve(dirname(fromFile), cleaned);
	const candidates = [`${base}.ts`, join(base, "index.ts")];
	for (const candidate of candidates) {
		try {
			statSync(candidate);
			const rel = relative(SOLVER_ROOT, candidate);
			if (rel.startsWith("..")) {
				return undefined;
			}
			return moduleId(candidate);
		} catch {
			// try next
		}
	}
	return undefined;
}

function buildImportGraph(): Map<string, Set<string>> {
	const graph = new Map<string, Set<string>>();
	for (const file of listTsFiles(SOLVER_ROOT)) {
		const id = moduleId(file);
		const deps = graph.get(id) ?? new Set<string>();
		graph.set(id, deps);
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(IMPORT_RE)) {
			const spec = match[1];
			if (spec === undefined || !spec.startsWith(".")) {
				continue;
			}
			const dep = resolveSolverImport(file, spec);
			if (dep !== undefined) {
				deps.add(dep);
			}
		}
	}
	return graph;
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
	const color = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const cycles: string[][] = [];

	function dfs(node: string): void {
		color.set(node, 1);
		stack.push(node);
		for (const next of [...(graph.get(node) ?? [])].sort()) {
			const state = color.get(next) ?? 0;
			if (state === 1) {
				const start = stack.indexOf(next);
				cycles.push([...stack.slice(start), next]);
			} else if (state === 0) {
				dfs(next);
			}
		}
		stack.pop();
		color.set(node, 2);
	}

	for (const node of [...graph.keys()].sort()) {
		if ((color.get(node) ?? 0) === 0) {
			dfs(node);
		}
	}
	return cycles;
}

describe("solver architecture (#77)", () => {
	it("keeps src/solver import graph acyclic", () => {
		const graph = buildImportGraph();
		const cycles = findCycles(graph);
		expect(cycles).toEqual([]);
	});

	it("forbids edges that reintroduce labels/remediation cycles", () => {
		const graph = buildImportGraph();
		const violations: string[] = [];
		for (const [from, to] of FORBIDDEN) {
			if (graph.get(from)?.has(to)) {
				violations.push(`${from} -> ${to}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("keeps resolveRemediationPolicy in options (not remediation-owned)", () => {
		const options = readFileSync(join(SOLVER_ROOT, "options.ts"), "utf8");
		const labels = readFileSync(join(SOLVER_ROOT, "labels.ts"), "utf8");
		expect(options).toContain("export function resolveRemediationPolicy");
		expect(labels).toContain('from "./options.js"');
		expect(labels).not.toContain('from "./remediation.js"');
	});
});
