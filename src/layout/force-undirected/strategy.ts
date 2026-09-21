/**
 * ForceUndirectedStrategy —— 力导向无向图布局策略。
 *
 * 按 doc/布局核心原则.md 的无向图流水线组织：
 *   [质点网格粗布局] → [膨胀压实] → [连续坐标微调]
 * 前两阶段由 coarse.ts 完成（拓扑骨架的离散布置，无重叠由构造保证）；
 * 微调阶段复用纯力导向的完整力学引擎（RelaxationSolver + 力场全栈：
 * 橡皮筋、跳数衰减斥力、避让软墙、交叉罚），由现有收敛判据自适应
 * 决定步数 —— 粗布局已近乎成品，弛豫只需消除网格折线感并到达力学
 * 平衡，因此迭代预算的安全网远小于 force-directed。
 *
 * 算法不消费 subgraphs/hiddenGroups 声明（分组语义归 force-group）；
 * subgraph 容器作为普通大节点参与布局。
 */

import type { GraphStore } from '../../graph/store.js';
import {
  deriveParams,
  type DerivedParams,
  type ForceContext,
} from '../force/forces.js';
import { RelaxationSolver, type SolverOptions } from '../force/solver.js';
import { buildHopScale } from '../force/hops.js';
import { createCoordinateSystem, type CoordinateNode, type CoordinateSystem } from '../coordinates.js';
import { registerStrategy } from '../strategy.js';
import type { ForceSnapshot, LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { AccuracyMode, LayoutStage, RunOptions, RunResult } from '../../types.js';
import { coarsePlacement } from './coarse.js';

/**
 * 微调预算安全网（正常路径由收敛判据自适应提前停，实测远低于该值）：
 * n=200 随机图 ~80 步、树 21 ~470 步、n=500 ~380 步、n=2000 ~1540 步、
 * mermaid 样本（矩形大节点）~2560 步。取 4000 覆盖实测最大需求。
 */
const DEFAULT_MAX_ITERATIONS = 4000;

export class ForceUndirectedStrategy implements LayoutStrategy {
  readonly name: string = 'force-undirected';

  private store: GraphStore;
  private options: ResolvedLayoutOptions;
  private params: DerivedParams;
  private ctx: ForceContext;
  private solver: RelaxationSolver;
  private cs: CoordinateSystem;
  readonly energyHistory: number[] = [];

  constructor(store: GraphStore, options: ResolvedLayoutOptions) {
    this.store = store;
    this.options = options;
    this.cs = createCoordinateSystem(options.coordinateSystem);
    this.store.refreshLabelBoxes();
    // 文字尺寸先物化进有效半径：粗布局的膨胀按最终包围尺寸计算。
    this.store.applyNodeLabelSizes(true);
    this.params = deriveParams(options, store.elements.length);
    // 阶段 2/3：质点网格放置 + 膨胀压实（就地写回坐标）。
    coarsePlacement(this.store.elements, this.store.adj, this.params.L);
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
      hopScale: buildHopScale(
        this.store.adj,
        options.hopRepulsionDecay,
        options.unrelatedRepulsion,
      ),
      extensions: {},
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
  }

  private solverOptions(): SolverOptions {
    const L = this.params.L;
    return {
      maxStep: Math.max(1e-3, this.options.maxStepRatio * L),
      initStep: L * 0.05,
      minStep: 1e-3,
      forceEps: Math.min(0.02, Math.max(1.5e-3, 0.5 / L)),
      calmNeeded: 5,
      driftForceEps: 1e-6,
      driftRatio: 0.1,
    };
  }

  /** 更新布局参数（保留当前坐标继续微调，适合 demo 实时调参）。 */
  refresh(options: ResolvedLayoutOptions): void {
    const hopChanged =
      options.hopRepulsionDecay !== this.options.hopRepulsionDecay ||
      options.unrelatedRepulsion !== this.options.unrelatedRepulsion;
    const csChanged = options.coordinateSystem !== this.options.coordinateSystem;
    this.options = options;
    const newParams = deriveParams(options, this.store.elements.length);
    // 原地更新，保证 ctx.params 引用稳定
    Object.assign(this.params, newParams);
    this.ctx.gravity = options.gravity;
    this.ctx.accuracy = options.accuracy;
    this.ctx.theta = options.theta;
    this.ctx.labelCollision = options.labelCollision;
    if (hopChanged) {
      this.ctx.hopScale = buildHopScale(
        this.store.adj,
        options.hopRepulsionDecay,
        options.unrelatedRepulsion,
      );
    }
    if (csChanged) {
      this.cs = createCoordinateSystem(options.coordinateSystem);
    }
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(true);
    Object.assign(this.solver.opts, this.solverOptions());
    this.solver.stepSize = Math.min(this.solver.stepSize, this.solver.opts.maxStep);
    this.solver.invalidate();
  }

  invalidate(): void {
    this.solver.invalidate();
  }

  /** 图结构变化（增删节点/边）：重新粗布局并重建求解器。 */
  rebuild(): void {
    this.params = deriveParams(this.options, this.store.elements.length);
    Object.assign(this.ctx.params, this.params);
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(true);
    this.ctx.elements = this.store.elements;
    this.ctx.edges = this.store.edges;
    this.ctx.adj = this.store.adj;
    this.ctx.edgeKaMul = new Array<number>(this.store.edges.length).fill(1);
    this.ctx.edgeCrossCounts = new Array<number>(this.store.edges.length).fill(0);
    this.ctx.crossPenaltyEnergy = 0;
    this.ctx.hopScale = buildHopScale(
      this.store.adj,
      this.options.hopRepulsionDecay,
      this.options.unrelatedRepulsion,
    );
    coarsePlacement(this.store.elements, this.store.adj, this.params.L);
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
    this.solver.invalidate();
  }

  // ── 迭代 ────────────────────────────────────────────────

  /**
   * 单步微调。返回 true 表示节点有被接受的移动（驱动动画帧）。
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

  /** 微调到力学平衡（收敛判据自适应），再按坐标系做一次坐标修正。 */
  run(opts: RunOptions = {}): RunResult {
    const max = Math.max(0, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    this.store.applyNodeLabelSizes(true);
    this.solver.invalidate();
    this.runBudget(max, opts.onTick);

    // 坐标系修正（布局完成后，以最优布局为基础）：free 恒等，grid 网格化吸附
    if (this.store.elements.length > 0) {
      const nodes: CoordinateNode[] = this.store.elements.map((el) => ({
        id: el.id,
        x: el.x,
        y: el.y,
        r: el.r,
        fixed: el.fixed,
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

  /** 在预算内微调到收敛，返回实际使用的迭代数。 */
  private runBudget(budget: number, onTick?: () => void): number {
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

  /** 微调阶段固定为全量力场（粗布局已覆盖分阶段弛豫的职责）。 */
  get stage(): LayoutStage {
    return 3;
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

registerStrategy('force-undirected', (store, options) => new ForceUndirectedStrategy(store, options));
