# Phase 2: Text, Labels, And Shape Geometry - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24T19:56:22+08:00
**Phase:** 2-Text, Labels, And Shape Geometry
**Areas discussed:** TextMeasurer / LabelFitter interface, Shape geometry rules, Verification and phase boundary, Container/group geometry

---

## Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| 全部讨论 | 覆盖 TextMeasurer/LabelFitter、形状几何规则、测试与边界标准，最适合进入规划。 | ✓ |
| 只定接口 | 先锁定 TextMeasurer 和 LabelFitter 的 API 形状，几何和测试细节交给后续规划。 | |
| 只定边界 | 先锁定 Phase 2 做到哪里、哪些留给 Phase 3/4，减少范围蔓延。 | |

**User's choice:** 全部讨论
**Notes:** User wanted all key gray areas resolved before planning.

---

## TextMeasurer / LabelFitter Interface

| Option | Description | Selected |
|--------|-------------|----------|
| 两段式接口 | `prepare(text, font)` 先做重活，`layout(prepared, maxWidth, lineHeight)` 做快速布局。更符合 Pretext 模式，也方便后续 layout 阶段反复试宽度。 | ✓ |
| 单次测量接口 | `measure(text, options)` 一次返回宽高和行信息。更简单，Phase 2 代码少，但后续可能需要再拆缓存层。 | |
| 两者都提供 | 底层两段式，外层给 `measureLabel()` 便捷函数。API 更完整，但 Phase 2 范围会稍大。 | |

**User's choice:** 1
**Notes:** User explicitly said text algorithms should directly use Pretext and avoid reinventing the wheel. User also requested README appreciation for Pretext and MIT license alignment.

---

## Shape Geometry Rules

| Option | Description | Selected |
|--------|-------------|----------|
| 实用近似 | 每个 shape 都有准确外接 `Box`、中心点、9 个标准 anchor；edge entry/exit 先按形状边界做确定性近似。 | ✓ |
| 严格形状边界 | ellipse、diamond、hexagon、cylinder 都按真实数学边界求交点。几何更准，但 Phase 2 会更重。 | |
| 先统一矩形盒 | 所有 shape Phase 2 先只用 box 和 anchors，真实边界留给 Phase 3/4。最快，但会削弱 GEO-03 的价值。 | |

**User's choice:** 1
**Notes:** User accepted practical approximation but required a clear later path for precise calculations.

---

## Verification And Phase Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| 数值测试 + SVG-safe 断言 | Phase 2 不生成 SVG，只用 numeric fixtures 验证 label layout、padding、min/max width、shape anchors、collision boxes 等。 | ✓ |
| Phase 2 加一个最小 SVG smoke renderer | 用临时 SVG 输出检查 label 是否溢出。更直观，但容易让 exporter 逻辑提前进入 Phase 2。 | |
| 只做纯单元测试 | 只测 `TextMeasurer`、`LabelFitter`、shape math 的数值，不定义 SVG-safe 语义。最快，但 TXT-03 验证偏弱。 | |

**User's choice:** User challenged repeated SVG generation as wasteful and asked whether there is a better way for HTML usage.
**Notes:** Decision refined to numeric tests plus a renderer-neutral HTML/SVG-safe `LabelLayout` contract. Phase 2 should not generate SVG for validation.

---

## Container / Group Geometry

| Option | Description | Selected |
|--------|-------------|----------|
| Container geometry in Phase 2 | Given known child boxes, padding, optional label/header, and min size, compute container outer box, content box, label layout, anchors, and obstacle/collision box. | ✓ |
| Container layout in Phase 3 | Automatic child placement and containment constraint solving belong to Phase 3. | ✓ |

**User's choice:** 确定
**Notes:** User asked how the most important element, container, should reflect this calculation logic. We locked the boundary: Phase 2 computes container geometry from known child boxes; Phase 3 places children and solves containment constraints.

---

## the agent's Discretion

- Exact TypeScript type names can be chosen during planning.
- Exact deterministic fallback design can be chosen during planning as long as it does not reimplement a full text engine.
- Exact numeric tolerances can be chosen during planning as long as they expose drift clearly.

## Deferred Ideas

- Precise mathematical shape boundary intersections after the practical approximation path.
- Automatic child placement and containment solving in Phase 3.
- Real SVG golden rendering checks in Phase 4.

