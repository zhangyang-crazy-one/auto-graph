# Changelog

## 0.1.0

### Layout & Routing

- **Container child distribution** — New `distributeContainedChildren` option distributes
  siblings along the main axis inside containment groups, with cross-axis centering.
  Locked children are skipped with a diagnostic; oversized children are reserved.
  Opt-in (default `false`). (#23)
- **Sibling gap enforcement** — `minSiblingGap` now actively enforces minimum spacing
  in `repairOverlaps` for sibling pairs, rather than only reporting violations.
  Sibling pairs use `max(overlapSpacing, minSiblingGap)` as effective spacing. (#18 P0)
- **Intra-container overflow diagnostics** — New `intra_container_overflow` (warning)
  and `intra_container_overflow_total` (error) diagnostics report sibling overlaps
  and aggregate size overflow within containers when `minSiblingGap` is set.
- **Page bounds diagnostics** — New `pageBounds` option reports `page_overflow` when
  content exceeds page dimensions. Frame boxes included in the check.
- **Vertical stack wrapping** — `maxStackDepth` and `preferredAspectRatio` options
  detect and reflow single-column vertical runaways into multi-column layouts.
- **Diagonal straight edge obstacle avoidance** — `expandFallbackRoute` now generates
  obstacle-aware L-shaped detour candidates for diagonal edges, reusing
  `horizontalDetourLane` / `verticalDetourLane` and selecting the shortest
  obstacle-free path. (#21)
- **Port anchor clamping** — Port spacing is compressed when `spacing * (count - 1)`
  would overflow the node edge, ensuring distinct anchors even with many ports.
- **Lane gutter** — `minLaneGutter` option adds configurable spacing between contract
  swimlane lanes. Negative values clamped to 0.

### Label & Text

- **Prefit label sizing** — `prefitLabelSize` option measures labels before layout
  and expands node sizes to fit. Uses CJK-aware font when CJK metadata is present.
  `solveDiagramSafe` convenience wrapper enables it by default. (#22)
- **Label layout centering** — `expandLabelLayoutToNode` centers fitted label layouts
  within preserved node dimensions when the node is larger than needed.
- **Edge label avoidance** — Edge label placement now avoids node, port, swimlane,
  and frame text annotation boxes, plus previously placed edge labels.
  Anchor candidates expand progressively based on label size.

### CJK Typography

- **Automatic CJK font family** — CJK text labels get `YaHei,SimSun,sans-serif` and
  minimum 14px font size by default. Configurable via `cjkFontFamily` / `minCjkFontSize`
  options (set to `false` to disable).
- **Safe metadata extraction** — `prefitLabelFont` uses `labelCjkTypography` for
  runtime-validated extraction rather than unsafe type casts.
- **Shared defaults** — DSL default constants (`DEFAULT_FONT`, `DEFAULT_NODE_PADDING`,
  etc.) exported from `normalize.ts` and reused in solver's prefit path.

### Diagnostics & Reporting

- **Content box clamping** — `contentBox` dimensions are clamped to 0 to prevent
  negative content sizes from excessive padding triggering false overflow errors.
- **Page overflow deferred** — `reportPageOverflow` now runs after edge routing and
  text annotation placement, covering the full diagram extent.
- **Spatial extent overflow** — `reportIntraContainerOverflow` uses actual spatial
  extent (`max - min`) rather than sequential-stack estimate, avoiding false
  positives for cross-axis arrangements.

### Performance

- **Sibling pair spatial pre-sort** — Sorted children by main-axis position with
  early break in the overlap pair-check loop, reducing O(n²) to near O(n log n)
  for well-separated children.
- **Inlined content dimension** — Avoids full `Box` allocation during overlap
  total-size check.
- **Safe spread elimination** — `Math.min/max(...spread)` replaced with for-loop
  to avoid RangeError for very large containment groups.

### Testing

- **Deterministic text measurement in CI** — Two font-sensitive tests use
  `DeterministicTextMeasurer` to avoid platform-dependent label widths on Ubuntu CI.
- **Test isolation** — `pool: "forks"` and `fileParallelism: false` for CI stability.
  Replaced by the `DeterministicTextMeasurer` approach.

### Misc

- **`solveDiagramSafe`** — Convenience wrapper enabling `prefitLabelSize` by default.
- **Planning docs** — Removed `.planning/` directory from the repository.
