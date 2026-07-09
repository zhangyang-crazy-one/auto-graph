# Phase 15: External Label Execution - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning
**Source:** #75 Slice B

<domain>
## Phase Boundary

This phase executes one remediation class: external keyed edge labels. It should remove long congested inline edge-label boxes from saturated route fields when policy allows `externalLabels: "auto"`.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** External labels must be deterministic and keyed by stable edge order.
- **D-02:** Long text moves to an external shelf/legend; local route field contains only a short key or no local long label box.
- **D-03:** Externalization must preserve edge identity and enough metadata for downstream draw.io/SVG exporters.
- **D-04:** This phase does not need to render perfect callout graphics in every exporter, but solver output must be machine-readable.

### the agent's Discretion
- The executor may choose top/bottom/right/left shelf defaults based on current bounds, provided output is deterministic and non-overlapping in tests.
</decisions>

<canonical_refs>
## Canonical References

- `src/solver/solve.ts` - edge label placement and `reportExternalizedLabelDiagnostics`.
- `src/ir/label-layout.ts` - solved text annotation shape and placement metadata.
- `src/ir/diagram.ts` - remediation plan and coordinated output metadata.
- `test/solver.test.ts` - label congestion and external labels tests.
- `test/dense-acceptance.test.ts` - dense CV/OV/SV evidence.
</canonical_refs>

<specifics>
## Specific Ideas

Use existing `externalLabels` behavior as the starting point. Convert it from "external-callout-required" advice into deterministic execution when the policy is `auto`.
</specifics>

<deferred>
## Deferred Ideas

- Page-level rail/gutter policy is Phase 16.
- Strict loop integration is Phase 17.
</deferred>
