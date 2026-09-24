/**
 * ForceUndirectedStrategy —— 力导向无向图布局策略（基础算法）。
 *
 * 按 doc/布局核心原则.md 的无向图流水线组织：
 *   [质点网格粗布局] → [膨胀压实] → [连续坐标微调]
 * 前两阶段由 coarse.ts 完成（拓扑骨架的离散布置，无重叠由构造保证）；
 * 微调阶段使用本目录的力学引擎（RelaxationSolver + 力场全栈：橡皮筋、
 * 跳数衰减斥力、避让软墙、交叉罚——自原 force/ 迁入，作为基础算法的
 * 共享引擎），由现有收敛判据自适应决定步数 —— 粗布局已近乎成品，弛豫
 * 只需消除网格折线感并到达力学平衡，因此迭代预算的安全网远小于
 * force-directed。
 *
 * 算法消费 subgraphs 声明为「世界分块」（见 worlds.ts）：每个容器内部
 * 是独立力学世界 —— 容器对成员无力、外部对内部无影响（跨世界零耦合），
 * 跨世界连线提升为容器本体间的连线；根层即"无限大容器"的世界。成员块
 * 与容器的对齐用纯平移（粗布局后种入 + 收敛后终局对齐）。hiddenGroups
 * 声明仍不消费（聚类语义归 group-undirected）。
 */

import type { GraphStore } from '../../graph/store.js';
import {
  deriveParams,
  type DerivedParams,
  type ForceContext,
} from './forces.js';
import { RelaxationSolver, type SolverOptions } from './solver.js';
import { buildHopScale } from './hops.js';
import {
  createCoordinateSystem,
  resolveRefineLattice,
  zoneLatticeCap,
  type CoordinateNode,
  type CoordinateSystem,
  type RefineFlow,
  type RefineZone,
} from '../coordinates.js';
import { registerStrategy } from '../strategy.js';
import type { ForceSnapshot, LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { AccuracyMode, LayoutStage, RunOptions, RunResult } from '../../types.js';
import { coarsePlacement } from './coarse.js';
import {
  alignMembersToContainers,
  buildWorldPartition,
  clampMembersToContainers,
  type WorldPartition,
} from './worlds.js';

/**
 * 微调预算安全网（正常路径由收敛判据自适应提前停，实测远低于该值）：
 * n=200 随机图 ~80 步、树 21 ~470 步、n=500 ~380 步、n=2000 ~1540 步、
 * mermaid 样本（矩形大节点）~2560 步。取 4000 覆盖实测最大需求。
 */
const DEFAULT_MAX_ITERATIONS = 4000;

export class ForceUndirectedStrategy implements LayoutStrategy {
  readonly name: string = 'force-undirected';

  // 派生算法（如 force-directed）需要访问图数据、派生参数与力场上下文。
  protected store: GraphStore;
  protected options: ResolvedLayoutOptions;
  protected params: DerivedParams;
  protected ctx: ForceContext;
  /** 世界分块表（有 subgraph 声明时非空；null = 无分组，全部走原路径）。 */
  protected partition: WorldPartition | null = null;
  private solver: RelaxationSolver;
  private cs: CoordinateSystem;
  /** 终局对齐 + 坐标系修正是否已应用于当前收敛态（防逐帧路径重复执行）。 */
  private correctionApplied = false;
  readonly energyHistory: number[] = [];
  /** 最近一次修正的实际格距（自适应放大后；渲染背景网格用）。 */
  gridLattice: number | null = null;

  constructor(store: GraphStore, options: ResolvedLayoutOptions) {
    this.store = store;
    this.options = options;
    this.cs = createCoordinateSystem(options.coordinateSystem);
    this.store.refreshLabelBoxes();
    // 文字尺寸先物化进有效半径：粗布局的膨胀按最终包围尺寸计算。
    this.store.applyNodeLabelSizes(true);
    this.params = deriveParams(options, store.elements.length);
    // 世界分块在粗布局前构建：粗布局按提升拓扑放置（成员聚块、容器聚外），
    // 随后种入容器。
    if (store.subgraphNodes.length > 0) {
      this.partition = buildWorldPartition(store);
    }
    // 阶段 2/3：质点网格放置 + 膨胀压实（就地写回坐标）。
    this.applyCoarsePlacement();
    const partition = this.partition;
    this.ctx = {
      elements: this.store.elements,
      edges: partition ? partition.liftedEdges : this.store.edges,
      adj: partition ? partition.liftedAdj : this.store.adj,
      params: this.params,
      gravity: options.gravity,
      accuracy: options.accuracy,
      theta: options.theta,
      labelCollision: options.labelCollision,
      edgeKaMul: new Array<number>(partition ? partition.liftedEdges.length : this.store.edges.length).fill(1),
      edgeCrossCounts: new Array<number>(partition ? partition.liftedEdges.length : this.store.edges.length).fill(0),
      crossPenaltyEnergy: 0,
      hopScale: buildHopScale(
        partition ? partition.liftedAdj : this.store.adj,
        options.hopRepulsionDecay,
        options.unrelatedRepulsion,
      ),
      extensions: {},
      world: partition?.world,
      edgeWorld: partition?.edgeWorld,
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    // 力场扩展点注入（派生算法覆写以挂接附加力学）。
    this.configureExtensions();
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
  }

  /**
   * 接缝：粗布局时机（阶段 2/3）。默认用无向放置美学（undirectedHeuristics）；
   * 派生算法覆写本方法以传入自己的 CoarseHeuristics（如层级引导放置）。
   * 注意：构造期会被基类构造函数调用，覆写实现不得依赖子类字段初始化器
   * （其在本构造体返回后才执行），所需数据应在方法内就地计算。
   *
   * 有世界分块时：粗布局按提升拓扑放置（成员按同世界内部边聚块、容器
   * 与提升邻居聚拢），随后把成员块种入容器（纯平移）。
   */
  protected applyCoarsePlacement(): void {
    const partition = this.partition;
    coarsePlacement(
      this.store.elements,
      partition ? partition.liftedAdj : this.store.adj,
      this.params.L,
    );
    if (partition) {
      alignMembersToContainers(this.store, partition);
    }
  }

  /**
   * 接缝：力场扩展点注入。默认无扩展；派生算法覆写本方法向
   * ctx.extensions 挂接附加力学（如方向流动势能）。构造期调用约束同上。
   */
  protected configureExtensions(): void {
    this.ctx.extensions = {};
  }

  /**
   * 接缝：坐标修正（网格化吸附）的流向约束。默认不约束 —— 无向算法
   * 不含流向语义（options.direction 只服务有向派生算法的粗布局与
   * 流动力）；有向派生算法覆写本方法返回正向边集合 + options.direction，
   * 让吸附的格点选择保持 target 严格不逆于 source 的行/列序。
   */
  protected refineFlow(): RefineFlow | null {
    return null;
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
        this.partition ? this.partition.liftedAdj : this.store.adj,
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
    // 参数变化后重新弛豫，收敛时需再做一次终局对齐与修正。
    this.correctionApplied = false;
    // 参数变化可能改变力学平衡（如 naturalLength），格距估计随之失效，
    // 本 episode 收敛时按新平衡重估（拖拽路径 invalidate 不重置 —— 坐标
    // 变了平衡没变，重估被吸附污染的坐标只会正反馈漂移）。
    this.gridLattice = null;
  }

  invalidate(): void {
    this.solver.invalidate();
    // 拖拽等外部坐标改动后重新弛豫，收敛时需再做一次终局对齐与修正。
    this.correctionApplied = false;
  }

  /** 图结构变化（增删节点/边）：重建世界分块、重新粗布局并重建求解器。 */
  rebuild(): void {
    // 格距是「弛豫终态力学平衡」的估计：只在首次修正时估计一次。
    // 逐帧重复估计会正反馈漂移 —— 吸附/流向约束把布局撑大后，再次
    // 估计的最近邻随之变大，格距越抬越高（实测 12 节点图 124 → 512）。
    // 重建（图结构/重新弛豫）时重置，拖拽不改变力学平衡故保留。
    this.gridLattice = null;
    this.params = deriveParams(this.options, this.store.elements.length);
    Object.assign(this.ctx.params, this.params);
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(true);
    this.partition =
      this.store.subgraphNodes.length > 0 ? buildWorldPartition(this.store) : null;
    const partition = this.partition;
    this.ctx.elements = this.store.elements;
    this.ctx.edges = partition ? partition.liftedEdges : this.store.edges;
    this.ctx.adj = partition ? partition.liftedAdj : this.store.adj;
    this.ctx.world = partition?.world;
    this.ctx.edgeWorld = partition?.edgeWorld;
    this.ctx.edgeKaMul = new Array<number>(this.ctx.edges.length).fill(1);
    this.ctx.edgeCrossCounts = new Array<number>(this.ctx.edges.length).fill(0);
    this.ctx.crossPenaltyEnergy = 0;
    this.ctx.hopScale = buildHopScale(
      this.ctx.adj,
      this.options.hopRepulsionDecay,
      this.options.unrelatedRepulsion,
    );
    this.applyCoarsePlacement();
    // 扩展点重注入：派生算法的 extensions 闭包可能捕获图结构快照
    // （如边下标集合），增删节点/边后必须用新图重建。
    this.configureExtensions();
    this.solver = new RelaxationSolver(this.ctx, this.solverOptions());
    this.solver.invalidate();
    // 图结构变化后重新弛豫，收敛时需再做一次终局对齐与修正。
    this.correctionApplied = false;
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
    if (this.partition) {
      // 弛豫每步钳制：世界内弹力可能把成员推出容器边界（交互拖拽贴边
      // 时尤甚），压回保证成员任何时刻都在自己的世界内。run 与逐帧
      // （demo 动画）共用本方法，两条路径行为一致。
      clampMembersToContainers(this.store, this.partition);
    }
    // 收敛即终局化：终局对齐 + 坐标系修正（与 run() 末尾同一口径）。
    // 逐帧驱动（demo 动画循环）不经过 run()，网格化必须挂在收敛路径上：
    // 触发条件是"本步无接受移动（局部停滞）或求解器已收敛"——单步拒绝
    // 时求解器未必置收敛位，但布局已不再变化，正是终局化的时机；每个
    // 收敛episode只做一次（修正后坐标已稳定，重复执行纯属浪费）。
    if (!this.correctionApplied && (!moved || this.solver.converged)) {
      this.correctionApplied = true;
      this.applyCoordinateCorrection();
    }
    return moved;
  }

  /** 微调到力学平衡（收敛判据自适应），再按坐标系做一次坐标修正。 */
  run(opts: RunOptions = {}): RunResult {
    const max = Math.max(0, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    this.store.applyNodeLabelSizes(true);
    this.solver.invalidate();
    this.correctionApplied = false;
    this.runBudget(max, opts.onTick);
    this.correctionApplied = true;
    this.applyCoordinateCorrection();
    return {
      iterations: this.solver.iterations,
      converged: this.solver.converged,
      energy: this.energy,
    };
  }

  /**
   * 终局对齐 + 坐标系修正（布局完成后，以最优布局为基础）：free 恒等，
   * grid 网格化吸附。世界分块时先做终局对齐（弛豫期两世界零耦合各自
   * 收敛，末次纯平移把成员块对齐容器本体，不改内部相对构型），再对
   * **全部元素**统一精修 —— 网格不变量（坐标 = 格距倍数）对成员同样
   * 成立，且精修以全图几何与全部原始边做质量否决；成员节点携带
   * region 约束（锚点 = 容器本体吸附后的新位置，净空 = 声明矩形
   * 内净空），候选格钳制在声明矩形内，包含性保持构造保证。容器渲染
   * 几何按成员实占刷新（updateBoundsFromChildren）。
   */
  private applyCoordinateCorrection(): void {
    if (this.store.elements.length === 0) return;
    const partition = this.partition;
    if (partition) {
      alignMembersToContainers(this.store, partition);
    }
    const targets = this.store.elements;
    const nodes: CoordinateNode[] = targets.map((el) => ({
      id: el.id,
      x: el.x,
      y: el.y,
      r: el.r,
      fixed: el.fixed,
    }));
    // 成员包含区：声明矩形内净空（逐轴半宽高 − 成员力学外接半尺寸）。
    // region 成员在精修中最后放置，读到的是容器本体吸附后的最终位置；
    // 声明矩形装不下成员实体（净空 ≤ 0）时退回无约束，不虚构包含。
    // 全部容器同时登记为保留区：非成员的落格避让容器内部。
    const zones: RefineZone[] = [];
    // 各容器的格距容量上限：净空内装得下全部有效成员格胞的最大格距
    // （按最小净空成员算，格距超过它成员就得降级出区）。
    const caps: number[] = [];
    for (const sg of this.store.subgraphNodes) {
      const rect = sg.declaredShape;
      if (rect.kind !== 'rect') continue;
      zones.push({ anchorId: sg.id, hw: rect.w / 2, hh: rect.h / 2 });
      let minHw = Infinity;
      let minHh = Infinity;
      let count = 0;
      for (const mi of sg.memberIndices) {
        const el = targets[mi];
        const nd = nodes[mi];
        if (!el || !nd) continue;
        const hwIn = rect.w / 2 - el.hw;
        const hhIn = rect.h / 2 - el.hh;
        if (hwIn <= 0 || hhIn <= 0) continue;
        nd.region = { anchorId: sg.id, hw: hwIn, hh: hhIn };
        minHw = Math.min(minHw, hwIn);
        minHh = Math.min(minHh, hhIn);
        count++;
      }
      if (count > 0) caps.push(zoneLatticeCap(minHw, minHh, count));
    }
    const requested =
      this.options.gridSize > 0 ? this.options.gridSize : this.options.naturalLength;
    // 格距自适应：力学平衡间距大于请求格距时抬格距（就近量化才能每点
    // 一格、无量化洞），但对容器容量上限取小（包含性优先于量化均匀）。
    // 只在首次修正时估计（rebuild 重置）：吸附/流向约束会拉伸布局，
    // 吸附态上重复估计最近邻会正反馈抬高格距，不动点不成立。
    let lattice = this.gridLattice;
    if (lattice === null) {
      lattice = resolveRefineLattice(requested, nodes, caps);
      this.gridLattice = lattice;
    }
    // 质量感知吸附：全部边供穿越否决，流向约束由接缝提供（有向算法）
    const elements = this.store.elements;
    const edges = this.store.edges.map((e) => ({
      source: elements[e.sourceIndex]!.id,
      target: elements[e.targetIndex]!.id,
    }));
    this.cs.refine(nodes, { lattice, edges, zones, flow: this.refineFlow() ?? undefined });
    for (let i = 0; i < nodes.length; i++) {
      targets[i]!.x = nodes[i]!.x;
      targets[i]!.y = nodes[i]!.y;
    }
    // 终局包含口径：容器矩形以容器节点（格点）为中心按成员实占贴合
    // —— 网格吸附/保留区使块中心与节点不严格重合，AABB 中心口径会
    // 把矩形画偏；节点中心贴合使包含性回到构造保证（容量不足而降级
    // 出区的成员同样被覆盖）。
    if (partition) {
      for (const sg of this.store.subgraphNodes) {
        sg.fitShapeToMembersAtNode(this.store.elements);
      }
    }
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
