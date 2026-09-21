# fishgraph

核力式力导向图布局算法。零运行时依赖，TypeScript，vitest 测试。

图由**节点**（圆/椭圆/矩形，可带文字）与**连线**（可带文字）构成。布局不是"弹簧-电荷"
的经验堆叠，而是一个**保守力场**：所有力都从同一个能量泛函求梯度得到（力 = −∇E），
求解器沿能量下降方向弛豫，能量单调不增，必然收敛。

## 安装与运行

```bash
npm install
npm test          # vitest 全量测试（~2 分钟）
npm run typecheck
npm run demo      # 交互式 demo（vite，http://localhost:5173）
```

## 排列原则（用户定义 + 代码实现对照）

| # | 原则 | 实现 |
|---|---|---|
| 1 | 出入线段多（度数高）的节点先排 | BFS 生成树度数优先 + **树中心**作分量根（剥叶法），扇形平面展开 |
| 2 | 连线是橡皮筋：越长拉力越大 | 弹力 F = τ·(k_a/L³)·g（线性！），τ=1 时平衡间隙恰为 naturalLength |
| 3 | 近程斥力飞速增加、严格杜绝重叠、超过距离无斥力 | 截断势 E = ½k_r(1/g−1/R)²，g≥2L 归零；gFloor 以下接触弹簧硬化 |
| 4 | 边文字越大，连线最短长度越长 | 文字包围盒软墙把两端撑到恰好容纳（最小面积回绕） |
| 5 | 连线和文字不能被节点覆盖 | 边-节点/标签线性软墙（强斥力、有限作用域，两端反向让路） |
| 6 | 跳数>3 无远程斥力，<3 随跳数下降 | σ(1)=1，σ(2,3)=decay^(h−1)，h>3 与无关系对乘 0.35 下限 |
| 7 | 覆盖面积趋向最小 | 截断斥力 + 跳数衰减 + 弱引力/调和约束共同收紧 |
| 8 | 交叉点越多能量越高 | 交叉能量罚 + 交叉收缩（μ_e 放大弹力劲度）+ **线间避让斥力**（采样点软墙，交叉在力学上直接被挤开） |
| 9 | 环状结构节点平均分布、环面积趋小 | 均匀键合的对称平衡是能量极小（S2 测试验证正多边形） |

**补充原则（代码中同样成立）：**

- **10. 防穿越硬规则**：0.8L 内的贴身斥力永不随跳数衰减 —— 远端节点可以不互相推挤，但不能互相穿越（否则树形布局会产生交叉）。
- **11. 初值即好图**：无向流水线用质点网格粗布局给出拓扑正确的初值（邻居相邻、无重叠、环紧凑）；有向流水线再叠加层级行与层内 barycenter 排序 —— 有向树初值即零交叉。
- **12. 线的两端会让路**：节点压线时，反作用力按投影重心分摊给线段两端。
- **13. 文字按最小面积回绕**：拉丁词不拆、CJK 逐字断，枚举行数取包围盒面积最小。
- **14. 无摩擦、单调、必达平衡**：所有力 = −∇E（分段保守），信任域 + 回溯线搜索保证能量单调不增，力≈0 即停。
- **15. 线与线互相让路**：两条连线靠近时（中心距 < 0.35L）互相排斥，力按最近采样点/垂足的线性插值分摊给各自的两个端点 —— 线与线在力学上是实体，交叉被主动挤开。
- **16. 平面性守恒**：平面初值 + 能量单调下降 + 交叉能量罚 → 树/森林全程无交叉（树 21 验收测试）。有环图（如 mermaid 样例）因回环边的拓扑缠绕，交叉消解仍是进行中的工作。

## 物理模型

记节点 i、j 的**表面间隙** `g = |pᵢ − pⱼ| − rᵢ − rⱼ`（中心距减两个包围半径），
`m = mᵢ·mⱼ` 为质量积，L = `naturalLength`，R = 2L 为斥力作用域。

### 1. 节点间斥力 —— 核力式，有限作用域

```
g ≥ R（R = 2L）:  E = 0,  F = 0
gFloor ≤ g < R:   远程墙 E = ½·k_r·m·σ·(1/g − 1/R)²   F = k_r·m·σ·(1/g − 1/R)/g²
                  近程墙 E = ½·k_near·m·(1/g − 1/g_near)²（g_near = 0.8L，永不衰减）
g < gFloor:       接触弹簧线性延拓（穿透越深推力越大，永不衰减）
```

- **近距陡增**：g → 0 主项回归 `k_r/g³`；σ 为跳数衰减系数（原则 6）；
- **脱接触即归零**：作用域边界处能量与力同时光滑归零（C¹，保守场不破）；
- `k_r = 2L·k_a`：无弹力干扰时平衡校准锚点。

### 2. 连线弹力 —— 橡皮筋收缩力（仅相邻节点对）

```
F_b = τ·(k_a/L³)·μ_e·m·g        E_b = ½·τ·(k_a/L³)·μ_e·m·g²
```

- **连线越长拉力越大**（线性，正牌橡皮筋），g→0 拉力消失（压缩交给斥力）；
- τ = `edgeTension`（刚度倍率）：**τ=1 时平衡间隙恰为 naturalLength**；
- μ_e = 1 + λ·X_e 为交叉收缩乘子（原则 8）：交叉越多的线收缩力量越大；
- 节点内部的那截线不贡献弹力（所有量以表面间隙 g 计）。

### 3. 交叉规则 —— 交叉越多，收缩越大、能量越高

交叉计数 X_e（扫描线 + 严格相交，带预算）每次力场求值重算：

- **收缩力**：弹力劲度 ×μ_e（上式）；
- **能量罚**：总能量 + `crossingEnergy·(k_a/L)·ΣX` —— 分段常数势垒，
  含交叉的布局能量天然更高，线搜索在拓扑取舍上回避交叉。

力与能量用同一组计数（分段保守），能量单调下降不受影响。

### 4. 跳数斥力衰减

```
σ(i,j) = 1                       h ≤ 1（邻接）
σ(i,j) = decay^(h−1)             h = 2, 3（decay = hopRepulsionDecay 默认 0.7）
σ(i,j) = unrelatedRepulsion      h > 3 或不同分量（默认 0.35，基本没有远程斥力）
```

只衰减远程墙；近程墙（0.8L 内）与接触弹簧永不衰减 —— 远端节点互不推挤，
但谁也不能互相穿越或重叠。节点数 > 3000 自动停用。

### 5. 弱基础引力 —— 非相邻节点对

- `pairwise`：F_w = k_w·m/g²（k_w ≪ k_a），陌生人平衡距饱和于斥力作用域；
- `centroid`（默认）：全对调和约束（等价朝质心简谐束缚），合力/合力矩恒零。

### 6. 边-节点避让与边文字软墙

- 节点压线：F = k_en·(ρ−h)/ρ（ρ = 0.15L 作用域），反作用按投影重心分摊两端；
- 边文字：包围盒软墙把两端撑到恰好容纳文字；长文字按最小面积回绕。

### 6.5 线间避让斥力 —— 线与线互相让路

两条连线中心线靠近（最近采样距 < 0.35L）时互相排斥。每条边按 0.35L 间距
离散成固定参数的采样点（≤6 个），采样点对对方线段做点-线软墙：

```
E = ½·k_ee·(d_ee − h)²/d_ee    F = k_ee·(d_ee − h)/d_ee    k_ee = 30·k_a/L²
```

采样点是端点的线性插值 → ∂P/∂a = 1−t、∂P/∂b = t，力按插值权重分摊回
两端（反作用按垂足重心分给对方两端）—— **力 = −∇E 严格成立**（机器精度
验证）。这是原则 8 的力学支撑：交叉不仅费能量，还费力 —— 交叉会直接被挤开。

## 分组：subgraph / hidden-group

分组的数据层（subgraph 容器物化、`detectHiddenGroups` 隐藏组推断）是底座
能力，始终可用；分组**力学消费者**原由派生算法 `force-group` 提供，现已随
旧一代纯力导向算法一并移除，**待按新的基础算法派生接缝重写**。当前所有内置
算法都不消费分组力学语义（`subgraphs` 容器按普通大节点参与布局，
`hiddenGroups` 声明被忽略，有纯度用例锁定）。分组相关测试以 skip 保留，
重写后恢复。下述力学行为（组内精修、包含墙、张力传导）是重写时的设计蓝本：

图可以声明两类分组（`GraphSpec.subgraphs` / `GraphSpec.hiddenGroups`）：

```ts
const graph = {
  nodes: [{ id: 'in1' }, { id: 'in2' }, { id: 'out1' }],
  edges: [
    { source: 'in1', target: 'in2' },
    { source: 'sub', target: 'out1' },   // 外部边直接连 subgraph 的 id
  ],
  subgraphs: [
    // 有固定边界（shape 必填）→ 物化成容器大节点：
    // 外部看是一个大节点，成员约束在其内部区域内
    { id: 'sub', shape: { kind: 'rect', w: 400, h: 300 }, members: ['in1', 'in2'] },
  ],
  hiddenGroups: [
    // 无边界 → 无实体，仅"成员聚集在一起"的束缚
    { id: 'h1', members: ['in1', 'x1', 'x2'] },
  ],
};
```

- **hidden-group**（`HiddenGroupSpec`）：布局期物化为 `ClusterConstraint`，对成员
  施加"到组质心的简谐束缚"（强度 `attractionStrength`，缺省用全局 `groupCohesion`，
  按成员数归一，保守、总合力零），组内节点倾向于聚集；不参与碰撞，形状 = 成员包围盒。
- **subgraph**（`SubgraphSpec`）：物化为 `LayoutSubgraphNode` 容器节点（Compound
  Node），是真正的物理实体，与普通节点一起参与全局力场（质量随成员数增长，外部
  连线连到容器 id），每轮迭代末按成员几何 + `padding` 重算包围半径；成员被包含墙
  约束在容器内部区域内（成员出界被向心拉回；容器与成员之间无斥力——成员在容器内
  不算穿透）。
  **渲染约定**：容器在 `layout.subgraphViews` 中（不再是 `nodeViews` 的一部分），
  绘制时应**作为背景层最先画**（成员与其它节点画在其上），否则容器矩形会盖住内部节点。
- **入口 / 出口 / 内部节点**：与组外有连线的成员是边界节点（`外→成员` 为
  入口、`成员→外` 为出口），纯内连的是内部节点。查询：`store.groupRoles(groupId)`。
- **布局流程**：整体弛豫（组束缚全程生效）→ 收敛后**组内精修**（冻结组外
  节点与 subgraph 容器，仅组内成员弛豫）→ 若 hidden-group 的包围盒变化
  超过 15%，引发一轮重新整体布局（比例与阈值可调，算法待议条款）。
- **边的端点语义**（由两端角色自然决定，EdgeSpec 零改动）：

| 连接方式 | 力学语义 |
|---|---|
| 外部 ↔ 容器（组 id） | 容器整体连接：外部被推离容器边缘，容器被边拉向外部 |
| 外部 ↔ 成员（直连） | 成员被单独拉向外部侧（组内布局局部重组），张力按有界比例传导给容器（容器朝连接方向响应，封顶防发散） |
| 成员 ↔ 成员 | 容器内连接，正常键合 |

  张力传导当前为实验开关（`tensionConduction`，默认关）——简单传导与
  容器间力平衡后仍可能振荡，需要专项的引力+阻尼设计。

**自动推断隐藏组**（无需声明，`detectHiddenGroups(graph)`）：

1. 度 ≤ 2 的相邻节点组成链状隐藏组；
2. 环上的所有节点组成隐藏组（边双连通分量中含环的块）；
3. 隐藏组与节点只有一条连线 → 该节点并入；
4. 两个对外只有一条连线的隐藏组合并，对外连线少的被吞并；对外多连线（>3）的组不合并；
5. 星形中心等多连线节点不入组。

## 坐标系（可替换）

求解过程始终在自由坐标上进行；**布局完成后**，以最优布局为基础做一次
坐标修正（策略对象 `CoordinateSystem.refine`，按注册名选择，核心代码
零类型分支）：

```ts
const layout = new ForceLayout(graph, {
  coordinateSystem: 'grid',  // 'free'（默认，恒等）| 'grid'（网格化）
  gridSize: 60,              // 网格间距，默认 = naturalLength
});
```

- `'grid'`：就近吸附到格点；目标格被占或与已放节点距离过近时，
  BFS 环形扩搜最近可用格点 —— **吸附后保证任意两节点不重叠**；
  fixed 节点也吸附（优先注册占用）；subgraph 成员的格点被钳制在
  其容器内部区域内（包含语义保持）。
- 自定义坐标系（hex/polar 等）用 `registerCoordinateSystem(name, impl)`
  注册即可介入（接口：`refine(nodes, { lattice })`），核心零改动。

## 求解器

无摩擦、不"卡住"：位置直接沿力方向弛豫（信任域步长 + 回溯线搜索），
能量单调不增。收敛判据是力残差 `max|F|/forceUnit < ε` 连续若干步。

**分阶段弛豫**（对应人工排图的直觉）：

| 阶段 | 启用的力 | 预算 |
|---|---|---|
| 0 | 节点斥力 + 弱引力（先把节点摆开） | 35% |
| 1 | 加入连线引力与张力（收缩成骨架） | 30% |
| 2 | 加入边-节点避让、边文字软墙 | 20% |
| 3 | 节点文字生效（节点变大）微调 | 15% |

**性能**：节点-节点力用 Barnes-Hut 四叉树（双树遍历 + 保守聚合，
力/能量仍是同一泛函的精确梯度）O(n log n)；避让对用均匀空间网格。
2000 节点压力测试在秒级完成。`accuracy: 'exact'` 为 O(n²) 参考实现，
两者结果一致性有测试保证。

## 力导向无向图（force-undirected，默认算法）

`algorithm: 'force-undirected'`——按 `doc/布局核心原则.md` 无向图流水线组织的
**默认与基础算法**：**质点网格粗布局 → 膨胀压实 → 短弛豫微调**。

```ts
const layout = new ForceLayout(graph, { algorithm: 'force-undirected' });
```

- **质点粗布局**：所有节点先视为 1×1 质点布置在整数格上，按「度数优先的
  连通生长」逐个放置——每个节点贴着已放置邻居评分择优（张力项 + 环周长
  奖励），邻居总是相邻，环/树结构在离散阶段就消灭长边穿透；候选点被完全
  占满时整体插一行/列挤出新空间，放置 100% 不死锁。
- **膨胀压实**：删除全部空行空列，按真实包围半径拉伸相邻行列间距——
  **无重叠由构造保证**，不依赖弛豫兜底。
- **短弛豫微调**：粗布局坐标作为初值，使用共享力学引擎（位于本算法目录）
  与收敛判据自适应收尾（实测几十至两千余步）。
- 不消费分组语义（subgraph 容器按普通大节点参与布局，hiddenGroups 被忽略）；
  分组支持等 force-group 重写后再议。设计细节见
  [doc/layout-force-undirected.md](doc/layout-force-undirected.md)。

## 网格无向图（grid-undirected，grid-first 流水线）

`algorithm: 'grid-undirected'`——按 `doc/布局核心原则.md`「纯网格布局算法
流程」组织的**纯网格策略**：**质点拓扑粗布局 → 节点与文字轴向膨胀物化为
格 AABB → 通道约束压实 → 网格 A\* 避障走线**，全程整数格运算、确定性重放，
不经力场弛豫。

```ts
const layout = new ForceLayout(graph, { algorithm: 'grid-undirected' });
layout.run();
// nodeViews 附带 w/h（物化 AABB 物理尺寸）
// edgeViews 附带 waypoints（A* 正交走线拐点，物理坐标）
```

- **膨胀**：节点按形状 + 文字盒换算逻辑格宽高，锚点不动向右/下扩张，
  扩张所需行列由插行/插列让位（邻居整体平移）；
- **通道约束压实**（`channelMargin`，默认 1 格）：相邻占用行/列之间的
  空隙统一调整为恰好 margin 格——贴邻的扩张出走线走廊，大片空白压缩回收，
  全局成行成列、走线走廊均匀；
- **A\* 走线**：连线不占空间，只在自由通道格中流转（拐点惩罚偏好少弯折），
  节点位置一旦物化不再被走线反向推开；无可行正交路径时降级直线；
- 第一期边界：连线文字不占格（虚拟文本节点待后续）；subgraph 容器按声明
  形状参与；无连续模式短弛豫；平行线等距分布待做。空间原语抽象见
  `src/layout/space/`（`SpaceContext`：GridSpaceContext / ContinuousSpaceContext）。
  设计细节见 [doc/layout-grid-undirected.md](doc/layout-grid-undirected.md)。

## 力导向有向图（force-directed）

`algorithm: 'force-directed'`——基础算法的有向派生：**解环与层级 → 软层级
引导网格寻优 →（继承的）膨胀压实 → 流动势能微调**，流程与力学引擎全部
复用 force-undirected，只注入有向语义。

```ts
const layout = new ForceLayout(graph, {
  algorithm: 'force-directed',
  direction: 'TB',   // 'TB' 自上而下（默认）| 'LR' 自左向右
});
```

- **解环与层级**：三色 DFS 识别反馈边（回环边不参与定层级），最长路径
  层级保证每个节点排在其全部上游之后；
- **软层级粗布局**：节点贴自己的层级行放置（行距随节点大小自动膨胀），
  偏行有罚分、方向不可逆（下游不得在上游）；行内顺序按邻居质心
  （barycenter）排序，有向树零交叉；
- **流动势能**：每条正向边是「源→汇」弹簧，目标长度 = 层级差 × 行距，
  微调期主动维持层级感，收敛后力自然归零；
- 有向美学承诺层级流动感与层内不交错；全局零交叉是无向算法的核心追求。

设计细节见 [doc/layout-force-directed.md](doc/layout-force-directed.md)。

## 架构（策略模式）

布局算法随时在变，节点管理与界面展示是稳定的 —— 三者严格分离：

```
src/
  graph/store.ts          节点/边管理（稳定底座）：图数据、邻接、固定状态、
                          文字度量、增删改查。不含任何布局算法。
  layout/strategy.ts      LayoutStrategy 接缝：策略接口 + 注册表
                          （registerStrategy / createStrategy / listStrategies）。
  layout/force-undirected/ 力导向无向图（默认+基础算法）：质点网格粗布局 coarse.ts
                          （CoarseHeuristics 放置美学钩子）+ 流水线 strategy.ts
                          （protected 派生接缝）；共享力学引擎件在此目录
                          （forces.ts 力场、solver.ts 求解器、hops/crossings/
                          quadtree/spatialgrid）。
  layout/force-directed/  力导向有向图（派生算法）：levels.ts 解环+层级、
                          directedCoarse.ts 软层级引导+层内排序、strategy.ts
                          流动势能（TB/LR）——只覆写接缝，流程与引擎全部继承。
  layout/circle/          环形布局（独立子目录）：最小策略示例。
  layout.ts               ForceLayout 门面：装配 store + 当前策略，公共 API 委派。
```

- 策略只通过 `GraphStore` 读图、写坐标，不拥有图数据；图结构变化后由门面通知
  `rebuild()`，用户拖拽通知 `invalidate()`。
- 运行时切换：`layout.setStrategy('circle')` 或 `updateOptions({ algorithm })` ——
  图数据保留，位置由新策略重新初始化。
- **新增布局算法** = 新建一个子目录实现 `LayoutStrategy`（5 个必选成员 +
  若干只读状态），调用 `registerStrategy(name, factory)` 即接入，测试与界面无需改动。
- 多个算法共享的公共部分（力学引擎件：力场、求解器、跳数矩阵、加速结构）
  位于基础算法 `layout/force-undirected/` 内，`force-directed/` 经派生接缝
  复用（详见 doc/layout-force-undirected.md §9）。

## API

```ts
import { ForceLayout } from 'fishgraph';

const layout = new ForceLayout(
  {
    nodes: [{ id: 'a', shape: { kind: 'rect', w: 120, h: 40 }, label: '开始' }],
    edges: [{ source: 'a', target: 'b', label: 'PASS' }],
  },
  { naturalLength: 120, edgeNodeRepulsion: 3, seed: 42 },
);
const r = layout.run({ maxIterations: 20000 });
layout.positions;   // Map<id, {x,y}>
layout.energy;      // 当前总能量
r.converged;        // 力残差判据
```

实时调参（demo 用）：`layout.updateOptions({...})` 保留坐标继续弛豫；
`layout.fix(id, x, y)` / `unfix(id)` 拖拽节点。

## 参数调优

| 参数 | 默认 | 作用 |
|---|---|---|
| `algorithm` | 'force-undirected' | 布局策略名（内置 force-undirected / force-directed / grid-undirected / circle）；运行时用 `layout.setStrategy(name)` 切换 |
| `naturalLength` | 120 | 一切尺度的锚：平衡边长 = 它，斥力作用域 = 2×它 |
| `edgeTension` | 1 | >0 让长边额外收缩；过大时会把多跳路径压成叠线 |
| `crossingShrink` | 0.15 | 交叉收缩力：边每交叉一次，引力/张力放大 (1+λ) 倍 |
| `crossingEnergy` | 0.05 | 交叉能量罚：每个交叉点抬高能量 0.05×(k_a/L)，交叉布局能量更高 |
| `coordinateSystem` | 'free' | 坐标系（布局完成后的坐标修正）：'grid' 网格化吸附 |
| `gridSize` | naturalLength | 网格间距（'grid' 时生效），吸附后保证节点不重叠 |
| `hopRepulsionDecay` | 0.7 | 跳数斥力衰减：相距 h 跳的节点斥力乘 decay^(h−1) |
| `unrelatedRepulsion` | 0.35 | 无关系节点对（不同分量）的斥力下限系数 |
| `edgeNodeRepulsion` | 3 | 压线推开力度；大矩形+回环枢纽的图可加到 10–20 |
| `weakGravityRatio` | 0.2 | pairwise 模式陌生人间距（饱和于 2L）；越大越远 |
| `gravity` | centroid | 多个不相关分量想保持紧凑用 centroid；想让分量自由分形用 pairwise |
| `labelCollision` | true | 关掉后边文字不再参与力学 |
| `accuracy` | barnes-hut | n < ~300 或要逐位复现用 exact |
| `edgeAngleAlignment` | 0 | 连线方向对齐开关（opt-in，默认关）：>0 时水平/垂直能量最低、±45° 稍高、其余更高，温和鼓励排列感，推荐 0.1；0 关闭 |
| `channelMargin` | 1 | 走线通道宽（格，仅 grid-undirected）：压实后相邻节点 AABB 间的空行/列数；0 = 压到贴邻 |
| `direction` | 'TB' | 流动方向（仅 force-directed 消费）：'TB' 自上而下 / 'LR' 自左向右 |

## 测试

`tests/layout.test.ts`：物理平衡（平衡间隙解析解）、能量单调、确定性、
压线推开、BH/exact 一致性、规模 5→2000、成群/离散比例混合、
五个构型场景（S1 自由自然形、S2 全连接等同形、S3 品字/菱形、
S4 方形贴合、S5 文字撑开+最小面积回绕）。

`tests/mermaid.test.ts`：19 节点真实流程图（Quality Gate 分支 + 回环），
force-directed 有向验收：收敛、零重叠、正向边全部顺流、零线穿节点，
并渲染 `output/mermaid-layout.svg` 供目视比对。

`tests/tree21.test.ts`：21 节点有向树，断言全部边顺流、层级行清晰、零交叉；
`tests/force-directed.test.ts`：解环收敛、TB/LR、方向切换、确定性。
`tests/angle-alignment.test.ts`：连线方向对齐验收（三档能量、力=−∇E 差分、
strength=0 纯度、单边转向、稀疏链排列感）。

## demo

`npm run demo` 打开交互页面：示例图（树/网格/星形/混合/随机/形状+文字）、
参数滑条实时弛豫、拖拽节点观察力场响应、能量曲线。
