/**
 * ForceLayout —— fishgraph 公共 API。
 *
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
 *
 * 默认采用分阶段弛豫（对应"先排节点 → 加连线微调 → 加边文字 → 加节点文字"）：
 *   阶段 0 只有节点力场；阶段 1 加入连线；阶段 2 加入避让与边文字；
 *   阶段 3 节点文字生效（节点有效半径变大）后整体微调。
 */

import { applyInitPlacement } from './init.js';
import {
  deriveParams,
  type DerivedParams,
  type ForceContext,
  type InternalEdge,
  type LayoutNode,
  type LayoutStage,
} from './forces.js';
import { DEFAULT_SHAPE, boundingRadius } from './geometry.js';
import { estimateLabelBox } from './label.js';
import { RelaxationSolver } from './solver.js';
import type {
  GraphSpec,
  LayoutOptions,
  NodeId,
  NodeView,
  RunOptions,
  RunResult,
} from './types.js';

const DEFAULTS = {
  naturalLength: 120,
  // pairwise 弱引力比例：非相邻节点对的平衡间距 = naturalLength / weakGravityRatio。
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

type ResolvedOptions = Required<LayoutOptions>;

function resolveOptions(options: LayoutOptions): ResolvedOptions {
  return { ...DEFAULTS, ...options } as ResolvedOptions;
}

/** 分阶段弛豫中各阶段的迭代预算比例（阶段可提前收敛）。 */
const STAGE_BUDGETS: Array<[LayoutStage, number]> = [
  [0, 0.35],
  [1, 0.3],
  [2, 0.2],
  [3, 0.15],
];

export class ForceLayout {
  private options: ResolvedOptions;
  private nodes: LayoutNode[] = [];
  private edges: InternalEdge[] = [];
  private adj: Array<Set<number>> = [];
  private params: DerivedParams;
  private ctx: ForceContext;
  private solver: RelaxationSolver;
  /** 每个被接受步进后的总能量记录（供绘制能量曲线）。 */
  readonly energyHistory: number[] = [];

  constructor(graph: GraphSpec, options: LayoutOptions = {}) {
    this.options = resolveOptions(options);

    // 节点：校验 id 唯一，解析形状/质量/固定状态
    const idToIndex = new Map<NodeId, number>();
    graph.nodes.forEach((spec, index) => {
      if (idToIndex.has(spec.id)) {
        throw new Error(`duplicate node id: ${String(spec.id)}`);
      }
      idToIndex.set(spec.id, index);
      const shape = spec.shape ?? DEFAULT_SHAPE;
      const baseR = boundingRadius(shape);
      this.nodes.push({
        id: spec.id,
        x: 0,
        y: 0,
        fx: 0,
        fy: 0,
        r: baseR,
        baseR,
        mass: spec.mass && spec.mass > 0 ? spec.mass : 1,
        shape,
        label: spec.label ?? null,
        fixed: spec.fixed ?? false,
        placed: spec.x !== undefined && spec.y !== undefined,
      });
      if (this.nodes[index].placed) {
        this.nodes[index].x = spec.x!;
        this.nodes[index].y = spec.y!;
      }
    });

    // 边：校验端点存在；自环不参与力学
    for (const spec of graph.edges) {
      const a = idToIndex.get(spec.source);
      const b = idToIndex.get(spec.target);
      if (a === undefined || b === undefined) {
        const missing = a === undefined ? spec.source : spec.target;
        throw new Error(`edge references unknown node id: ${String(missing)}`);
      }
      if (a === b) continue;
      this.edges.push({ a, b, label: spec.label ?? null, labelHw: 0, labelHh: 0 });
    }

    this.adj = this.nodes.map(() => new Set<number>());
    for (const e of this.edges) {
      this.adj[e.a].add(e.b);
      this.adj[e.b].add(e.a);
    }

    this.params = deriveParams(this.options, this.nodes.length);
    // 分量根之间的摆放尺度：与引力模式的真实平衡尺度一致。
    // pairwise：弱引力与截断斥力的平衡间隙 g = 1/(k_w/k_r + 1/R)（饱和于斥力作用域）；
    // centroid：调和束缚下的 blob 尺度。
    const spreadD =
      this.options.gravity === 'centroid'
        ? this.params.L * Math.pow(1 / (2 * Math.max(this.options.centroidStrength, 1e-4)), 0.25)
        : 1 / (this.params.kw / this.params.kr + 1 / this.params.repR);
    applyInitPlacement(this.nodes, this.adj, this.options.init, this.params.L, this.options.seed, spreadD);

    this.ctx = {
      nodes: this.nodes,
      edges: this.edges,
      adj: this.adj,
      params: this.params,
      gravity: this.options.gravity,
      accuracy: this.options.accuracy,
      theta: this.options.theta,
      labelCollision: this.options.labelCollision,
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    this.refreshLabelBoxes();
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
  }

  // ── 配置 ────────────────────────────────────────────────

  private solverOptions() {
    const L = this.params.L;
    return {
      maxStep: Math.max(1e-3, this.options.maxStepRatio * L),
      initStep: L * 0.05,
      minStep: 1e-3,
      // 力残差阈值随尺度放大：对应位置精度 ~0.05px（曲率 ~ O(1/L)）
      forceEps: Math.min(0.02, Math.max(2.5e-3, 1 / L)),
      calmNeeded: 5,
      driftForceEps: 1e-6,
      driftRatio: 0.1,
    };
  }

  /** 更新布局参数（保留当前坐标继续弛豫，适合 demo 实时调参）。 */
  updateOptions(partial: LayoutOptions): void {
    this.options = { ...this.options, ...partial };
    const newParams = deriveParams(this.options, this.nodes.length);
    // 原地更新，保证 ctx.params 引用稳定
    Object.assign(this.params, newParams);
    this.ctx.gravity = this.options.gravity;
    this.ctx.accuracy = this.options.accuracy;
    this.ctx.theta = this.options.theta;
    this.ctx.labelCollision = this.options.labelCollision;
    this.refreshLabelBoxes();
    this.applyNodeLabelSizes(this.ctx.stage >= 3);
    Object.assign(this.solver.opts, this.solverOptions());
    this.solver.stepSize = Math.min(this.solver.stepSize, this.solver.opts.maxStep);
    this.solver.invalidate();
  }

  private refreshLabelBoxes(): void {
    const fs = this.options.labelFontSize;
    const pad = this.options.labelPadding;
    for (const e of this.edges) {
      if (e.label === null) {
        e.labelHw = 0;
        e.labelHh = 0;
      } else {
        const box = estimateLabelBox(e.label, fs, pad);
        e.labelHw = box.hw;
        e.labelHh = box.hh;
      }
    }
  }

  /** 阶段 3：节点文字使有效半径变大（布局用包围圆，渲染仍可用原形状）。 */
  private applyNodeLabelSizes(enabled: boolean): void {
    const fs = this.options.labelFontSize;
    const pad = this.options.labelPadding;
    for (const nd of this.nodes) {
      if (!enabled || nd.label === null) {
        nd.r = nd.baseR;
        continue;
      }
      const box = estimateLabelBox(nd.label, fs, pad);
      nd.r = Math.max(nd.baseR, Math.hypot(box.hw, box.hh) + 2);
    }
  }

  // ── 交互（拖拽支持）─────────────────────────────────────

  /** 固定节点（可同时移动它）。固定节点不受力移动，但仍对其他节点施力。 */
  fix(id: NodeId, x?: number, y?: number): void {
    const nd = this.nodeById(id);
    nd.fixed = true;
    if (x !== undefined) nd.x = x;
    if (y !== undefined) nd.y = y;
    this.solver.invalidate();
  }

  unfix(id: NodeId): void {
    this.nodeById(id).fixed = false;
    this.solver.invalidate();
  }

  setNodePosition(id: NodeId, x: number, y: number): void {
    const nd = this.nodeById(id);
    nd.x = x;
    nd.y = y;
    this.solver.invalidate();
  }

  private nodeById(id: NodeId): LayoutNode {
    const nd = this.nodes.find((n) => n.id === id);
    if (!nd) throw new Error(`unknown node id: ${String(id)}`);
    return nd;
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
      this.applyNodeLabelSizes(true);
      this.solver.invalidate();
      this.runBudget(max, opts.onTick);
    } else {
      let remaining = max;
      const totalWeight = STAGE_BUDGETS.reduce((s, [, w]) => s + w, 0);
      for (let s = 0; s < STAGE_BUDGETS.length && remaining > 0; s++) {
        const [stage, weight] = STAGE_BUDGETS[s];
        const budget = s === STAGE_BUDGETS.length - 1 ? remaining : Math.ceil((max * weight) / totalWeight);
        this.ctx.stage = stage;
        this.applyNodeLabelSizes(stage >= 3);
        this.solver.invalidate();
        const used = this.runBudget(budget, opts.onTick);
        remaining -= used;
      }
    }
    return {
      iterations: this.solver.iterations,
      converged: this.solver.converged,
      energy: this.energy,
    };
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

  /** 节点视图（内部坐标的只读引用，实时反映最新位置）。 */
  get nodeViews(): readonly NodeView[] {
    return this.nodes;
  }

  /** 物理边列表（a/b 为 nodeViews 下标；自环已剔除）。 */
  get edgeViews(): readonly Readonly<InternalEdge>[] {
    return this.edges;
  }

  get positions(): Map<NodeId, { x: number; y: number }> {
    const map = new Map<NodeId, { x: number; y: number }>();
    for (const nd of this.nodes) map.set(nd.id, { x: nd.x, y: nd.y });
    return map;
  }

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

  get currentOptions(): Required<LayoutOptions> {
    return { ...this.options };
  }

  // ── 测试/调试 ───────────────────────────────────────────

  /**
   * 用指定精度重算一次力场，返回力向量与能量（不推进布局）。
   * 供单元测试对比精确解与 Barnes-Hut 近似。
   */
  _forceSnapshot(accuracy: 'exact' | 'barnes-hut'): { fx: Float64Array; fy: Float64Array; energy: number } {
    const prev = this.ctx.accuracy;
    this.ctx.accuracy = accuracy;
    this.solver.invalidate();
    const energy = this.solver.energy;
    const fx = new Float64Array(this.nodes.length);
    const fy = new Float64Array(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) {
      fx[i] = this.nodes[i].fx;
      fy[i] = this.nodes[i].fy;
    }
    this.ctx.accuracy = prev;
    this.solver.invalidate();
    return { fx, fy, energy };
  }
}
