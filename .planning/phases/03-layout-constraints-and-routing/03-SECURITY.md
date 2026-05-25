---
phase: 03
slug: layout-constraints-and-routing
status: verified
threats_open: 0
asvs_level: 1
created: 2026-05-25
verified_at: 2026-05-25T01:05:33Z
---

# Phase 03 — Security

Per-phase security contract for layout, constraints, routing, solver integration, public API, and canonical fixture generation.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Normalized diagram input -> Dagre wrapper | User-prepared node sizes and edge references are translated into Dagre graph data. | Node IDs, dimensions, direction, edge references |
| Dagre output -> DGE constraints | Third-party center coordinates become DGE-owned top-left boxes and enter deterministic constraints. | Layout boxes, diagnostics |
| Constraint input -> box mutation | Fixed positions, exact positions, references, and containment rules can move geometry. | Positions, target IDs, padding, locks |
| Coordinated node geometry -> routing | Shape geometry, anchors, and obstacle boxes become connector route points. | Ports, obstacles, route kind |
| Solver -> public coordinated IR | Partial safe output and diagnostics cross into public API consumers and exporters. | Coordinated nodes, groups, edges, bounds, diagnostics |
| Test generation -> golden fixtures | Solver output is serialized into committed canonical fixtures. | Canonical JSON snapshots |

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-03-01-LAYOUT | Tampering | `src/layout/dagre.ts` | mitigate | Node dimensions are checked with finite/non-negative validation before Dagre; invalid nodes emit `layout.node-size.invalid` and are omitted from result boxes. | closed |
| T-03-02-LAYOUT | Tampering | `src/layout/dagre.ts` | mitigate | Edges are only added to Dagre when both endpoints exist in the valid node set; invalid refs emit `layout.edge-reference.missing`. | closed |
| T-03-03-LAYOUT | Denial of Service | `src/layout/dagre.ts` | accept | Phase 03 wrapper calls Dagre once per solve. Broader diagram-size limits remain a future CLI/DSL policy concern. | closed |
| T-03-01-CONSTRAINTS | Tampering | `src/constraints/solver.ts` | mitigate | Fixed and exact positions are finite-checked; invalid positions emit `constraints.position.invalid` and preserve previous finite boxes. | closed |
| T-03-02-CONSTRAINTS | Tampering | `src/constraints/solver.ts` | mitigate | Source/reference/container/child/target IDs are checked before mutation; malformed references emit `constraints.reference.missing`. | closed |
| T-03-03-CONSTRAINTS | Denial of Service | `src/constraints/solver.ts` | accept | Constraint solving is bounded to deterministic passes over constraints and box pairs; no unbounded physics loop or search is introduced. | closed |
| T-03-01-ROUTING | Tampering | `src/routing/routes.ts` | mitigate | Routing reuses shape geometry and port validation from Phase 02 and emits route points from validated geometry primitives. | closed |
| T-03-02-ROUTING | Tampering | `src/routing/routes.ts` | transfer | Node/edge reference validation belongs to `solveDiagram()` before routing; routing validates geometry/anchor input at the lower-level API boundary. | closed |
| T-03-03-ROUTING | Denial of Service | `src/routing/routes.ts` | mitigate | Orthogonal routing uses a fixed candidate list and deterministic fallback diagnostic; no A* or open-node search is implemented. | closed |
| T-03-01-SOLVER | Tampering | `src/solver/solve.ts` | mitigate | Layout and constraint diagnostics are propagated; node/group/edge output is only built from solved boxes and computed geometry. | closed |
| T-03-02-SOLVER | Tampering | `src/solver/solve.ts` | mitigate | Edge and group references are checked before routing or container construction; missing references emit `solver.*.missing` and omit unsafe elements. | closed |
| T-03-03-SOLVER | Denial of Service | `src/solver/solve.ts` | mitigate | Solver stable-sorts once, calls Dagre once, and routes each edge through bounded candidate routing. | closed |
| T-03-01-FIXTURES | Tampering | `test/fixtures/phase-03/*.canonical.json` | mitigate | Fixtures are generated from `stringifyCanonical(solveDiagram(input))`; canonical serialization rejects non-finite numbers. | closed |
| T-03-02-FIXTURES | Tampering | `test/determinism.test.ts` | mitigate | Determinism and diagnostic tests cover malformed references and stable diagnostic visibility. | closed |
| T-03-03-FIXTURES | Denial of Service | `rtk npm run verify` gate | mitigate | Full verification includes focused routing/solver tests and a renderer-neutral forbidden-term scan in Phase 03 summaries. | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-03-01 | T-03-03-LAYOUT | Dagre is a runtime dependency and the Phase 03 wrapper makes a single layout call; explicit graph-size policy belongs to the future DSL/CLI boundary where user input size is introduced. | Codex | 2026-05-25 |
| AR-03-02 | T-03-03-CONSTRAINTS | The deterministic constraint pass is intentionally bounded and not a complete constraint optimizer; unresolved layouts are reported through diagnostics. | Codex | 2026-05-25 |

## Audit Evidence

| Control | Evidence | Status |
|---------|----------|--------|
| Layout dimension validation | `src/layout/dagre.ts` checks `isValidDimension()` and emits `layout.node-size.invalid`; `test/layout.test.ts` covers invalid sizes. | verified |
| Layout edge reference validation | `src/layout/dagre.ts` checks endpoints against `validNodeIds`; layout tests cover missing references. | verified |
| Constraint finite/reference diagnostics | `src/constraints/solver.ts` uses `isFiniteBox`, `isFinitePoint`, and `missingReference`; `test/constraints.test.ts` covers invalid positions and missing refs. | verified |
| Locked precedence | Constraint solver applies fixed/exact before weaker constraints and tests assert hard-lock behavior. | verified |
| Bounded overlap repair | Solver checks sorted box pairs once and reports `constraints.overlap.unresolved` if overlap remains. | verified |
| Bounded routing | `src/routing/routes.ts` has a fixed orthogonal candidate list and `routing.obstacle.unavoidable`; routing tests cover fallback. | verified |
| Solver safe partial output | `src/solver/solve.ts` omits unsafe edge/group output after missing references and appends stable diagnostics. | verified |
| Public API surface | `test/public-api.test.ts` imports Phase 03 APIs from `../src/index.js`; `package.json` exports only `"."`. | verified |
| Full gate | `rtk npm run verify` passed after Phase 03 implementation. | verified |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-05-25 | 15 | 15 | 0 | Codex |

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-25
