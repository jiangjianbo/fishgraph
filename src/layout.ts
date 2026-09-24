/**
 * ForceLayout —— 公共 API 门面。
 *
 * 架构（策略模式）：
 *   GraphStore（src/graph/store.ts）—— 节点/边管理，稳定底座：
 *     图数据、邻接、固定状态、文字度量、增删改查。不含任何布局算法。
 *   LayoutStrategy（src/layout/strategy.ts）—— 布局算法接缝：
 *     算法各自独立子目录（src/layout/force/、src/layout/circle/），
 *     通过 registerStrategy 注册，按名创建、可运行时热切换。
 *
 * 本类只做装配与委派：持有 store + 当前策略，把公共 API 转接过去。
 * 物理模型概要（详见 README）：
 *   - 核力式斥力只在短程作用域（表面间隙 < 2×naturalLength）内存在：
 *     接触/近距陡增保证不重叠，在作用域边界处能量与力光滑归零 ——
 *     脱离接触的节点互不干扰，图自然趋向紧凑（覆盖面积趋小）
 *   - 有连线才有橡皮筋收缩弹力（F ∝ g，连线越长拉力越大；自然长度 = naturalLength）
 *   - 非相邻节点对之间只有很弱的基础引力（pairwise）或调和约束（centroid，默认）
 *   - 节点压到不相关的线段上会受到线性软墙强斥力，线段两端也被反向推动（让路）
 *   - 边文字是软墙：文字贴到节点才加压，把两端撑开到恰好容纳文字；
 *     长文字按"占用面积最小"自动回绕
 */

import { GraphStore, type InternalEdge, LayoutSubgraphNode } from './graph/store.js';
import {
  createStrategy,
  type ForceSnapshot,
  type LayoutStrategy,
  type ResolvedLayoutOptions,
} from './layout/strategy.js';
import type {
  AccuracyMode,
  EdgeSpec,
  ElementId,
  GraphSpec,
  LayoutOptions,
  NodeSpec,
  NodeView,
  RunOptions,
  RunResult,
  SubgraphView,
} from './types.js';

const DEFAULTS = {
  // 默认基础算法：无向力导向（均匀分布、无交叉的紧凑布局）
  algorithm: 'force-undirected',
  // 有向图流动方向（算法：force-directed 消费，默认自顶向下）
  direction: 'TB' as const,
  // 自然边长（格）：相邻节点表面的平衡间隙 = 6 格。一格 = 分级基准盒
  // （grade.ts 宽高独立聚类的几何平均比例尺）；默认 6 格在典型均匀圆点图
  // （盒 20px）下与旧 px 口径（120px）等距，格单位力学见 types.ts。
  naturalLength: 6,
  // pairwise 弱引力比例：陌生人的平衡间隙 g = 1/(k_w/k_r + 1/2L)，饱和于斥力作用域。
  weakGravityRatio: 0.2,
  edgeNodeRepulsion: 3,
  // 橡皮筋刚度倍率：τ=1 时平衡间隙恰为 naturalLength（越长拉力越大）
  edgeTension: 1,
  // 交叉收缩：边每交叉一次，引力/张力放大 15% —— 交叉越多的线越努力变短。
  crossingShrink: 0.15,
  // 交叉能量罚：每个交叉点抬高总能量 0.05×(k_a/L)，交叉布局天然能量更高。0 关闭。
  crossingEnergy: 0.05,
  // 线间避让斥力（opt-in）：稀疏流程图防交叉的重武器；全连接图/高密度图关闭
  lineAvoidance: false,
  // 连线方向对齐（opt-in，默认关）：往水平/垂直/45° 转的温和力矩
  // （E(θ)=kAng·[(1−cos4θ)+(1−cos8θ)]）。稀疏图（链/树/流程图）想要排列感时
  // 显式设置正值开启（推荐 0.1：排列感可测量；全连接小图仍由弹簧主导）。
  edgeAngleAlignment: 0,
  // 同顶点连线角向均布（opt-in，默认关）：同一节点的相邻线对之间有张开
  // 斥力，夹角越小斥力越大（E = k·(1−sin(θ/2))，θ→π 归零），顶点连线趋向
  // 等分圆周（4 线十字、3 线品字、2 线拉直）。推荐 0.5 起步。
  // 注意：该力的平衡态对链是「拉直」、对拥挤线对是「撑开」，会系统性
  // 增大组内链跨度、重排卫星节点的切向布局（实测任何非零强度都会，
  // 强度只影响快慢），需要组内紧凑/既有切向物理的图慎开。
  angleBalance: 0,
  // 隐藏组聚集强度：hidden-group 成员向组质心的简谐束缚（越大越紧凑）
  groupCohesion: 3,
  // 走线通道宽度（格，算法：grid-undirected）：通道约束压实后相邻节点
  // AABB 之间保留的最小空行/列数（走线走廊）。
  channelMargin: 1,
  // 坐标系（布局完成后的坐标修正策略）：'grid' 网格化吸附（唯一内置）
  coordinateSystem: 'grid' as const,
  // 网格间距（格）；0 = 跟随 naturalLength
  gridSize: 0,
  // 跳数斥力衰减：相距 h 跳的节点斥力乘 0.7^(h-1)；跳数>3 与不同分量的节点对乘 0.35
  // —— 无直接或间接关系的节点几乎互不推挤（防重叠接触弹簧不衰减）。
  hopRepulsionDecay: 0.7,
  unrelatedRepulsion: 0.35,
  labelCollision: true,
  labelFontSize: 12,
  labelPadding: 4,
  // 默认调和约束（centroid）：所有节点对之间一根极软的"到质心弹簧"（线性力），
  // 严格保守、合力恒为零，孤立点也保持紧凑对称的自然构型。
  // 若需要让无连线的节点完全自由铺开（如星形的卫星点贴合四边），
  // 用 gravity: 'pairwise' —— 弱引力随距离衰减，不会把节点对粘住。
  gravity: 'centroid' as const,
  centroidStrength: 0.1,
  accuracy: 'barnes-hut' as const,
  theta: 0.9,
  seed: 42,
  maxStepRatio: 0.2,
};

export class ForceLayout {
  private store: GraphStore;
  private strategy: LayoutStrategy;
  private options: ResolvedLayoutOptions;

  constructor(graph: GraphSpec, options: LayoutOptions = {}) {
    this.options = { ...DEFAULTS, ...options } as ResolvedLayoutOptions;
    this.store = new GraphStore(graph);
    this.store.setLabelMetrics(this.options.labelFontSize, this.options.labelPadding);
    this.strategy = createStrategy(this.options.algorithm, this.store, this.options);
  }

  // ── 策略切换 ────────────────────────────────────────────

  /** 当前策略名（LayoutOptions.algorithm）。 */
  get strategyName(): string {
    return this.strategy.name;
  }

  /**
   * 格单位比例尺（px/格）：初始化分级基准盒的几何平均。布局坐标 ÷ 本值
   * = 整数格下标（格单位存储口径）；渲染映射 px = 格 × 本值。
   */
  get cellScale(): number {
    return this.store.cellScale;
  }

  /** 运行时切换布局算法：图数据保留，位置由新策略重新初始化。 */
  setStrategy(name: string): void {
    this.options = { ...this.options, algorithm: name };
    // 旧策略的走线拐点与物化尺寸都绑定旧坐标，换算法即失效
    this.store.clearEdgeWaypoints();
    this.store.clearMaterializedSizes();
    this.strategy = createStrategy(name, this.store, this.options);
  }

  /** 更新布局参数（保留当前坐标继续弛豫，适合 demo 实时调参）。 */
  updateOptions(partial: LayoutOptions): void {
    const next = { ...this.options, ...partial } as ResolvedLayoutOptions;
    if (partial.algorithm !== undefined && partial.algorithm !== this.options.algorithm) {
      this.options = next;
      // 旧策略的走线拐点与物化尺寸都绑定旧坐标，换算法即失效
      this.store.clearEdgeWaypoints();
      this.store.clearMaterializedSizes();
      this.strategy = createStrategy(next.algorithm, this.store, next);
      return;
    }
    this.options = next;
    this.store.setLabelMetrics(next.labelFontSize, next.labelPadding);
    this.strategy.refresh(next);
  }

  // ── 节点/边管理（GraphStore 透传）───────────────────────
  // 变更后通知策略 rebuild()：新节点获得初始位置，内部状态按新图重建。

  addNode(spec: NodeSpec): void {
    this.store.addNode(spec);
    this.store.refreshLabelBoxes();
    this.strategy.rebuild();
  }

  removeNode(id: ElementId): void {
    this.store.removeNode(id);
    this.strategy.rebuild();
  }

  addEdge(spec: EdgeSpec): void {
    this.store.addEdge(spec);
    this.store.refreshLabelBoxes();
    this.strategy.rebuild();
  }

  removeEdge(source: ElementId, target: ElementId): void {
    this.store.removeEdge(source, target);
    this.strategy.rebuild();
  }

  /** 固定节点（可同时移动它）。固定节点不受力移动，但仍对其他节点施力。 */
  fix(id: ElementId, x?: number, y?: number): void {
    this.store.fix(id, x, y);
    this.strategy.invalidate();
  }

  unfix(id: ElementId): void {
    this.store.unfix(id);
    this.strategy.invalidate();
  }

  setNodePosition(id: ElementId, x: number, y: number): void {
    this.store.setNodePosition(id, x, y);
    this.strategy.invalidate();
  }

  /**
   * 把成员坐标钳制进所属容器（成员包围圆完全落在容器边界内）；
   * 非成员原样返回。拖拽交互用——成员不可被拖出 subgraph。
   */
  clampToContainer(id: ElementId, x: number, y: number): { x: number; y: number } {
    return this.store.clampToContainer(id, x, y);
  }

  /** 容器的全部成员 id（递归展开嵌套容器，不含容器自身）。 */
  subgraphMemberIds(id: ElementId): ElementId[] {
    return this.store.subgraphMemberIds(id);
  }

  /** id 所属最内层 subgraph 容器（非成员返回 null）。 */
  containerOf(id: ElementId): LayoutSubgraphNode | null {
    return this.store.containerOf(id);
  }

  // ── 迭代 ────────────────────────────────────────────────

  /**
   * 单步弛豫。返回 true 表示节点有被接受的移动（驱动动画帧）。
   * 连续调用直到 `converged` 或达到迭代上限。
   */
  step(): boolean {
    return this.strategy.step();
  }

  /** 迭代到收敛（或达到 maxIterations）。 */
  run(opts: RunOptions = {}): RunResult {
    return this.strategy.run(opts);
  }

  // ── 结果访问 ────────────────────────────────────────────

  /** 节点视图（内部坐标的只读引用，实时反映最新位置）。 */
  get nodeViews(): readonly NodeView[] {
    return this.store.nodeViews;
  }

  /** subgraph 容器视图（渲染约定：背景层最先绘制，成员绘制在其上）。 */
  get subgraphViews(): readonly SubgraphView[] {
    return this.store.subgraphViews;
  }

  /**
   * 物理边列表（sourceIndex/targetIndex 为 nodeViews 所在 elements 数组
   * 下标；自环已剔除；grid-undirected 策略附带走线 waypoints）。
   */
  get edgeViews(): readonly InternalEdge[] {
    return this.store.edgeViews;
  }

  get positions(): Map<ElementId, { x: number; y: number }> {
    return this.store.positions;
  }

  get energy(): number {
    return this.strategy.energy;
  }

  get iterations(): number {
    return this.strategy.iterations;
  }

  get converged(): boolean {
    return this.strategy.converged;
  }

  /**
   * 最近一次网格修正实际使用的吸附格距（格胞中心间距，已按力学平衡
   * 间距自适应放大）；未修正或策略无网格概念时为 null。渲染背景网格
   * 必须用它，格线才能从节点之间穿过（节点坐在格胞正中）。
   */
  get gridLattice(): number | null {
    return this.strategy.gridLattice ?? null;
  }

  /** 策略内部调度进度（分阶段弛豫的阶段号）。 */
  get stage(): number {
    return this.strategy.stage;
  }

  /** 每个被接受步进后的总能量记录（供能量曲线）。 */
  get energyHistory(): number[] {
    return this.strategy.energyHistory;
  }

  get currentOptions(): Required<LayoutOptions> {
    return { ...this.options };
  }

  // ── 测试/调试 ───────────────────────────────────────────

  /**
   * 用指定精度重算一次力场，返回力向量与能量（不推进布局）。
   * 供单元测试对比精确解与 Barnes-Hut 近似；仅力学策略支持。
   */
  _forceSnapshot(accuracy: AccuracyMode): ForceSnapshot {
    if (!this.strategy.forceSnapshot) {
      throw new Error(`strategy ${this.strategy.name} does not support force snapshot`);
    }
    return this.strategy.forceSnapshot(accuracy);
  }
}
