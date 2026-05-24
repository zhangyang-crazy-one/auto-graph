## Local Shell Rule

@/home/zhangyangrui/.codex/RTK.md

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Diagram Geometry Engine**

Diagram Geometry Engine (DGE), code name "Pretext for Graphics", is a deterministic geometry computation engine that translates high-level diagram intent into precise numeric coordinates. It is for LLMs, coding agents, and developers who need to generate accurate architecture diagrams, flowcharts, and editable diagram files without hand-guessing x/y positions or relying on visual feedback.

DGE is not a renderer or a visual editor. It is the missing geometry solving layer between automatic graph layout engines and render/export formats such as SVG, Excalidraw JSON, draw.io XML, Mermaid, and ASCII.

**Core Value:** Given the same declarative diagram intent, DGE must produce deterministic, collision-aware, text-safe coordinates that downstream exporters can render or edit without manual coordinate repair.

### Constraints

- **Runtime**: TypeScript on Node.js first - Pretext and Dagre are native NPM dependencies and avoid Python subprocess complexity.
- **Architecture**: Prepare/solve/export separation - expensive measurement and validation happen before hot path geometry solving.
- **Determinism**: Same input must produce byte-stable or numerically stable output - required for tests and agent repeatability.
- **Measurement**: Text measurement must be abstracted behind an interface - Pretext is default, but exporters or runtimes may need alternate measurement backends.
- **Quality**: Golden tests must catch text overflow, connector misalignment, collisions, non-deterministic output, and malformed exports.
- **Scope**: v1 focuses on core library, CLI, SVG, Excalidraw, and enough layout/routing to support real architecture and flow diagrams.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommendation
## Runtime And Language
| Choice | Recommendation | Rationale | Confidence |
|--------|----------------|-----------|------------|
| Language | TypeScript | Native path to Pretext and Dagre, strong geometry IR typing, straightforward SVG/JSON/XML output | High |
| Runtime | Node.js 20+ | Modern baseline for CLI tools and package publishing; good ESM/CJS support | High |
| Package manager | npm or pnpm | Either is fine; avoid over-optimizing before package scaffold exists | Medium |
| Build | tsup or tsdown | Simple dual ESM/CJS output and CLI bundling | Medium |
| Tests | Vitest | Fast TS-native unit and snapshot testing | High |
| Lint/format | Biome or oxlint plus prettier-compatible formatting | Fast enough for a small TS library | Medium |
## Core Dependencies
| Dependency | Current Check | Use |
|------------|---------------|-----|
| `@chenglou/pretext` | `npm view` returned version `0.0.7` | Default text measurement backend |
| `@dagrejs/dagre` | `npm view` returned version `3.0.0` | Directed graph initial layout |
| YAML parser | To choose during implementation | CLI and DSL parser |
| JSON Schema validator | To choose during implementation | DSL validation and helpful error messages |
## Source Notes
- Pretext repository describes a pure JS/TS multiline text measurement and layout library, avoiding DOM measurement and exposing `prepare()` plus `layout()` APIs for one-time analysis and cheap hot-path layout: https://github.com/chenglou/pretext
- Dagre repository describes client-side directed graph layout for JavaScript, suitable as the initial automatic layout layer: https://github.com/dagrejs/dagre
- Excalidraw developer docs expose `updateScene(sceneData)` with `elements` and `appState`, confirming JSON scene export is a practical editable target: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api
- Mermaid flowchart docs define direction, nodes, edges, subgraphs, and many semantic shapes, confirming Mermaid should be treated as a text DSL export/import target rather than DGE's coordinate source of truth: https://mermaid.js.org/syntax/flowchart.html
- mxGraph is the legacy JavaScript diagramming library behind draw.io-style XML concepts, but the project notes it is stable and not advised for new direct dependency use, so DGE should implement draw.io export as an XML adapter: https://github.com/jgraph/mxgraph
## What Not To Use First
- Do not start with Graphviz subprocess integration. It complicates installation and produces a different layout model from the TS-native Dagre route.
- Do not use a browser-only measurement dependency in the core package. Text measurement must be callable from CLI tests.
- Do not build a React UI before the CLI and golden outputs exist. Visual preview is useful after deterministic output is proven.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
