# Phase 17: Strict Remediation Loop And Issue Closure - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning
**Source:** #75 Slices D/E

<domain>
## Phase Boundary

This phase integrates the contract, external labels, and page policies into the strict remediation loop. It also documents the public behavior and prepares issue hygiene for #74/#73/#71/#69/#75.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** `routing.route-label-loop.exhausted` is a state transition into remediation planning.
- **D-02:** Auto policies execute remediations and re-solve affected geometry before final output.
- **D-03:** Suggest/off policies return machine-applicable remediation plans and mark strict output unsatisfiable when collisions remain.
- **D-04:** Strict dense output cannot return visually colliding degraded geometry as normal success.
- **D-05:** Diagnostics must distinguish label strike-through, pileup, graze, fixed-geometry block, rail/lane overflow, and true evidence crossing.
</decisions>

<canonical_refs>
## Canonical References

- `src/solver/solve.ts` - route-label feedback loop, deliverability report, remediation execution.
- `src/ir/diagnostics.ts` - deliverability diagnostic set and taxonomy.
- `src/ir/diagram.ts` - public remediation contract.
- `test/dense-acceptance.test.ts` - final dense strict closure gate.
- `test/solver.test.ts` - strict diagnostics and feedback tests.
- `README.md`, `README.zh-CN.md`, `CHANGELOG.md` - docs and release notes.
</canonical_refs>

<specifics>
## Specific Ideas

Final acceptance should not celebrate another critical-count reduction. It should assert clean Stage 5-style geometry or structured unsat with executed/machine-applicable remediation plans.
</specifics>

<deferred>
## Deferred Ideas

- Automatic multi-page split materialization can remain future work if the split plan is machine-readable.
</deferred>
