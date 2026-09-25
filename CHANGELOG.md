# Changelog

## Unreleased

### Dense MBSE issues on top of RSOP (#76, #88, #91–#95)

- **Merged #90** (RSOP soft-text clear, draw.io jumps, #91 port docking, #92 same-side slots) with main's views, page fitting, agent reports and incremental stability; `--format` now takes `svg`, `excalidraw`, `drawio` and `geometry`.
- **Slots respect ports (#92/#94)**: anonymous same-side slots are placed between a side's named ports and ordered by where the other end lies; every endpoint gets its own fraction (overflow is reported, never stacked). A slot whose side is walled off is retried on the node's other sides.
- **No border-hugging ends**: short-orthogonal candidates that leave/enter along a node border pay a direction penalty; micro-clear keeps end segments on the side normal; new channel-sweep candidates run the middle segment beside an obstacle instead of only on the midline.
- **Edge separation on short-orthogonal (#88)**: main's separator now runs for `short-orthogonal-jumps` before labels are placed, keeping clear of every route's end segments (`lockEnds`); `rsopChannelNudge` is opt-in. Fixed the RSOP nudge reverting every move (it counted the edge's own end nodes as hits) and its track centring. Dense SV-1 / AV-1 / OV-5b pages: overlapping parallels, shared endpoints and slot collisions all 0.
- **Hard gate (#95)**: a short-orthogonal route that still enters a foreign node, zone or hard text falls back (non-strict) to a clean obstacle-avoiding route within `maxDetourRatio`; strict pages keep the unsat report.
- **Label shelves (#93)**: capacity-aware packing inside `pageBounds` (columns, obstacle clearance, no row reuse); leftovers stay inline with `routing.label-shelf.capacity_exhausted`; callout shelves take part in text-collision diagnostics; crowded keys move along their own edge.
- **No zigzag fallback (#76)**: the greedy obstacle push inserted a single waypoint and produced diagonal zigzags (81 bends on OV-5b); it now makes orthogonal detours around the union of the obstacles it meets.

### Port equal-division docking (#91) + same-side slots / stubs (#92)

- **Named ports (#91)**: equal-division fractions `{0.5}` / `{0.25,0.75}` / `{0.25,0.5,0.75}` (n>3 → `(i+1)/(n+1)`); `portGeometry` pins only the matching side; capacity → `routing.port.capacity_exhausted`.
- **Same-side slots (#92)**: pre-route anonymous endpoint assignment via `attachSlotFractions`; ported ends skipped.
- **Escape stubs (#92)**: short-orthogonal prefers candidates with a separable interior span (stub pitch = `idealNudgingDistance`, default 10); same-Y 0-bend remains fallback when no separable candidate exists.
- **Honest Left-Edge**: channel nudge is greedy Left-Edge / interval coloring — MLCM LP explicitly deferred (docs no longer claim MLCM-style).

### Readable Short-Orthogonal Pipeline / RSOP (#86–#89)

- **Soft-text micro-clear (#87)**: short-orthogonal uses layered cost `length + α·bends + β·textHits`; foreign nodes are hard; text is soft with ±track-pitch micro-detours; never flyer past `maxDetourRatio`.
- **Channel tracks + nudge (#88)**: post-process assigns greedy Left-Edge tracks in shared gutters and nudges by `idealNudgingDistance` (default 10); capacity exhaustion emits `routing.channel.capacity_exhausted`.
- **draw.io jump parity (#89)**: thin `exportDrawio` / CLI `--format drawio` maps `edgeCrossings` to `jumpStyle` + crossing metadata; SVG/Excalidraw hops unchanged.
- **Shelf honesty**: external callout shelves clamp inside `pageBounds` when set.

### Shape-aware label fitting (global layout plan P1)

- **Node labels fit their drawn outline**: node sizes come from exact containment bounds for the Pretext-measured text box: diamond `2w×2h`, circle by the text diagonal, hexagon `w + 2·skew·h/H`, parallelogram `w + skew·(H+h)/H`, cylinder `h + 2m + 2r_y` with the label shifted below the top cap. Applied in DSL normalization and the solver prefit path. Label overflow is now 0 on every layout benchmark.
- **Balanced wrapping**: the narrowest wrap width that keeps the line count (no orphan CJK character or word), never breaking inside a Latin word; diamonds/ellipses also try extra lines and keep the most compact outline.
- **Centred multi-line labels**: `fitLabel` accepts `align: "center"`; node labels centre each line box inside the content box (exporters keep drawing from solved line boxes).
- **Fixes**: overlap repair rebuilds its spatial index every pass (pairs created by an earlier move were skipped); cross-edge post-passes (endpoint spreading, nudging) rerun over all edges after single-edge label reroutes; straight routes can be spread with a dogleg; lone interior segments that clip an obstacle are shifted clear; edge labels avoid the visible text of group titles instead of their padded fitting box.
- **Metrics**: `edgesThroughNodes` tests the drawn outline, multi-line text extent follows the solved line boxes, the canvas includes frame / matrices / tables / evidence panels, and `edgeLabelCollisions` is ratcheted as a hard metric.
- **Label line frame**: `LabelLayout.lines` are owner-local; `translateLabelLayout` moves box, content box and lines together wherever a layout is re-positioned, and annotation builders convert lines to annotation-box-relative coordinates.
- **Post-pass safety**: separation, obstacle escape and border-detachment stubs are validated against policy soft obstacles (tables, panels, title bars, lane corridors) as well as nodes, hard blocks and text.

### Edge distribution: even ports, parallel-track separation, flow-ordered lanes

- **Default port distribution** (`routeKind: "orthogonal"` without `anchorCapacity`): endpoints sharing a node side are split evenly along it (`(i+1)/(n+1)`), ordered by the opposite node so a fan does not cross itself, and projected onto the drawn outline of diamond / hexagon / ellipse / parallelogram / cylinder shapes. Sides are chosen by flow direction (LR → left/right whenever nodes are horizontally separated), so fan-out edges no longer collapse onto one point.
- **Degree-based pre-growth**: nodes with ≥3 edges on a flow side grow along that side before layout so ports keep ~14px spacing.
- **Edge separation (nudging)**: after routing, collinear overlapping interior segments of different edges are spread into evenly spaced parallel tracks inside their free channel; track order minimises crossings. Opt out / tune with `edgeSeparation: false | { spacing }` (API and DSL `routing.edgeSeparation`).
- **Exit/entry direction**: route ranking penalises end segments that do not leave/enter along the anchor normal (no more edges running down a node border). Fallback routes that still hug a border get a short outward stub.
- **Blocked-side retry and endpoint spreading**: a pinned side that cannot avoid obstacles is retried with free side choice; coincident endpoints on one side are spread apart afterwards.
- **Horizontal swimlane contract** keeps one shared x offset for all lanes, preserving flow order across lanes instead of left-packing each lane.
- **`relative-position` `align: center`** (opt-in) centres the source on the reference's cross axis; default `start` is unchanged.
- Ellipse/circle node labels are re-centred after circle sizing.

### Pretext sizing + semantic roles (#84 A/D)

- **Pretext sizing contract**: `maxWidth` is wrap-only; fitted boxes grow to wrapped text + padding; DSL/prefit use `overflow: "diagnose"` (no truncate). `deliverabilityMode` enables `prefitLabelSize` by default. Ellipse nodes use circle diameter `max(w,h)`.
- **Semantic roles**: DSL/API `role: start|end|decision|process|data|concept` maps to fixed shapes when `shape` is omitted; explicit `shape` wins. SysML blocks omit `role` and stay rectangular.

### Short-path / jump-bridge routing contract (#84 C+B+E)

- **`routeKind: "short-orthogonal-jumps"`**: prefer 0–2 bend attach-slot routes; reject flying detours beyond `maxDetourRatio` (default 3); do not treat 2-point `route_obstacle_fallback` as success.
- **Attach slots (25/50/75)**: public `attachSlotFractions` / `attachSlotsForBox` helpers; dense and short-path profiles default `maxAttachPointsPerSide=3`.
- **`edgeCrossings` IR**: declared edge–edge jump/gap/bridge records; SVG, Excalidraw, and draw.io render hops from the same IR.
- **Deliverability**: short-path capacity failures emit `routing.obstacle.unavoidable` + rail/split remediation instead of flyer geometry marked clean.

### Dense remediation loop

- **Bounded remediation pass** after route/label feedback exhaustion (default 2 iterations): apply order grow → rails → external-label; `pageSplit` is never auto-materialized.
- **`remediationPolicy` apply matrix**: `externalLabels` / `routeRails` / `growFixedGeometry` `auto` mutate geometry or mark `blocked`; `suggest`/`off` stay non-mutating; plans expose `applied`/`blocked`/`suggested`.
- **`conflictClass` taxonomy** on deliverability diagnostics (`node-label-strike`, `edge-label-pileup`, `label-bbox-graze`, `fixed-geometry-block`, `rail-lane-overflow`, `evidence-crossing`) without changing diagnostic codes.
- **Strict dense gate**: full-auto profile returns clean geometry or structured `unsatisfiable` with per-family remediation plans.

## 0.2.5 (2026-06-26)

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
