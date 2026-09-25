# auto-graph

[English README](./README.md)

auto-graph 是一个确定性的图形几何计算引擎。它把高层 YAML 或 JSON 图表意图转换成稳定、避碰、文本安全的坐标，并导出为 SVG 或可编辑的 Excalidraw JSON。

它不是可视化编辑器，也不是以渲染为中心的画图工具。auto-graph 解决的是“意图”和“可渲染坐标”之间的几何求解层，适合编码 Agent、LLM 自动化流程、CLI 管线和需要可重复图表输出的开发者。

## 安装

```bash
npm install @crazyhappyone/auto-graph
```

CLI 命令是 `agh`。

```bash
agh --input examples/architecture.yaml --format svg --output architecture.svg
cat examples/architecture.yaml | agh --format excalidraw > architecture.excalidraw.json
```

本地开发时，先构建再直接运行编译后的 CLI：

```bash
npm run build
node dist/cli/index.js --input examples/architecture.yaml --format svg --output architecture.svg
```

## 为什么需要它

很多图表生成工具要么依赖渲染器反馈来确定布局，要么暴露坐标让人或 Agent 反复微调。auto-graph 保持几何求解的确定性和无头运行：

1. 通过 `TextMeasurer` 抽象在布局前测量文本。
2. 用 Dagre 生成有向初始布局，再叠加确定性约束。
3. 从已解析的形状端口生成直线或正交连接线。
4. 导出已求解的坐标，不在导出阶段重新排版。

同样的输入应产生稳定的数值输出，方便快照测试、自动化生成和下游导出器复用。

## TypeScript API

```typescript
import {
  exportExcalidraw,
  exportSvg,
  normalizeDiagramDsl,
  parseDiagramDsl,
  solveDiagram,
} from "@crazyhappyone/auto-graph";

const source = `
title: Architecture
layout: { direction: LR }
nodes:
  api: { label: "API Gateway", shape: rounded-rectangle }
  db: { label: "Database", shape: cylinder }
edges:
  - api -> db: "reads"
constraints:
  - kind: relative-position
    source: db
    reference: api
    relation: right-of
    offset: { x: 140, y: 0 }
`;

const parsed = parseDiagramDsl(source);
if (parsed.value === undefined) {
  throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
}

const normalized = normalizeDiagramDsl(parsed.value);
const coordinated = solveDiagram(normalized.diagram, {
  routeKind: "obstacle-avoiding",
  maxRoutingAttempts: 8,
  labelPlacement: "beside",
  labelOffset: 16,
});

const svg = exportSvg(coordinated, { title: "Architecture" });
const excalidraw = exportExcalidraw(coordinated);
```

求解器按职责拆分（`ports`、`route-edges`、`labels`、`remediation` 等）。模块归属与默认管线阶段顺序见 [`src/solver/ARCHITECTURE.md`](./src/solver/ARCHITECTURE.md)。

## DSL 示例

```yaml
title: Architecture
layout:
  direction: LR
nodes:
  web:
    label: Web App
    shape: rounded-rectangle
  api:
    label: API
    shape: hexagon
  db:
    label: Database
    shape: cylinder
edges:
  - web -> api: calls
  - api -> db: reads
constraints:
  - kind: relative-position
    source: api
    reference: web
    relation: right-of
    offset: { x: 160, y: 0 }
```

## 密集走线控制

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

本地 route/label 反馈循环耗尽后，残余冲突进入有界 remediation 轮次（默认最多 2 次）。应用顺序为 grow → rails → external-label。`pageSplit` **不会**自动物化拆页。

### 连线分布默认行为

默认 `orthogonal` 路由下：

- 共享同一节点边的连线端口沿该边均分，按对端节点位置排序，并投影到真实形状轮廓（菱形 / 六边形 / 椭圆 / 平行四边形 / 圆柱）。某一流向侧连线较多的节点会在布局前自动增高/加宽。
- 路由后，共用走线通道的连线会被分离成等距平行轨道（`routing.edgeSeparation: false` 关闭，`{ spacing: 16 }` 调整间距）。
- `relative-position` 支持 `align: center`，`below` / `right-of` 会与参考节点中心对齐，不受节点尺寸影响。

### `remediationPolicy` 应用矩阵

| 键 | `suggest` / `off` | `auto` |
|----|-------------------|--------|
| `externalLabels` | 仅暂存 keyed callout 计划 | 应用确定性 keyed callout 并复查 clearance |
| `routeRails` | 仅暂存 dependency rail 计划 | 强制 dependency rails、重路由，标记 `applied` 或 `blocked` |
| `growFixedGeometry` | 仅暂存增长计划 | 应用 growth deltas / 扩展节点、重路由，标记 `applied` 或 `blocked` |
| `pageSplit` | 暂存可读的 `required`/`available` 计划（仅 `suggest`，无 `auto`） | — 拆页**不会**自动物化 |

计划状态为 `suggested`、`applied` 或 `blocked`。在 full-auto strict 密集验收下，可自动执行的类型必须是 `applied` 或 `blocked`，不能停留在 `suggested`。

求解结果继续保留旧的 `degraded`、`deliverability.status` 和 `deliverability.remediationTypes` 字段。同时提供确定性的 `deliverability.remediationPlans` 对象，包含稳定 ID、类型、状态、诊断代码、edge/node ID 以及类型专属细节，strict 消费方可以直接应用或暂存 remediation，而不需要解析自由文本诊断。

### Issue 收口建议（密集 MBSE epic）

本契约在本地 fixture 落地后，建议人工操作：

- 关闭 [#74](https://github.com/zhangyang-crazy-one/auto-graph/issues/74) — 回归守卫已存在（文本硬障碍不得升级为 evidence crossing）。
- 将 [#71](https://github.com/zhangyang-crazy-one/auto-graph/issues/71)、[#73](https://github.com/zhangyang-crazy-one/auto-graph/issues/73)、[#69](https://github.com/zhangyang-crazy-one/auto-graph/issues/69) 并入 [#75](https://github.com/zhangyang-crazy-one/auto-graph/issues/75)。
- 保持 [#75](https://github.com/zhangyang-crazy-one/auto-graph/issues/75) 开放，直到本地密集契约（干净或带计划的结构化 unsat）满足为止——不以 live DoDAF Stage 5 critical 归零为关闭条件。

## CLI

```bash
agh --input diagram.yaml --format svg --output diagram.svg
agh --input diagram.yaml --format excalidraw --output diagram.excalidraw.json
agh --input diagram.yaml --font ./fonts/NotoSansSC-Regular.otf --output diagram.svg
cat diagram.yaml | agh --json
```

支持的输出格式：

- `svg`
- `excalidraw`
- `geometry` —— 解算后的几何契约（见下）

格式优先级为 CLI `--format`、DSL 中的 `output.format`，最后默认 `svg`。

## 几何契约

`--format geometry`（TypeScript 中为 `exportGeometry(diagram)`）把解算结果输出为纯数字，智能体或应用可以用任意渲染器直接绘制，不必再各自手写一套 SVG 布局。格式带版本号（`"format": "dge-geometry", "version": 1`），JSON Schema 见 [`schema/dge-geometry.v1.schema.json`](schema/dge-geometry.v1.schema.json)（也可调用 `geometryJsonSchema()`）。

统一坐标系（px，原点左上，y 向下），所有数值保留 3 位小数，同一输入逐字节稳定：

- `nodes`：外框、外形（`rect` + 圆角、`ellipse`、`polygon`、`cylinder` 原语，**以及** `M`/`L`/`A`/`Z` 路径命令）、端口。
- `containers`：分组、泳道与泳道行（框、表头、父子关系）。
- `edges`：起止点与所在边、路由点 `points`、描边路径 `path`（截到箭头底边，并在从其他连线下方穿过处切入跳线弧或缺口）、箭头三角形、交叉点、标签引用。
- `texts`：每个文字块的框、字体、逐行位置（左侧 `x`、基线 `y`、宽度、行框）、需要先画的白底框以及旋转角度。
- `zOrder`：从后到前的绘制顺序；`metrics`：布局质量指标；`diagnostics`：诊断信息。

渲染就是遍历 `zOrder`；`renderGeometrySvg(document)` 是只依赖该文档、约 100 行的参考渲染器。

`--metrics <path>` 会额外输出整张画布的布局质量指标 JSON（节点/分组重叠、文字溢出外形、交叉、共享端点、空白率、泳道填充率等），智能体无需"看图"即可用数值自检：

```bash
agh --input diagram.yaml --output diagram.svg --metrics diagram.metrics.json
```

## 当前范围

auto-graph v0.0.1 包含：

- TypeScript 公共 API，支持 ESM 和 CJS 构建
- YAML 和 JSON DSL 解析
- parse、validate、solve、export、I/O 分层诊断
- 基于 Pretext 的文本测量抽象和测试 fallback
- Pretext 用画布上可用的字体测量。传入图实际使用的字体文件（`--font NotoSansSC.otf`，可重复，`字体名=文件` 可指定名称；或 `renderDiagramDsl` 的 `fonts` 选项、`registerFonts()`），标签就按真实字体精确测量，注册的中文字体会排在中文字体栈最前面。没有真实字体时（Node 画布会退到本机已有字体，这里汉字被少算约 25%），全角字符一律按 1 em（所有主流中文字体都如此），中文字体栈中的拉丁字母预留 6% 余量，保证不溢出。折行遵守避头尾规则（行首不出现 `，。）」…`，行尾不出现 `（「…`）。默认中文字体栈为 `'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', sans-serif`。
- 标签适配、形状几何、AABB 避碰工具和连接端口
- Dagre 初始有向布局
- exact、relative、align、distribute、containment 约束
- 直线、正交、避障和密集依赖 rail 走线
- 文本感知走线避让、边标签重路由、固定泳道几何和结构化拥堵诊断
- SVG 和 Excalidraw 导出
- Golden fixture 与确定性测试

首个版本暂不包含：

- 浏览器 UI
- draw.io XML 导出
- Mermaid 导入/导出
- 完整样式系统

## 验证

```bash
npm run verify
```

该命令会运行 TypeScript 类型检查、双格式构建、Vitest 测试和 Biome 检查。

## 致谢

auto-graph 使用 `@chenglou/pretext` 做无渲染器文本准备，使用 `@dagrejs/dagre` 做有向图初始布局。
