# Phase 10: Label Congestion And External Labels - Context

**Gathered:** 2026-07-08
**Status:** Ready for execution
**Mode:** Autonomous recommended path

<domain>
Issue #73 identifies edge-label congestion as a remaining dense MBSE blocker. The solver must distinguish local label placement failure from route failure and expose an external-callout-required outcome.
</domain>

<decisions>
- Extend `SolvedTextAnnotation` with placement metadata instead of inventing a renderer.
- `externalLabels: true` is a public control for downstream callout rendering.
- Strict mode can mark congested edge labels external when no clean local candidate exists.
- Route/text clearance ignores labels that are explicitly externalized.
</decisions>

<code_context>
- `edgeLabelAnchor` scores local candidates.
- `coordinateEdgeTextAnnotations` emits final edge-label annotations.
- `reportExternalizedLabelDiagnostics` provides remediation details.
- DSL routing metadata forwards `externalLabels`.
</code_context>
