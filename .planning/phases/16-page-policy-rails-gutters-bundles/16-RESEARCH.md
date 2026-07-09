# Phase 16 Research: Page Policy Rails, Gutters, And Bundles

## Research Complete

## Current State

`solve.ts` already exposes `railRouting` and `routing.rails/gutters`, but the mechanism is narrow and mostly same-rank/dependency shaped. `bus-router.ts` contains `computeFanOutPorts`, but it is not wired into edge coordination.

## Needed Behavior

Dense pages need capacity before route search:

- classify page intent or accept explicit metadata
- reserve lanes/gutters/rails
- route against rail occupancy and label shelves
- grow high fan-in anchors before route selection
- emit split plans when rail/lane capacity is exceeded

## Validation Architecture

Fixtures should prove page policy changes geometry, not just diagnostics:

- dependency rails use deterministic coordinates and avoid labels/nodes
- resource-flow gutters route around node clusters
- IBD bundle/fan-out separates same-side anchors
- capacity over budget emits split plan with numeric capacity detail
