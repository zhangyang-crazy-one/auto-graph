[English](./advanced-routing.md) · [返回 README](../README.zh-CN.md)

# 密集走线控制

需要保留坐标的密集图可以通过 YAML `routing` 元数据启用避障走线控制。这些控制保持确定性和无头运行；如果布局无法满足约束，会返回结构化诊断，而不是依赖人工看图判断。

```yaml
layout:
  mode: positions
  direction: LR
routing:
  kind: obstacle-avoiding
  edgeLabelRerouting: { maxIterations: 2 }
  compactTextObstacles: labels-only
  textIntersectionTolerance: 2
  textObstacleVertices: true
  fixedSwimlaneGeometry: diagnose-overflow
  anchorCapacity: { minSpacing: 16, grow: true }
  railRouting: dependency
  externalLabels: { edgeLabels: true }
  deliverabilityMode: strict
  remediationPolicy:
    externalLabels: auto
    routeRails: auto
    growFixedGeometry: auto
    pageSplit: suggest
```

当下游需要保留容器几何时，在 swimlane 或 lane 上提供 `box` 并启用 `fixedSwimlaneGeometry`。高扇入/扇出节点使用 `anchorCapacity`，同层依赖密集页面使用 `railRouting: dependency`，需要把拥挤边标签交给下游 keyed callout 渲染时使用 `externalLabels`。

`deliverabilityMode: strict`（等价于 `strict: true`）要求几何干净，或返回带 `remediationPlans` 的结构化 `unsatisfiable`。`deliverabilityMode: degraded-ok` 保留 advisory degraded 输出。

本地 route/label 反馈循环耗尽后，残余冲突进入有界 remediation 轮次（默认最多 2 次）。应用顺序为 grow → rails → external-label。设置 `pageSplit: auto` 后，之后仍不干净的页面会被拆成多页（见下文）。

## 连线分布默认行为

默认 `orthogonal` 路由下：

- 共享同一节点边的连线端口沿该边均分，按对端节点位置排序，并投影到真实形状轮廓（菱形 / 六边形 / 椭圆 / 平行四边形 / 圆柱）。某一流向侧连线较多的节点会在布局前自动增高/加宽。
- 路由后，共用走线通道的连线会被分离成等距平行轨道（`routing.edgeSeparation: false` 关闭，`{ spacing: 16 }` 调整间距）。
- `relative-position` 支持 `align: center`，`below` / `right-of` 会与参考节点中心对齐，不受节点尺寸影响。

## `remediationPolicy` 应用矩阵

| 键 | `suggest` / `off` | `auto` |
|----|-------------------|--------|
| `externalLabels` | 仅暂存 keyed callout 计划 | 应用确定性 keyed callout 并复查 clearance |
| `routeRails` | 仅暂存 dependency rail 计划 | 强制 dependency rails、重路由，标记 `applied` 或 `blocked` |
| `growFixedGeometry` | 仅暂存增长计划 | 应用 growth deltas / 扩展节点、重路由，标记 `applied` 或 `blocked` |
| `pageSplit` | 暂存可读的 `required`/`available` 计划 | 拆成 2–6 页并逐页求解，标记 `applied`（附 `pages` 与 `crossPageEdgeIds`）或 `blocked` |

### 拆页（`pageSplit: auto`）

其他补救措施之后仍有交付冲突（超容量）的页面，或在 `--page` 适配下标签会小于 8px 的页面，会被拆成多页。属于一起的节点不会被拆开：一个分组及其嵌套内容、一个节点及其子节点总在同一页。页面是这些单元按单页求解时的排列顺序（沿流向；若横向切割更少则横向）连续分段，互不相连的部分保持分开，使它们之间的分页边界不切断任何边；分段边界在保持各页均衡的前提下切断最少的边。之后每页独立求解；泳道池保留全部泳道；框架标题与图标题加上 “(2/3)”。被切断的边在两页上都画出，并止于一个**跨页连接符**，注明另一侧的页码和节点（“→ P2 · Billing”、“P1 · Orders →”；`metadata.offPageConnector`、`remotePage`、`remoteNodeId`）。

分段边界由对单元的动态规划求出，内存与单元数和边数成线性关系。计算量随单元数平方增长，所以超过 2000 万次转移的预算（6 页时约 2500 个单元）后，会先把单元合并成同样数量、权重大致相等的连续块，再在块之间分页。结果是确定性的，每个节点都有归属页，计划的 `detail.partition` 会记录 `{ units, blocks }`；这时切断的边可能比精确解多几条。

只有当拆页后的冲突更少（或可读字号更大）时才采用拆页；否则计划标记为 `blocked` 并附原因，同时给出 `remediation.page-split.blocked` 警告。结果是第 1 页加上 `pages`（每页的求解结果）、合并后的 `deliverability`（各页计划带页前缀，如 `page-2-remediation-01-…`），以及带 `detail.page` 的全部诊断。在 `deliverabilityMode: strict` 下，任何一页残留的冲突仍然是错误（带页码的 `routing.deliverability.unsatisfiable`）。各导出器都会输出全部页面：SVG 纵向堆叠（每页一个嵌套的 `<svg class="page">`，各自适配纸张），draw.io 每页一个 `<diagram>` 标签页，Excalidraw 纵向堆叠并给 id 加 `page-N:` 前缀，geometry 文档带 `pages`。

计划状态为 `suggested`、`applied` 或 `blocked`。在 full-auto strict 密集验收下，可自动执行的类型必须是 `applied` 或 `blocked`，不能停留在 `suggested`。

求解结果继续保留旧的 `degraded`、`deliverability.status` 和 `deliverability.remediationTypes` 字段。同时提供确定性的 `deliverability.remediationPlans` 对象，包含稳定 ID、类型、状态、诊断代码、edge/node ID 以及类型专属细节，strict 消费方可以直接应用或暂存 remediation，而不需要解析自由文本诊断。
