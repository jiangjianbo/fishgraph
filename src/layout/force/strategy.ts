/**
 * ForceDirectedStrategy —— 力导向布局策略（默认算法）。
 *
 * 纯粹的"算法"角色：不拥有图数据，只通过 GraphStore 读写坐标；
 * 内部组装 参数派生 → 初始摆放 → 分阶段弛豫求解器。
 * 物理模型与公式见 README；这里只做调度与生命周期管理。
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
  readonly name = 'force-directed';

  private store: GraphStore;
  private options: ResolvedLayoutOptions;
  private params: DerivedParams;
  private ctx: ForceContext;
  private solver: RelaxationSolver;
  /** 坐标系（组合根按注册名创建一次；布局完成后用它做坐标修正）。 */
  private cs: CoordinateSystem;
  readonly energyHistory: number[] = [];

  constructor(store: GraphStore, options: ResolvedLayoutOptions) {
    this.store = store;
    this.options = options;
    this.cs = createCoordinateSystem(options.coordinateSystem);
    this.store.refreshLabelBoxes();
    this.params = deriveParams(options, store.nodes.length);
    // 分量根之间的摆放尺度：与引力模式的真实平衡尺度一致。
    // pairwise：弱引力与截断斥力的平衡间隙 g = 1/(k_w/k_r + 1/R)（饱和于斥力作用域）；
    // centroid：调和束缚下的 blob 尺度。
    const spreadD =
      options.gravity === 'centroid'
        ? this.params.L * Math.pow(1 / (2 * Math.max(options.centroidStrength, 1e-4)), 0.25)
        : 1 / (this.params.kw / this.params.kr + 1 / this.params.repR);
    applyInitPlacement(
      this.store.nodes,
      this.store.adj,
      options.init,
      this.params.L,
      options.seed,
      spreadD,
    );
    this.ctx = {
      nodes: this.store.nodes,
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
      hubOfMember: this.buildHubMap(),
      hiddenGroups: this.buildHiddenGroupConstraints(),
      subgraphBoxes: this.buildSubgraphConstraints(),
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
  }

  // ── 生命周期 ────────────────────────────────────────────

  /** 下标 → 所属 subgraph hub 下标。 */
  private buildHubMap(): Int32Array {
    const map = new Int32Array(this.store.nodes.length).fill(-1);
    for (let i = 0; i < this.store.nodes.length; i++) {
      const h = this.store.hubOfMember(i);
      map[i] = h;
    }
    return map;
  }

  /** hidden-group 聚集束缚（成员数归一，groupCohesion 可调）。 */
  private buildHiddenGroupConstraints(): Array<{ members: number[]; k: number }> {
    const L = this.options.naturalLength;
    return this.store.groups
      .filter((g) => !g.shape)
      .map((g) => {
        const members = g.members
          .map((m) => this.store.indexOf(m))
          .filter((x) => x >= 0);
        return { members, k: (this.options.groupCohesion * 1) / (L * L * Math.max(members.length, 1)) };
      })
      .filter((g) => g.members.length >= 2);
  }

  /** subgraph 包含墙（成员出界拉回；内切半径近似 = 包围半径 × 0.55）。 */
  private buildSubgraphConstraints(): Array<{ hub: number; members: number[]; rIn: number; k: number }> {
    const kin = 12 / (this.options.naturalLength * this.options.naturalLength);
    return this.store.groups
      .filter((g) => !!g.shape)
      .map((g) => {
        const hub = this.store.groupHub.get(g.id) ?? -1;
        if (hub < 0) return null;
        const members = g.members
          .map((m) => this.store.indexOf(m))
          .filter((x) => x >= 0);
        const hubR = this.store.nodes[hub].r;
        return { hub, members, rIn: hubR * 0.55, k: kin };
      })
      .filter((x): x is { hub: number; members: number[]; rIn: number; k: number } => x !== null);
  }

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
    this.options = options;
    const newParams = deriveParams(options, this.store.nodes.length);
    // 原地更新，保证 ctx.params 引用稳定
    Object.assign(this.params, newParams);
    this.ctx.gravity = options.gravity;
    this.ctx.accuracy = options.accuracy;
    this.ctx.theta = options.theta;
    this.ctx.labelCollision = options.labelCollision;
    // 跳数系数变化时重建乘子矩阵（拓扑没变，仅系数变）
    if (
      options.hopRepulsionDecay !== this.options.hopRepulsionDecay ||
      options.unrelatedRepulsion !== this.options.unrelatedRepulsion
    ) {
      this.ctx.hopScale = this.buildHopScale();
    }
    if (options.groupCohesion !== this.options.groupCohesion) {
      this.ctx.hiddenGroups = this.buildHiddenGroupConstraints();
    }
    if (options.coordinateSystem !== this.options.coordinateSystem) {
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
    this.params = deriveParams(this.options, this.store.nodes.length);
    Object.assign(this.ctx.params, this.params);
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(this.ctx.stage >= 3);
    this.ctx.nodes = this.store.nodes;
    this.ctx.edges = this.store.edges;
    this.ctx.adj = this.store.adj;
    this.ctx.edgeKaMul = new Array<number>(this.store.edges.length).fill(1);
    this.ctx.edgeCrossCounts = new Array<number>(this.store.edges.length).fill(0);
    this.ctx.crossPenaltyEnergy = 0;
    this.ctx.hopScale = this.buildHopScale();
    this.ctx.hubOfMember = this.buildHubMap();
    this.ctx.hiddenGroups = this.buildHiddenGroupConstraints();
    this.ctx.subgraphBoxes = this.buildSubgraphConstraints();
    const spreadD =
      this.options.gravity === 'centroid'
        ? this.params.L * Math.pow(1 / (2 * Math.max(this.options.centroidStrength, 1e-4)), 0.25)
        : 1 / (this.params.kw / this.params.kr + 1 / this.params.repR);
    applyInitPlacement(
      this.store.nodes,
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
    // 组内布局（分组原则 4）：整体收敛后冻结组外节点，组内成员弛豫；
    // 若 hidden-group 形状（成员包围盒）变化超过 15%，引发一轮重新整体布局。
    if (this.store.groups.length > 0 && max > 0) {
      const before = this.hiddenGroupBoxes();
      this.refineGroups(Math.max(150, Math.floor(max * 0.1)), opts.onTick);
      const after = this.hiddenGroupBoxes();
      const changed = before.some((b, i) => {
        const a = after[i];
        return a && (Math.abs(a.w - b.w) > b.w * 0.15 || Math.abs(a.h - b.h) > b.h * 0.15);
      });
      if (changed) {
        this.solver.invalidate();
        this.runBudget(Math.max(200, Math.floor(max * 0.3)), opts.onTick);
      }
    }

    // 坐标系修正（布局完成后，以最优布局为基础）：free 恒等，grid 网格化吸附
    if (this.store.nodes.length > 0) {
      const nodes: CoordinateNode[] = this.store.nodes.map((nd, ni) => {
        const hub = this.store.hubOfMember(ni);
        let region: CoordinateNode['region'];
        if (hub >= 0) {
          region = { anchorId: this.store.nodes[hub].id, rIn: this.store.nodes[hub].r * 0.55 };
        }
        return { id: nd.id, x: nd.x, y: nd.y, r: nd.r, fixed: nd.fixed, region };
      });
      const lattice =
        this.options.gridSize > 0 ? this.options.gridSize : this.options.naturalLength;
      this.cs.refine(nodes, { lattice });
      for (let i = 0; i < nodes.length; i++) {
        this.store.nodes[i].x = nodes[i].x;
        this.store.nodes[i].y = nodes[i].y;
      }
    }

    return {
      iterations: this.solver.iterations,
      converged: this.solver.converged,
      energy: this.energy,
    };
  }

  /** hidden-group 的成员包围盒（形状 = 成员组成的形状）。 */
  private hiddenGroupBoxes(): Array<{ w: number; h: number }> {
    return this.store.groups
      .filter((g) => !g.shape)
      .map((g) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const m of g.members) {
          const idx = this.store.indexOf(m);
          if (idx < 0) continue;
          const nd = this.store.nodes[idx];
          minX = Math.min(minX, nd.x);
          minY = Math.min(minY, nd.y);
          maxX = Math.max(maxX, nd.x);
          maxY = Math.max(maxY, nd.y);
        }
        return { w: maxX - minX, h: maxY - minY };
      });
  }

  /** 组内精修：冻结全部组外节点（含 subgraph hub），只让组成员弛豫。 */
  private refineGroups(budget: number, onTick?: () => void): void {
    const isMember = new Uint8Array(this.store.nodes.length);
    for (const g of this.store.groups) {
      for (const m of g.members) {
        const idx = this.store.indexOf(m);
        if (idx >= 0) isMember[idx] = 1;
      }
    }
    // subgraph hub 代表组的全局位置：组内精修期间固定
    for (const hub of this.store.groupHub.values()) isMember[hub] = 0;
    const frozen: number[] = [];
    for (let i = 0; i < isMember.length; i++) if (!isMember[i]) frozen.push(i);
    for (const i of frozen) this.store.nodes[i].fixed = true;
    this.solver.invalidate();
    this.runBudget(budget, onTick);
    for (const i of frozen) this.store.nodes[i].fixed = false;
    this.solver.invalidate();
  }

  /** 在当前阶段消耗最多 budget 次迭代，返回实际使用的迭代数。 */
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
    const fx = new Float64Array(this.ctx.nodes.length);
    const fy = new Float64Array(this.ctx.nodes.length);
    for (let i = 0; i < this.ctx.nodes.length; i++) {
      fx[i] = this.ctx.nodes[i].fx;
      fy[i] = this.ctx.nodes[i].fy;
    }
    this.ctx.accuracy = prev;
    this.solver.invalidate();
    return { fx, fy, energy };
  }
}

registerStrategy('force-directed', (store, options) => new ForceDirectedStrategy(store, options));
