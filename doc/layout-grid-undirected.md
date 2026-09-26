# 布局设计说明：网格无向图（grid-undirected）

> 注册名 `'grid-undirected'`，实现于 `src/layout/grid-undirected/`。
> 是 `doc/布局核心原则.md`「纯网格布局算法流程（Pure-Grid Layout Pipeline）」
> 的第一期实现：**质点拓扑粗布局 → 节点与文字轴向膨胀（物化为格 AABB）→
> 通道约束压实 → 网格 A\* 避障走线**，全程整数格运算，不经力场弛豫。
> 空间运算原语来自泛型化接缝 `src/layout/space/`（`SpaceContext`）。

## 1. 设计动机与定位

力导向流水线（force-undirected）把网格粗布局当作力场弛豫的初值产生器，
精细调整全部交给力学引擎。grid-undirected 走相反的主从关系：**网格是主
引擎**——节点位置在离散阶段一次成型，连线不占空间、只在自由通道格中
寻路走线，节点位置一旦物化不再被走线反向推开。

| 维度 | force-undirected | grid-undirected |
|---|---|---|
| 空间 | 质点网格 → 连续浮点（主体） | 整数格（全程） |
| 节点尺寸模型 | 包围圆 `r` | 格 AABB（`w × h` 格，物化为 `NodeView.w/h`） |
| 求解 | 数千步能量单调弛豫 | 构造期一次完成（`run()` 即返回收敛） |
| 边的输出 | 两端中心（直线语义） | 中心 + A\* 正交走线拐点（`InternalEdge.waypoints`） |
| 成行成列 | 压实变距映射后不保证 | 通道压实后严格保证 |
| 确定性 | seed 路径确定 | 全程固定规则，无随机源 |

两算法共享阶段 1：`force-undirected/coarse.ts` 的 `coarseGridPlacement`
（纯质点网格放置，见 [layout-force-undirected.md](./layout-force-undirected.md)
§2）。它只放置、不压实、不写回坐标——力导向流水线继续走自己的压实映射，
grid 流水线消费放置产物进入膨胀。

## 2. 阶段 1：质点拓扑粗布局（复用）

`coarseGridPlacement(elements, adj, naturalLength)` 返回
`{ grid, posOf, cell, order }`：每格一节点的 `PointGrid`、每元素的格坐标、
格距（= `naturalLength` 格数 × `cellScale` 比例尺）、放置顺序。
度数优先连通生长 + 环形扩搜评分（曼哈顿张力 − 环周长奖励 + 环内方位
分类）+ 死锁插行列，**100% 不死锁**、全固定规则。连线不占位——只有
文字例外（第一期尚未实现虚拟文本节点，见 §7）。

方位分类是 grid-undirected 对共享放置美学的唯一增量（`directionClass:
true`，力导向管线默认关）：边的走向优先落在邻居的十字（水平/垂直）
方位，45° 对角次之，杂角再次——能量 0 / 0.25 / 0.5，压在张力每格 1
之下，只在张力同分的候选之间做环内平局裁决；距离维全权由张力承担。

## 3. 阶段 2：节点与文字轴向膨胀（expansion.ts）

质点是 1×1 的，真实尺寸通过**格化 + 逐个扩张**物化。

### 3.1 格化

每元素的物理 AABB 尺寸 = 形状声明 ⊕ 文字盒取较大者
（`GraphStore.nodeBoxSize`：circle 2r / ellipse 2rx×2ry / rect w×h，
label 用 `estimateLabelBox` 的回绕盒），再向上取整为逻辑格宽高：

```text
gw = max(1, ceil(nodeBoxWidth  / cell))    gh = max(1, ceil(nodeBoxHeight / cell))
```

格化是保守的（向上取整 + `1e-9` 容差），物化 AABB 保证 ≥ 文字盒。

### 3.2 ExpansionGrid：AABB 占用网格

`PointGrid` 是"每格一元素"，膨胀需要"每元素占 w×h 格"。`ExpansionGrid`
维护两张表：`anchorOf`（元素 → AABB 左上格）与 `covered`（覆盖格 → 元素）。

`expand(i, gw, gh)`：释放 i 自身的质点覆盖格 → **中心对称插列/插行**
（奇数尺寸向两侧各扩 (gw−1)/2 格，质点格恰为 AABB 几何中心；偶数尺寸
格上无精确中心，固定向左/上多配一格配平半格；`shiftLine`：at 处开辟
新行/列，该侧全部占用格与锚点整体平移一格让位）→ 锚点改写为 AABB
左上格 → 标记 i 的完整覆盖区。质点格在全过程中不动，且
`anchor + floor(size/2)` 恒等于质点格（§6 的 A\* 中心格口径不变），
与质点布局的"邻居贴邻"语义兼容：扩张推走的正是 i 四周的邻居。

膨胀按 `order`（放置序）执行——后放置的节点在外缘，让位平移量小。

## 4. 阶段 3：通道约束压实（Channel Safety Margin）

膨胀后网格中留有大片空行/空列（插行列的让位副作用）。压实把布局
**归一化为均匀走线走廊**：

```text
相邻占用行（列）之间的空隙 = 恰好 channelMargin 格（LayoutOptions.channelMargin，默认 1）
  · 贴邻（空隙 0）→ 扩张出走线走廊（设计原则第 7 步「紧密相邻节点之间
    插入空行空列」）
  · 大片空白 → 压缩回收（合并空行/空列，直到再并就小于 margin 为止）
```

实现是**单轴保序重映射**：收集占用坐标排序后，`new[k+1] = new[k] + 1 +
margin`。AABB 内部格全为占用列（间隔 0），重映射不影响其连续性；不同
AABB 的间隔 ≥ 1 格，无重叠由构造保证。压实后全局严格成行成列。

## 5. 物理化写回

AABB 中心映射为连续坐标（格 × cell），整体平移使质心位于原点：

```text
center.x = (gx + gw/2) × cell + ox        el.w = gw × cell    el.h = gh × cell
```

写回 `elements[i].x/y/w/h`——`w/h` 是新增的可选输出（`NodeView.w/h`），
渲染方按「中心 + 半宽高」得到包围盒；连续布局不产生这两个字段（用 `r`
包围圆）。`coordinateSystem` 修正不适用：网格解本身就是格点。

## 6. 阶段 4：网格 A\* 避障走线（泛型化层消费）

走线委托给 `GridSpaceContext.routeEdge(source, target, obstacles)`
（`src/layout/space/grid-route.ts` 的 A\*）：4 邻域正交寻路、状态 =
(格, 进入方向)、代价 = 步数 + `turnCost` × 转向（曼哈顿启发可采纳），
搜索界从「端点 + 障碍包围盒外扩 margin」起步逐轮加倍，**无可行路径返回
null**（不静默降级）。路径经三格窗口压缩为拐点序列。

策略侧的约定：

- **端点** = 两端 AABB 的中心格（`anchor + floor(size/2)`）；
- **障碍** = 其余全部节点的格 AABB（两端自身豁免，否则多格 AABB 会挡住
  自己的出口）；走线**不修改节点位置**——连线不占空间，只在自由通道格
  流转；
- **输出**：`InternalEdge.waypoints` = 首尾（两端节点中心的精确物理坐标）
  + 中间拐点（格中心 `(g + 0.5) × cell + offset`）。无可行正交路径（贴邻
  节点顶死出口）时降级为两端直线两点。

端点锚定的精化（边框交点、同侧多边等距分布）与平行线的通道内偏移
是走线层的后续工作。

## 7. 泛型化空间上下文（src/layout/space/）

空间运算不写死在算法里，而是收敛为 `SpaceContext<T>` 五原语：

| 原语 | GridSpaceContext | ContinuousSpaceContext |
|---|---|---|
| `distance` | 曼哈顿 \|dx\|+\|dy\| | 欧氏 √(dx²+dy²) |
| `isOverlapped` | 半开区间格 AABB | 连续 AABB（相切不算重叠） |
| `getNeighbors` | 4 邻域 | 8 方向 × step |
| `expandSpaceIfNeeded` | 插行列让位（返回是否扩容） | 恒 false（空间无限） |
| `routeEdge` | A\* 正交寻路（null 显式失败） | 直线降级 |

`Box<T>`（位置 + 尺寸）是障碍物/节点 AABB 的统一形态。连续模式的应用
场景（网格解为初始解 + 5~10 步短弛豫）与完整连续避障走线属后续工作。

## 8. 第一期边界

- **连线文字不占格**：设计中连线文字作为 1×1 虚拟质点参与拓扑粗布局
  （Source—Label—Target 链式挂载），第二期实现；当前边文字不参与网格布局；
- **subgraph 容器**按声明形状参与网格（成员包裹尺寸未接入）；
- **无连续模式短弛豫**：网格解直接输出，不经过力场；
- **平行走线**：同一通道内的多条平行线尚无等距分布（可能重合）；
- `placed`/`fixed` 元素参与占格反算，但网格解一律写回（与力导向的
  「placed 不移动」语义不同）。

## 9. 测试（tests/grid-undirected.test.ts）

注册与 `run()` 即收敛（零迭代）；格点成行成列（中心差 = 格宽整数倍）；
全对 AABB 无重叠（含文字节点）；文字物化（AABB ≥ 文字盒、格化向上取整）；
通道空隙恰 = `channelMargin`（0/1/3 三档对照）；膨胀推挤（大文字节点
扩张推走邻居且不重叠）；**中心对称膨胀**（奇数尺寸质点 = AABB 精确
中心、偶数尺寸固定左/上配平半格、质点格恒为中心格、竖直相邻边横向
膨胀后仍竖直、四周推挤无重叠）；走线正交 + 首尾为端点中心 + 中段不穿
第三方 AABB；确定性（同图同参逐位一致，含 waypoints）；rebuild 重放。

空间原语层的独立验收见 `tests/space-context.test.ts`（度量、碰撞口径、
邻域、扩容腾空、A\* 绕障/拐点惩罚/封死 null/端点豁免、两上下文接口一致性）。
