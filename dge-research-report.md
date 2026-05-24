# Pretext 源码深入分析与 DGE 可行性/语言选择报告

> 基准：`@chenglou/pretext` v0.0.7，源码 ~6,853 行纯 TypeScript，零运行时依赖，GitHub 47k stars

---

## 一、Pretext 的核心算法剖析

### 1.1 两阶段架构（这是最关键的设计决策）

```
第一阶段：prepare() —— 一次性的昂贵计算
第二阶段：layout()  —— 纯算术的极速热路径
```

| 阶段 | 做了什么 | 耗时 | 调用频率 |
|------|---------|------|---------|
| `prepare(text, font)` | 全部重活：规范化空白、Intl.Segmenter 分词、语言规则合并（CJK 禁则、阿拉伯语标点、缅甸语粘连、连字符断词等）、canvas measureText 测量每个片段、emoji 校正检测、letter-spacing 预先分配 | ~0.8ms（典型段落） | **仅一次**，文字或字体变化时 |
| `layout(prepared, maxWidth, lineHeight)` | **纯算术**：遍历已缓存的 width[] 数组，`lineW += widths[i]`，`if (lineW > maxWidth) { lineCount++; lineW = 0 }` | **~0.0002ms** | 每次 resize 都调用 |

**核心数据结构**（不是对象，是并行数组）：

```typescript
// prepare() 的输出 —— 8 个并行原始数组 + 4 个标量
type PreparedCore = {
  widths: number[]               // [42.5, 4.4, 37.2] — 每个 segment 宽度
  kinds: SegmentBreakKind[]      // ['text', 'space', 'text'] — 断行行为
  breakableFitAdvances: (number[] | null)[]  // 每个可断字位的子像素宽度
  spacingGraphemeCounts: number[]  // letter-spacing 所需的字位数
  // ... 还有 lineEndFitAdvances, lineEndPaintAdvances 等
}
```

**为什么用并行数组而不是对象？** 缓存密度。CPU 的 L1 缓存预取连续的 float64，比散布在对象堆里快 10x。

### 1.2 测量引擎（measurement.ts）

Pretext 的测量依赖 Canvas API，但**依赖被严格封装**：

```typescript
// 只在 prepare() 中调用，结果缓存到 Map<string, Map<string, SegmentMetrics>>
function getSegmentMetrics(seg: string, cache: Map<string, SegmentMetrics>): SegmentMetrics {
  let metrics = cache.get(seg)
  if (metrics === undefined) {
    const ctx = getMeasureContext()  // OffscreenCanvas 或 DOM canvas
    metrics = { width: ctx.measureText(seg).width, containsCJK: isCJK(seg) }
    cache.set(seg, metrics)
  }
  return metrics  // 后续访问 O(1) 缓存命中
}
```

**运行时兼容性**：
- 浏览器：`new OffscreenCanvas(1,1).getContext('2d')` 或 DOM canvas
- **Node.js 18+**：原生支持 `OffscreenCanvas` ✅
- **Bun**：原生支持 Canvas API ✅

### 1.3 断行算法（line-break.ts）

`walkPreparedLinesSimple()` —— 这是 hot path 的实现，约 190 行纯逻辑：

```
输入:  widths[], kinds[], breakableFitAdvances[][], maxWidth
算法:
  for each segment (width w, kind k, index i):
    if lineW + w > maxWidth:
      在最近的 break point 换行
    else:
      lineW += w
输出: lineCount, 每行的 (startSegmentIndex, endSegmentIndex, width)
```

复杂度 O(n)，无内存分配（除每行回调外），无 string 操作，无 canvas 调用。

### 1.4 非英文支持（这是 Pretext 的精髓）

在 `analysis.ts`（1458 行，是整个库最大的文件）中处理了：

| 语言特性 | 实现 |
|---------|------|
| CJK 禁则处理（行首禁则/行末禁则） | `kinsokuStart` / `kinsokuEnd` 两个 Set，各 ~20 个字符 |
| 阿拉伯语标点合并 | `arabicNoSpaceTrailingPunctuation` + 脚本检测 |
| 缅甸语后缀粘连 | `myanmarMedialGlue` |
| 连字符优先断词 | `isPreferredBreakGrapheme`（-, —, –） |
| 数值+货币符号粘连 | 50 个 Unicode range 的 `lineBreakNumericAffixRanges` |
| 零宽空格/软连字符 | `zero-width-break` / `soft-hyphen` 两类特殊段 |
| Emoji 宽度校正 | 每个字体自动检测 Chrome/Firefox canvas vs DOM 偏差 |
| Letter-spacing | 分布在每个段，非暴力追加 |

**核心洞见**：Pretext 的一半代码用于处理**你没有的语言问题**。这暗示 DGE 如果要做通用，也需要投入大量精力在边缘情况。

---

## 二、DGE 可行性分析

### 2.1 Pretext 模式可以照搬到 DGE 上吗？

**大部分可以，但有本质差异：**

| 维度 | Pretext（文字） | DGE（图形） |
|------|---------------|------------|
| 维度 | 一维（宽度） | 二维（x, y） |
| 约束 | 一个：`maxWidth` | 多个：间距、对齐、分布、避障 |
| 测量依赖 | Canvas API | Pretext（文字）+ 自研（形状） |
| 热路径 | 纯算术 O(n) | Dagre 布局 O(V+E) + A* 避障 O(grid) |
| 输出 | 行数+每行宽度 | 每个节点的 (x,y,w,h) + 每条边的路径 |

**结论：两阶段架构完全适用，但 layout 阶段比 Pretext 复杂。**

```
DGE 的两阶段：

Phase 1: prepare() —— 一次性测量
  - 所有文字的测量 → Pretext（直接复用 NPM）
  - 所有形状的默认尺寸 → 自研 LabelFitter
  - 构建约束图
  - 缓存所有结果

Phase 2: layout() —— 纯数学求解
  - 约束传播 → 确定每个节点的 (x, y, w, h)
  - 边路由 → A* 寻路（在预计算的网格上）
  - 都是纯数学，无 DOM 无 Canvas 无字符串操作
```

### 2.2 哪些部分已经现成可用

| 组件 | 状态 | 来源 |
|------|------|------|
| 文字测量 | ✅ 直接复用 | `@chenglou/pretext` NPM |
| 有向图布局 | ✅ 直接复用 | `@dagrejs/dagre` NPM |
| 形状锚点计算 | ❌ 自研 | 三角函数 + 几何公式，~200 行 |
| 正交走线 | ❌ 自研 | A* 迷宫走线，~300 行 |
| 约束求解 | ❌ 自研 | 简化的数值迭代，~200 行 |
| 格式导出 | ❌ 自研 | 每种格式一个转换器 |
| 碰撞检测 | ❌ 自研 | AABB 碰撞，~50 行 |

**自研部分的预估代码量：~750 行**。对比 Pretext 的 6,853 行，DGE 的核心逻辑只有其 ~11%。

### 2.3 可行性结论

**技术上完全可行。** Pretext 验证了两个核心假设：
1. 两阶段架构（prepare→layout）对几何计算有效
2. 纯数学计算可以替代视觉反馈

DGE 的独特挑战（二维约束、避障走线）都有成熟的算法（约束传播、A*），只是没有人把它们打包成 Pretext 那样干净的库。

---

## 三、语言选择：TypeScript

### 3.1 对比矩阵

| 标准 | TypeScript | Python | 胜出 |
|------|-----------|--------|------|
| **Pretext 直接复用** | `import { prepare } from '@chenglou/pretext'` | 需 subprocess 或 Pillow 替代 | **TS** |
| **Dagre 直接复用** | `import { layout } from '@dagrejs/dagre'` | `graphviz`（非 Dagre，布局行为不同） | **TS** |
| **运行时无依赖** | ✅ 零运行时 deps 模式已被 Pretext 验证 | ❌ numpy/shapely 通常是硬依赖 | **TS** |
| **Canvas 测量** | Node 18+ 原生 OffscreenCanvas | 需 Pillow（精度不同）或 subprocess | **TS** |
| **类型安全性** | 强类型，几何 IR 用 interface 严格约束 | typing 动态，IDE 提示不如 TS | **TS** |
| **热路径性能** | V8 JIT + 类型数组 Float64Array | CPython 循环慢 10-50x | **TS** |
| **格式导出** | 原生 JSON/SVG 字符串操作 | 需要 xml.etree/json 标准库 | **TS** |
| **Hermes 集成** | 现有技能 (excalidraw/architecture) 都是 TS | Hermes 核心是 Python | **平** |
| **生态成熟度** | NPM 4M+ 包，dagre/pretext 都在这里 | PyPI 类似，但关键 dep 在 NPM | **TS** |
| **CLI 可分发** | `npx @diagram-geometry/core < diagram.yaml` | `pip install` + Python 入口 | **TS** |

### 3.2 Python 什么情况下更好

**Python 不是坏选择，但在这个项目上不如 TS 匹配。** Python 擅长的场景是：
- 数据科学集成（pandas, numpy）
- ML 推理管道
- 快速原型

DGE 的核心不是上述任何一项。它的核心是：
1. 几何计算（纯数学）
2. 约束求解（算法）
3. 格式序列化（字符串操作）

这些都是 TypeScript 的优势领域。而且 Pretext 的架构哲学——**零运行时依赖、两阶段、并行数组、类型安全**——和 TypeScript 天然亲和。

### 3.3 Python 版的定位

Python 版应该作为 **Phase 3（可选）**，而且合理的设计是：

```
TS 版（主）                 Python 版（副）
  prepare() ──→ 序列化为 JSON ──→ 读取 JSON → layout()
  layout()                   （相同的 layout 算法翻译为 numpy）
```

这样 Python 版不必重新实现 Pretext 的测量逻辑（最复杂的部分），只需要用 numpy 实现几何求解器的热路径。

### 3.4 最终推荐

```
主语言：TypeScript
理由：
  1. Pretext 和 Dagre 都是 TS/NPM，直接 import，零损耗
  2. 零运行时依赖模式已被 Pretext 证明可行
  3. 类型系统对几何 IR 至关重要
  4. 热路径性能（V8 JIT > CPython）
  5. 格式导出（SVG/JSON/XML）的天然优势
  6. 跨平台（浏览器 + Node + Bun + Deno）
  7. CLI 可无痛分发（npx / npm install -g）

辅语言：Python（Phase 3 选项）
理由：
  1. Hermes 生态以 Python 为主
  2. 量化/数据科学场景需要
  3. 但必须通过 JSON 序列化绕过 Pretext 测量依赖
```

### 3.5 构建工具选型

参考 Pretext 的极简方案：

```json
{
  "devDependencies": {
    "typescript": "^5.x",
    "oxlint": "^1.x"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json"
  }
}
```

对 DGE 的建议：
- **构建**：`tsup`（esbuild 封装，输出 cjs+esm）
- **打包**：esbuild 把 dagre 和 pretext tree-shake 进去，保持单包可安装
- **测试**：vitest（与 TS 生态一致）
- **Lint**：oxlint 或 biome
- **发布**：NPM `@diagram-geometry/core`

---

## 四、总结

### Pretext 对 DGE 的启示

1. **两阶段架构是可行的** — prepare 做重活（测量+缓存），layout 做纯算术
2. **热路径必须零分配** — 不在 layout 中创建对象、字符串或做 I/O
3. **并行数组 > 对象数组** — 缓存局部性决定性能上限
4. **零运行时依赖是可实现的** — Pretext 证明即使需要 Canvas 测量，也能封装到 prepare 阶段
5. **边缘问题占 50% 代码** — 中文/阿拉伯语/emoji/连字符……DGE 如果有这些需求也要准备投入

### 语言结论

**选择 TypeScript。** 这不是偏好问题——Pretext 和 Dagre 都是 TS/NPM，选择 TS 意味着直接 import，选择 Python 意味着 subprocess 或重新实现。几何计算和格式序列化的特性也天然偏向 TS。

### 可行性结论

**可行，而且值得做。** Pretext 的空前成功（47k stars，无营销，纯靠解决真问题）验证了"确定性几何求解器"这个品类确实有需求。DGE 把同样的思路从文本扩展到图形，填补的是一个真实的空白。
