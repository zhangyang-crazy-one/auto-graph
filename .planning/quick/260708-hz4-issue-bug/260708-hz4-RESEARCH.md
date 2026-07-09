# Research: Dense Orthogonal Routing For Large Nodes And Labels

## Sources Consulted

- Orthogonal Connector Routing, Marriott/Stuckey/Wybrow: https://people.eng.unimelb.edu.au/pstuckey/papers/gd09.pdf
- Seeing Around Corners: Fast Orthogonal Connector Routing: https://link.springer.com/chapter/10.1007/978-3-662-44043-8_4
- yFiles Orthogonal Edge Router developer guide: https://docs.yworks.com/yfiles/doc/developers-guide/orthogonal_edge_router.html
- yFiles EdgeRouter API label awareness options: https://docs.yfiles.com/yfiles/doc/api/y/layout/router/polyline/EdgeRouter.html
- ELK Libavoid integration notes: https://eclipse.dev/elk/blog/posts/2022/22-11-17-libavoid.html
- Automatic label placement in diagrams: https://www.yworks.com/pages/automatic-label-placement-in-diagrams
- Edge routing with ordered bundles: https://www.sciencedirect.com/science/article/pii/S0925772115001133

## Findings

1. Object-avoiding orthogonal connector routing should not be a first-success heuristic. The established approach is a path search over obstacle-aware visibility/grid structures with an explicit objective, typically length plus bend count, and hard object avoidance where feasible.
2. Visibility graph plus A* is appropriate, but dense diagrams produce many topologically equivalent paths. The "Seeing Around Corners" direction reduces this by using canonical obstacle-hugging / 1-bend visibility paths.
3. Mature routers expose monotonic path restrictions because long backward travel is a separate quality failure. These restrictions should be soft unless the caller explicitly accepts object crossings.
4. yFiles-style routers distinguish center-driven from space-driven search and use penalties for crossings plus rerouting of the worst paths. That maps directly to Auto Graph's current issue: text and label crossings must be part of candidate cost, not only post-solve diagnostics.
5. Label-aware routing is a first-class routing option in mature tools. Node labels and fixed edge labels can be considered obstacles during route search, and integrated edge labeling is a separate pass when labels of routed edges must move too.
6. For dense graphs, bus/rail/ordered-bundle techniques are a global strategy. They minimize clutter and channel congestion by routing related edges through shared lanes while preserving separate edge tracks. Auto Graph already has a rail-routing seed, but the residual OV/SV failures show route scoring and fallback still need to treat channel congestion as a hard cost.
7. Automatic labeling is not always feasible in dense diagrams, especially with large labels. A solver should either find a safe label/route pair or report a structured unsatisfiable condition requiring external labels, more rails/gutters, node growth, or view splitting.

## Implementation Direction

The immediate fix should make the current router algorithmic rather than local:

- Score every candidate path with one shared cost model:
  - hard obstacle crossings;
  - endpoint interior re-entry;
  - soft/text obstacle crossing count and crossing length;
  - path length;
  - bend count;
  - backward travel and excessive length ratio.
- Sort/rank fallback candidates by this score instead of accepting the first hard-clear path.
- Treat endpoint interior protection as always relevant, including explicit anchors and ports.
- Apply the same backtracking gate to greedy-rerouted fallbacks.
- Preserve structured diagnostics when all candidates require crossing large labels/nodes or excessive backtracking.

This is not the final form of a full libavoid clone, but it aligns the existing visibility/A* and heuristic router with the same objective function used by mature orthogonal edge routers.
