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
 *   - 有连线才会有的万有引力式吸引（∝ 1/g²，长程）+ 线性张力（连线越长拉力越大）
 *   - 非相邻节点对之间只有很弱的基础引力（pairwise，平衡距饱和于斥力作用域）
 *     或调和约束（centroid，默认）
 *   - 节点压到不相关的线段上会受到线性软墙强斥力，线段两端也被反向推动（让路）
 *   - 边文字是软墙：文字贴到节点才加压，把两端撑开到恰好容纳文字；
 *     长文字按"占用面积最小"自动回绕
 */

import { GraphStore } from './graph/store.js';
import {
  createStrategy,
  type ForceSnapshot,
  type LayoutStrategy,
  type ResolvedLayoutOptions,
} from './layout/strategy.js';
import type {
  AccuracyMode,
  EdgeSpec,
  GraphSpec,
  LayoutOptions,
  NodeId,
  NodeSpec,
  NodeView,
  RunOptions,
  RunResult,
} from './types.js';

const DEFAULTS = {
  algorithm: 'force-directed',
  naturalLength: 120,
  // pairwise 弱引力比例：陌生人的平衡间隙 g = 1/(k_w/k_r + 1/2L)，饱和于斥力作用域。
  weakGravityRatio: 0.2,
  edgeNodeRepulsion: 3,
  edgeTension: 0.1,
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
  init: 'bfs' as const,
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

  /** 运行时切换布局算法：图数据保留，位置由新策略重新初始化。 */
  setStrategy(name: string): void {
    this.options = { ...this.options, algorithm: name };
    this.strategy = createStrategy(name, this.store, this.options);
  }

  /** 更新布局参数（保留当前坐标继续弛豫，适合 demo 实时调参）。 */
  updateOptions(partial: LayoutOptions): void {
    const next = { ...this.options, ...partial } as ResolvedLayoutOptions;
    if (partial.algorithm !== undefined && partial.algorithm !== this.options.algorithm) {
      this.options = next;
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

  removeNode(id: NodeId): void {
    this.store.removeNode(id);
    this.strategy.rebuild();
  }

  addEdge(spec: EdgeSpec): void {
    this.store.addEdge(spec);
    this.store.refreshLabelBoxes();
    this.strategy.rebuild();
  }

  removeEdge(source: NodeId, target: NodeId): void {
    this.store.removeEdge(source, target);
    this.strategy.rebuild();
  }

  /** 固定节点（可同时移动它）。固定节点不受力移动，但仍对其他节点施力。 */
  fix(id: NodeId, x?: number, y?: number): void {
    this.store.fix(id, x, y);
    this.strategy.invalidate();
  }

  unfix(id: NodeId): void {
    this.store.unfix(id);
    this.strategy.invalidate();
  }

  setNodePosition(id: NodeId, x: number, y: number): void {
    this.store.setNodePosition(id, x, y);
    this.strategy.invalidate();
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

  /** 物理边列表（a/b 为 nodeViews 下标；自环已剔除）。 */
  get edgeViews(): readonly Readonly<{ a: number; b: number; label: string | null; labelHw: number; labelHh: number }>[] {
    return this.store.edgeViews;
  }

  get positions(): Map<NodeId, { x: number; y: number }> {
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
