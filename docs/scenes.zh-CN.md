# 3D 场景

[English](./scenes.md)

场景文档描述一个房间、里面的物体，以及物体之间的关系。auto-graph 解算出每个物体放在哪里、朝向哪边，并检查结果。全程是纯数学计算，不依赖任何 3D 软件，agent 拿到的是精确数值，可以直接交给 Blender、游戏引擎或机器人规划器。

第一阶段只覆盖室内：平面布局加上下叠放（2.5D），物体只能绕竖直轴转动。地理锚定（WGS84 → 局部 ENU）、地形和轨迹规划安排在 #120–#122 及后续 issue 中。

## 坐标系

- x 朝东、y 朝北、z 朝上，单位是米。
- 原点在房间西南角的地面，地面范围从 `[0, 0]` 到 `[width, depth]`。
- 东南西北只是房间方向的名字：`north` 就是 +y，不代表地理上的北。
- 角度用度，从上往下看逆时针为正，0 度指向东。
- 物体的 `size` 是转动前的 `[宽, 深, 高]`：宽沿物体自身的 x 轴，深沿自身的 y 轴。
- `front` 是转动前正面的朝向，默认 `-y`，即朝南，对着站在房间南侧、面朝北看的人。
- “左”“右”按站在参照物正面、看着它时的左右来算。默认朝向下，左是西（-x），右是东（+x）。

## 文档结构

```yaml
scene: study                 # 名称
units: m                     # m（默认）、cm 或 mm；下面所有长度都用这个单位
bounds: { width: 4, depth: 5, height: 2.8 }   # height 可省略（省略则不检查天花板）
minGap: 0.05                 # 同一平面上物体之间的最小间距（默认 0）
objects:
  desk:  { size: [1.4, 0.7, 0.75] }
  chair: { size: [0.5, 0.5, 0.9], front: -y, label: Chair, asset: office_chair }
  seat:  { size: [0.45, 0.45, 0.9], count: 4 }     # 展开为 seat1 … seat4，也可以整组写作 "seat"
  plant: { size: [0.4, 0.4, 1.1], position: [0.35, 0.35], yaw: 30 }   # 手动钉住
relations:
  - desk against wall north
  - chair in-front-of desk, facing desk, gap 0.1
```

物体字段：

| 字段 | 说明 |
| --- | --- |
| `size` | `[宽, 深, 高]`，必须为正数 |
| `front` | `-y`（默认）、`+y`、`-x`、`+x` |
| `count` | 展开为 `id1 … idN`；id 以数字结尾时展开为 `id-1 …` |
| `position` | 钉住底面中心 `[x, y]`（不能与 `count` 同用） |
| `yaw` | 钉住转角（度） |
| `label` | 俯视图和 Blender 里显示的名字 |
| `asset` | 用 Blender 中的同名集合代替方块 |

关系里的长度默认使用文档的单位，也可以带后缀：`gap 10cm`、`radius 0.9m`。

## 关系

每条关系占一行：主语、动词，后面用逗号接修饰子句。主语可以是一个物体、一个 `count` 组，或用 `and` 连接的多个物体。只接受单个主语的关系写成一个组时，会对组里每个成员分别生效。

| 关系 | 含义 | 修饰 |
| --- | --- | --- |
| `a in-front-of b` / `behind` / `left-of` / `right-of` | `a` 放在 `b` 的那一侧（就近对齐到世界坐标轴），在垂直方向上与 `b` 居中对齐 | `gap`（两侧之间的距离，默认 `minGap`）或 `distance`（中心距） |
| `a against wall north`（也可写 `against north wall`，或 `n`/`s`/`e`/`w`） | `a` 的一侧贴墙；没有其他指定时背对这面墙 | `gap` |
| `a corner ne`（`nw`、`se`、`sw`） | 放在墙角，同时贴着两面墙 | `gap` |
| `a center-of room` / `a center-of b` | 放在房间中央，或 `b` 的底面中心 | |
| `a on b` | 放在 `b` 上（z 为 `b` 的顶面），并随 `b` 一起转动 | `at center`、`front`、`back`、`left`、`right`、`front-left` …（`right-back` 这种写法也可以） |
| `a facing b` / `facing north` | 转向 `b` 离自己最近的点，或某个方向 | |
| `a rotate 30` | 转一个角度（也可写 `30deg`） | |
| `a and b align x with c` | 中心 x 与 `c` 相同（`y` 同理） | |
| `g distribute evenly along x` / `along wall south` | 成排等距排列；沿墙时同时贴墙 | `gap`（固定间距，整排居中） |
| `g grid 2x3` | 行 × 列，北边为第一行，从西到东 | `gap` |
| `g around c, radius 0.9` | 绕 `c` 均匀排成一圈（极坐标），各自朝向 `c` | `start`（起始角度，默认 270，即南）；写 `facing` / `rotate` 时不再自动朝向 `c` |
| `a and b symmetric about room` / `about c` | 关于房间或 `c` 的中线镜像对称 | `axis x` / `axis y`（默认取两者分开的那个轴） |
| `keep clear 0.8 between a and b` | 两者至少相距这么远（通道） | |

`facing` 和 `rotate` 也可以跟在其他动词后面，例如 `chair in-front-of desk, facing desk`。

## 求解过程

1. **叠放**：`on` 关系构成一片森林。被支撑的物体放在支撑物顶面，按 `at` 在支撑物自身坐标系里取落点；其余物体放在地面上。
2. **朝向**：按以下优先级决定：
   - 钉住的 `yaw`、`rotate` 或 `facing`（给出的角度互相冲突时报错）；
   - 否则 `around` 朝向圆心；
   - 否则靠墙的物体背对墙；
   - 否则被支撑的物体随支撑物转动，两者正面一致。
3. **平面布局**：x、y 两个轴各解一个带分离约束的二次规划，用的是 auto-graph 的 VPSC 求解器，四面墙也作为变量参与。
   - 大部分关系转成某个轴上的等式。
   - "在某物旁边"类关系额外把两者中心轻轻拉齐。
   - 所有物体都约束在房间内。
   - 重叠（间距小于 `minGap` 或 `keep clear` 的距离）按 VPSC 去除节点重叠的方式处理：分离约束加在重叠较小的那个轴上，但不会加在两者相对位置已被锁死的轴上；加完仍然重叠的，换到另一个轴再试一次。
   - 没有任何约束的物体，初始时按网格铺在房间里。
4. **多轮迭代**：朝向某物体需要知道双方的位置，支撑面上的落点又取决于朝向，所以平面布局和叠放分多轮求解，直到朝向不再变化。
5. **检查**：
   - 穿插：对转动后的底面轮廓和高度区间做分离轴检测；
   - 是否越过墙壁或天花板；
   - 被支撑物体的中心是否落在支撑面外；
   - 关系是否成立；
   - `keep clear` 距离；
   - 是否出现非有限数值。

   伸出边缘和小于 `minGap` 只给警告。

同样的输入，逐字节相同的输出。

## 路径

路径是智能体必须能走通的路线，例如人从门口走到书桌、扫地机器人回到充电座。它在场景里对应图表中的连线，用的也是同一套路由方法（#128）。

```yaml
openings:
  door: { wall: south, at: 0.6, width: 0.9 }   # 门中心距墙的西端（或南端）0.6 m
agents:
  robot: { radius: 0.18, height: 0.1 }          # 内置 person（半径 0.25，高 1.8）
paths:
  - person from door to desk
  - person from door to shelf, clearance 0.05
  - robot from door to shelf, orthogonal
  - person from chair to door, via lamp and table
```

- **构型空间**：把智能体缩成一个点，挡路的物体都按“智能体半径 + `clearance`”外扩，墙也同样往里收。物体底部低于智能体高度才算挡路，所以矮机器人能从架在立柱上的桌面下方钻过去。
- **起点和终点**：走到物体时，站在它正面；正面被占了，就改去左侧、右侧或背面。某一侧中间离墙太近时，站位会沿着这一侧滑动。走到门洞时，站在门内侧。
- **路由**：
  - 默认求任意角度的最短路：在外扩后的轮廓角点上建可见图，用 A* 搜索。
  - 写了 `orthogonal` 时，改用 auto-graph 给图表连线布线的稀疏网格路由器，只走直角。
- **检查**：每条路径都单独对照物体真实的旋转轮廓和墙壁检查一遍。输出里的 `clearance` 是智能体边缘到最近物体的距离。
- **走不通时**：逐步缩小智能体，直到能走通为止。能通过的最宽智能体有多宽，路上最窄的地方就有多宽，于是报出这个瓶颈，例如：`"person" cannot get from "door" to "desk": the way between "cabinet" and the west wall is 0.4 m wide; it needs 0.5 m (0.1 m short).`。门洞比智能体窄时，单独报告。

规划好的路径写进 `dge-scene` JSON 的 `paths`（折点、长度、宽度、净空），在俯视图里画成和智能体一样宽的色带；门洞在两处也都会出现。路径在过道中居中、平行路径分道、瓶颈反馈给布局、时间参数化和 Blender 导出，后续在 #128 中完成。

## 输出

`renderSceneDsl(source, { format })`，或 `agh --input room.yaml --format …`：

- **`scene-json`**（默认）：`dge-scene` v1 文档，格式见 [`schema/dge-scene.v1.schema.json`](../schema/dge-scene.v1.schema.json)，数值保留 4 位小数。每个物体给出：
  - `position`：底面中心和底面高度 `[x, y, z]`；
  - `yaw`，以及同一个转角的四元数 `quaternion` `[x, y, z, w]`；
  - `size` 和 `front`；
  - `supportedBy`；
  - 世界坐标包围盒 `aabb`。

  文档还包含 `valid` 和诊断信息。
- **`blender`**：嵌入了场景数据的 Blender（bpy）Python 脚本。
  - 每个方块的原点在底面中心，所以它在 Blender 里的位置就等于 `position`，绕 z 轴的旋转就是 `yaw`。
  - 顶面画一个三角标出正面。
  - `asset` 对应文件里已有的同名集合时，放置该集合的实例。
  - 所有东西放进一个以场景命名的集合，重复运行脚本会重建。
  - 无界面渲染（Cycles 用 CPU，不需要显卡）：`blender -b --python room.py -- --render room.jpg [--size 1200x900] [--samples 24]`。
- **`svg`**：用于肉眼核对的俯视图：
  - 上为北，0.5 m 网格；
  - 每个物体的正面画一个三角；
  - 叠放的物体按层级着色；
  - 出错的物体用红框标出，诊断信息列在图下。

场景无效（`valid: false`）时，CLI 照样输出结果，退出码为 1，方便直接看到问题；文档本身写法不合法时什么都不输出。`--page` 这类只用于图表的参数会被拒绝。

## 诊断

| 代码 | 含义 |
| --- | --- |
| `validate.scene.*` | 文档本身的问题：未知物体或动词（附“是否想写 …”提示）、动词不接受的修饰、数值不合法、保留字、需要单个物体的地方用了组 |
| `scene.layout.conflict` | 关系（或钉住的位置）之间无法同时成立，并指出涉及哪些物体 |
| `scene.collision` | 两个物体互相穿插（附穿插深度） |
| `scene.out-of-bounds`、`scene.above-ceiling` | 越过墙壁或天花板（附超出多少） |
| `scene.support.unstable` / `scene.support.overhang` | 中心落在支撑面外（会掉下去）/ 伸出支撑面边缘 |
| `scene.keep-clear`、`scene.min-gap` | 小于通道宽度 / `minGap` |
| `scene.yaw.conflict` | 同一物体被指定了两个不同的转角 |
| `scene.support.multiple`、`scene.support.cycle` | 一个物体放在两个物体上，或几个物体互相叠放成环 |
| `scene.relation.off-floor` | 平面关系涉及放在其他物体上的物体（该关系不生效） |

## 在 Blender 中核对

`test/support/blender_check.py` 在 Blender 里运行生成的脚本，把每个物体的世界坐标包围盒（由网格顶点算出）和转角与 JSON 比对，精度 1e-4：

```bash
pip install bpy        # 需要 Python 3.11 环境
DGE_BLENDER_PYTHON=$(which python) npx vitest run test/scene-export.test.ts
DGE_BLENDER_PYTHON=$(which python) npm run docs:scene-renders   # 生成 README 里的渲染图
```

## 第一阶段的限制

- 物体只能绕竖直轴转动。底面轮廓是带方向的矩形，高度是一个区间。
- 平面关系只在地面上的物体之间生效；放在其他物体上的物体用 `at` 定位。
- “在某物旁边”类关系会把参照物的那一侧就近对齐到世界坐标轴。转了角度的物体，分离和贴墙都按它的外包矩形算（偏保守）；穿插检测仍用真实的旋转轮廓。
- 求解器只保证关系成立，不保证布局舒适。重要的要求需要写明，例如用 `keep clear` 留出拉椅子的空间。
