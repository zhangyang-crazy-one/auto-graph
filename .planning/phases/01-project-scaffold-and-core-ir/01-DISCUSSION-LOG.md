# Phase 1: Project Scaffold And Core IR - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 1-Project Scaffold And Core IR
**Areas discussed:** Toolchain Baseline, Source Module Boundaries, Public IR Types, Deterministic Serialization

---

## Toolchain Baseline

| Option | Description | Selected |
|--------|-------------|----------|
| npm + tsup + tsc + Vitest | Small standard Node package baseline with bundled output and explicit typecheck | yes |
| pnpm + tsup + Vitest | Good workspace ergonomics but unnecessary before multiple packages exist | |
| plain tsc only | Lowest dependency count but weaker bundling story for CLI/package output | |

**User's choice:** Interactive selection UI was unavailable in Default mode; workflow fallback selected the recommended option.
**Notes:** The source docs recommend TypeScript and mention tsup/esbuild-style bundling. Phase 1 should not overbuild a monorepo.

---

## Source Module Boundaries

| Option | Description | Selected |
|--------|-------------|----------|
| Single package with clear module folders | Preserves future boundaries without workspace overhead | yes |
| Monorepo immediately | Too early; package boundaries are not proven | |
| Flat src directory | Fast initially but likely to blur IR, serialization, DSL, exporter, and CLI concerns | |

**User's choice:** Interactive selection UI was unavailable in Default mode; workflow fallback selected the recommended option.
**Notes:** Boundaries should reflect prepare/solve/export architecture without implementing later phases prematurely.

---

## Public IR Types

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal extensible core IR | Enough for downstream phases while avoiding premature full DSL/exporter types | yes |
| Full DSL schema types now | Belongs mostly to DSL phase | |
| Exporter-specific types now | Belongs to exporter phase and risks renderer creep | |

**User's choice:** Interactive selection UI was unavailable in Default mode; workflow fallback selected the recommended option.
**Notes:** Core IR must remain renderer-neutral.

---

## Deterministic Serialization

| Option | Description | Selected |
|--------|-------------|----------|
| Canonical JSON serializer with 3-decimal numeric rounding | Gives byte-stable snapshots and readable geometry fixtures | yes |
| Raw JSON.stringify | Too sensitive to object construction order and undefined values | |
| Lossless high precision everywhere | More noise in snapshots; not necessary for Phase 1 contract | |

**User's choice:** Interactive selection UI was unavailable in Default mode; workflow fallback selected the recommended option.
**Notes:** Phase 1 must include a repeated-run determinism test.

---

## the agent's Discretion

- Exact directory names may vary if module boundaries stay clear.
- Biome or oxlint may be selected by the planner based on install friction.
- Package metadata details are flexible.

## Deferred Ideas

None.
