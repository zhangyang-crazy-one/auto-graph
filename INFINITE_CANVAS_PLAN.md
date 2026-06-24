# Infinite Canvas Solver Plan

## Target

Accept arbitrary multi-node diagram intent and produce deterministic,
collision-aware coordinates on an unbounded canvas. Exporters should preserve
the solved coordinates without clipping.

## Current gap

- Coordinates are already unbounded and bounds are content-derived, but Dagre is
  always the first node placement step unless callers rely on later fixed
  position locks.
- Disconnected components are not packed as independent clusters.
- Overlap repair is a bounded, local pairwise pass rather than a global
  feasibility solver.
- Edge routing checks every edge against the full obstacle set and can degrade on
  dense canvases.
- Tests cover small and medium diagrams, but not sparse, negative, or large
  manually positioned canvases.

## PR sequence

1. Done: add an explicit `positions` initial layout mode so callers can seed an
   infinite canvas directly from node positions, while unpositioned nodes still
   fall back to Dagre.
2. Done: add component-aware packing for disconnected auto-layout subgraphs.
3. Done: add spatial-index-backed overlap candidate selection and clearer
   locked-node conflict diagnostics.
4. Done: add routing obstacle spatial filtering and a large-canvas stress test.
5. Done: add opt-in exporter viewport metadata for editable targets where the
   target format supports it.

## PR scope

This PR implements the plan as v1 building blocks. It preserves default Dagre
behavior, adds explicit positioned-canvas seeding, separates disconnected auto
components, improves overlap/routing candidate selection with spatial indexes,
and adds opt-in viewport metadata without changing solved coordinates.
