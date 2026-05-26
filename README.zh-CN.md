# auto-graph

[English README](./README.md)

auto-graph 是一个确定性的图形几何计算引擎。它把高层 YAML 或 JSON 图表意图转换成稳定、避碰、文本安全的坐标，并导出为 SVG 或可编辑的 Excalidraw JSON。

它不是可视化编辑器，也不是以渲染为中心的画图工具。auto-graph 解决的是“意图”和“可渲染坐标”之间的几何求解层，适合编码 Agent、LLM 自动化流程、CLI 管线和需要可重复图表输出的开发者。

## 安装

```bash
npm install auto-graph
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
} from "auto-graph";

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
const coordinated = solveDiagram(normalized.diagram);

const svg = exportSvg(coordinated, { title: "Architecture" });
const excalidraw = exportExcalidraw(coordinated);
```

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

## CLI

```bash
agh --input diagram.yaml --format svg --output diagram.svg
agh --input diagram.yaml --format excalidraw --output diagram.excalidraw.json
cat diagram.yaml | agh --json
```

支持的输出格式：

- `svg`
- `excalidraw`

格式优先级为 CLI `--format`、DSL 中的 `output.format`，最后默认 `svg`。

## 当前范围

auto-graph v0.0.1 包含：

- TypeScript 公共 API，支持 ESM 和 CJS 构建
- YAML 和 JSON DSL 解析
- parse、validate、solve、export、I/O 分层诊断
- 基于 Pretext 的文本测量抽象和测试 fallback
- 标签适配、形状几何、AABB 避碰工具和连接端口
- Dagre 初始有向布局
- exact、relative、align、distribute、containment 约束
- 直线和正交连接线
- SVG 和 Excalidraw 导出
- Golden fixture 与确定性测试

首个版本暂不包含：

- 浏览器 UI
- draw.io XML 导出
- Mermaid 导入/导出
- 完整样式系统
- CAD 级密集走线

## 验证

```bash
npm run verify
```

该命令会运行 TypeScript 类型检查、双格式构建、Vitest 测试和 Biome 检查。

## 致谢

auto-graph 使用 `@chenglou/pretext` 做无渲染器文本准备，使用 `@dagrejs/dagre` 做有向图初始布局。
