# Phase 05: DSL Parser And CLI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-25T10:41:21+08:00
**Phase:** 05-dsl-parser-and-cli
**Areas discussed:** DSL Expression Shape, Constraints And Layout Syntax, Error Output And Diagnostics, CLI Command Behavior

---

## DSL Expression Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Agent-friendly shorthand | YAML/JSON both supported, examples primarily YAML, concise fields for LLM authoring | ✓ |
| IR-like strict | DSL closely mirrors existing TypeScript IR with explicit fields | |
| Dual mode | Default shorthand plus strict mode | |

**User's choice:** Agent-friendly shorthand.
**Notes:** User selected `1A`. DSL remains a parser layer over existing IR.

| Option | Description | Selected |
|--------|-------------|----------|
| Object map | Nodes keyed by stable id, for example `nodes.api` | ✓ |
| Array | Nodes as `[{ id, label }]`, closer to internal IR | |
| Support both | Accept both styles but document one primary style | |

**User's choice:** Object map.
**Notes:** User selected `2A`.

| Option | Description | Selected |
|--------|-------------|----------|
| Allow string shorthand | Edges may be written as `api -> db` or `web -> api: calls` | ✓ |
| Structured objects only | Edges require explicit source/target/label fields | |
| Support both | String shorthand expands to structured edge objects | |

**User's choice:** Allow string shorthand.
**Notes:** User selected `3A`.

| Option | Description | Selected |
|--------|-------------|----------|
| DSL optional plus CLI override | DSL may include output defaults, but CLI flags win | ✓ |
| CLI only | DSL only describes the diagram | |
| Must match | DSL and CLI output settings must agree | |

**User's choice:** DSL optional plus CLI override.
**Notes:** User selected `4A`.

---

## Constraints And Layout Syntax

| Option | Description | Selected |
|--------|-------------|----------|
| Inline node position | Fixed positions are written under nodes as `position` | ✓ |
| Only exact-position constraints | Fixed positions are expressed only as constraint objects | |
| Support both | Inline positions normalize to exact-position constraints | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Structured objects | Relative, align, and distribute constraints use explicit structured records | ✓ |
| String DSL | Constraints use compact expressions such as `api left-of db by 40` | |
| Support both with strings as sugar | Structured primary, string sugar optional | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Group definition first | Group membership is primary containment semantic source | ✓ |
| Constraint first | Containment is primarily expressed through constraints | |
| Group plus forced constraint | Group is semantic, constraint forces geometry | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Top-level defaults plus edge overrides | `layout`/`routing` defaults, with per-edge overrides where needed | ✓ |
| Top-level only | Edges cannot override routing/layout options | |
| Edge-level only | Every edge states routing options explicitly | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

---

## Error Output And Diagnostics

| Option | Description | Selected |
|--------|-------------|----------|
| Human-readable by default | Default stderr output includes summary, path, and repair hint | ✓ |
| Machine-readable by default | Default output is JSON errors | |
| Minimal message by default | Detailed context only with verbose flags | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Provide `--json` | Human default, structured JSON for agents and automation | ✓ |
| Human-readable only | No machine-readable error mode yet | |
| Always print both | Print human and JSON together | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Layered errors | Separate parse, validate, solve, and export failure layers | ✓ |
| Single diagnostics array | All failures appear in one diagnostics list | |
| Fatal/nonfatal only | Only severity split matters | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Output with warning | Warnings do not block output; errors block output | ✓ |
| Warnings block output | Any warning prevents output | |
| Strict mode only | Warnings block only under `--strict` | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

---

## CLI Command Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| `dge` | Short command name matching Phase 5 requirements | ✓ |
| `diagram-geometry-engine` | Long command name | |
| Both aliases | Provide short and long command names | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Unix-friendly stdin/stdout | No `--input` reads stdin; no `--output` writes stdout; diagnostics use stderr | ✓ |
| Require explicit input and output | Always require both flags | |
| Require `--stdin` | File input default, stdin only with explicit flag | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Overwrite by default | Output files are overwritten; implementation avoids partial writes on failure | ✓ |
| Do not overwrite by default | Existing output file is an error | |
| Require `--force` | Existing output file requires force flag | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

| Option | Description | Selected |
|--------|-------------|----------|
| Default `svg` | Neutral engineering SVG is default; CLI `--format` overrides DSL | ✓ |
| Require `--format` | Caller must choose every time | |
| Infer from extension | Output file extension controls format, fallback to SVG | |

**User's choice:** Recommended option.
**Notes:** User said `按照推荐`.

---

## the agent's Discretion

- Exact parser module boundaries and helper names.
- YAML dependency selection after research.
- Exact documented exit code numbers.
- Exact planning split for edge shorthand support.

## Deferred Ideas

- draw.io/mxGraph XML export.
- Mermaid and ASCII/Unicode exports.
- Browser preview and visual review UI.
- Rich style API or theme configuration.
