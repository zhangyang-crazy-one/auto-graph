# Changelog

## 0.2.4 (2026-06-26)

### Issue #54 布局与路由引擎

- **递归容器布局 (方案 A)**: `runRecursiveContainerLayout` — DFS post-order 自底向上布局，叶容器先布局（尺寸 = unionBoxes + padding），父布局中视为原子节点。通过 `recursiveLayout: true` 启用。 (#56)
- **角点可见图 A* 路由 (方案 B)**: `findCornerGraphPath` — libavoid 风格的正交路由，基于角点可见度图 + Steiner 投影点，带 turn penalty 的 A* 搜索。`routeEdge` 中透明 fallback 到 grid A*。 (#57)
- **边总线端口分散 (方案 C)**: `computeFanOutPorts` — 同源同向边沿节点边均匀分散，避免端口堆叠。clamp 溢出锚点到节点边界内。 (#58)
- **5 维度布局质量评分 (方案 E)**: `scoreLayoutQuality` — node-overlap、edge-crossing、bend-count、route-backtrack、label-collision 各 20 分，总分 0–100。通过 `qualityScore: true` 启用。 (#59)

### 🏗️ 基础设施

- **LayoutPipeline**: 可替换 phase 的阶段管线，`createDefaultPipeline()` 提供 solve-diagram → quality-score 两阶段。 (#55)

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
