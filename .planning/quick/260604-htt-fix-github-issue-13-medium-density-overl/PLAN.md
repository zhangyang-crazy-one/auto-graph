---
quick_id: 260604-htt
slug: fix-github-issue-13-medium-density-overl
status: in_progress
created_at: 2026-06-04T04:50:10.289Z
---

# Fix GitHub Issue #13 Medium-Density Solver Warnings

## Scope

GitHub issue #13 reports real solver-scope failures in medium-density diagrams:

- unresolved node overlap in the microservice architecture example
- route fallback warnings caused by dense obstacles
- label fit behavior concerns and diagnostic actionability concerns

This quick task keeps the PR focused on deterministic geometry solving. It does
not add new DSL switches or broad diagnostic modes in this slice.

## Plan

1. Add the issue #13 microservice YAML as a regression fixture.
2. Reproduce the current overlap warning through DSL render/solve tests.
3. Improve overlap repair so unlocked medium-density nodes can move on the
   secondary axis deterministically before reporting unresolved overlap.
4. Keep fixed/exact-position lock behavior unchanged.
5. Run targeted tests and full project verification.
6. Commit the PR branch and open a GitHub PR linked to issue #13.

## Acceptance

- The issue #13 microservice fixture solves without
  `constraints.overlap.unresolved`.
- Existing lock conflict tests still report unresolved overlap when both boxes
  are locked.
- Solver output remains deterministic and TypeScript/lint/test checks pass.
