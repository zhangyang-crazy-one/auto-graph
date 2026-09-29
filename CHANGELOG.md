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
- **Obstacle-avoiding ends (#76)**: coincident endpoints are spread for `obstacle-avoiding` pages too, and anonymous ends move off named-port points (ported ends stay put but occupy their point); edge separation keeps clear of end segments there as well.
- **Every crossing drawable**: when a crossing sits too close to a bend of the jumping edge for the hop glyph, the other edge jumps instead.
- **draw.io export (#89)**: every solved element is exported (frame, swimlanes, groups, matrices, tables, evidence panels, external callouts), translated to the page origin; end points are pinned with exit/entry constraints (draw.io ignores `sourcePoint`/`targetPoint` next to terminals); straight/diagonal routes use `edgeStyle=none`; parallelogram/hexagon shapes, dashed strokes, hollow arrowheads and per-edge `gap`/`arc` jump styles are kept.
- **Review fixes (round 3)**: the opt-in channel nudge keeps a move only if it hits no more of the edge's own obstacles (soft, group, text, nodes); soft hits (port labels) also trigger the slot side search, and router fallbacks rank behind accepted routes; hops account for the arrowhead cut; callout keys stay off nodes, tables, matrices and panels; draw.io keeps node fill/stroke/font, ports and port labels, SysML compartments and solved edge-label positions.
- **Review fixes**: `portShifting.enabled: false` keeps ports at the side middle again; successful port growth no longer reports `routing.port.capacity_exhausted`; the opt-in channel nudge runs before labels; slots take the place of fan-out anchors in both anchor and point; the #95 gate checks every foreign node and its fallback keeps relocated slots and uses the Euclidean detour ratio; channel tracks group bridge-joined intervals; inseparable short candidates stay in the feasibility pool; shelves avoid evidence panels and unresolved key overlaps are reported.
- **Greedy detour speed**: the detour search only tests obstacles within the segment's span and takes at most 8 outward steps (dense acceptance pages back to main's timings).
- **Render check (short-orthogonal)**: rendering the dense SV-1 / AV-1 / OV-5b pages showed defects the numeric gates missed; each now has a regression metric and is 0 on all three pages.
  - An end entering along its own border ranks right after hard hits in the slot side search (ahead of text hits); a final segment too short for the arrowhead retries the slot's side and costs extra in the tournament; separation keeps a 16px end stub.
  - Lane content corridors are no longer soft obstacles for short routes: counting them made routes ride the lane dividers or loop around the pool. Lane headers stay hard.
  - Lone facing ends line up (middle of the shared span, or level with a named port), so the route runs straight instead of jogging a few pixels; TB/BT slot sides follow the wider gap between the boxes.
  - A route keeps off its own port labels; segments along a group frame or node side step clear of it (tournament cost plus a validated post-pass).
  - Edge labels slide along their own line before drifting more than three steps away from it.
- **Swimlanes with fixed children**: when every child of a contract swimlane has a fixed position, none can move into the uniform lane slots, yet the slots were still drawn: children sat in the wrong lane or outside the pool, and the header row covered the top node (its title hidden). The lanes are now drawn around the children in declared order (boundaries midway between neighbouring lanes, empty lanes in the gaps, header band before every child), with `swimlane.lanes-fitted-to-children` instead of `constraints.locked-target-not-moved`. Lanes with free children keep the slot contract.
- **Labels and lane lines**: lane borders are label obstacles, so an edge label's backdrop no longer cuts a divider; a label first looks for a spot where its backdrop stays off every line (its own included) near its line, then falls back to the text-box rule (obstacle-avoiding pages keep the text-box rule). Lane content corridors are no longer soft route obstacles for obstacle-avoiding routes either (lane headers stay hard). New dense-MBSE checks: children outside their lane, nodes on a lane header, labels across a lane border.
- **Review fixes (rounds 5–7)**: channel tracks group segments by coordinate distance, not rounding buckets; label shelves keep callouts off labels that stay inline; `routing.rsopChannelNudge` / `routing.idealNudgingDistance` reach the solver from YAML; a named port's side wins over an explicit anchor on the same end; node-plus-text crossings report `routing.obstacle.unavoidable` (mixed), not an evidence crossing; ends with an authored corner/center anchor take no slot; lanes fitted around fixed children keep `minLaneGutter`. draw.io: ports and port labels are node children, plain-text labels are HTML-escaped, node and edge labels keep the solver's line breaks, and evidence panels are drawn as a title column plus one row per item.
- **Review fixes (round 8)**: a callout key with no spot clear of nodes, tables and panels leaves its label inline (`routing.label-shelf.key_blocked`) instead of keeping a colliding key; draw.io edge labels carry the solved font family and size; `exportDiagram("drawio", …)` forwards export options (page title); short-orthogonal same-side slots on ellipses, diamonds, cylinders and other non-rectangular nodes end on the visible outline.
- **Review fixes (round 22)**: on a bounded page, callout keys stay inside the page area a frame leaves free; draw.io nests matrix, table and evidence-panel cells under their block's background cell and port labels under their port cell, so each moves with what it belongs to; the draw.io page covers ports and text that reach past the solved bounds.
- **Review fixes (round 21)**: with `lockEnds`, edge separation re-reads the locked end segments before each orientation pass, so a track keeps clear of an end segment a previous move stretched; draw.io frame, group and lane titles are children of the cell they label, so they move with it; bounded label shelves keep room for a diagram frame's padding and title bar, so callouts no longer push the frame off the page.
- **Review fixes (round 20)**: draw.io gives a lane label with an ambiguous dotted owner id to the lane whose header it sits on; the greedy obstacle detour keeps a segment when no detour meets fewer obstacles; callout keys keep off frame and lane title bars.
- **Review fixes (round 19)**: same-side slot port alignment is keyed by node then port, and draw.io gives a port label with an ambiguous dotted owner id to its nearest port, so dotted ids cannot cross; draw.io evidence cells carry the Arial font their text was measured in; a callout wider than the usable page gets no shelf column.
- **Review fixes (round 18)**: endpoint spreading may not trade one obstacle for another; callout keys keep off port labels; bounded shelves try the free page right of the content before columns across the drawing; draw.io port lookup is keyed by node then port, so dotted ids cannot collide.
- **Review fixes (round 17)**: the opt-in channel nudge may not trade one obstacle for another either; later callout keys keep off labels whose keys were blocked.
- **Review fixes (round 16)**: short-orthogonal routes treat tables, evidence panels and title bars as hard obstacles (not text-clearance problems); post-pass moves (outline clearing, uncrossing, end tidying) may not enter any obstacle the route did not already meet; callout keys keep off ordinary inline labels, and the unbounded shelf starts right of protruding obstacles; Excalidraw hops keep clear of the arrowhead; draw.io docks ported edges at their port cells.
- **Review fixes (round 15)**: label shelves keep callouts off frame and lane title bars; draw.io leaves unlabeled lanes blank and moves node labels to their solved box (lines, typography, and spacing for an off-centre label such as a cylinder's), keeping them the node's own editable label.
- **Review fixes (round 14)**: a crossing right at a segment end no longer pulls a drawable neighbour out of its hop; the unbounded callout shelf starts right of protruding inline labels.
- **Review fixes (round 13)**: label shelves keep callouts off port labels that reach past their node; draw.io honours `viewportPadding` and draws solved compartment rows (with separators) as node children; crossings on one segment closer than a glyph share one wider, flat hop (SVG, Excalidraw, geometry paths), so every crossing stays under a hop and no two hops overlap.
- **Review fixes (round 12)**: draw.io draws lane labels (turned in horizontal pools) and the frame title from their solved annotations; bounded label shelves keep callouts off ordinary inline edge labels.
- **Review fixes (round 11)**: draw.io leaves unlabeled nodes blank and draws group titles from their solved lines, typography and box; stale text-clearance diagnostics after the channel nudge are judged against text obstacles only; callout keys test diagonal routes by the segment itself, not its bounds; a crossing too close to a bend of both edges for a hop is still counted but drawn plainly (SVG, Excalidraw, geometry paths).
- **Review fixes (round 10)**: a callout key that finds no spot clear of other routes may sit on one (reported as `routing.label-shelf.key_on_route`), but never on a node, panel or other key: then its label stays inline (`key_blocked`) and callouts are packed clear of it; draw.io port labels keep their solved lines and typography; an authored `size` keeps a cylinder label's cap offset; the opt-in channel nudge settles its tracks as a group after per-edge rollbacks (remaining coincident routes are reported) and drops text-clearance diagnostics of nudged routes that now clear their text.
- **Review fixes (round 9)**: a bounded page whose every callout key is blocked no longer hangs the shelf packer; blocked keys are folded into the external-label remediation plan (`blockedKeyEdgeIds`); draw.io callouts keep their solved typography and frames their authored fill and stroke; fitted swimlanes whose neighbouring fixed children leave less than twice the padding report `swimlane.lane-padding.reduced`; micro-jog cleanup keeps a moved end on the same node side.
- **Fan-in on default orthogonal pages (#99)**: a state page where four states fan in to one side state crossed itself and ran along node borders. Implicit same-side ends are ordered by how their routes nest (ends coming from in front by position, ends wrapping round from either flank outermost first); coincident ends spread in the same nesting order; routed edges' label estimates follow their real route and a fan sibling's guesses are not avoided before it is routed; a validated post-pass slides interior segments (alone or with the edge they cross) to remove crossings, then straightens sub-2px jogs and lengthens end stubs shorter than the arrowhead. Border-hugging-end detection ignores pre-placement label estimates.
- **Node `size` in the DSL**: `nodes.<id>.size: { width, height }` is a minimum node size (the label fit can still grow it); it was silently dropped before.

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
