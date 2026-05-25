# Phase 04: Coordinated Exporters - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-25T01:36:07Z
**Phase:** 04-Coordinated Exporters
**Areas discussed:** SVG 输出基线, Excalidraw 编辑语义, 共享 fixture 与验证门禁, 样式边界

---

## SVG 输出基线

| Option | Description | Selected |
|--------|-------------|----------|
| 七形状都映射 | Export rectangle, rounded rectangle, ellipse, diamond, parallelogram, hexagon, and cylinder. | ✓ |
| 先核心形状 | Export only rectangle, rounded rectangle, ellipse, and diamond first. | |
| 极简占位 | Render every node as a rectangle placeholder. | |

**User's choice:** 七形状都映射.
**Notes:** User chose the recommended baseline.

| Option | Description | Selected |
|--------|-------------|----------|
| 按 LabelLayout 渲染 | Use existing line boxes and baselines; do not remeasure text. | ✓ |
| 简单居中 text | Place label text at node center only. | |
| 暂不输出文本 | Skip text output for now. | |

**User's choice:** 按 `LabelLayout` 渲染.
**Notes:** User chose the recommended text baseline.

| Option | Description | Selected |
|--------|-------------|----------|
| path 加 marker | Use edge points to generate path output with arrowheads. | ✓ |
| 只画 polyline | Render connector lines without arrowheads. | |
| 边先跳过 | Export nodes and groups only. | |

**User's choice:** path 加 marker.
**Notes:** User added that arrowhead landing point and overall arrow direction must be precisely calculated from vectors.

---

## Excalidraw 编辑语义

| Option | Description | Selected |
|--------|-------------|----------|
| 形状元素 + 独立 text 元素 | Preserve editable shapes and text. | ✓ |
| 只用 shape 的 text 字段/容器文字 | Fewer elements but weaker edit semantics. | |
| 先不导出文字 | Skip text export. | |

**User's choice:** 按推荐.
**Notes:** Excalidraw nodes should export as shape elements plus separate text elements.

| Option | Description | Selected |
|--------|-------------|----------|
| 做 startBinding/endBinding | Preserve arrow-to-node relationships. | ✓ |
| 只导出绝对 points | Simpler but less editable after moving nodes. | |
| Phase 4 先 points，binding 留后续 | Lower initial risk but weaker editability. | |

**User's choice:** 按推荐.
**Notes:** Binding must not replace coordinated edge points as the source of geometry.

| Option | Description | Selected |
|--------|-------------|----------|
| 导出 group 边框 + children groupIds | Preserve visual group and edit relationship. | ✓ |
| 只导出 group 边框 | Visual only. | |
| 暂不导出 groups | Skip group export. | |

**User's choice:** 按推荐.
**Notes:** User clarified that Excalidraw is only one exporter adapter, not the core model.

---

## 共享 fixture 与验证门禁

| Option | Description | Selected |
|--------|-------------|----------|
| CoordinatedDiagram JSON fixture | Use the same coordinated IR fixture for SVG and Excalidraw. | ✓ |
| NormalizedDiagram 先 solve 再导出 | Closer to full pipeline but mixes solver changes into exporter tests. | |
| 每个 exporter 自己准备 fixture | Flexible but risks format divergence. | |

**User's choice:** 按推荐.
**Notes:** Shared coordinated fixture is the source of truth.

| Option | Description | Selected |
|--------|-------------|----------|
| 字符串/JSON canonical snapshot 都要做 | SVG stable string and Excalidraw canonical JSON. | ✓ |
| 只测结构字段 | Lower maintenance, weaker regression protection. | |
| 只跑 smoke test | Fastest, but weak correctness gate. | |

**User's choice:** 按推荐.
**Notes:** Golden comparisons are required for both exporters.

| Option | Description | Selected |
|--------|-------------|----------|
| 加测试/grep 禁止 importer 使用 solver/layout/text/routing | Enforce exporters only consume coordinated IR. | ✓ |
| 只靠 code review | Advisory only. | |
| 不特别限制 | Fast but violates EXP-03. | |

**User's choice:** 按推荐.
**Notes:** Exporter geometry recomputation must fail automated gates.

---

## 样式边界

| Option | Description | Selected |
|--------|-------------|----------|
| 极简默认样式，不引入公共 style API | Prove exporter correctness first. | ✓ |
| 引入 renderer-neutral style options | More complete but expands scope. | |
| 每个 exporter 自己定样式 | Fast but format-inconsistent. | |

**User's choice:** 按推荐.
**Notes:** No public style API in Phase 4.

| Option | Description | Selected |
|--------|-------------|----------|
| 中性工程图 | White background, gray/black strokes, light node fills. | ✓ |
| Excalidraw 手绘风优先 | Prioritizes Excalidraw look. | |
| 黑白无填充 | Stable but less readable. | |

**User's choice:** 按推荐.
**Notes:** User added that neutral engineering diagram style is the default implementation.

| Option | Description | Selected |
|--------|-------------|----------|
| 只检查必要默认属性存在 | Check stroke, fill, font, marker without brittle aesthetics. | ✓ |
| 完整锁定所有样式属性 | Stronger lock, higher churn. | |
| 不测样式 | Easier but can produce unreadable output. | |

**User's choice:** 按推荐.
**Notes:** Excalidraw should be its own attachment/adapter wave; default neutral style remains shared.

## the agent's Discretion

- Exact exporter module file names.
- Exact SVG serialization helper shape.
- Exact deterministic Excalidraw element ID strategy.
- Exact coordinated fixture authoring flow.

## Deferred Ideas

- draw.io/mxGraph XML export.
- Mermaid export/import.
- ASCII/Unicode export.
- Rich public style API.
- Browser preview UI.
