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

1. Add an explicit `positions` initial layout mode so callers can seed an
   infinite canvas directly from node positions, while unpositioned nodes still
   fall back to Dagre.
2. Add component-aware packing for disconnected auto-layout subgraphs.
3. Add a scalable overlap resolver with spatial indexing and clearer locked-node
   conflict diagnostics.
4. Add routing spatial indexes and large-canvas stress fixtures.
5. Add exporter viewport metadata for editable infinite-canvas targets where the
   target format supports it.

## First PR scope

This PR implements step 1 only. It preserves the default Dagre behavior and adds
focused tests for sparse positioned nodes, negative coordinates, mixed positioned
and automatic nodes, and DSL rendering through `layout.mode: positions`.
