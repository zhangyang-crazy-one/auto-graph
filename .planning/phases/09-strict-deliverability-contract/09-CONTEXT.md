# Phase 9: Strict Deliverability Contract - Context

**Gathered:** 2026-07-08
**Status:** Ready for execution
**Mode:** Autonomous recommended path

<domain>
Issue #73 requires dense MBSE solves to be either deliverable or explicitly non-deliverable. Existing `degraded` and strict severity promotion were not enough because downstream Stage 5 needs a stable `clean` / `degraded` / `unsatisfiable` contract plus remediation metadata.
</domain>

<decisions>
- Keep non-strict behavior compatible: degraded layouts still return geometry.
- Strict mode turns deliverability blockers into an `unsatisfiable` result.
- Add a structured aggregate diagnostic instead of relying on many unrelated warnings.
</decisions>

<code_context>
- `src/ir/diagram.ts` owns public solved output shape.
- `src/ir/diagnostics.ts` owns deliverability diagnostic classification.
- `src/solver/solve.ts` performs strict promotion at the end of solving.
</code_context>
