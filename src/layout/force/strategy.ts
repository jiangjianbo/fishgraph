/**
 * ForceDirectedStrategy —— 纯力导向布局策略（默认算法）。
 *
 * 纯粹的"算法"角色：不拥有图数据，只通过 GraphStore 读写坐标；
 * 内部组装 参数派生 → 初始摆放 → 分阶段弛豫求解器。
 * 物理模型与公式见 README；这里只做调度与生命周期管理。
 *
 * 纯粹性约定：本类不含任何 group（subgraph / hidden-group）语义 ——
 * 分组力学与组内精修由派生策略 force-group（src/layout/force-group/）
 * 通过本类的受保护扩展缝注入：
 *   - configureContext()  向 ForceContext.extensions 注入附加力项/钩子；
 *   - onRefresh()         参数刷新后的派生联动；
 *   - refineLayout()      主弛豫结束后的派生精修（坐标系修正之前）；
 *   - coordinateRegion()  坐标系修正时单元素的吸附区域。
 */

import type { GraphStore } from '../../graph/store.js';
import { applyInitPlacement } from './init.js';
import { deriveParams, type DerivedParams, type ForceContext } from './forces.js';
import { RelaxationSolver, type SolverOptions } from './solver.js';
import { buildHopScale } from './hops.js';
import { createCoordinateSystem, type CoordinateNode, type CoordinateSystem } from '../coordinates.js';
import { registerStrategy } from '../strategy.js';
import type { ForceSnapshot, LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { AccuracyMode, LayoutStage, RunOptions, RunResult } from '../../types.js';

/** 分阶段弛豫中各阶段的迭代预算比例（阶段可提前收敛）。 */
const STAGE_BUDGETS: Array<[LayoutStage, number]> = [
  [0, 0.35],
  [1, 0.3],
  [2, 0.2],
  [3, 0.15],
];

export class ForceDirectedStrategy implements LayoutStrategy {
  readonly name: string = 'force-directed';

  protected store: GraphStore;
  protected options: ResolvedLayoutOptions;
  protected params: DerivedParams;
  protected ctx: ForceContext;
  protected solver: RelaxationSolver;
  /** 坐标系（组合根按注册名创建一次；布局完成后用它做坐标修正）。 */
  private cs: CoordinateSystem;
  readonly energyHistory: number[] = [];

  constructor(store: GraphStore, options: ResolvedLayoutOptions) {
    this.store = store;
    this.options = options;
    this.cs = createCoordinateSystem(options.coordinateSystem);
    this.store.refreshLabelBoxes();
    this.params = deriveParams(options, store.elements.length);
    // 分量根之间的摆放尺度：与引力模式的真实平衡尺度一致。
    // pairwise：弱引力与截断斥力的平衡间隙 g = 1/(k_w/k_r + 1/R)（饱和于斥力作用域）；
    // centroid：调和束缚下的 blob 尺度。
    const spreadD =
      options.gravity === 'centroid'
        ? this.params.L * Math.pow(1 / (2 * Math.max(options.centroidStrength, 1e-4)), 0.25)
        : 1 / (this.params.kw / this.params.kr + 1 / this.params.repR);
    applyInitPlacement(
      this.store.elements,
      this.store.adj,
      options.init,
      this.params.L,
      options.seed,
      spreadD,
    );
    this.ctx = {
      elements: this.store.elements,
      edges: this.store.edges,
      adj: this.store.adj,
      params: this.params,
      gravity: options.gravity,
      accuracy: options.accuracy,
      theta: options.theta,
      labelCollision: options.labelCollision,
      edgeKaMul: new Array<number>(this.store.edges.length).fill(1),
      edgeCrossCounts: new Array<number>(this.store.edges.length).fill(0),
      crossPenaltyEnergy: 0,
      hopScale: this.buildHopScale(),
      extensions: {},
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    this.configureContext();
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
  }

  // ── 派生扩展缝（force-group 等派生策略覆盖）──────────────

  /** 向 ForceContext 注入派生扩展点与派生状态（构造与 rebuild 时调用）。 */
  protected configureContext(): void {}

  /** 参数刷新后的派生联动（previous 为刷新前的选项快照）。 */
  protected onRefresh(_previous: ResolvedLayoutOptions): void {}

  /** 主弛豫结束后的派生精修（坐标系修正之前）。纯力导向无精修。 */
  protected refineLayout(_maxIterations: number, _onTick?: () => void): void {}

  /** 坐标系修正时单个元素的吸附区域（无区域约束返回 undefined）。 */
  protected coordinateRegion(_index: number): CoordinateNode['region'] {
    return undefined;
  }

  // ── 生命周期 ────────────────────────────────────────────

  /** 跳数斥力乘子矩阵（拓扑导出，坐标无关；仅在图结构或系数变化时重建）。 */
  private buildHopScale(): Float32Array | null {
    return buildHopScale(
      this.store.adj,
      this.options.hopRepulsionDecay,
      this.options.unrelatedRepulsion,
    );
  }

  private solverOptions(): SolverOptions {
    const L = this.params.L;
    return {
      maxStep: Math.max(1e-3, this.options.maxStepRatio * L),
      initStep: L * 0.05,
      minStep: 1e-3,
      // 力残差阈值：0.5/L。线间避让斥力满额约 30 单位，远高于该阈值，
      // 交叉态不会被误判为平衡；低于它的残余力对位移的影响可忽略。
      forceEps: Math.min(0.02, Math.max(1.5e-3, 0.5 / L)),
      calmNeeded: 5,
      driftForceEps: 1e-6,
      driftRatio: 0.1,
    };
  }

  /** 更新布局参数（保留当前坐标继续弛豫，适合 demo 实时调参）。 */
  refresh(options: ResolvedLayoutOptions): void {
    // 先比较再赋值：检测拓扑派生量与坐标系的系数是否变化（变化才重建）
    const hopChanged =
      options.hopRepulsionDecay !== this.options.hopRepulsionDecay ||
      options.unrelatedRepulsion !== this.options.unrelatedRepulsion;
    const csChanged = options.coordinateSystem !== this.options.coordinateSystem;
    const previous = this.options;
    this.options = options;
    const newParams = deriveParams(options, this.store.elements.length);
    // 原地更新，保证 ctx.params 引用稳定
    Object.assign(this.params, newParams);
    this.ctx.gravity = options.gravity;
    this.ctx.accuracy = options.accuracy;
    this.ctx.theta = options.theta;
    this.ctx.labelCollision = options.labelCollision;
    // 跳数系数变化时重建乘子矩阵（拓扑没变，仅系数变）
    if (hopChanged) {
      this.ctx.hopScale = this.buildHopScale();
    }
    this.onRefresh(previous);
    if (csChanged) {
      this.cs = createCoordinateSystem(options.coordinateSystem);
    }
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(this.ctx.stage >= 3);
    Object.assign(this.solver.opts, this.solverOptions());
    this.solver.stepSize = Math.min(this.solver.stepSize, this.solver.opts.maxStep);
    this.solver.invalidate();
  }

  invalidate(): void {
    this.solver.invalidate();
  }

  /** 图结构变化（增删节点/边）：重建内部状态，并为未显式定位的节点重新初始化。 */
  rebuild(): void {
    this.params = deriveParams(this.options, this.store.elements.length);
    Object.assign(this.ctx.params, this.params);
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(this.ctx.stage >= 3);
    this.ctx.elements = this.store.elements;
    this.ctx.edges = this.store.edges;
    this.ctx.adj = this.store.adj;
    this.ctx.edgeKaMul = new Array<number>(this.store.edges.length).fill(1);
    this.ctx.edgeCrossCounts = new Array<number>(this.store.edges.length).fill(0);
    this.ctx.crossPenaltyEnergy = 0;
    this.ctx.hopScale = this.buildHopScale();
    this.configureContext();
    const spreadD =
      this.options.gravity === 'centroid'
        ? this.params.L * Math.pow(1 / (2 * Math.max(this.options.centroidStrength, 1e-4)), 0.25)
        : 1 / (this.params.kw / this.params.kr + 1 / this.params.repR);
    applyInitPlacement(
      this.store.elements,
      this.store.adj,
      this.options.init,
      this.params.L,
      this.options.seed,
      spreadD,
    );
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
    this.solver.invalidate();
  }

  // ── 迭代 ────────────────────────────────────────────────

  /**
   * 单步弛豫。返回 true 表示节点有被接受的移动（驱动动画帧）。
   * 连续调用直到 `converged` 或达到迭代上限。
   */
  step(): boolean {
    const moved = this.solver.step();
    if (moved) {
      this.energyHistory.push(this.ctx.energy);
      if (this.energyHistory.length > 4000) this.energyHistory.shift();
    }
    return moved;
  }

  /**
   * 迭代到收敛（或达到 maxIterations）。
   * 默认分阶段弛豫：0 力场 → 1 连线 → 2 避让+边文字 → 3 节点文字，
   * 每阶段用掉剩余预算的一部分，且可提前收敛。
   */
  run(opts: RunOptions = {}): RunResult {
    const max = Math.max(0, opts.maxIterations ?? 1500);
    const staged = opts.staged ?? true;
    if (!staged) {
      this.ctx.stage = 3;
      this.store.applyNodeLabelSizes(true);
      this.solver.invalidate();
      this.runBudget(max, opts.onTick);
    } else {
      let remaining = max;
      const totalWeight = STAGE_BUDGETS.reduce((s, [, w]) => s + w, 0);
      for (let s = 0; s < STAGE_BUDGETS.length && remaining > 0; s++) {
        const [stage, weight] = STAGE_BUDGETS[s];
        const budget = s === STAGE_BUDGETS.length - 1 ? remaining : Math.ceil((max * weight) / totalWeight);
        this.ctx.stage = stage;
        this.store.applyNodeLabelSizes(stage >= 3);
        this.solver.invalidate();
        const used = this.runBudget(budget, opts.onTick);
        remaining -= used;
      }
    }
    // 派生精修（如 force-group 的组内弛豫），发生在坐标系修正之前。
    this.refineLayout(max, opts.onTick);

    // 坐标系修正（布局完成后，以最优布局为基础）：free 恒等，grid 网格化吸附
    if (this.store.elements.length > 0) {
      const nodes: CoordinateNode[] = this.store.elements.map((el, ni) => ({
        id: el.id,
        x: el.x,
        y: el.y,
        r: el.r,
        fixed: el.fixed,
        region: this.coordinateRegion(ni),
      }));
      const lattice =
        this.options.gridSize > 0 ? this.options.gridSize : this.options.naturalLength;
      this.cs.refine(nodes, { lattice });
      for (let i = 0; i < nodes.length; i++) {
        this.store.elements[i].x = nodes[i].x;
        this.store.elements[i].y = nodes[i].y;
      }
    }

    return {
      iterations: this.solver.iterations,
      converged: this.solver.converged,
      energy: this.energy,
    };
  }

  /** 在当前阶段消耗最多 budget 次迭代，返回实际使用的迭代数。 */
  protected runBudget(budget: number, onTick?: () => void): number {
    let used = 0;
    let guard = budget * 2 + 64;
    while (!this.solver.converged && used < budget && guard-- > 0) {
      if (this.step()) {
        used++;
        onTick?.();
      }
    }
    return used;
  }

  // ── 结果访问 ────────────────────────────────────────────

  get energy(): number {
    return this.solver.energy;
  }

  get iterations(): number {
    return this.solver.iterations;
  }

  get converged(): boolean {
    return this.solver.converged;
  }

  /** 当前力阶段（分阶段弛豫进度）。 */
  get stage(): LayoutStage {
    return this.ctx.stage;
  }

  /**
   * 用指定精度重算一次力场，返回力向量与能量（不推进布局）。
   * 供单元测试对比精确解与 Barnes-Hut 近似。
   */
  forceSnapshot(accuracy: AccuracyMode): ForceSnapshot {
    const prev = this.ctx.accuracy;
    this.ctx.accuracy = accuracy;
    this.solver.invalidate();
    const energy = this.solver.energy;
    const fx = new Float64Array(this.ctx.elements.length);
    const fy = new Float64Array(this.ctx.elements.length);
    for (let i = 0; i < this.ctx.elements.length; i++) {
      fx[i] = this.ctx.elements[i].fx;
      fy[i] = this.ctx.elements[i].fy;
    }
    this.ctx.accuracy = prev;
    this.solver.invalidate();
    return { fx, fy, energy };
  }
}

registerStrategy('force-directed', (store, options) => new ForceDirectedStrategy(store, options));
